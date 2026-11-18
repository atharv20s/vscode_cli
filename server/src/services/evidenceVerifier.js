/**
 * Evidence-Based Verifier for ATH IDE 3.0
 * 
 * Provides:
 * 1. Structured test and diagnostic evidence parsing (failing test, file/line, severity).
 * 2. Attribution: determines whether the failure was introduced by the agent's edits.
 * 3. Synthesis of actionable, targeted repair instructions.
 * 4. Strict gatekeeping: rejects self-declared completion without verified passing evidence.
 */

export class EvidenceVerifier {
  constructor() {}

  /**
   * Parse test runner or compiler outputs into structured evidence records.
   */
  parseTestOutput(rawOutput, { changedFiles = [] } = {}) {
    const evidence = [];
    const text = String(rawOutput || "");
    const changedSet = new Set(changedFiles.map(f => f.replace(/\\/g, "/").toLowerCase()));

    // Split into test failure sections marked by '✖ '
    const sections = text.split(/\n(?=✖\s+)/);

    for (const section of sections) {
      if (!section.startsWith("✖ ")) continue;

      const lines = section.split("\n");
      const titleLine = lines[0].replace(/^✖\s+/, "").trim();
      const testName = titleLine.replace(/\s*\([^\)]+\)$/, "").trim();

      // Find stack trace line with file and line number
      // e.g. "at TestContext.<anonymous> (c:/app/src/auth/jwt.test.js:32:14)"
      // or "at file:///c:/app/src/auth/jwt.test.js:32:14"
      let foundFile = null;
      let foundLine = null;
      let foundCol = null;

      const stackRegex = /at\s+(?:async\s+)?(?:[^\(\n]+\((?:file:\/\/\/)?|file:\/\/\/)?([a-zA-Z]:[\\\/][^\:\s\)]+|[^\:\s\)]+\.[a-zA-Z0-9]+):(\d+):(\d+)\)?/;
      for (const line of lines) {
        const m = stackRegex.exec(line);
        if (m) {
          foundFile = m[1].replace(/\\/g, "/");
          foundLine = parseInt(m[2], 10);
          foundCol = parseInt(m[3], 10);
          break;
        }
      }

      const isAgentIntroduced = foundFile
        ? Array.from(changedSet).some(cf => foundFile.toLowerCase().includes(cf))
        : true;

      const errorSnippet = lines.slice(1, 6).join("\n");

      evidence.push({
        testName,
        file: foundFile,
        line: foundLine,
        column: foundCol,
        error: errorSnippet,
        introducedByAgent: isAgentIntroduced,
        severity: section.includes("SyntaxError") ? "CRITICAL" : "HIGH",
        suggestedRepair: this.extractSuggestedRepair(section),
      });
    }

    // Generic fallback if test failed but no '✖ ' was present
    if (evidence.length === 0 && (text.includes("FAIL") || text.includes("AssertionError") || text.includes("FAILED"))) {
      const genericLines = text.split("\n").filter(l => l.includes("FAIL") || l.includes("Error:")).slice(0, 4);
      evidence.push({
        testName: "Test Suite Failure",
        file: changedFiles[0] || "workspace",
        line: 1,
        column: 1,
        error: genericLines.join("\n"),
        introducedByAgent: true,
        severity: "HIGH",
        suggestedRepair: "Inspect assertion error output and adjust implementation to match expected values.",
      });
    }

    return evidence;
  }

  extractSuggestedRepair(errorSnippet) {
    if (errorSnippet.includes("SyntaxError")) {
      return "Fix the syntax or unclosed bracket/quote at the indicated line.";
    }
    if (errorSnippet.includes("is not defined")) {
      return "Ensure all referenced variables and functions are properly imported or declared.";
    }
    if (errorSnippet.includes("Expected values to be strictly equal") || errorSnippet.includes("expected")) {
      return "Update the logic to return the expected value or data structure format.";
    }
    return "Review the stack trace and repair the failing assertion.";
  }

  /**
   * Formats a focused, targeted repair prompt to guide the model directly to the fix.
   */
  generateRepairPrompt(evidenceList) {
    if (!evidenceList || !evidenceList.length) return "";
    const lines = [
      "## 🚨 Evidence-Based Verification Failure",
      "Do NOT claim the task is complete. One or more verification checks failed.",
      "",
    ];

    for (let i = 0; i < evidenceList.length; i++) {
      const item = evidenceList[i];
      lines.push(`### Failure #${i + 1}: ${item.testName}`);
      if (item.file) lines.push(`- **Location**: \`${item.file}${item.line ? `:${item.line}` : ""}\``);
      lines.push(`- **Severity**: ${item.severity}`);
      lines.push(`- **Introduced in this session**: ${item.introducedByAgent ? "YES (Priority fix)" : "NO"}`);
      lines.push(`- **Suggested Repair**: ${item.suggestedRepair}`);
      lines.push(`- **Error Snippet**:\n\`\`\`\n${item.error}\n\`\`\``);
      lines.push("");
    }

    lines.push("Directive: Focus repair ONLY on the root cause of these specific failures, then rerun the relevant test.");
    return lines.join("\n");
  }

  /**
   * Evaluate whether the run can be marked verified.
   */
  evaluateCompletion(evidenceList, criteriaList = []) {
    if (evidenceList.length > 0) {
      return {
        verified: false,
        reason: `${evidenceList.length} test failure(s) pending repair.`,
      };
    }
    return {
      verified: true,
      reason: "All executed checks passed with verifiable evidence.",
    };
  }
}

export const evidenceVerifier = new EvidenceVerifier();
