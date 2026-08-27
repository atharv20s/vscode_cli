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

  // 3. generate_architecture
  registerTool(
    {
      type: "function",
      function: {
        name: "generate_architecture",
        description: "Generate an architectural diagram and documentation in architecture.md.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Architecture title" },
            diagram: { type: "string", description: "ASCII or Mermaid diagram code" },
            explanation: { type: "string", description: "Explanation of component data flow" },
          },
          required: ["title", "diagram", "explanation"],
        },
      },
    },
    async (args, ctx = {}) => {
      const content = `# Architecture - ${args.title}

## System Overview Diagram
\`\`\`
${args.diagram}
\`\`\`

## Component Data Flow
${args.explanation}
`;

      try {
        await workspaceService.writeFile("architecture.md", content, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        return {
          success: true,
          output: `Architecture document created at architecture.md.`,
          path: "architecture.md",
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}
