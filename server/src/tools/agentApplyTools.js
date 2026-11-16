import path from "node:path";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx|keystore))$/i;

export function registerAgentApplyTools(registerTool) {
  registerTool({
    type: "function",
    function: {
      name: "propose_changes",
      description: "Prepare a reviewable multi-file patch. Use this instead of writing files directly for normal code edits. The user sees Monaco diffs and must explicitly accept before any file is changed. Never include secrets, credentials, environment files, or binary content.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Short description of the proposed change." },
          files: {
            type: "array",
            minItems: 1,
            maxItems: MAX_FILES,
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace-relative file path." },
                content: { type: "string", description: "Complete proposed UTF-8 file content." }
              },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        required: ["files"],
        additionalProperties: false
      }
    }
  }, async (args, context) => {
    const workspace = context.workspaceService;
    if (!workspace || typeof context.onEvent !== "function") {
      return { success: false, error: "Review-first changes are unavailable in this agent context." };
    }
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > MAX_FILES) {
      return { success: false, error: "A proposal must contain between 1 and 20 files." };
    }
    const seen = new Set();
    let total = 0;
    const files = [];
    for (const item of args.files) {
      const file = typeof item?.path === "string" ? item.path.trim() : "";
      const content = item?.content;
      if (!file || file.length > 1024 || path.isAbsolute(file) || file.includes("\0") || typeof content !== "string") {
        return { success: false, error: "Each proposed file needs a safe relative path and UTF-8 string content." };
      }
      const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
      if (seen.has(normalized)) return { success: false, error: "Duplicate path in proposal: " + normalized };
      seen.add(normalized);
      if (SECRET_PATH.test(normalized) || normalized.split("/").some(part => [".git", ".ath-locks", "node_modules"].includes(part))) {
        return { success: false, error: "Sensitive or generated paths cannot be included: " + normalized };
      }
      const bytes = Buffer.byteLength(content, "utf8");
      total += bytes;
      if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || content.includes("\u0000")) {
        return { success: false, error: "Proposal exceeds text file or total patch size limits, or contains binary data." };
      }
      const target = workspace.resolvePath(normalized);
      if (!target.safe || target.relative === ".") return { success: false, error: "Path is outside the active workspace: " + normalized };
      files.push({ path: target.relative, content });
    }
    context.onEvent({
      type: "agent.apply.proposal",
      data: { summary: String(args.summary || "Agent proposed workspace changes").slice(0, 240), files }
    });
    return {
      success: true,
      output: "The multi-file patch is waiting in the user's review panel. Do not write these files directly; wait for explicit acceptance."
    };
  });
}
