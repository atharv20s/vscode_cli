import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadContextService() {
  const sandbox = { window: { monaco: { editor: { getModelLanguage: () => "plaintext" } } } };
  vm.runInNewContext(fs.readFileSync(new URL("../../public/js/agentContext.js", import.meta.url), "utf8"), sandbox);
  return sandbox.window.AgentContextService;
}

test("ambient context excludes secret-bearing active files and their edit history", () => {
  const AgentContextService = loadContextService();
  const model = { getValue: () => "SECRET=do-not-send", getValueInRange: () => "SECRET=do-not-send" };
  const editor = {
    monacoEditor: { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 1 }),
      getSelection: () => ({ isEmpty: () => false, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 20 }) },
    activeTab: ".env.local", openTabs: new Map([[".env.local", { content: model.getValue() }]]),
    documentSymbols: new Map([[".env.local", [{ name: "SECRET", kind: 1, line: 1 }]]])
  };
  const service = new AgentContextService(editor);
  service.recentEdits.push({ file: ".env.local", inserted: "SECRET=do-not-send" });
  const context = service.getActiveEditorContext();
  assert.equal(context.activeContent, null);
  assert.equal(context.selectedText, "");
  assert.equal(context.selection, null);
  assert.equal(context.importedSymbols.length, 0);
  assert.equal(context.recentEdits.length, 0);
  service.recordRecentEdit(".env.local", { changes: [{ text: "SECRET=again" }] }, { getPosition: () => ({ lineNumber: 1 }) });
  assert.equal(service.recentEdits.length, 1);
  assert.equal(service.recentEdits[0].file, ".env.local");
});

test("ordinary source files retain bounded editor context", () => {
  const AgentContextService = loadContextService();
  const model = { getValue: () => "const answer = 42;", getValueInRange: () => "answer" };
  const editor = {
    monacoEditor: { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 7 }),
      getSelection: () => ({ isEmpty: () => false, startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 13 }) },
    activeTab: "src/app.js", openTabs: new Map([["src/app.js", { content: model.getValue() }]]),
    documentSymbols: new Map([["src/app.js", [{ name: "answer", kind: 13, line: 1 }]]])
  };
  const service = new AgentContextService(editor);
  const context = service.getActiveEditorContext();
  assert.equal(context.activeContent, "const answer = 42;");
  assert.equal(context.selectedText, "answer");
  assert.equal(context.importedSymbols.length, 1);
});
