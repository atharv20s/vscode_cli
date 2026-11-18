/**
 * Task Memory System for ATH IDE 3.0
 * 
 * Provides structured, durable memory across turns, restarts, and context resets:
 * 1. User objective and acceptance criteria
 * 2. Architectural decisions & rationale
 * 3. Files changed ledger and their current status
 * 4. Tests executed with actual evidence and outcomes
 * 5. Active failures and unresolved tasks
 * 6. Immediate next action
 * 7. Two-way compression into an Engineering State Document
 */

export class TaskMemory {
  constructor({ objective = "", criteria = [] } = {}) {
    this.objective = objective;
    this.criteria = Array.isArray(criteria) ? [...criteria] : [];
    this.decisions = [];
    this.fileLedger = new Map(); // filePath -> { action, status, timestamp, summary }
    this.testResults = new Map(); // testName -> { passed, output, error, durationMs, timestamp }
    this.activeFailures = new Map(); // issueKey -> { issue, severity, suggestedFix, timestamp }
    this.nextAction = "";
    this.startedAt = Date.now();
    this.checkpointVersion = 1;
  }

  setObjective(objective, criteria = []) {
    if (objective) this.objective = String(objective).trim();
    if (Array.isArray(criteria) && criteria.length) {
      this.criteria = criteria.map(c => String(c).trim());
    }
  }

  recordDecision(decision, rationale = "") {
    if (!decision) return;
    this.decisions.push({
      decision: String(decision).trim(),
      rationale: String(rationale).trim(),
      timestamp: Date.now(),
    });
  }

  recordFileMutation(filePath, { action = "edit", status = "modified", summary = "" } = {}) {
    if (!filePath) return;
    this.fileLedger.set(filePath, {
      action,
      status,
      summary: summary || `${action} applied`,
      updatedAt: Date.now(),
    });
  }

  recordTestResult(testName, { passed = false, output = "", error = "", durationMs = null } = {}) {
    if (!testName) return;
    this.testResults.set(testName, {
      passed: Boolean(passed),
      output: String(output || "").slice(0, 1000),
      error: String(error || "").slice(0, 1000),
      durationMs,
      timestamp: Date.now(),
    });

    if (passed) {
      this.resolveFailure(testName);
    }
  }

  recordFailure(issueKey, { severity = "medium", suggestedFix = "" } = {}) {
    if (!issueKey) return;
    this.activeFailures.set(issueKey, {
      issue: issueKey,
      severity,
      suggestedFix,
      timestamp: Date.now(),
    });
  }

  resolveFailure(issueKey) {
    this.activeFailures.delete(issueKey);
  }

  setNextAction(action) {
    this.nextAction = String(action || "").trim();
  }

  /**
   * Compresses the entire conversational history into a structured Engineering State Document.
   */
  compressToStateDocument() {
    const lines = [
      "# 📌 Engineering State Document",
      `*Checkpoint Version: ${this.checkpointVersion++} | Updated: ${new Date().toISOString()}*`,
      "",
      "## 1. Objective & Acceptance Criteria",
      `- **Goal**: ${this.objective || "No explicit objective set."}`,
    ];

    if (this.criteria.length) {
      lines.push(...this.criteria.map(c => `  - [ ] ${c}`));
    }

    lines.push("", "## 2. Key Architectural Decisions");
    if (this.decisions.length === 0) {
      lines.push("*(No major architectural decisions recorded yet)*");
    } else {
      for (const d of this.decisions) {
        lines.push(`- **Decision**: ${d.decision}`);
        if (d.rationale) lines.push(`  *Rationale*: ${d.rationale}`);
      }
    }

    lines.push("", "## 3. Workspace Mutation Ledger");
    if (this.fileLedger.size === 0) {
      lines.push("*(No files modified yet)*");
    } else {
      for (const [file, item] of this.fileLedger.entries()) {
        lines.push(`- \`${file}\` [${item.action.toUpperCase()} / ${item.status}]: ${item.summary}`);
      }
    }

    lines.push("", "## 4. Test Execution Matrix");
    if (this.testResults.size === 0) {
      lines.push("*(No tests executed yet)*");
    } else {
      for (const [name, t] of this.testResults.entries()) {
        const mark = t.passed ? "✔ PASS" : "✖ FAIL";
        lines.push(`- [${mark}] \`${name}\`${t.durationMs ? ` (${t.durationMs}ms)` : ""}`);
        if (!t.passed && t.error) {
          lines.push(`  *Error trace*: ${t.error.split("\n")[0]}`);
        }
      }
    }

    lines.push("", "## 5. Active Failures & Unresolved Tasks");
    if (this.activeFailures.size === 0) {
      lines.push("*(None — all known checks passing)*");
    } else {
      for (const [key, f] of this.activeFailures.entries()) {
        lines.push(`- [${f.severity.toUpperCase()}] **${key}**`);
        if (f.suggestedFix) lines.push(`  *Suggested repair*: ${f.suggestedFix}`);
      }
    }

    lines.push("", "## 6. Current Next Action");
    lines.push(this.nextAction ? `- ${this.nextAction}` : "*(Awaiting next tool or user command)*");

    return lines.join("\n");
  }

  /**
   * Compact string for system prompt injection (~400-800 tokens).
   */
  formatPromptMemory() {
    const parts = [
      "### Durable Engineering State (Task Memory)",
      `- Objective: ${this.objective || "In progress"}`,
    ];

    if (this.decisions.length) {
      parts.push(`- Key Decisions: ${this.decisions.slice(-3).map(d => d.decision).join("; ")}`);
    }

    if (this.fileLedger.size) {
      parts.push(`- Modified Files: ${Array.from(this.fileLedger.keys()).join(", ")}`);
    }

    const failingTests = Array.from(this.testResults.entries()).filter(([_, r]) => !r.passed);
    if (failingTests.length) {
      parts.push(`- Failing Tests to Repair: ${failingTests.map(([n]) => n).join(", ")}`);
    }

    if (this.nextAction) {
      parts.push(`- Next Action: ${this.nextAction}`);
    }

    return parts.join("\n");
  }
}
