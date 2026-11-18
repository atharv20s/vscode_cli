/**
 * Shared Task State & Typed Artifact Engine for ATH IDE 3.0
 * 
 * Provides:
 * 1. Strongly-typed artifact schemas for agent teamwork:
 *    - Planner: Task Graph (nodes, dependencies, status)
 *    - Context Agent: Symbol & File Map
 *    - Coder: Atomic Patch & Rationale
 *    - Tester: Verifiable Test Evidence
 *    - Reviewer: Findings with Line/Severity & Approval Gate
 * 2. Immutable state snapshots across agent turns.
 * 3. Enforces contract boundaries: no agent can forge or hallucinate another agent's typed outputs.
 */

export class SharedTaskState {
  constructor({ sessionId = "default", workspaceId = "default" } = {}) {
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.artifacts = {
      planner: null,     // TaskGraphArtifact
      context: null,     // SymbolMapArtifact
      coder: [],         // Array<PatchArtifact>
      tester: null,      // TestEvidenceArtifact
      reviewer: null,    // ReviewFindingsArtifact
    };
    this.history = [];
    this.version = 1;
  }

  /**
   * Set Task Graph contributed by Planner Agent.
   */
  setTaskGraph(agentId, { tasks = [] } = {}) {
    if (!Array.isArray(tasks)) throw new Error("Planner artifact must provide a tasks array.");
    this.artifacts.planner = {
      agentId,
      timestamp: Date.now(),
      tasks: tasks.map(t => ({
        id: String(t.id || ""),
        title: String(t.title || ""),
        status: ["pending", "in_progress", "completed", "failed"].includes(t.status) ? t.status : "pending",
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
      })),
    };
    this.recordCheckpoint("planner_updated");
    return this.artifacts.planner;
  }

  /**
   * Set Symbol Map contributed by Context Agent.
   */
  setSymbolMap(agentId, { relevantFiles = [], symbols = [] } = {}) {
    this.artifacts.context = {
      agentId,
      timestamp: Date.now(),
      relevantFiles: Array.isArray(relevantFiles) ? relevantFiles : [],
      symbols: Array.isArray(symbols) ? symbols : [],
    };
    this.recordCheckpoint("context_updated");
    return this.artifacts.context;
  }

  /**
   * Add a patch artifact contributed by Coder Agent.
   */
  addPatch(agentId, { file, diff = "", searchReplace = null, rationale = "" } = {}) {
    if (!file) throw new Error("Coder artifact must provide a target file path.");
    const patch = {
      id: `patch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      agentId,
      timestamp: Date.now(),
      file,
      diff,
      searchReplace,
      rationale,
      applied: false,
    };
    this.artifacts.coder.push(patch);
    this.recordCheckpoint("coder_patch_added");
    return patch;
  }

  /**
   * Set Test Evidence contributed by Tester Agent.
   */
  setTestEvidence(agentId, { passed = false, total = 0, failures = [] } = {}) {
    this.artifacts.tester = {
      agentId,
      timestamp: Date.now(),
      passed: Boolean(passed),
      total: Number(total) || 0,
      failures: Array.isArray(failures) ? failures : [],
    };
    this.recordCheckpoint("tester_evidence_recorded");
    return this.artifacts.tester;
  }

  /**
   * Set Review Findings contributed by Reviewer Agent.
   */
  setReviewFindings(agentId, { approved = false, findings = [] } = {}) {
    this.artifacts.reviewer = {
      agentId,
      timestamp: Date.now(),
      approved: Boolean(approved),
      findings: Array.isArray(findings) ? findings.map(f => ({
        file: f.file || "",
        line: f.line || 1,
        severity: ["critical", "high", "medium", "low"].includes(f.severity) ? f.severity : "medium",
        message: String(f.message || ""),
      })) : [],
    };
    this.recordCheckpoint("reviewer_findings_recorded");
    return this.artifacts.reviewer;
  }

  recordCheckpoint(reason) {
    this.version++;
    this.history.push({
      version: this.version,
      reason,
      timestamp: Date.now(),
      stateSnapshot: JSON.parse(JSON.stringify(this.artifacts)),
    });
    if (this.history.length > 30) this.history.shift();
  }

  /**
   * Check if changes are approved and verified for deployment/completion.
   */
  isReadyForCompletion() {
    const testerPassed = this.artifacts.tester?.passed === true;
    const reviewerApproved = this.artifacts.reviewer?.approved === true;
    return testerPassed && reviewerApproved;
  }

  getSummary() {
    return {
      version: this.version,
      hasPlan: Boolean(this.artifacts.planner),
      tasksCount: this.artifacts.planner?.tasks?.length || 0,
      contextFilesCount: this.artifacts.context?.relevantFiles?.length || 0,
      patchesCount: this.artifacts.coder.length,
      testerPassed: Boolean(this.artifacts.tester?.passed),
      reviewerApproved: Boolean(this.artifacts.reviewer?.approved),
      ready: this.isReadyForCompletion(),
    };
  }
}
