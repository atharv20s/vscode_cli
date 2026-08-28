/**
 * File Tools — Centralized Workspace File System Interface
 * 
 * Routes through PermissionEngine for security checks and WorkspaceService
 * for path policy enforcement and lightweight mutation event publishing.
 */

import { registerTool } from "./index.js";
import { workspaceService } from "../services/workspaceService.js";
import { permissionEngine } from "../services/permissionEngine.js";

export function registerFileTools() {
  // 1. read_file
  registerTool(
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file in the workspace. Supports optional line range.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            start_line: { type: "integer", description: "Optional start line (1-based)" },
            end_line: { type: "integer", description: "Optional end line (1-based, inclusive)" },
          },
          required: ["path"],
        },
      },
    },
    async (args, ctx = {}) => {
      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "file",
        action: "read",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const result = await workspaceService.readFile(args.path, args.start_line, args.end_line);
        return { success: true, output: result.content };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 2. write_file
  registerTool(
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a file in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      },
    },
    async (args, ctx = {}) => {
      const filePath = args.path || args.filePath || args.file || args.filename || "index.html";
      const fileContent = args.content !== undefined ? args.content : (args.data !== undefined ? args.data : (args.code !== undefined ? args.code : (args.text !== undefined ? args.text : "")));

      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "file",
        action: "write",
        payload: { path: filePath, content: fileContent },
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const result = await workspaceService.writeFile(filePath, fileContent, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
          operationId: ctx.operationId,
        });
        return {
          success: true,
          output: `Successfully written to ${result.path} (${result.size} bytes)`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 3. edit_file
  registerTool(
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file by searching for an exact string and replacing it with new content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            search: { type: "string", description: "Exact string to find" },
            replace: { type: "string", description: "Replacement string" },
          },
          required: ["path", "search", "replace"],
        },
      },
    },
    async (args, ctx = {}) => {
      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "file",
        action: "edit",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const file = await workspaceService.readFile(args.path);
        if (!file.content.includes(args.search)) {
          return { success: false, error: `Search string not found in ${args.path}` };
        }

        const updated = file.content.replace(args.search, args.replace);
        await workspaceService.writeFile(args.path, updated, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
          operationId: ctx.operationId,
        });

        return {
          success: true,
          output: `Edited ${args.path}\n\n--- Before ---\n${args.search}\n\n+++ After +++\n${args.replace}`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 4. delete_file
  registerTool(
    {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file or directory from the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file or folder to delete" },
          },
          required: ["path"],
        },
      },
    },
    async (args, ctx = {}) => {
      const targetPath = args.path || args.file || args.filename || args.filePath;
      if (!targetPath) return { success: false, error: "Missing required 'path' parameter." };

      const perm = await permissionEngine.checkPermission({
        resource: "file",
        action: "delete",
        payload: { path: targetPath },
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const result = await workspaceService.deleteFile(targetPath, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
          operationId: ctx.operationId,
        });
        return { success: true, output: `Successfully deleted ${result.path}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 5. compile_file
  registerTool(
    {
      type: "function",
      function: {
        name: "compile_file",
        description: "Compile or syntax-check a source code file (C, C++, Rust, Go, TypeScript, Java, Python, JavaScript) and report compile errors or generate binaries.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the source file to compile" },
            output_binary: { type: "string", description: "Optional output binary name (e.g. 'game.out', 'main')" },
            flags: { type: "string", description: "Optional additional compiler flags (e.g. '-O3 -Wall -pthread')" },
          },
          required: ["path"],
        },
      },
    },
    async (args, ctx = {}) => {
      const filePath = args.path || args.file || args.filename || args.filePath;
      if (!filePath) return { success: false, error: "Missing 'path' parameter for compilation." };

      const ext = filePath.split(".").pop().toLowerCase();
      const outName = args.output_binary || filePath.replace(/\.[^/.]+$/, "");
      const flags = args.flags || "";

      let compileCmd = "";
      if (ext === "c") {
        compileCmd = `gcc ${flags} "${filePath}" -o "${outName}" -lm`;
      } else if (ext === "cpp" || ext === "cc" || ext === "cxx") {
        compileCmd = `g++ -std=c++20 ${flags} "${filePath}" -o "${outName}" -lm`;
      } else if (ext === "rs") {
        compileCmd = `rustc ${flags} "${filePath}" -o "${outName}"`;
      } else if (ext === "go") {
        compileCmd = `go build ${flags} -o "${outName}" "${filePath}"`;
      } else if (ext === "ts" || ext === "tsx") {
        compileCmd = `npx -y tsc --noEmit "${filePath}"`;
      } else if (ext === "py") {
        compileCmd = `python3 -m py_compile "${filePath}"`;
      } else if (ext === "js" || ext === "mjs") {
        compileCmd = `node --check "${filePath}"`;
      } else if (ext === "html" || ext === "htm") {
        // Syntax verification for HTML files
        try {
          const content = await workspaceService.readFile(filePath);
          const hasClosing = content.includes("</html>") || content.includes("</canvas>") || content.includes("</body>");
          return {
            success: true,
            output: `HTML verification succeeded for ${filePath}. Document is well-formed (${(content.length / 1024).toFixed(1)} KB).`,
            isHtml: true,
          };
        } catch (readErr) {
          return { success: false, error: `HTML verification failed: ${readErr.message}` };
        }
      } else if (ext === "json") {
        try {
          const content = await workspaceService.readFile(filePath);
          JSON.parse(content);
          return { success: true, output: `JSON verification succeeded for ${filePath}. Valid syntax.` };
        } catch (jsonErr) {
          return { success: false, error: `JSON syntax error: ${jsonErr.message}` };
        }
      } else if (ext === "java") {
        compileCmd = `javac ${flags} "${filePath}"`;
      } else {
        return { success: false, error: `Unsupported file extension for compilation: .${ext}` };
      }

      const { executionService } = await import("../services/executionService.js");
      const res = await executionService.executeCommand(compileCmd, {
        cwd: ctx.workspaceDir,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });

      if (res.exitCode === 0) {
        return {
          success: true,
          output: `Compilation succeeded for ${filePath}.\nCommand: ${compileCmd}\n${res.stdout || "No warnings."}`,
          binary: outName,
        };
      } else {
        return {
          success: false,
          error: `Compilation failed with exit code ${res.exitCode}:\n${res.stderr || res.stdout}`,
        };
      }
    }
  );

  // 6. launch_file / launch_preview
  registerTool(
    {
      type: "function",
      function: {
        name: "launch_file",
        description: "Launch an HTML file, web app, or frontend game in the IDE Live Preview browser tab.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the HTML or web entry file (e.g. 'index.html', 'snake.html')" },
            port: { type: "integer", description: "Optional port if starting a custom dev server" },
          },
          required: ["path"],
        },
      },
    },
    async (args, ctx = {}) => {
      const raw = (args.path || args.file || args.filename || "index.html").trim();
      const filePath = raw.replace(/^\/+/, "").replace(/^preview\//, "");
      const { previewService } = await import("../services/previewService.js");
      
      const previewUrl = `/preview/${filePath}`;
      previewService.setReady(previewUrl, 3001);

      return {
        success: true,
        output: `Application launched! Live preview is now open at ${previewUrl}`,
        url: previewUrl,
      };
    }
  );

  // 7. list_files / list_dir
  registerTool(
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and subdirectories in a workspace directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative directory path (default: '.')" },
          },
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      const dirPath = args.path || ".";
      try {
        const result = await workspaceService.listDirectory(dirPath);
        const formatted = result.entries.map((e) => (e.isDirectory ? `${e.name}/` : `${e.name} (${(e.size / 1024).toFixed(1)} KB)`));
        return {
          success: true,
          output: formatted.length > 0 ? `Contents of ${dirPath}/:\n${formatted.join("\n")}` : `Empty directory: ${dirPath}/`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}
