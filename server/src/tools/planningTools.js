/**
 * Planning Tools — Autonomous AI Roadmap & Task Management
 * 
 * Provides dedicated tools for creating structured implementation plans,
 * tracking multi-step task checklists, and recording verification milestones.
 */

import { registerTool } from "./index.js";
import { workspaceService } from "../services/workspaceService.js";

export function registerPlanningTools() {
  // 1. create_plan
  registerTool(
    {
      type: "function",
      function: {
        name: "create_plan",
        description:
          "Create a structured implementation plan with objectives, task checklists, and verification steps in the workspace.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the implementation plan" },
            objective: { type: "string", description: "Overview and goal of the task" },
            tasks: {
              type: "array",
              description: "List of actionable task steps",
              items: { type: "string" },
            },
            verification: {
              type: "string",
              description: "Verification steps and expected outcomes",
            },
          },
          required: ["title", "objective", "tasks"],
        },
      },
    },
    async (args, ctx = {}) => {
      const taskList = args.tasks.map((t, i) => `- [ ] ${i + 1}. ${t}`).join("\n");
      const planContent = `# ${args.title}

## Objective
${args.objective}

## Task Checklist
${taskList}

## Verification Plan
${args.verification || "Verify functionality upon completion."}
`;

      const taskContent = `# Current Tasks\n\n${taskList}\n`;

      try {
        await workspaceService.writeFile("implementation_plan.md", planContent, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        await workspaceService.writeFile("task.md", taskContent, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
        });

        return {
          success: true,
          output: `Implementation plan created with ${args.tasks.length} tasks.\nSaved to implementation_plan.md and task.md.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 2. update_plan
  registerTool(
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "Mark a task complete or update progress in task.md.",
        parameters: {
          type: "object",
          properties: {
            task_number: { type: "integer", description: "The task number (1-based)" },
            status: {
              type: "string",
              description: "Task status: 'completed', 'in_progress', 'blocked'",
              enum: ["completed", "in_progress", "blocked"],
            },
            notes: { type: "string", description: "Optional progress note" },
          },
          required: ["task_number", "status"],
        },
      },
    },
    async (args, ctx = {}) => {
      try {
        const file = await workspaceService.readFile("task.md");
        const lines = file.content.split("\n");
        const targetPrefix = `- [ ] ${args.task_number}.`;
        const completedPrefix = `- [x] ${args.task_number}.`;

        let updated = false;
        const newLines = lines.map((line) => {
          if (line.startsWith(targetPrefix)) {
            updated = true;
            if (args.status === "completed") {
              return line.replace("- [ ]", "- [x]");
            }
            if (args.notes) {
              return `${line} (${args.notes})`;
            }
          }
          return line;
        });

        if (updated) {
          await workspaceService.writeFile("task.md", newLines.join("\n"), {
            source: "agent",
            actor: "agent",
            turnId: ctx.turnId,
          });
          return { success: true, output: `Updated Task ${args.task_number} status to ${args.status}` };
        }

        return { success: false, error: `Task number ${args.task_number} not found in task.md` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}
