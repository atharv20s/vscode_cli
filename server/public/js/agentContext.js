(function (root) {
  "use strict";
  const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx|keystore))$/i;
  class AgentContextService {
    constructor(editor) { this.editor = editor; this.recentEdits = []; }
    recordRecentEdit(filePath, event, activeEditor) {
      if (SENSITIVE_PATH.test(filePath || "")) return;
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
      const file = this.editor.activeTab;
      const sensitive = SENSITIVE_PATH.test(file || "");
      const selectedText = !sensitive && model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : "";
      const symbols = file && !sensitive ? (this.editor.documentSymbols?.get(file) || []).slice(0, 40).map(item => ({
        name: item.name, kind: item.kind, line: item.line
      })) : [];
      return {
        activeFile: file || null, language: model && root.monaco ? root.monaco.editor.getModelLanguage(model) : null,
        cursor: position ? { line: position.lineNumber, column: position.column } : null,
        selection: !sensitive && selection && !selection.isEmpty() ? {
          startLineNumber: selection.startLineNumber, startColumn: selection.startColumn,
          endLineNumber: selection.endLineNumber, endColumn: selection.endColumn
        } : null,
        selectedText: selectedText.slice(0, 12000), activeContent: !sensitive && model ? model.getValue().slice(0, 12000) : null,
        openFiles: Array.from(this.editor.openTabs.keys()).slice(0, 40),
        recentEdits: this.recentEdits.filter(edit => !SENSITIVE_PATH.test(edit.file || "")).slice(0, 8),
        importedSymbols: symbols
      };
    }
    getSnapshotEditorState() {
      return {
        activeTab: this.editor.activeTab, activeGroup: this.editor.activeGroup || "primary",
        groupTabs: { primary: this.editor.groupTabs?.primary || null, secondary: this.editor.groupTabs?.secondary || null },
        splitRatio: Number.isFinite(this.editor.splitRatio) ? this.editor.splitRatio : 0.5,
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
      const groupTabs = state.groupTabs && typeof state.groupTabs === "object" ? state.groupTabs : {};
      const primary = this.editor.openTabs.has(groupTabs.primary) ? groupTabs.primary : null;
      const secondary = this.editor.openTabs.has(groupTabs.secondary) ? groupTabs.secondary : null;
      if (secondary && !this.editor.secondaryEditor) this.editor.toggleSplitEditor();
      else if (!secondary && this.editor.secondaryEditor) this.editor.toggleSplitEditor();
      this.editor.groupTabs = { primary, secondary };
      if (primary) this.editor.selectTab(primary, "primary");
      if (secondary) this.editor.selectTab(secondary, "secondary");
      const active = state.activeTab && this.editor.openTabs.has(state.activeTab)
        ? state.activeTab : (state.activeGroup === "secondary" ? secondary : primary) || this.editor.openTabs.keys().next().value;
      this.editor.splitRatio = Math.max(0.25, Math.min(0.75, Number(state.splitRatio) || 0.5));
      this.editor.editorView?.parentElement?.style.setProperty("--editor-split-ratio", (this.editor.splitRatio * 100).toFixed(1) + "%");
      if (active) this.editor.selectTab(active, state.activeGroup === "secondary" && this.editor.secondaryEditor ? "secondary" : "primary");
      this.editor.saveStateToCache();
    }
  }
  root.AgentContextService = AgentContextService;
})(window);
