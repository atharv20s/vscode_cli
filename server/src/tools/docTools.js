/**
 * Documentation & Artifact Generation Tools
 * 
 * Generates production-grade README documentation, verification walkthroughs,
 * and architectural diagrams (with zero emojis).
 */

import { registerTool } from "./index.js";
import { workspaceService } from "../services/workspaceService.js";

export function registerDocTools() {
  // 1. create_readme
  registerTool(
    {
      type: "function",
      function: {
        name: "create_readme",
        description:
          "Generate a comprehensive, professional project README.md file in the workspace " +
          "documenting architecture, features, installation, and usage (without emojis).",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Project title" },
            description: { type: "string", description: "Project summary and problem solved" },
            features: {
              type: "array",
              description: "List of key features",
              items: { type: "string" },
            },
            installation: { type: "string", description: "Installation & setup steps" },
            usage: { type: "string", description: "Usage instructions" },
          },
          required: ["title", "description"],
        },
      },
    },
    async (args, ctx = {}) => {
      const featureList = (args.features || []).map((f) => `* **${f}**`).join("\n");
      const content = `# ${args.title}

${args.description}

---

## Key Features

${featureList || "* Core functionality and autonomous workflows."}

---

## Getting Started

### Installation
\`\`\`bash
${args.installation || "npm install"}
\`\`\`

### Usage
\`\`\`bash
${args.usage || "npm run dev"}
\`\`\`

---

## Architecture & System Design

The application follows an event-driven, decoupled architecture separating the user interface, execution runtime, and state management layers.

---

## License

MIT License.
`;

      try {
        await workspaceService.writeFile("README.md", content, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        return {
          success: true,
          output: `Successfully generated comprehensive README.md in the workspace.`,
          path: "README.md",
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 2. generate_walkthrough
  registerTool(
    {
      type: "function",
      function: {
        name: "generate_walkthrough",
        description: "Generate a structured walkthrough.md summarizing completed work, testing, and validation results.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Walkthrough title" },
            summary: { type: "string", description: "Summary of changes made" },
            files_modified: {
              type: "array",
              description: "List of modified or created files",
              items: { type: "string" },
            },
            verification_results: { type: "string", description: "Validation and testing results" },
            preview_url: { type: "string", description: "Live preview URL if available" },
          },
          required: ["title", "summary", "files_modified", "verification_results"],
        },
      },
    },
    async (args, ctx = {}) => {
      const fileList = args.files_modified.map((f) => `* \`${f}\``).join("\n");
      const content = `# Walkthrough - ${args.title}

## Summary of Completed Work
${args.summary}

---

## Files Changed
${fileList}

---

## Verification & Testing
${args.verification_results}

${args.preview_url ? `\n---\n\n## Live Preview\nApplication is verified and running at: ${args.preview_url}` : ""}
`;

      try {
        await workspaceService.writeFile("walkthrough.md", content, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        return {
          success: true,
          output: `Walkthrough document generated at walkthrough.md.`,
          path: "walkthrough.md",
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 3. generate_architecture / generate_uml_diagram
  registerTool(
    {
      type: "function",
      function: {
        name: "generate_uml_diagram",
        description: "Generate a professional UML diagram (Flowchart, Sequence Diagram, Class Diagram, State Diagram, ER Diagram, or Git Graph) using Mermaid.js syntax and save it as a markdown/diagram file with live visual rendering.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Diagram title" },
            diagram_type: {
              type: "string",
              enum: ["flowchart", "sequence", "class", "state", "er", "gitGraph"],
              description: "Type of UML diagram to produce",
            },
            mermaid_code: { type: "string", description: "Valid Mermaid.js diagram source code" },
            explanation: { type: "string", description: "Detailed explanation of components, interactions, and data flow" },
            output_file: { type: "string", description: "Filename to save into (default: 'architecture.md')" },
          },
          required: ["title", "mermaid_code"],
        },
      },
    },
    async (args, ctx = {}) => {
      const fileName = args.output_file || "architecture.md";
      const cleanMermaid = (args.mermaid_code || "").trim().replace(/^```mermaid\s*/i, "").replace(/```$/, "").trim();

      const content = `# ${args.title}

## System Architecture Diagram

\`\`\`mermaid
${cleanMermaid}
\`\`\`

## System Overview & Component Specifications
${args.explanation || "This diagram illustrates the core components, boundaries, and communication protocols within the system."}

---
*Generated by Agentic Studio Architecture Engine.*
`;

      try {
        await workspaceService.writeFile(fileName, content, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        // Also create a standalone HTML interactive viewer so it can be previewed in the IDE
        const htmlViewer = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${args.title} - UML Diagram</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: 'dark' });</script>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 2rem; display: flex; flex-direction: column; align-items: center; }
    .card { background: #1e293b; border-radius: 12px; padding: 2rem; border: 1px solid #334155; max-width: 900px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h1 { font-size: 1.5rem; margin-top: 0; color: #38bdf8; }
    .explanation { margin-top: 1.5rem; line-height: 1.6; color: #94a3b8; font-size: 0.95rem; border-top: 1px solid #334155; padding-top: 1rem; }
    .mermaid { display: flex; justify-content: center; margin: 1.5rem 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${args.title}</h1>
    <div class="mermaid">
${cleanMermaid}
    </div>
    <div class="explanation">
      <strong>Architecture Overview:</strong><br>
      ${args.explanation || "Component interaction and state transition flow."}
    </div>
  </div>
</body>
</html>`;

        const htmlFileName = fileName.replace(/\.md$/i, "") + "_diagram.html";
        await workspaceService.writeFile(htmlFileName, htmlViewer, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        return {
          success: true,
          output: `UML Diagram successfully generated!\n- Markdown file: ${fileName}\n- Live Visual Interactive Viewer: ${htmlFileName}\n- Preview URL: /preview/${htmlFileName}`,
          markdownFile: fileName,
          htmlFile: htmlFileName,
          previewUrl: `/preview/${htmlFileName}`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 4. generate_readme (Comprehensive, high-grade GitHub README with badges & TOC)
  registerTool(
    {
      type: "function",
      function: {
        name: "generate_readme",
        description: "Generate a production-grade, beautifully formatted GitHub README.md with badges, table of contents, architecture diagram, feature breakdown, setup guide, and license.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Project title / repository name" },
            tagline: { type: "string", description: "One-line catchy tagline" },
            description: { type: "string", description: "Detailed project overview and problem solved" },
            tech_stack: { type: "array", items: { type: "string" }, description: "List of technologies/frameworks used (e.g. ['Node.js', 'Express', 'PostgreSQL', 'Mermaid'])" },
            features: { type: "array", items: { type: "string" }, description: "List of key features" },
            mermaid_diagram: { type: "string", description: "Optional Mermaid.js architecture diagram to embed" },
            installation_steps: { type: "array", items: { type: "string" }, description: "Step by step installation commands" },
            environment_vars: { type: "array", items: { type: "string" }, description: "List of required environment variables" },
          },
          required: ["title", "description"],
        },
      },
    },
    async (args, ctx = {}) => {
      const techBadges = (args.tech_stack || []).map(t => `![${t}](https://img.shields.io/badge/${encodeURIComponent(t)}-38bdf8?style=for-the-badge&logo=${encodeURIComponent(t.toLowerCase())}&logoColor=white)`).join(" ");
      const featureItems = (args.features || []).map(f => `- **${f}**`).join("\n");
      const installCommands = (args.installation_steps || ["git clone <repo-url>", "npm install", "npm run dev"]).join("\n");
      const envList = (args.environment_vars || []).map(e => `\`${e}\``).join(", ");

      const diagramSection = args.mermaid_diagram ? `
## 📐 System Architecture

\`\`\`mermaid
${args.mermaid_diagram.trim().replace(/^```mermaid\s*/i, "").replace(/```$/, "").trim()}
\`\`\`
` : "";

      const content = `# ${args.title}

${args.tagline ? `> **${args.tagline}**\n` : ""}
${techBadges ? `\n${techBadges}\n` : ""}

${args.description}

---

## 📑 Table of Contents
- [Features](#-key-features)
${args.mermaid_diagram ? "- [System Architecture](#-system-architecture)\n" : ""}- [Tech Stack](#-tech-stack)
- [Quick Start](#-quick-start)
- [Environment Variables](#-environment-variables)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Key Features

${featureItems || "- Fully autonomous multi-agent coding engine\n- Real-time sandboxed terminal environment\n- Resilient priority execution queue"}
${diagramSection}
---

## 🛠️ Tech Stack
${(args.tech_stack || ["Node.js", "Express", "PostgreSQL", "WebSocket", "Docker"]).map(t => `- **${t}**`).join("\n")}

---

## ⚡ Quick Start

### Prerequisites
- Node.js (v20+ recommended)
- Git

### Installation

\`\`\`bash
# 1. Clone repository
${installCommands}
\`\`\`

---

## 🔐 Environment Variables

${envList ? `Configure the following variables in your \`.env\` file:\n\n${envList}` : "Copy `.env.example` to `.env` and provide your API keys."}

---

## 🤝 Contributing
1. Fork the Project
2. Create your Feature Branch (\`git checkout -b feature/AmazingFeature\`)
3. Commit your Changes (\`git commit -m 'Add some AmazingFeature'\`)
4. Push to the Branch (\`git push origin feature/AmazingFeature\`)
5. Open a Pull Request

---

## 📄 License
Distributed under the MIT License. See \`LICENSE\` for more information.
`;

      try {
        await workspaceService.writeFile("README.md", content, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        return {
          success: true,
          output: `Production-ready README.md generated successfully with architecture diagrams, badges, and installation guide!`,
          path: "README.md",
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}
