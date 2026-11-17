(function (root) {
  "use strict";

  function splitLines(value) {
    return String(value ?? "").split("\n");
  }

  function diffLines(originalText, proposedText) {
    const original = splitLines(originalText);
    const proposed = splitLines(proposedText);
    if (original.length === proposed.length && original.every((line, index) => line === proposed[index])) return [];

    const maxCells = 1500000;
    let operations = [];
    if ((original.length + 1) * (proposed.length + 1) <= maxCells) {
      const width = proposed.length + 1;
      const table = new Uint32Array((original.length + 1) * width);
      for (let i = original.length - 1; i >= 0; i--) {
        for (let j = proposed.length - 1; j >= 0; j--) {
          table[i * width + j] = original[i] === proposed[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < original.length || j < proposed.length) {
        if (i < original.length && j < proposed.length && original[i] === proposed[j]) {
          operations.push({ type: "equal", line: original[i] }); i++; j++;
        } else if (i < original.length && (j >= proposed.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
          operations.push({ type: "delete", line: original[i++] });
        } else {
          operations.push({ type: "insert", line: proposed[j++] });
        }
      }
    } else {
      let prefix = 0;
      while (prefix < original.length && prefix < proposed.length && original[prefix] === proposed[prefix]) prefix++;
      let suffix = 0;
      while (suffix < original.length - prefix && suffix < proposed.length - prefix &&
        original[original.length - 1 - suffix] === proposed[proposed.length - 1 - suffix]) suffix++;
      for (let i = 0; i < prefix; i++) operations.push({ type: "equal", line: original[i] });
      for (let i = prefix; i < original.length - suffix; i++) operations.push({ type: "delete", line: original[i] });
      for (let i = prefix; i < proposed.length - suffix; i++) operations.push({ type: "insert", line: proposed[i] });
      for (let i = suffix; i > 0; i--) operations.push({ type: "equal", line: original[original.length - i] });
    }

    const hunks = [];
    let originalIndex = 0;
    let current = null;
    const finish = () => {
      if (!current) return;
      current.originalEnd = originalIndex;
      current.id = "h" + hunks.length + "-" + current.originalStart + "-" + current.originalEnd;
      current.additions = current.replacement.length;
      current.deletions = current.originalLines.length;
      hunks.push(current);
      current = null;
    };

    for (const operation of operations) {
      if (operation.type === "equal") {
        finish();
        originalIndex++;
        continue;
      }
      if (!current) current = { originalStart: originalIndex, originalEnd: originalIndex, originalLines: [], replacement: [] };
      if (operation.type === "delete") {
        current.originalLines.push(operation.line);
        originalIndex++;
      } else {
        current.replacement.push(operation.line);
      }
    }
    finish();
    return hunks;
  }

  function applyHunks(originalText, hunks, selectedIds) {
    const lines = splitLines(originalText);
    const selected = new Set(selectedIds || []);
    const accepted = (hunks || []).filter(hunk => selected.has(hunk.id)).slice().sort((a, b) => b.originalStart - a.originalStart);
    for (const hunk of accepted) {
      lines.splice(hunk.originalStart, hunk.originalEnd - hunk.originalStart, ...hunk.replacement);
    }
    return lines.join("\n");
  }

  root.AgentPatchDiff = { diffLines, applyHunks };
})(typeof window !== "undefined" ? window : globalThis);
