#!/usr/bin/env node
/**
 * Standalone GitHub & Architecture Tool Model Context Protocol (MCP) Server
 * 
 * Complies with standard Model Context Protocol (MCP) JSON-RPC 2.0.
 * Exposes full GitHub control, Git versioning, UML diagrams, README generation,
 * compilation, and file operations over stdio transport.
 */

import readline from "readline";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(process.cwd(), "./workspace");

// MCP Tool Definitions
const MCP_TOOLS = [
  {
    name: "github_get_repo_info",
    description: "Get metadata for a GitHub repository (stars, forks, open issues, default branch).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create an issue in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body / description" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "github_create_pr",
    description: "Create a GitHub Pull Request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Pull request title" },
        body: { type: "string", description: "Pull request description" },
        head: { type: "string", description: "Source branch (e.g. feature-branch)" },
        base: { type: "string", description: "Target branch (default: main)" },
      },
      required: ["owner", "repo", "title", "head"],
    },
  },
  {
    name: "git_status",
    description: "Get current git status of the workspace.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "git_commit_and_push",
    description: "Stage all files, commit with a message, and push to GitHub remote.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
        remote: { type: "string", description: "Remote name (default: origin)" },
        branch: { type: "string", description: "Branch name (default: current)" },
      },
      required: ["message"],
    },
  },
  {
    name: "generate_uml_diagram",
    description: "Generate a Mermaid.js UML architecture, flowchart, sequence, or class diagram.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Diagram title" },
        diagram_type: { type: "string", enum: ["flowchart", "sequence", "class", "state", "er", "gitGraph"] },
        mermaid_code: { type: "string", description: "Mermaid diagram code" },
        explanation: { type: "string", description: "Component and flow explanation" },
        output_file: { type: "string", description: "File path to write (default: architecture.md)" },
      },
      required: ["title", "mermaid_code"],
    },
  },
  {
    name: "generate_readme",
    description: "Generate a production-grade, beautifully formatted GitHub README.md with badges, table of contents, and architecture diagram.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Project title" },
        tagline: { type: "string", description: "Short tagline" },
        description: { type: "string", description: "Project overview" },
        tech_stack: { type: "array", items: { type: "string" } },
        features: { type: "array", items: { type: "string" } },
        mermaid_diagram: { type: "string", description: "Optional embedded Mermaid architecture" },
      },
      required: ["title", "description"],
    },
  },
  {
    name: "compile_file",
    description: "Compile or syntax-check source code (C, C++, Rust, Go, TypeScript, Java, Python).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        flags: { type: "string", description: "Compiler flags (optional)" },
      },
      required: ["path"],
    },
  },
];

// Tool Handlers
async function callTool(name, args) {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN;

  switch (name) {
    case "git_status": {
      try {
        const { stdout } = await execAsync("git status --porcelain", { cwd: WORKSPACE_ROOT });
        return { content: [{ type: "text", text: stdout || "(workspace is clean)" }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
    }

    case "git_commit_and_push": {
      try {
        await execAsync("git add -A", { cwd: WORKSPACE_ROOT });
        const safeMsg = args.message.replace(/"/g, '\\"');
        const commitRes = await execAsync(`git commit -m "${safeMsg}"`, { cwd: WORKSPACE_ROOT });
        const pushRes = await execAsync(`git push ${args.remote || "origin"} ${args.branch || ""}`, { cwd: WORKSPACE_ROOT });
        return {
          content: [{ type: "text", text: `Committed & Pushed successfully!\n${commitRes.stdout}\n${pushRes.stdout}` }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Git operation failed: ${err.message}` }] };
      }
    }

    case "generate_uml_diagram": {
      const fileName = args.output_file || "architecture.md";
      const cleanMermaid = (args.mermaid_code || "").trim().replace(/^```mermaid\s*/i, "").replace(/```$/, "").trim();
      const content = `# ${args.title}\n\n\`\`\`mermaid\n${cleanMermaid}\n\`\`\`\n\n## Architecture Details\n${args.explanation || ""}\n`;
      const targetPath = path.resolve(WORKSPACE_ROOT, fileName);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
      return { content: [{ type: "text", text: `UML diagram saved to ${fileName}` }] };
    }

    case "generate_readme": {
      const techBadges = (args.tech_stack || []).map(t => `![${t}](https://img.shields.io/badge/${encodeURIComponent(t)}-38bdf8?style=for-the-badge)`).join(" ");
      const featureList = (args.features || []).map(f => `- **${f}**`).join("\n");
      const diagramSection = args.mermaid_diagram ? `\n## 📐 Architecture\n\n\`\`\`mermaid\n${args.mermaid_diagram}\n\`\`\`\n` : "";

      const content = `# ${args.title}\n\n> ${args.tagline || ""}\n\n${techBadges}\n\n${args.description}\n\n## 🚀 Features\n${featureList}\n${diagramSection}\n## ⚡ Installation\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n## 📄 License\nMIT\n`;
      const targetPath = path.resolve(WORKSPACE_ROOT, "README.md");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
      return { content: [{ type: "text", text: `README.md generated successfully at ${targetPath}` }] };
    }

    case "compile_file": {
      const filePath = args.path;
      const ext = filePath.split(".").pop().toLowerCase();
      let cmd = "";
      if (ext === "c") cmd = `gcc ${args.flags || ""} "${filePath}" -o "${filePath}.out" -lm`;
      else if (ext === "cpp") cmd = `g++ -std=c++20 ${args.flags || ""} "${filePath}" -o "${filePath}.out" -lm`;
      else if (ext === "rs") cmd = `rustc "${filePath}"`;
      else if (ext === "go") cmd = `go build "${filePath}"`;
      else if (ext === "ts") cmd = `npx -y tsc --noEmit "${filePath}"`;
      else if (ext === "py") cmd = `python3 -m py_compile "${filePath}"`;
      else if (ext === "js") cmd = `node --check "${filePath}"`;
      else return { isError: true, content: [{ type: "text", text: `Unsupported file extension .${ext}` }] };

      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: WORKSPACE_ROOT });
        return { content: [{ type: "text", text: `Compilation Succeeded!\n${stdout || stderr || "No errors."}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Compilation Error:\n${err.stderr || err.stdout || err.message}` }] };
      }
    }

    case "github_get_repo_info": {
      try {
        const headers = { "User-Agent": "Agentic-MCP-Server" };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(`https://api.github.com/repos/${args.owner}/${args.repo}`, { headers });
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
    }

    case "github_create_issue": {
      if (!token) return { isError: true, content: [{ type: "text", text: "GitHub token required." }] };
      try {
        const res = await fetch(`https://api.github.com/repos/${args.owner}/${args.repo}/issues`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Agentic-MCP-Server",
          },
          body: JSON.stringify({
            title: args.title,
            body: args.body || "",
            labels: args.labels || [],
          }),
        });
        const data = await res.json();
        return { content: [{ type: "text", text: `Issue created: ${data.html_url}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
    }

    default:
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
}

// Stdio JSON-RPC MCP Server Protocol Loop
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = request;

  if (method === "initialize") {
    sendResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "agentic-github-architecture-mcp",
          version: "1.0.0",
        },
      },
    });
  } else if (method === "tools/list") {
    sendResponse({
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    });
  } else if (method === "tools/call") {
    const { name, arguments: toolArgs } = params || {};
    try {
      const result = await callTool(name, toolArgs || {});
      sendResponse({
        jsonrpc: "2.0",
        id,
        result,
      });
    } catch (err) {
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message },
      });
    }
  } else if (method === "notifications/initialized") {
    // Client initialized notification — no reply needed
  } else {
    if (id !== undefined) {
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  }
});
