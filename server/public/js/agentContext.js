(function (root) {
  "use strict";
  class AgentContextService {
    constructor(editor) { this.editor = editor; this.recentEdits = []; }
    recordRecentEdit(filePath, event, activeEditor) {
      const change = event?.changes?.[0];
      const position = change?.range?.startLineNumber || activeEditor.getPosition()?.lineNumber || 1;
      this.recentEdits.unshift({
        file: filePath, line: position, inserted: String(change?.text || "").slice(0, 120),
        removedLength: Number(change?.rangeLength || 0), at: Date.now()
      });
      this.recentEdits = this.recentEdits.slice(0, 12);
    }
    getActiveEditorContext() {
      const editor = this.editor.monacoEditor, model = editor?.getModel();
      const position = editor?.getPosition(), selection = editor?.getSelection();
      const sensitive = /(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx|keystore))$/i.test(this.editor.activeTab || "");
      const selectedText = !sensitive && model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : "";
      const file = this.editor.activeTab;
      const symbols = file ? (this.editor.documentSymbols?.get(file) || []).slice(0, 40).map(item => ({
        name: item.name, kind: item.kind, line: item.line
      })) : [];
      return {
        activeFile: file || null, language: model && root.monaco ? root.monaco.editor.getModelLanguage(model) : null,
        cursor: position ? { line: position.lineNumber, column: position.column } : null,
        selection: selection && !selection.isEmpty() ? {
          startLineNumber: selection.startLineNumber, startColumn: selection.startColumn,
          endLineNumber: selection.endLineNumber, endColumn: selection.endColumn
        } : null,
        selectedText: selectedText.slice(0, 12000), activeContent: !sensitive && model ? model.getValue().slice(0, 12000) : null,
        openFiles: Array.from(this.editor.openTabs.keys()).slice(0, 40),
        recentEdits: this.recentEdits.slice(0, 8), importedSymbols: symbols
      };
    }
    getSnapshotEditorState() {
      return {
        activeTab: this.editor.activeTab, activeGroup: this.editor.activeGroup || "primary",
        tabs: Array.from(this.editor.openTabs.entries()).slice(0, 40).map(([filePath, tab]) => ({
          path: filePath, content: tab.content || "", version: tab.version || null, isDirty: tab.isDirty === true
        }))
      };
    }
    restoreSnapshotEditorState(state) {
      if (!state || !Array.isArray(state.tabs)) return;
      this.editor.primaryEditor?.setModel(null);
      this.editor.secondaryEditor?.setModel(null);
      for (const filePath of this.editor.openTabs.keys()) {
        const uriValue = this.editor.lspRootUri ? this.editor.lspRootUri + filePath.split("/").map(encodeURIComponent).join("/") : "file:///" + filePath.split("/").map(encodeURIComponent).join("/");
        const uri = root.monaco?.Uri?.parse(uriValue);
        if (uri) root.monaco.editor.getModel(uri)?.dispose();
      }
      this.editor.groupTabs = { primary: null, secondary: null };
      this.editor.openTabs.clear(); this.editor.tabsContainer?.replaceChildren();
      state.tabs.slice(0, 40).forEach(tab => {
        this.editor.openTabs.set(tab.path, {
          content: tab.content || "", version: tab.version || null,
          isDirty: tab.isDirty === true, language: this.editor.detectLanguage(tab.path)
        });
        this.editor.createTabElement(tab.path);
      });
      const active = state.activeTab && this.editor.openTabs.has(state.activeTab)
        ? state.activeTab : this.editor.openTabs.keys().next().value;
      if (active) this.editor.selectTab(active, state.activeGroup === "secondary" ? "secondary" : "primary");
      this.editor.saveStateToCache();
    }
  }
  root.AgentContextService = AgentContextService;
})(window);
