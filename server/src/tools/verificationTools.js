import { registerTool, executeTool } from "./index.js";
import { getWorkspaceServiceForContext } from "../services/workspaceService.js";

function parseJson(content) {
  try { return JSON.parse(content); } catch { return null; }
}

export function detectVerificationCommands(manifest, files = []) {
  const scripts = manifest?.scripts || {};
  const commands = [];
  const manager = files.includes("pnpm-lock.yaml") ? "pnpm"
    : files.includes("yarn.lock") ? "yarn" : "npm";
  const run = name => manager === "npm" ? "npm run " + name : manager + " run " + name;

  if (scripts.typecheck) commands.push({ name: "typecheck", command: run("typecheck") });
  if (scripts.lint) commands.push({ name: "lint", command: run("lint") });
  if (scripts.test) commands.push({
    name: "test",
    command: manager === "npm" ? "CI=true npm test" : manager + " test",
  });
  if (scripts.build) commands.push({ name: "build", command: run("build") });

  if (!scripts.test && (files.includes("pyproject.toml") || files.includes("requirements.txt") || files.includes("pytest.ini"))) {
    commands.push({ name: "test", command: "python3 -m pytest -q" });
  }
  if (!scripts.test && files.includes("Cargo.toml")) commands.push({ name: "test", command: "cargo test --locked" });
  if (!scripts.test && files.includes("go.mod")) commands.push({ name: "test", command: "go test ./..." });
  return commands.slice(0, 4);
}

export function registerVerificationTools() {
  registerTool({
    type: "function",
    function: {
      name: "verify_workspace",
      description: "Run the workspace's declared typecheck, lint, test and build scripts, or standard Python/Rust/Go tests when detected. Returns exact outcomes. Must be used before claiming a code-changing task is complete. Does not install packages or deploy.",
      parameters: {
        type: "object",
        properties: {
          browser_url: { type: "string", description: "Optional running localhost or configured preview URL for browser acceptance." },
          checks: {
            type: "array",
            items: { type: "string", enum: ["typecheck","lint","test","build"] },
            description: "Optional subset of checks to run; defaults to all detected checks",
          },
        },
        required: [],
      },
    },
  }, async (args, ctx = {}) => {
    const workspace = getWorkspaceServiceForContext(ctx);
    const manifestFile = await workspace.readFile("package.json").catch(() => null);
    const manifest = manifestFile?.content ? parseJson(manifestFile.content) : null;
    const tree = await workspace.listDirectory(".").catch(() => ({ entries: [] }));
    const paths = (tree.entries || []).map(item => item.name).filter(Boolean);
    let checks = detectVerificationCommands(manifest, paths);
    if (args.checks?.length) checks = checks.filter(item => args.checks.includes(item.name));
    if (!checks.length) return {
      success: false,
      output: "No supported verification scripts or standard test manifests were detected. Inspect the project and run documented checks manually; absence of checks is not a pass.",
      checks: [],
      verified: false,
    };

    const results = [];
    for (const check of checks) {
      if (ctx.signal?.aborted) return { success: false, verified: false, checks: results, error: "Verification cancelled." };
      ctx.onEvent?.({ type: "verification_start", data: check });
      const result = await executeTool("run_command", { command: check.command, timeout_seconds: 300 }, {
        ...ctx,
        allowedTools: null,
      });
      const item = {
        ...check,
        success: result.success === true,
        output: String(result.output || result.error || "").slice(-10000),
      };
      results.push(item);
      ctx.onEvent?.({ type: "verification_result", data: item });
      if (!item.success) break;
    }
    let browserResult = null;
    if (args.browser_url && results.every(item => item.success)) {
      browserResult = await executeTool("browser_verify", { url: args.browser_url }, {
        ...ctx,
        allowedTools: null,
      });
    }
    const verified = results.length === checks.length && results.every(item => item.success) &&
      (!args.browser_url || browserResult?.success === true);
    const output = results.map(item => (item.success ? "PASS " : "FAIL ") + item.name + ": " + item.command + "\n" + item.output).join("\n\n");
    return {
      success: verified,
      verified,
      checks: results,
      browser: browserResult,
      output: output + (browserResult ? "\n\nBROWSER ACCEPTANCE:\n" + JSON.stringify(browserResult).slice(0,12000) : ""),
    };
  });
}
