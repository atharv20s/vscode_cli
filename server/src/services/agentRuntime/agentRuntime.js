/**
 * Modular Agent Runtime for ATH IDE 3.0
 * 
 * Replaces the monolithic agent loop with explicit, composable stages:
 * 1. ContextPlanner: Assembles AST repo map, durable state memory, and editor context.
 * 2. ModelGateway: Streams LLM reasoning, tracks usage tokens, handles truncation.
 * 3. ToolExecutor: Dispatches via ToolScheduler with concurrency and safety rules.
 * 4. PermissionEngine: Enforces independent capability and security policy gates.
 * 5. StateMemoryManager: Records decisions, mutations, tests into durable task memory.
 * 6. VerificationEngine: Drives evidence-based testing and targeted repair loops.
 * 7. RecoveryController: Handles snapshot rollback and failure recovery.
 * 8. AgentController: Coordinates stages, checks progress metrics, and advances turns.
 */

import { repoIntelligence } from "../repoIntelligence.js";
import { TaskMemory } from "../taskMemory.js";
import { toolScheduler } from "../toolScheduler.js";
import { evidenceVerifier } from "../evidenceVerifier.js";
import { progressEvaluator, Recommendation } from "../progressEvaluator.js";
import { taskController } from "../taskController.js";

export class AgentRuntime {
  constructor({
    sessionId = "default",
    workspaceDir = "",
    model = "default",
    maxTurns = 15,
  } = {}) {
    this.sessionId = sessionId;
    this.workspaceDir = workspaceDir;
    this.model = model;
    this.maxTurns = maxTurns;

    this.memory = new TaskMemory();
    this.scheduler = toolScheduler;
    this.verifier = evidenceVerifier;
    this.evaluator = progressEvaluator;
    this.controller = taskController;

    this.turn = 0;
    this.actionHistory = [];
    this.errorHistory = [];
    this.mutationsCount = 0;
  }

  /**
   * Stage 1: Context Planning
   * Assembles high-signal, token-budgeted prompt context.
   */
  async planContext(userPrompt, { openFiles = [] } = {}) {
    this.memory.setObjective(userPrompt);

    // 1. Query relevant repository context via AST intelligence
    let repoMapBlock = "";
    if (this.workspaceDir) {
      const relevant = repoIntelligence.queryRelevantContext({
        task: userPrompt,
        openFiles,
        maxFiles: 6,
      });
      repoMapBlock = repoIntelligence.formatRepoMap(relevant);
    }

    // 2. Query durable state memory
    const memoryBlock = this.memory.formatPromptMemory();

    return {
      repoMapBlock,
      memoryBlock,
      complexity: this.controller.classifyTask(userPrompt),
    };
  }

  /**
   * Stage 2: Tool Execution through the Scheduler
   */
  async executeTools(toolCalls, toolHandler) {
    if (!toolCalls || !toolCalls.length) return [];

    const mappedCalls = toolCalls.map(tc => {
      let args = {};
      if (typeof tc.arguments === "object" && tc.arguments !== null) args = tc.arguments;
      else if (typeof tc.arguments === "string") {
        try { args = JSON.parse(tc.arguments); } catch { args = { raw: tc.arguments }; }
      }
      return { id: tc.id, name: tc.name, args };
    });

    const results = await this.scheduler.scheduleAndExecute(mappedCalls, toolHandler);

    // Record actions and mutations in history
    for (const r of results) {
      const matched = mappedCalls.find(c => c.id === r.id);
      if (matched) {
        this.actionHistory.push({
          name: matched.name,
          argsHash: JSON.stringify(matched.args || {}),
        });

        if (r.success && (matched.name.includes("write") || matched.name.includes("edit") || matched.name.includes("patch"))) {
          this.mutationsCount++;
          this.memory.recordFileMutation(matched.args?.path || "modified_file", {
            action: matched.name,
            summary: "Applied tool mutation",
          });
        }
      }

      if (!r.success && r.error) {
        this.errorHistory.push(String(r.error));
      }
    }

    return results;
  }

  /**
   * Stage 3: Verification Engine
   */
  async runVerification(testCommandRunner) {
    if (typeof testCommandRunner !== "function") return { verified: true };

    const rawOutput = await testCommandRunner();
    const evidence = this.verifier.parseTestOutput(rawOutput, {
      changedFiles: Array.from(this.memory.fileLedger.keys()),
    });

    for (const item of evidence) {
      this.memory.recordTestResult(item.testName, {
        passed: false,
        error: item.error,
      });
    }

    const evaluation = this.verifier.evaluateCompletion(evidence);
    const repairPrompt = evidence.length ? this.verifier.generateRepairPrompt(evidence) : "";

    return {
      verified: evaluation.verified,
      evidence,
      repairPrompt,
    };
  }

  /**
   * Stage 4: Turn Evaluation & Progress Check
   */
  evaluateTurnProgress() {
    this.turn++;
    return this.evaluator.evaluateTurn({
      turnNumber: this.turn,
      recentActions: this.actionHistory.slice(-4),
      recentErrors: this.errorHistory.slice(-4),
      mutationsCount: this.mutationsCount,
    });
  }
}
