/**
 * Specialist-Agent Team Orchestrator (Milestone 2.0 / PR #68)
 *
 * Implements end-to-end multi-agent software engineering pipelines:
 *   PLANNER -> CODER -> TESTER -> SECURITY REVIEWER
 *
 * Features:
 * - Topological dependency execution of task batches
 * - Automatic test-driven repair loop: if tester fails, routes back to coder
 * - Shared context graph preserving contracts, diffs, and test evidence
 * - Independent reviewer verification before final acceptance
 */

import { executeTaskGraph } from "./taskGraph.js";
import { logger } from "../config/logger.js";

export const PIPELINE_STAGES = ["plan", "code", "test", "review", "complete"];

export class AgentTeamOrchestrator {
  constructor(options = {}) {
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
  }

  /**
   * Run a full autonomous team pipeline for a user task.
   *
   * @param {object} params
   * @param {string} params.goal - High-level user requirement
   * @param {string} params.workspaceDir - Target workspace path
   * @param {Function} params.agentRunner - Async function (role, prompt, context) => { success, output, artifacts }
   * @param {Function} [params.onProgress] - Progress callback
   * @returns {Promise<{ success: boolean, stage: string, findings: object, iterations: number }>}
   */
  async runPipeline({ goal, workspaceDir, agentRunner, onProgress, signal }) {
    if (!goal || typeof goal !== "string") throw new Error("A valid task goal is required.");
    if (typeof agentRunner !== "function") throw new Error("agentRunner must be an async function.");

    const contextGraph = {
      goal,
      workspaceDir,
      plan: null,
      codeChanges: [],
      testResults: [],
      securityFindings: [],
      repairCount: 0,
    };

    // Stage 1: Planning
    onProgress?.({ stage: "plan", message: "Planner agent analyzing workspace and generating task graph..." });
    const planResult = await agentRunner("planner", `Create an implementation plan for: ${goal}`, contextGraph);
    if (!planResult.success || signal?.aborted) {
      return { success: false, stage: "plan", error: planResult.output || "Planning failed.", context: contextGraph };
    }
    contextGraph.plan = planResult.output;

    // Stage 2 & 3: Coder + Tester Iterative Loop
    let testPassed = false;
    let repairAttempts = 0;

    while (!testPassed && repairAttempts <= this.maxRepairAttempts) {
      if (signal?.aborted) return { success: false, stage: "aborted", context: contextGraph };

      // Coder Step
      onProgress?.({
        stage: "code",
        message: repairAttempts === 0
          ? "Coder agent implementing changes based on plan..."
          : `Coder agent repairing test failures (attempt ${repairAttempts}/${this.maxRepairAttempts})...`,
      });

      const codePrompt = repairAttempts === 0
        ? `Implement the solution for: ${goal}\nPlan:\n${contextGraph.plan}`
        : `Repair the code to fix these test failures:\n${contextGraph.testResults.at(-1)?.output}`;

      const codeResult = await agentRunner("coder", codePrompt, contextGraph);
      if (!codeResult.success) {
        return { success: false, stage: "code", error: codeResult.output, context: contextGraph };
      }
      contextGraph.codeChanges.push(codeResult.output);

      // Tester Step
      onProgress?.({ stage: "test", message: "Tester agent executing verification tests..." });
      const testResult = await agentRunner("tester", `Verify implementation for: ${goal}`, contextGraph);
      contextGraph.testResults.push(testResult);

      if (testResult.success) {
        testPassed = true;
      } else {
        repairAttempts++;
        contextGraph.repairCount = repairAttempts;
        logger.info(`Test failure detected by orchestrator. Initiating repair pass ${repairAttempts}/${this.maxRepairAttempts}`);
      }
    }

    if (!testPassed) {
      return {
        success: false,
        stage: "test",
        error: "Exceeded maximum repair attempts without passing tests.",
        context: contextGraph,
      };
    }

    // Stage 4: Independent Security Reviewer
    onProgress?.({ stage: "review", message: "Security reviewer evaluating changes against security policies..." });
    const reviewResult = await agentRunner("security_reviewer", `Review changes for security compliance and safety:\n${goal}`, contextGraph);
    contextGraph.securityFindings.push(reviewResult);

    if (!reviewResult.success) {
      return {
        success: false,
        stage: "review",
        error: `Security review flagged blockers: ${reviewResult.output}`,
        context: contextGraph,
      };
    }

    // Pipeline Complete
    onProgress?.({ stage: "complete", message: "Autonomous team pipeline completed and verified successfully." });
    return {
      success: true,
      stage: "complete",
      context: contextGraph,
      repairs: repairAttempts,
    };
  }
}

export const agentTeamOrchestrator = new AgentTeamOrchestrator();
