/**
 * Monaco-backed editor and multi-tab workspace manager.
 * Keeps the existing workspace file API, optimistic versions and collaboration hooks.
 */
class EditorManager {
  constructor() {
    this.openTabs = new Map();
    this.activeTab = null;
    this.tabsContainer = document.getElementById("tabs-container");
    this.welcomeScreen = document.getElementById("editor-welcome");
    this.editorView = document.getElementById("code-editor-view");
    this.saveBtn = document.getElementById("btn-save-file");
    this.monacoEditor = null;
    this.monacoReady = false;
    this.pendingModel = null;
    this.gitDecorationIds = new Map();
    this.gitDiffEditor = null;
    this.gitDiffOverlay = null;
    this.gitDiffSideBySide = true;
    this.splitRatio = 0.5;
    this.splitSash = null;
    this.agentApplyOverlay = null;
    this.agentApplyDiffEditor = null;
    this.agentApplyDiffModels = [];
    this.agentApplyFiles = [];
    this.agentApplySelectedPath = null;
    this.agentApplyReady = false;
    this.agentApplyAcceptedPaths = new Set();
    this.agentApplyViewZoneId = null;
    this.agentApplyZoneEditor = null;
    this.agentApplyDecorations = null;
    this.agentApplyHunkZoneIds = [];
    this.agentApplyHunkStates = new Map();
    this.agentApplyHunkOverrides = new Map();
    this.agentApplyHunks = [];
    this.agentApplySelectedHunkId = null;
    this.contextService = window.AgentContextService ? new window.AgentContextService(this) : null;
    this.inlineEditRequest = null;
    this.inlineCompletionLastRequestAt = 0;
    this.lspPending = new Map();
    this.lspChangeTimers = new Map();
    this.lspRequestId = 1;
    this.lspRootUri = null;
    this.lspLanguage = null;
    this.suppressModelChange = false;
    this.initEventListeners();
    this.initInlineEditListeners();
    this.restoreStateFromCache();
    this.loadMonaco();
  }

  loadMonaco() {
    if (!this.editorView) return;
    if (typeof window.require !== "function") {
      this.showEditorError("Monaco loader did not load. Check your network/CDN access.");
      return;
    }
    window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs" } });
    window.MonacoEnvironment = {
      getWorkerUrl: function () {
        const code = "self.MonacoEnvironment={baseUrl:'https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/'};importScripts('https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs/base/worker/workerMain.js');";
        return "data:text/javascript;charset=utf-8," + encodeURIComponent(code);
      }
    };
    window.require(["vs/editor/editor.main"], () => {
      this.monacoEditor = monaco.editor.create(this.editorView, {
        value: "",
        language: "plaintext",
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: true },
        glyphMargin: true,
        fontFamily: "'Fira Code', Consolas, monospace",
        fontSize: 13,
        fontLigatures: true,
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: true,
        autoIndent: "full",
        formatOnPaste: true,
        formatOnType: true,
        bracketPairColorization: { enabled: true },
        guides: { indentation: true, bracketPairs: true },
        folding: true,
        foldingHighlight: true,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        renderWhitespace: "selection",
        wordWrap: "off",
        scrollBeyondLastLine: false,
        stickyScroll: { enabled: true },
        padding: { top: 12, bottom: 12 },
        suggest: { showWords: true, preview: true },
        quickSuggestions: true,
        inlineSuggest: { enabled: true },
        parameterHints: { enabled: true },
        hover: { enabled: true },
        links: true,
        mouseWheelZoom: true
      });

      const symbolLanguages = ["javascript", "typescript", "python", "rust", "go", "java"];
      const symbolHeaders = () => ({ Authorization: "Bearer " + (localStorage.getItem("token") || "") });
      const activeFileForModel = model => decodeURIComponent(String(model?.uri?.path || "").replace(/^\//, "")) || this.activeTab;
      const symbolRequest = async (endpoint, model, position) => {
        const word = model.getWordAtPosition(position);
        const file = activeFileForModel(model);
        if (!word || !file) return null;
        const params = new URLSearchParams({ file, symbol: word.word, line: String(position.lineNumber) });
        const response = await fetch("/api/workspace/symbols/" + endpoint + "?" + params.toString(), { headers: symbolHeaders() });
        if (!response.ok) return null;
        return response.json();
      };
      symbolLanguages.forEach(language => {
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (model, position) => {
            const data = await symbolRequest("definition", model, position);
            if (!data?.definition) return null;
            const definition = data.definition;
            const uri = monaco.Uri.parse("file:///" + String(definition.file).split("/").map(encodeURIComponent).join("/"));
            const line = Math.max(1, Number(definition.line) || 1);
            const column = Math.max(1, Number(definition.col) || 1);
            return { uri, range: new monaco.Range(line, column, line, column + String(data.symbol || "").length) };
          }
        });
        monaco.languages.registerHoverProvider(language, {
          provideHover: async (model, position) => {
            const data = await symbolRequest("hover", model, position);
            if (!data?.hover) return null;
            const item = data.hover;
            return {
              range: model.getWordAtPosition(position),
              contents: [
                { value: "**" + String(item.name || "") + "** (" + String(item.kind || "symbol") + ")" },
                { value: "Signature: " + String(item.signature || item.name || "").slice(0, 240) },
                { value: String(item.file || "") + ":" + String(item.line || "") }
              ]
            };
          }
        });
      });
      this.monacoReady = true;
      this.initLspProviders();
      this.initInlineCompletionProvider();
      if (this.pendingModel) this.selectTab(this.pendingModel);
      window.dispatchEvent(new CustomEvent("ath:monaco-ready"));
    }, (error) => this.showEditorError("Monaco failed to initialize: " + (error?.message || error)));
  }


  initLspProviders() {
    if (this.lspProvidersRegistered || !window.wsClient) return;
    this.lspProvidersRegistered = true;
    window.wsClient.on("lsp.message", message => {
      if (message?.method && message.id !== undefined) {
        const result = message.method === "workspace/workspaceFolders"
          ? [{ uri: this.lspRootUri, name: "workspace" }]
          : message.method === "workspace/configuration" ? (message.params?.items || []).map(() => null) : null;
        window.wsClient.send("lsp.message", { message: { jsonrpc: "2.0", id: message.id, result } });
        return;
      }
      if (message?.id !== undefined && this.lspPending.has(message.id)) {
        const pending = this.lspPending.get(message.id);
        clearTimeout(pending.timer);
        this.lspPending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "LSP request failed"));
        else pending.resolve(message.result);
        return;
      }
      if (message?.method === "textDocument/publishDiagnostics") {
        const params = message.params || {};
        const uri = monaco.Uri.parse(params.uri || "");
        const model = monaco.editor.getModel(uri);
        if (model) monaco.editor.setModelMarkers(model, "LSP", (params.diagnostics || []).map(item => ({
          severity: item.severity === 1 ? monaco.MarkerSeverity.Error : item.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
          message: String(item.message || "").slice(0, 2000),
          startLineNumber: Math.max(1, item.range?.start?.line + 1 || 1),
          startColumn: Math.max(1, item.range?.start?.character + 1 || 1),
          endLineNumber: Math.max(1, item.range?.end?.line + 1 || 1),
          endColumn: Math.max(1, item.range?.end?.character + 1 || 1),
          source: item.source || "LSP"
        })));
      }
    });
    window.wsClient.on("lsp.started", info => {
      this.lspLanguage = info.language;
      this.lspRootUri = info.rootUri;
      const id = this.lspRequestId++;
      this.lspRequest("initialize", {
        processId: null,
        rootUri: info.rootUri,
        capabilities: {
          textDocument: {
            completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            publishDiagnostics: { relatedInformation: true }
          },
          workspace: { configuration: true, workspaceFolders: true }
        },
        workspaceFolders: [{ uri: info.rootUri, name: "workspace" }]
      }, id).then(() => {
        window.wsClient.send("lsp.message", { message: { jsonrpc: "2.0", method: "initialized", params: {} } });
        if (this.activeTab) this.selectTab(this.activeTab);
      }).catch(error => window.app?.logTerminal("LSP initialize failed: " + error.message, "warning"));
    });
    window.wsClient.on("lsp.error", error => {
      this.lspLanguage = null; this.lspRootUri = null;
      window.app?.logTerminal("LSP: " + (error?.message || "language server error"), "warning");
    });
    const languages = ["typescript", "javascript", "python"];
    languages.forEach(language => {
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", '"', "'", "/", "@", "<"],
        provideCompletionItems: async (model, position) => {
          const result = await this.lspRequest("textDocument/completion", {
            textDocument: { uri: this.lspUriForModel(model) },
            position: { line: position.lineNumber - 1, character: position.column - 1 }
          });
          const items = Array.isArray(result) ? result : (result?.items || []);
          return { suggestions: items.map(item => ({
            label: item.label,
            kind: item.kind || monaco.languages.CompletionItemKind.Text,
            insertText: item.insertText || item.label,
            insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            detail: item.detail,
            documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
            sortText: item.sortText,
            filterText: item.filterText
          })) };
        }
      });
      monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position) => {
          const result = await this.lspRequest("textDocument/hover", {
            textDocument: { uri: this.lspUriForModel(model) },
            position: { line: position.lineNumber - 1, character: position.column - 1 }
          });
          if (!result?.contents) return null;
          const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
          return { contents: contents.map(item => ({ value: typeof item === "string" ? item : item.value || item.language || "" })) };
        }
      });
      monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (model, position) => {
          const result = await this.lspRequest("textDocument/definition", {
            textDocument: { uri: this.lspUriForModel(model) },
            position: { line: position.lineNumber - 1, character: position.column - 1 }
          });
          const locations = Array.isArray(result) ? result : (result ? [result] : []);
          return locations.map(location => {
            const range = location.range || location.targetSelectionRange || location.targetRange;
            return { uri: monaco.Uri.parse(location.uri || location.targetUri), range: new monaco.Range(
              range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1
            ) };
          });
        }
      });
    });
  }

  lspRequest(method, params, requestId = null) {
    if (!window.wsClient) return Promise.reject(new Error("Workspace WebSocket is unavailable."));
    if (method !== "initialize" && !this.lspRootUri) return Promise.reject(new Error("Language server is not initialized."));
    const id = requestId ?? this.lspRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lspPending.delete(id);
        reject(new Error("Language server request timed out."));
      }, 12000);
      this.lspPending.set(id, { resolve, reject, timer });
      window.wsClient.send("lsp.message", { message: { jsonrpc: "2.0", id, method, params } });
    });
  }

  lspUriForModel(model) {
    return model.uri.toString();
  }

  ensureLspForFile(filePath, tab) {
    const extension = String(filePath).toLowerCase().split(".").pop();
    const language = ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension) ? "typescript"
      : ["py", "pyi"].includes(extension) ? "python" : null;
    if (!language || !window.wsClient) return;
    if (this.lspLanguage !== language) {
      this.lspLanguage = language;
      this.lspRootUri = null;
      window.wsClient.send("lsp.start", { language });
      return;
    }
    this.openLspDocument(filePath, tab);
  }

  openLspDocument(filePath, tab = this.openTabs.get(filePath)) {
    if (!filePath || !tab || !this.lspRootUri || !this.lspLanguage) return;
    const extension = filePath.toLowerCase().split(".").pop();
    const language = ["py", "pyi"].includes(extension) ? "python" : "typescript";
    if (language !== this.lspLanguage) return;
    window.wsClient.send("lsp.message", { message: {
      jsonrpc: "2.0", method: "textDocument/didOpen",
      params: { textDocument: { uri: this.lspRootUri + filePath.split("/").map(encodeURIComponent).join("/"),
        languageId: language === "python" ? "python" : (["ts", "tsx"].includes(extension) ? "typescript" : "javascript"),
        version: 1, text: tab.content || "" } }
    } });
  }

  notifyLspDidChange(filePath, editor) {
    if (!this.lspRootUri || !this.lspLanguage || !filePath || !editor?.getModel()) return;
    const extension = filePath.toLowerCase().split(".").pop();
    const language = ["py", "pyi"].includes(extension) ? "python" : "typescript";
    if (language !== this.lspLanguage) return;
    clearTimeout(this.lspChangeTimers.get(filePath));
    const timer = setTimeout(() => {
      this.lspChangeTimers.delete(filePath);
      window.wsClient?.send("lsp.message", { message: {
        jsonrpc: "2.0", method: "textDocument/didChange",
        params: { textDocument: { uri: this.lspRootUri + filePath.split("/").map(encodeURIComponent).join("/"), version: Date.now() },
          contentChanges: [{ text: editor.getValue() }] }
      } });
    }, 250);
    this.lspChangeTimers.set(filePath, timer);
  }


  recordRecentEdit(filePath, event, editor) {
    this.contextService?.recordRecentEdit(filePath, event, editor);
  }

  getActiveEditorContext() {
    return this.contextService?.getActiveEditorContext() || {};
  }

  getSnapshotEditorState() {
    return this.contextService?.getSnapshotEditorState() || { activeTab: null, tabs: [] };
  }

  restoreSnapshotEditorState(state) {
    this.contextService?.restoreSnapshotEditorState(state);
  }

  initInlineCompletionProvider() {
    if (this.inlineCompletionProviderRegistered || !monaco.languages.registerInlineCompletionsProvider) return;
    this.inlineCompletionProviderRegistered = true;
    ["javascript", "typescript", "python", "javascriptreact", "typescriptreact", "go", "rust"].forEach(language => {
      monaco.languages.registerInlineCompletionsProvider(language, {
        provideInlineCompletions: async (model, position, _context, token) => {
          const now = Date.now();
          if (now - this.inlineCompletionLastRequestAt < 450 || model.getValueLength() > 120000) return { items: [] };
          const file = this.activeTab;
          if (!file || model !== this.monacoEditor?.getModel()) return { items: [] };
          this.inlineCompletionLastRequestAt = now;
          const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
          const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, model.getLineCount(), model.getLineMaxColumn(model.getLineCount())));
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          try {
            const response = await fetch("/api/workspace/inline-completion", {
              method: "POST", signal: controller.signal,
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.getItem("token") || "") },
              body: JSON.stringify({ file, language, prefix: prefix.slice(-12000), suffix: suffix.slice(0, 6000) })
            });
            if (!response.ok || token.isCancellationRequested) return { items: [] };
            const data = await response.json();
            if (data.latencyMs) window.app?.recordCompletionLatency?.(data.latencyMs, data.p50Ms, data.p95Ms);
            const insertText = String(data.completion || "");
            if (!insertText.trim()) return { items: [] };
            return { items: [{ insertText, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
          } catch { return { items: [] }; }
        },
        freeInlineCompletions() {}
      });
    });
  }

  initInlineEditListeners() {
    if (!window.wsClient || this.inlineEditListenersReady) return;
    this.inlineEditListenersReady = true;
    window.wsClient.on("inline.edit.started", data => {
      if (this.inlineEditRequest?.requestId !== data?.requestId) return;
      this.inlineEditRequest.output = "";
      this.inlineEditRequest.status.textContent = "Generating focused edit…";
      window.app?.transitionAgentState?.("editing", { source: "inline-edit" });
    });
    window.wsClient.on("inline.edit.delta", data => {
      if (this.inlineEditRequest?.requestId !== data?.requestId) return;
      this.inlineEditRequest.output += data.content || "";
      this.inlineEditRequest.preview.value = this.inlineEditRequest.output;
    });
    window.wsClient.on("inline.edit.complete", data => {
      if (this.inlineEditRequest?.requestId !== data?.requestId) return;
      let replacement = String(data.replacement || "");
      const fence = String.fromCharCode(96).repeat(3);
      if (replacement.trimStart().startsWith(fence) && replacement.trimEnd().endsWith(fence)) {
        const trimmed = replacement.trim();
        const firstNewline = trimmed.indexOf("\n");
        replacement = firstNewline >= 0 ? trimmed.slice(firstNewline + 1, -3).replace(/\n$/, "") : trimmed.slice(3, -3);
      }
      this.inlineEditRequest.output = replacement;
      this.inlineEditRequest.preview.value = replacement;
      this.inlineEditRequest.preview.readOnly = false;
      this.inlineEditRequest.status.textContent = "Review the replacement. You can edit it before accepting.";
      this.inlineEditRequest.accept.disabled = false;
      this.inlineEditRequest.openComposer.disabled = false;
      window.app?.transitionAgentState?.("awaiting_approval", { source: "inline-edit" });
    });
    window.wsClient.on("inline.edit.error", data => {
      if (this.inlineEditRequest?.requestId !== data?.requestId) return;
      this.inlineEditRequest.status.textContent = data.message || "Inline Edit failed.";
      this.inlineEditRequest.accept.disabled = true;
      this.inlineEditRequest.preview.readOnly = false;
      window.app?.transitionAgentState?.("idle", { source: "inline-edit-error" });
    });
  }

  openInlineEdit() {
    const editor = this.monacoEditor, model = editor?.getModel();
    if (!editor || !model || !this.activeTab) { window.app?.logTerminal("Open a file before using Inline Edit.", "warning"); return; }
    if (window.app?.isGenerating) { window.app?.logTerminal("Wait for the current Composer run to finish before starting Inline Edit.", "warning"); return; }
    this.closeInlineEdit();
    const filePath = this.activeTab;
    const openedModelVersion = model.getVersionId();
    const selection = editor.getSelection();
    const hasSelection = Boolean(selection && !selection.isEmpty());
    const selectedText = hasSelection ? model.getValueInRange(selection) : "";
    const range = hasSelection ? selection : new monaco.Range(1, 1, model.getLineCount(), model.getLineMaxColumn(model.getLineCount()));
    const panel = document.createElement("section");
    panel.className = "ath-inline-edit"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Inline Edit");
    const header = document.createElement("div"); header.className = "ath-inline-edit-header";
    const title = document.createElement("strong"); title.textContent = "Inline Edit · " + filePath;
    const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close Inline Edit");
    close.addEventListener("click", () => this.closeInlineEdit()); header.append(title, close);
    const instruction = document.createElement("textarea"); instruction.rows = 2;
    instruction.placeholder = hasSelection ? "What should change in the selection?" : "What should change in this file?";
    instruction.setAttribute("aria-label", "Inline edit instruction");
    const preview = document.createElement("textarea"); preview.rows = 9; preview.className = "ath-inline-edit-preview";
    preview.placeholder = "The proposed replacement will stream here…"; preview.readOnly = true; preview.setAttribute("aria-label", "Proposed code replacement");
    const status = document.createElement("div"); status.className = "ath-inline-edit-status";
    status.textContent = hasSelection ? "Selected code will be replaced." : "The complete file will be replaced.";
    const actions = document.createElement("div"); actions.className = "ath-inline-edit-actions";
    const send = document.createElement("button"); send.type = "button"; send.className = "primary-btn"; send.textContent = "Generate";
    const accept = document.createElement("button"); accept.type = "button"; accept.className = "primary-btn"; accept.textContent = "Accept"; accept.disabled = true;
    const openComposer = document.createElement("button"); openComposer.type = "button"; openComposer.className = "secondary-btn"; openComposer.textContent = "Open in Composer"; openComposer.disabled = true;
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary-btn"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { if (this.inlineEditRequest) window.wsClient?.send("inline.edit.cancel", { requestId: this.inlineEditRequest.requestId }); this.closeInlineEdit(); });
    send.addEventListener("click", () => {
      const request = instruction.value.trim();
      if (!request) { status.textContent = "Describe the change first."; instruction.focus(); return; }
      if (this.activeTab !== filePath || this.monacoEditor?.getModel() !== model || model.getVersionId() !== openedModelVersion) {
        status.textContent = "The active file or buffer changed while this prompt was open. Close Inline Edit and reopen it.";
        return;
      }
      const requestId = "ie_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const cursor = editor.getPosition(), tab = this.openTabs.get(filePath);
      this.inlineEditRequest = { requestId, filePath, model, modelVersion: openedModelVersion, range,
        hasSelection, selectedText, instruction: request, output: "", preview, status, accept, openComposer };
      preview.value = ""; preview.readOnly = true; accept.disabled = true; openComposer.disabled = true;
      status.textContent = "Connecting to the focused edit model…";
      window.app?.transitionAgentState?.("planning", { source: "inline-edit" });
      if (!window.wsClient?.isConnected) window.wsClient?.connect(localStorage.getItem("token") || "");
      window.wsClient?.send("inline.edit", {
        requestId, filePath, instruction: request, content: model.getValue(), selectedText,
        expectedVersion: tab?.version || null, language: monaco.editor.getModelLanguage(model),
        selection: hasSelection ? { startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.endLineNumber, endColumn: range.endColumn } : null,
        cursor: cursor ? { line: cursor.lineNumber, column: cursor.column } : null
      });
    });
    accept.addEventListener("click", () => this.acceptInlineEdit());
    openComposer.addEventListener("click", () => {
      const composer = document.getElementById("composer-input");
      if (composer && this.inlineEditRequest) {
        composer.value = "Continue this focused edit as a broader Composer task.\nFile: " + this.inlineEditRequest.filePath +
          "\nInstruction: " + this.inlineEditRequest.instruction + "\nCurrent editor context:\n" + JSON.stringify(this.getActiveEditorContext(), null, 2);
        composer.focus();
      }
      this.closeInlineEdit();
    });
    actions.append(send, accept, openComposer, cancel); panel.append(header, instruction, preview, status, actions);
    this.editorView?.appendChild(panel); instruction.focus(); this.inlineEditPanel = panel;
  }

  acceptInlineEdit() {
    const request = this.inlineEditRequest;
    if (!request || request.model.isDisposed() || this.activeTab !== request.filePath || this.monacoEditor?.getModel() !== request.model || request.model.getVersionId() !== request.modelVersion) {
      if (request) request.status.textContent = "The editor changed while the edit was generating. Regenerate against the latest buffer.";
      return;
    }
    request.model.pushEditOperations([], [{ range: request.range, text: request.preview.value, forceMoveMarkers: true }], () => null);
    const tab = this.openTabs.get(request.filePath);
    if (tab) { tab.content = request.model.getValue(); tab.isDirty = true; this.updateTabUI(request.filePath); }
    this.saveStateToCache(); this.closeInlineEdit();
    window.app?.transitionAgentState?.("idle", { source: "inline-edit-accepted" });
    window.app?.logTerminal("Inline edit accepted into the editor buffer. Save the file to persist it.", "success");
  }

  closeInlineEdit() {
    if (this.inlineEditRequest) {
      const pending = this.inlineEditRequest;
      if (pending.status?.textContent?.includes("Generating") || pending.status?.textContent?.includes("Connecting")) {
        window.wsClient?.send("inline.edit.cancel", { requestId: pending.requestId });
      }
    }
    this.inlineEditPanel?.remove(); this.inlineEditPanel = null; this.inlineEditRequest = null;
    window.app?.transitionAgentState?.("idle", { source: "inline-edit-closed" });
  }

  attachEditorGroup(editor, group) {
    editor.onDidChangeModelContent(event => {
      const filePath = this.groupTabs[group];
      if (this.suppressModelChange || !filePath || !this.openTabs.has(filePath)) return;
      const tab = this.openTabs.get(filePath);
      tab.content = editor.getValue();
      tab.isDirty = true;
      this.recordRecentEdit(filePath, event, editor);
      this.updateTabUI(filePath);
      this.saveStateToCache();
      this.scheduleDiagnostics(filePath, editor);
      this.notifyLspDidChange(filePath, editor);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { this.activateGroup(group); this.saveCurrentFile(); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => editor.getAction("actions.find").run());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => this.openWorkspaceSearch());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => this.openQuickOpen());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => { this.activateGroup(group); this.openInlineEdit(); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
      const input = document.getElementById("composer-input");
      if (input) { input.focus(); }
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => this.openCommandPalette());
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyUp, () => editor.getAction("editor.action.moveLinesUpAction").run());
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyDown, () => editor.getAction("editor.action.moveLinesDownAction").run());
    editor.onDidFocusEditorText(() => this.activateGroup(group));
    editor.onDidChangeCursorPosition(event => this.updateSymbolBreadcrumb(this.groupTabs[group], event.position.lineNumber));
    editor.onDidBlurEditorText(() => this.editorView.classList.remove("monaco-focused"));
  }

  activateGroup(group) {
    const editor = group === "secondary" ? this.secondaryEditor : this.primaryEditor;
    if (!editor) return;
    this.activeGroup = group;
    this.monacoEditor = editor;
    this.activeTab = this.groupTabs[group] || this.activeTab;
    this.editorView?.classList.add("monaco-focused");
    const activeFile = document.getElementById("status-active-file");
    if (activeFile && this.activeTab) activeFile.textContent = this.activeTab;
    this.tabsContainer?.querySelectorAll(".editor-tab").forEach(el => el.classList.toggle("active", el.dataset.path === this.activeTab));
  }

  toggleSplitEditor() {
    if (!this.monacoReady) return;
    if (this.secondaryEditor) {
      this.secondaryEditor.dispose();
      this.secondaryEditor = null;
      this.splitSash?.remove();
      this.splitSash = null;
      this.secondaryHost?.remove();
      this.secondaryHost = null;
      this.groupTabs.secondary = null;
      this.editorView?.classList.remove("split-primary");
      this.activateGroup("primary");
      this.primaryEditor?.layout();
      return;
    }
    const wrapper = this.editorView?.parentElement;
    if (!wrapper) return;
    this.secondaryHost = document.createElement("div");
    this.secondaryHost.id = "code-editor-view-secondary";
    this.secondaryHost.className = "code-editor-view-secondary";
    this.splitSash = document.createElement("div");
    this.splitSash.className = "editor-split-sash";
    this.splitSash.setAttribute("role", "separator");
    this.splitSash.setAttribute("aria-label", "Resize editor groups");
    this.splitSash.setAttribute("aria-orientation", "vertical");
    this.splitSash.tabIndex = 0;
    const resizeGroups = clientX => {
      const bounds = wrapper.getBoundingClientRect();
      if (!bounds.width) return;
      this.splitRatio = Math.max(0.25, Math.min(0.75, (clientX - bounds.left) / bounds.width));
      wrapper.style.setProperty("--editor-split-ratio", (this.splitRatio * 100).toFixed(1) + "%");
      this.primaryEditor?.layout();
      this.secondaryEditor?.layout();
    };
    this.splitSash.addEventListener("pointerdown", event => {
      event.preventDefault();
      this.splitSash.setPointerCapture(event.pointerId);
      const move = moveEvent => resizeGroups(moveEvent.clientX);
      const finish = () => {
        this.splitSash?.removeEventListener("pointermove", move);
        this.splitSash?.removeEventListener("pointerup", finish);
        this.splitSash?.removeEventListener("pointercancel", finish);
      };
      this.splitSash.addEventListener("pointermove", move);
      this.splitSash.addEventListener("pointerup", finish);
      this.splitSash.addEventListener("pointercancel", finish);
    });
    this.splitSash.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.splitRatio = Math.max(0.25, Math.min(0.75, this.splitRatio + (event.key === "ArrowLeft" ? -0.03 : 0.03)));
      wrapper.style.setProperty("--editor-split-ratio", (this.splitRatio * 100).toFixed(1) + "%");
      this.primaryEditor?.layout();
      this.secondaryEditor?.layout();
    });
    wrapper.style.setProperty("--editor-split-ratio", (this.splitRatio * 100).toFixed(1) + "%");
    wrapper.append(this.splitSash, this.secondaryHost);
    this.editorView.classList.add("split-primary");
    this.secondaryEditor = monaco.editor.create(this.secondaryHost, { ...this.editorOptions, value: "" });
    this.attachEditorGroup(this.secondaryEditor, "secondary");
    const initial = this.groupTabs.primary || this.activeTab;
    if (initial && this.openTabs.has(initial)) this.selectTab(initial, "secondary");
    this.activateGroup("secondary");
    this.secondaryEditor.layout();
    this.primaryEditor?.layout();
  }

  openInOtherGroup(filePath = this.activeTab) {
    if (!filePath) return;
    if (!this.secondaryEditor) this.toggleSplitEditor();
    if (!this.secondaryEditor) return;
    const target = this.activeGroup === "secondary" ? "primary" : "secondary";
    this.selectTab(filePath, target);
  }

  showEditorError(message) {
    if (!this.editorView) return;
    this.editorView.innerHTML = "";
    const notice = document.createElement("div");
    notice.className = "monaco-load-error";
    notice.textContent = message;
    this.editorView.appendChild(notice);
  }

  initEventListeners() {
    this.saveBtn?.addEventListener("click", () => this.saveCurrentFile());
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        this.saveCurrentFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "?" && !e.target.closest("input,textarea")) {
        e.preventDefault();
        this.showShortcutHelp();
      }
      if (e.key === "Escape") this.closeEditorDialog();
    });
    document.getElementById("editor-search-trigger")?.addEventListener("click", () => this.monacoEditor?.getAction("actions.find").run());
    document.getElementById("btn-git-diff-file")?.addEventListener("click", () => this.openGitDiff());
  }

  saveStateToCache() {
    try {
      const tabs = Array.from(this.openTabs, ([path, data]) => ({ path, content: data.content, isDirty: data.isDirty, version: data.version || null }));
      localStorage.setItem("ath_cached_editor_tabs", JSON.stringify(tabs));
      localStorage.setItem("ath_cached_active_tab", this.activeTab || "");
    } catch {}
  }

  restoreStateFromCache() {
    try {
      const raw = localStorage.getItem("ath_cached_editor_tabs");
      if (!raw) return;
      const tabs = JSON.parse(raw);
      if (!Array.isArray(tabs)) return;
      tabs.forEach(tab => {
        if (!tab?.path || typeof tab.content !== "string") return;
        this.openTabs.set(tab.path, { content: tab.content, version: tab.version || null, isDirty: !!tab.isDirty, language: this.detectLanguage(tab.path) });
        this.createTabElement(tab.path);
      });
      const active = localStorage.getItem("ath_cached_active_tab");
      if (tabs.length) this.selectTab(active && this.openTabs.has(active) ? active : tabs[0].path);
    } catch (error) { console.warn("Editor cache restore notice:", error); }
  }

  async openFile(filePath) {
    if (this.openTabs.has(filePath)) return this.selectTab(filePath);
    try {
      const response = await fetch("/api/workspace/file?path=" + encodeURIComponent(filePath), {
        headers: { Authorization: "Bearer " + (localStorage.getItem("token") || "") }
      });
      if (!response.ok) throw new Error("Failed to read " + filePath);
      const data = await response.json();
      this.openTabs.set(filePath, { content: data.content, version: data.version || null, isDirty: false, language: this.detectLanguage(filePath) });
      this.createTabElement(filePath);
      this.selectTab(filePath);
      this.saveStateToCache();
    } catch (err) {
      console.error("Open file error:", err);
      window.app?.logTerminal("Error opening " + filePath + ": " + err.message, "error");
    }
  }

  createTabElement(filePath) {
    if (!this.tabsContainer || this.tabsContainer.querySelector('[data-path="' + CSS.escape(filePath) + '"]')) return;
    const tab = document.createElement("div");
    tab.className = "editor-tab";
    tab.dataset.path = filePath;
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = filePath.split("/").pop();
    const close = document.createElement("button");
    close.className = "tab-close-btn";
    close.title = "Close Tab";
    close.setAttribute("aria-label", "Close " + filePath);
    close.textContent = "×";
    tab.append(title, close);
    tab.addEventListener("click", e => { if (!e.target.closest(".tab-close-btn")) this.selectTab(filePath); });
    close.addEventListener("click", e => { e.stopPropagation(); this.closeTab(filePath); });
    this.tabsContainer.appendChild(tab);
  }

  setEditorValue(content, language) {
    if (!this.monacoEditor) return;
    this.suppressModelChange = true;
    const model = this.monacoEditor.getModel();
    if (model && monaco.editor.getModelLanguage(model) !== language) monaco.editor.setModelLanguage(model, language);
    this.monacoEditor.setValue(content || "");
    this.suppressModelChange = false;
  }

  selectTab(filePath, group = this.activeGroup) {
    const tab = this.openTabs.get(filePath);
    if (!tab) return;
    if (group === "secondary" && !this.secondaryEditor) group = "primary";
    this.groupTabs[group] = filePath;
    this.activeGroup = group;
    this.activeTab = filePath;
    const editor = group === "secondary" ? this.secondaryEditor : this.primaryEditor;
    if (this.welcomeScreen) this.welcomeScreen.style.display = "none";
    if (this.editorView) this.editorView.style.display = "block";
    if (!this.monacoReady || !editor) { this.pendingModel = filePath; return; }
    const modelUri = this.lspRootUri ? this.lspRootUri + filePath.split("/").map(encodeURIComponent).join("/") : "file:///" + filePath.split("/").map(encodeURIComponent).join("/");
    const previousModel = editor.getModel();
    const model = monaco.editor.createModel(tab.content || "", tab.language || this.detectLanguage(filePath), monaco.Uri.parse(modelUri));
    const existing = monaco.editor.getModel(model.uri);
    if (existing) { model.dispose(); editor.setModel(existing); }
    else editor.setModel(model);
    if (previousModel && previousModel !== editor.getModel() && this.activeTab === filePath && previousModel.uri.toString() !== modelUri) {
      const sharedElsewhere = [this.primaryEditor, this.secondaryEditor].some(other => other && other !== editor && other.getModel() === previousModel);
      if (!sharedElsewhere) previousModel.dispose();
    }
    editor.updateOptions({ readOnly: false });
    this.activateGroup(group);
    editor.focus();
    this.saveStateToCache();
    this.refreshGitDecorations(filePath);
    this.scheduleDiagnostics(filePath, editor);
    this.refreshDocumentSymbols(filePath);
    this.ensureLspForFile(filePath, tab);
  }

  closeTab(filePath) {
    this.openTabs.delete(filePath);
    this.tabsContainer?.querySelector('[data-path="' + CSS.escape(filePath) + '"]')?.remove();
    const nextPath = Array.from(this.openTabs.keys()).at(-1) || null;
    const activeGroup = this.activeGroup;
    for (const group of ["primary", "secondary"]) {
      if (this.groupTabs[group] !== filePath) continue;
      const editor = group === "secondary" ? this.secondaryEditor : this.primaryEditor;
      if (nextPath && editor) this.selectTab(nextPath, group);
      else {
        this.groupTabs[group] = null;
        editor?.setModel(null);
      }
    }
    const stillOpenInGroup = this.groupTabs.primary === filePath || this.groupTabs.secondary === filePath;
    if (!stillOpenInGroup) {
      const model = window.monaco?.editor?.getModel(window.monaco.Uri.parse("file:///" + filePath.split("/").map(encodeURIComponent).join("/")));
      model?.dispose();
    }
    const fallbackGroup = this.groupTabs[activeGroup] ? activeGroup : (this.groupTabs.primary ? "primary" : (this.groupTabs.secondary ? "secondary" : null));
    if (fallbackGroup) this.activateGroup(fallbackGroup);
    else {
      this.activeTab = null;
      if (this.welcomeScreen) this.welcomeScreen.style.display = "flex";
      if (this.editorView) this.editorView.style.display = "none";
      const activeFile = document.getElementById("status-active-file");
      if (activeFile) activeFile.textContent = "No file open";
    }
    this.saveStateToCache();
  }

  async openSearchResult(filePath, line, column) {
    await this.openFile(filePath);
    if (!this.monacoEditor || this.activeTab !== filePath) return;
    const position = { lineNumber: Math.max(1, Number(line) || 1), column: Math.max(1, Number(column) || 1) };
    this.monacoEditor.setPosition(position);
    this.monacoEditor.revealPositionInCenter(position);
    this.monacoEditor.focus();
  }



  async openGitDiff(filePath = this.activeTab) {
    if (!filePath || !this.monacoReady) return;
    this.closeGitDiff();
    try {
      const response = await fetch("/api/workspace/git/diff?file=" + encodeURIComponent(filePath), {
        headers: { Authorization: "Bearer " + (localStorage.getItem("token") || "") }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "Unable to load Git diff.");
      const overlay = document.createElement("div");
      overlay.className = "git-diff-overlay";
      overlay.id = "git-diff-overlay";
      const header = document.createElement("div");
      header.className = "git-diff-header";
      const title = document.createElement("strong");
      title.textContent = data.file + " · HEAD ↔ Working Tree";
      const modeToggle = document.createElement("button");
      modeToggle.type = "button";
      modeToggle.className = "secondary-btn";
      modeToggle.textContent = this.gitDiffSideBySide ? "Inline diff" : "Side-by-side";
      modeToggle.setAttribute("aria-pressed", String(this.gitDiffSideBySide));
      modeToggle.addEventListener("click", () => {
        this.gitDiffSideBySide = !this.gitDiffSideBySide;
        this.gitDiffEditor?.updateOptions({ renderSideBySide: this.gitDiffSideBySide });
        modeToggle.textContent = this.gitDiffSideBySide ? "Inline diff" : "Side-by-side";
        modeToggle.setAttribute("aria-pressed", String(this.gitDiffSideBySide));
      });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "secondary-btn";
      close.textContent = "Close";
      close.addEventListener("click", () => this.closeGitDiff());
      header.append(title, modeToggle, close);
      const host = document.createElement("div");
      host.className = "git-diff-host";
      overlay.append(header, host);
      document.body.appendChild(overlay);
      this.gitDiffOverlay = overlay;
      const language = this.detectLanguage(data.file);
      const uriBase = "inmemory://ath-git-diff/" + encodeURIComponent(data.file);
      const original = monaco.editor.createModel(data.original || "", language, monaco.Uri.parse(uriBase + "?side=original"));
      const modified = monaco.editor.createModel(data.modified || "", language, monaco.Uri.parse(uriBase + "?side=modified"));
      this.gitDiffEditor = monaco.editor.createDiffEditor(host, {
        theme: "vs-dark", readOnly: true, originalEditable: false, renderSideBySide: this.gitDiffSideBySide,
        automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
        diffWordWrap: "on", renderIndicators: true
      });
      this.gitDiffEditor.setModel({ original, modified });
      overlay.addEventListener("keydown", event => { if (event.key === "Escape") this.closeGitDiff(); });
      close.focus();
    } catch (error) {
      window.app?.logTerminal("Git diff failed: " + error.message, "error");
    }
  }

  closeGitDiff() {
    if (this.gitDiffEditor) {
      const model = this.gitDiffEditor.getModel();
      model?.original?.dispose();
      model?.modified?.dispose();
      this.gitDiffEditor.dispose();
      this.gitDiffEditor = null;
    }
    this.gitDiffOverlay?.remove();
    this.gitDiffOverlay = null;
  }



  async reviewAgentChanges(proposal) {
    const incoming = Array.isArray(proposal?.files) ? proposal.files : [];
    if (!incoming.length) return;
    try {
      const response = await fetch("/api/workspace/agent/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.getItem("token") || "") },
        body: JSON.stringify({ summary: proposal.summary, files: incoming })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "Unable to prepare the agent patch.");
      const merged = new Map(this.agentApplyFiles.map(item => [item.path, item]));
      for (const item of data.files || []) {
        merged.set(item.path, item);
        this.agentApplyHunkStates.delete(item.path);
        this.agentApplyHunkOverrides.delete(item.path);
        this.agentApplyAcceptedPaths.delete(item.path);
      }
      this.agentApplyFiles = Array.from(merged.values());
      this.agentApplySummary = data.summary || proposal.summary || "Agent proposed changes";
      this.agentApplySelectedPath = this.agentApplyFiles[0]?.path || null;
      this.agentApplyReady = false;
      this.renderAgentApplyReview();
    } catch (error) { window.app?.renderError("Agent patch preview failed: " + error.message); }
  }

  renderAgentApplyReview() {
    if (!this.agentApplyFiles.length || !this.monacoEditor || typeof monaco === "undefined") return;
    this.closeAgentApplyReview();
    const zone = document.createElement("div");
    zone.className = "agent-inline-review";
    const heading = document.createElement("div");
    heading.className = "agent-inline-review-heading";
    const summary = document.createElement("strong");
    summary.textContent = this.agentApplySummary + " · " + this.agentApplyFiles.length + " proposed file(s)";
    const status = document.createElement("span");
    status.className = "agent-inline-review-status";
    status.textContent = this.agentApplyReady ? "Ready for review" : "Waiting for agent turn to finish";
    heading.append(summary, status);
    const files = document.createElement("div");
    files.className = "agent-inline-review-files";
    this.agentApplyFiles.forEach(item => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-inline-review-file" + (item.path === this.agentApplySelectedPath ? " active" : "");
      button.textContent = item.path + (this.agentApplyAcceptedPaths.has(item.path) ? " ✓" : "");
      button.addEventListener("click", () => {
        this.agentApplySelectedPath = item.path;
        this.renderAgentApplyReview();
      });
      files.appendChild(button);
    });
    const actions = document.createElement("div");
    actions.className = "agent-inline-review-actions";
    const apply = document.createElement("button");
    apply.type = "button"; apply.className = "primary-btn"; apply.textContent = "Apply accepted";
    apply.disabled = !this.agentApplyReady || this.agentApplyAcceptedPaths.size === 0;
    apply.addEventListener("click", () => this.acceptAgentChanges(false));
    const verify = document.createElement("button");
    verify.type = "button"; verify.className = "primary-btn"; verify.textContent = "Apply & verify";
    verify.disabled = !this.agentApplyReady || this.agentApplyAcceptedPaths.size === 0;
    verify.addEventListener("click", () => this.acceptAgentChanges(true));
    const rejectAll = document.createElement("button");
    rejectAll.type = "button"; rejectAll.className = "secondary-btn"; rejectAll.textContent = "Reject all";
    rejectAll.addEventListener("click", () => this.rejectAgentChanges());
    actions.append(apply, verify, rejectAll);
    zone.append(heading, files, actions);
    this.agentApplyZoneEditor = this.monacoEditor;
    this.agentApplyZoneEditor.changeViewZones(accessor => {
      if (this.agentApplyViewZoneId) accessor.removeZone(this.agentApplyViewZoneId);
      this.agentApplyViewZoneId = accessor.addZone({ afterLineNumber: 0, heightInLines: 4, domNode: zone, suppressMouseDown: false });
    });
    this.agentApplyStatus = status;
    this.agentApplyAcceptButton = apply;
    this.agentApplyVerifyButton = verify;
    this.agentApplyFileBar = files;
    this.agentApplyOverlay = zone;
    this.renderAgentApplySelectedDiff();
    this.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => this.acceptAgentHunk());
    this.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN, () => this.rejectAgentHunk());
  }

  renderAgentApplySelectedDiff() {
    const item = this.agentApplyFiles.find(file => file.path === this.agentApplySelectedPath);
    if (!item || !this.monacoEditor || !window.AgentPatchDiff) return;
    if (!this.openTabs.has(item.path)) {
      this.openTabs.set(item.path, { content: item.original || "", version: item.expectedVersion || null, isDirty: false, language: this.detectLanguage(item.path) });
      this.createTabElement(item.path);
    }
    if (this.activeTab !== item.path) this.selectTab(item.path);
    const model = this.monacoEditor.getModel();
    if (!model) return;
    const hunks = window.AgentPatchDiff.diffLines(item.original || "", item.content || "");
    this.agentApplyHunks = hunks;
    const states = this.agentApplyHunkStates.get(item.path) || new Map();
    this.agentApplyHunkStates.set(item.path, states);
    if (!hunks.some(hunk => hunk.id === this.agentApplySelectedHunkId)) this.agentApplySelectedHunkId = hunks.find(hunk => states.get(hunk.id) !== "rejected")?.id || null;

    const decorations = [];
    const zoneSpecs = [];
    hunks.forEach((hunk, index) => {
      const state = states.get(hunk.id) || "pending";
      if (state === "rejected") return;
      const startLine = Math.min(hunk.originalStart + 1, model.getLineCount());
      const endLine = Math.min(Math.max(hunk.originalEnd, hunk.originalStart + 1), model.getLineCount());
      for (let line = startLine; line <= endLine; line++) {
        decorations.push({ range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
          options: { isWholeLine: true, className: state === "accepted" ? "agent-inline-accepted-line" : "agent-inline-added-line",
            linesDecorationsClassName: "agent-inline-added-gutter" } });
      }
      const hunkZone = document.createElement("div");
      hunkZone.className = "agent-inline-hunk" + (state === "accepted" ? " is-accepted" : "") +
        (this.agentApplySelectedHunkId === hunk.id ? " is-selected" : "");
      hunkZone.addEventListener("click", () => {
        this.agentApplySelectedHunkId = hunk.id;
        this.renderAgentApplySelectedDiff();
      });
      const title = document.createElement("div");
      title.className = "agent-inline-hunk-title";
      title.textContent = "Hunk " + (index + 1) + " · +" + hunk.additions + " −" + hunk.deletions +
        (state === "accepted" ? " · accepted" : " · pending");
      const overrides = this.agentApplyHunkOverrides.get(item.path) || new Map();
      this.agentApplyHunkOverrides.set(item.path, overrides);
      const preview = document.createElement("div");
      preview.className = "agent-inline-hunk-preview-wrap";
      const removed = document.createElement("pre");
      removed.className = "agent-inline-hunk-removed";
      removed.textContent = hunk.originalLines.slice(0, 3).map(line => "- " + line).join("\n") || "(no removed lines)";
      const replacementEditor = document.createElement("textarea");
      replacementEditor.className = "agent-inline-hunk-editor";
      replacementEditor.rows = 2;
      replacementEditor.value = overrides.has(hunk.id) ? overrides.get(hunk.id) : hunk.replacement.join("\n");
      replacementEditor.setAttribute("aria-label", "Edit replacement for hunk " + (index + 1));
      replacementEditor.title = "Edit this proposed replacement before accepting the hunk";
      replacementEditor.addEventListener("click", event => event.stopPropagation());
      replacementEditor.addEventListener("input", () => overrides.set(hunk.id, replacementEditor.value));
      preview.append(removed, replacementEditor);
      const controls = document.createElement("div");
      controls.className = "agent-inline-hunk-controls";
      const accept = document.createElement("button");
      accept.type = "button"; accept.className = "primary-btn"; accept.textContent = state === "accepted" ? "Accepted" : "Accept hunk";
      accept.disabled = !this.agentApplyReady || state === "accepted";
      accept.addEventListener("click", event => { event.stopPropagation(); this.setAgentHunkState(item.path, hunk.id, "accepted"); });
      const reject = document.createElement("button");
      reject.type = "button"; reject.className = "secondary-btn"; reject.textContent = "Reject hunk";
      reject.disabled = state === "accepted";
      reject.addEventListener("click", event => { event.stopPropagation(); this.setAgentHunkState(item.path, hunk.id, "rejected"); });
      controls.append(accept, reject);
      hunkZone.append(title, preview, controls);
      zoneSpecs.push({ afterLineNumber: hunk.originalStart, domNode: hunkZone });
    });

    this.agentApplyDecorations?.clear();
    this.agentApplyDecorations = this.monacoEditor.createDecorationsCollection(decorations);
    this.agentApplyZoneEditor = this.monacoEditor;
    this.agentApplyZoneEditor.changeViewZones(accessor => {
      this.agentApplyHunkZoneIds.forEach(id => accessor.removeZone(id));
      this.agentApplyHunkZoneIds = zoneSpecs.map(spec => accessor.addZone({
        afterLineNumber: spec.afterLineNumber, heightInLines: 3, domNode: spec.domNode, suppressMouseDown: false
      }));
    });
    const accepted = states.size ? Array.from(states.values()).filter(value => value === "accepted").length : 0;
    if (accepted) this.agentApplyAcceptedPaths.add(item.path);
    else this.agentApplyAcceptedPaths.delete(item.path);
    if (this.agentApplyStatus) this.agentApplyStatus.textContent =
      accepted + " hunk(s) staged · " + hunks.length + " total · Ctrl+Y accept selected, Ctrl+N reject selected";
    if (this.agentApplyAcceptButton) this.agentApplyAcceptButton.disabled = !this.agentApplyReady || this.agentApplyAcceptedPaths.size === 0;
    if (this.agentApplyVerifyButton) this.agentApplyVerifyButton.disabled = !this.agentApplyReady || this.agentApplyAcceptedPaths.size === 0;
  }

  setAgentHunkState(filePath, hunkId, state) {
    const states = this.agentApplyHunkStates.get(filePath) || new Map();
    states.set(hunkId, state);
    this.agentApplyHunkStates.set(filePath, states);
    this.agentApplySelectedHunkId = hunkId;
    this.renderAgentApplyReview();
  }

  acceptAgentHunk() {
    if (!this.agentApplyReady || !this.agentApplySelectedPath || !this.agentApplySelectedHunkId) return;
    this.setAgentHunkState(this.agentApplySelectedPath, this.agentApplySelectedHunkId, "accepted");
  }

  rejectAgentHunk() {
    if (!this.agentApplySelectedPath || !this.agentApplySelectedHunkId) return;
    this.setAgentHunkState(this.agentApplySelectedPath, this.agentApplySelectedHunkId, "rejected");
  }

  enableAgentProposalActions() {
    this.agentApplyReady=true;
    this.renderAgentApplyReview();
    if(this.agentApplyStatus)this.agentApplyStatus.textContent="Agent turn finished. Review and stage hunks before applying.";
  }

  async acceptAgentChanges(verify) {
    if (!this.agentApplyReady || !this.agentApplyFiles.length || !window.AgentPatchDiff) return;
    const selected = this.agentApplyFiles.filter(item => this.agentApplyAcceptedPaths.has(item.path));
    if (!selected.length) return;
    const prepared = selected.map(item => {
      const rawHunks = window.AgentPatchDiff.diffLines(item.original || "", item.content || "");
      const overrides = this.agentApplyHunkOverrides.get(item.path) || new Map();
      const hunks = rawHunks.map(hunk => overrides.has(hunk.id)
        ? { ...hunk, replacement: String(overrides.get(hunk.id)).split("\n") } : hunk);
      const states = this.agentApplyHunkStates.get(item.path) || new Map();
      const acceptedIds = hunks.filter(hunk => states.get(hunk.id) === "accepted").map(hunk => hunk.id);
      const retainedIds = hunks.filter(hunk => states.get(hunk.id) !== "rejected").map(hunk => hunk.id);
      return {
        ...item,
        content: window.AgentPatchDiff.applyHunks(item.original || "", hunks, acceptedIds),
        remainingContent: window.AgentPatchDiff.applyHunks(item.original || "", hunks, retainedIds)
      };
    }).filter(item => item.content !== item.original);
    if (!prepared.length) return;
    const files = prepared.map(item => ({ path: item.path, content: item.content, expectedVersion: item.expectedVersion }));
    if (this.agentApplyStatus) this.agentApplyStatus.textContent = "Applying accepted hunks with version checks…";
    if (this.agentApplyAcceptButton) this.agentApplyAcceptButton.disabled = true;
    if (this.agentApplyVerifyButton) this.agentApplyVerifyButton.disabled = true;
    try {
      const response = await fetch("/api/workspace/agent/apply/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.getItem("token") || "") },
        body: JSON.stringify({ files })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data.message || data.error || "Patch commit failed") +
        (data.rollbackComplete === false ? " · rollback incomplete; inspect workspace immediately." : ""));
      const applied = prepared.map(item => ({ path: item.path, content: item.content }));
      const remainingFiles = [];
      for (const item of prepared) {
        const saved = (data.files || []).find(file => file.path === item.path);
        const tab = this.openTabs.get(item.path);
        if (tab) {
          tab.content = item.content;
          tab.version = saved?.version || tab.version || null;
          tab.isDirty = false;
          const uri = monaco.Uri.parse("file:///" + item.path.split("/").map(encodeURIComponent).join("/"));
          const model = monaco.editor.getModel(uri);
          if (model) model.setValue(item.content);
        }
        if (item.remainingContent !== item.content) {
          const pending = this.agentApplyFiles.find(file => file.path === item.path);
          if (pending) {
            pending.original = item.content;
            pending.content = item.remainingContent;
            pending.expectedVersion = saved?.version || tab?.version || pending.expectedVersion;
            remainingFiles.push(pending);
          }
        }
      }
      this.agentApplyFiles = this.agentApplyFiles.filter(item => !prepared.some(done => done.path === item.path) || remainingFiles.some(left => left.path === item.path));
      this.agentApplyHunkStates.clear();
      this.agentApplyHunkOverrides.clear();
      this.agentApplyAcceptedPaths.clear();
      this.closeAgentApplyReview();
      if (this.agentApplyFiles.length) {
        this.agentApplySelectedPath = this.agentApplyFiles[0].path;
        this.renderAgentApplyReview();
      } else {
        this.agentApplyReady = false;
        if (window.app) { window.app.agentAwaitingApproval = false; await window.app.completeAgentRunSnapshot?.(); }
      }
      await window.app?.loadWorkspaceFiles?.();
      window.app?.renderSystemMessage("**Agent patch accepted.** " + applied.length + " file(s) updated with version checks; unaccepted hunks remain available for review.");
      if (!this.agentApplyFiles.length) window.app?.transitionAgentState?.("idle", { source: "agent-apply-accepted" });
      if (verify) await window.app?.runAgentVerification?.(applied);
    } catch (error) {
      if (this.agentApplyStatus) this.agentApplyStatus.textContent = "Apply failed: " + error.message;
      if (this.agentApplyAcceptButton) this.agentApplyAcceptButton.disabled = false;
      if (this.agentApplyVerifyButton) this.agentApplyVerifyButton.disabled = false;
      window.app?.renderError("Agent Apply failed: " + error.message);
    }
  }

  async rejectAgentChanges() {
    this.closeAgentApplyReview();this.agentApplyFiles=[];this.agentApplyAcceptedPaths.clear();this.agentApplyHunkStates.clear();this.agentApplyHunkOverrides.clear();this.agentApplyReady=false;
    if (window.app) { window.app.agentAwaitingApproval = false; await window.app.completeAgentRunSnapshot?.(); window.app.transitionAgentState?.("idle", { source: "agent-patch-rejected" }); }
    window.app?.renderSystemMessage("Agent patch rejected. No proposed files were written.");
  }

  closeAgentApplyReview() {
    if (this.agentApplyZoneEditor && (this.agentApplyViewZoneId || this.agentApplyHunkZoneIds.length)) {
      this.agentApplyZoneEditor.changeViewZones(accessor => {
        if (this.agentApplyViewZoneId) accessor.removeZone(this.agentApplyViewZoneId);
        this.agentApplyHunkZoneIds.forEach(id => accessor.removeZone(id));
      });
    }
    this.agentApplyViewZoneId = null;
    this.agentApplyHunkZoneIds = [];
    this.agentApplyZoneEditor = null;
    this.agentApplyDecorations?.clear();
    this.agentApplyDecorations = null;
    this.agentApplyOverlay?.remove();
    this.agentApplyOverlay = null;
    this.agentApplyFileBar = null;
    this.agentApplyStatus = null;
    this.agentApplyAcceptButton = null;
    this.agentApplyVerifyButton = null;
  }

  async refreshDocumentSymbols(filePath) {
    if (!filePath) return;
    try {
      const response = await fetch("/api/workspace/symbols/document?file=" + encodeURIComponent(filePath), {
        headers: { Authorization: "Bearer " + (localStorage.getItem("token") || "") }
      });
      if (!response.ok) return;
      const data = await response.json();
      const symbols = Array.isArray(data.symbols) ? data.symbols : [];
      this.documentSymbols.set(filePath, symbols);
      if (this.activeTab === filePath) {
        this.renderSymbolOutline(filePath);
        this.updateSymbolBreadcrumb(filePath, this.monacoEditor?.getPosition()?.lineNumber || 1);
      }
    } catch (error) { console.warn("Document symbol refresh failed:", error); }
  }

  updateSymbolBreadcrumb(filePath, lineNumber = 1) {
    const bar = document.getElementById("editor-breadcrumbs");
    if (!bar) return;
    bar.replaceChildren();
    if (!filePath) return;
    const parts = filePath.split("/");
    parts.forEach((part, index) => {
      const crumb = document.createElement("span");
      crumb.className = "editor-breadcrumb";
      crumb.textContent = part;
      bar.appendChild(crumb);
      if (index < parts.length - 1) {
        const separator = document.createElement("span");
        separator.className = "editor-breadcrumb-separator";
        separator.textContent = "›";
        bar.appendChild(separator);
      }
    });
    const symbols = this.documentSymbols.get(filePath) || [];
    const active = symbols.filter(item => item.line <= lineNumber && (item.endLine || item.line) >= lineNumber)
      .sort((a, b) => b.line - a.line)[0] || symbols.filter(item => item.line <= lineNumber).sort((a, b) => b.line - a.line)[0];
    if (active) {
      const separator = document.createElement("span");
      separator.className = "editor-breadcrumb-separator";
      separator.textContent = "›";
      const symbol = document.createElement("span");
      symbol.className = "editor-breadcrumb editor-breadcrumb-symbol";
      symbol.textContent = active.name;
      bar.append(separator, symbol);
    }
  }

  toggleSymbolOutline(forceOpen = false) {
    let panel = document.getElementById("ath-symbol-outline");
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = "ath-symbol-outline";
      panel.className = "ath-symbol-outline";
      panel.hidden = true;
      const header = document.createElement("header");
      const title = document.createElement("strong");
      title.textContent = "Outline";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.addEventListener("click", () => { panel.hidden = true; });
      header.append(title, close);
      const search = document.createElement("input");
      search.type = "search";
      search.className = "ath-outline-filter";
      search.placeholder = "Filter symbols… (@symbol)";
      search.setAttribute("aria-label", "Filter symbols");
      search.autocomplete = "off";
      search.addEventListener("input", () => {
        this.outlineQuery = search.value;
        this.renderSymbolOutline(this.activeTab);
      });
      const list = document.createElement("div");
      list.className = "ath-symbol-outline-list";
      panel.append(header, search, list);
      this.editorView?.parentElement?.appendChild(panel);
    }
    panel.hidden = forceOpen ? false : !panel.hidden;
    this.renderSymbolOutline(this.activeTab);
    return panel;
  }

  symbolMatchScore(item, query) {
    const name = String(item.name || "").toLowerCase();
    const kind = String(item.kind || "").toLowerCase();
    const target = name + " " + kind;
    const needle = String(query || "").trim().toLowerCase().replace(/^@/, "");
    if (!needle) return 0;
    const direct = target.indexOf(needle);
    if (direct >= 0) return direct;
    let cursor = 0;
    let gaps = 0;
    for (const char of needle) {
      const found = target.indexOf(char, cursor);
      if (found < 0) return -1;
      gaps += found - cursor;
      cursor = found + 1;
    }
    return 100 + gaps;
  }

  renderSymbolOutline(filePath) {
    const panel = document.getElementById("ath-symbol-outline");
    if (!panel || !filePath) return;
    const list = panel.querySelector(".ath-symbol-outline-list");
    if (!list) return;
    list.replaceChildren();
    const symbols = this.documentSymbols.get(filePath) || [];
    const query = panel.querySelector(".ath-outline-filter")?.value || "";
    const visible = symbols.map(item => ({ item, score: this.symbolMatchScore(item, query) }))
      .filter(entry => entry.score >= 0)
      .sort((a, b) => a.score - b.score || a.item.line - b.item.line)
      .map(entry => entry.item);
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "ath-outline-empty";
      empty.textContent = query ? "No matching symbols." : "No indexed symbols in this file.";
      list.appendChild(empty);
      return;
    }
    visible.forEach(item => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ath-outline-item";
      row.textContent = item.name + "  ·  " + item.kind + "  :" + item.line;
      row.addEventListener("click", () => {
        const position = { lineNumber: item.line, column: item.col || 1 };
        this.monacoEditor?.setPosition(position);
        this.monacoEditor?.revealPositionInCenter(position);
        this.monacoEditor?.focus();
      });
      list.appendChild(row);
    });
  }

  scheduleDiagnostics(filePath, editor) {
    if (!filePath || !editor) return;
    clearTimeout(this.diagnosticTimers.get(filePath));
    const timer = setTimeout(() => this.refreshDiagnostics(filePath, editor), 650);
    this.diagnosticTimers.set(filePath, timer);
  }

  async refreshDiagnostics(filePath, editor = this.monacoEditor) {
    const model = editor?.getModel();
    if (!model || !filePath || !this.openTabs.has(filePath)) return;
    let modelPath = String(model.uri?.path || "");
    if (modelPath.startsWith("/")) modelPath = modelPath.slice(1);
    try { modelPath = decodeURIComponent(modelPath); } catch {}
    if (modelPath !== filePath) return;
    try {
      const response = await fetch("/api/workspace/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.getItem("token") || "") },
        body: JSON.stringify({ file: filePath, content: model.getValue() })
      });
      if (!response.ok) return;
      const data = await response.json();
      const diagnostics = [
        ...(Array.isArray(data.diagnostics) ? data.diagnostics : []),
        ...(Array.isArray(data.semanticDiagnostics) ? data.semanticDiagnostics : [])
      ];
      monaco.editor.setModelMarkers(model, "ath-workspace-diagnostics", diagnostics.map(item => ({
        startLineNumber: item.startLineNumber,
        startColumn: item.startColumn,
        endLineNumber: item.endLineNumber,
        endColumn: item.endColumn,
        message: item.message,
        source: item.source || "Tree-sitter",
        severity: item.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error
      })));
      this.renderProblems(filePath, diagnostics);
    } catch (error) { console.warn("Tree-sitter diagnostics failed:", error); }
  }

  toggleProblemsPanel(forceOpen = false) {
    let panel = document.getElementById("ath-problems-panel");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "ath-problems-panel";
      panel.className = "ath-problems-panel";
      panel.hidden = true;
      const header = document.createElement("header");
      const title = document.createElement("strong");
      title.textContent = "Problems";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.title = "Close Problems";
      close.addEventListener("click", () => { panel.hidden = true; });
      header.append(title, close);
      const list = document.createElement("div");
      list.className = "ath-problems-list";
      panel.append(header, list);
      this.editorView?.parentElement?.appendChild(panel);
    }
    panel.hidden = forceOpen ? false : !panel.hidden;
    return panel;
  }

  renderProblems(filePath, diagnostics) {
    const panel = document.getElementById("ath-problems-panel");
    const button = document.getElementById("btn-problems-panel");
    if (button) button.title = diagnostics.length ? diagnostics.length + " problems in " + filePath : "No problems in " + filePath;
    if (!panel) return;
    const list = panel.querySelector(".ath-problems-list");
    if (!list) return;
    list.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "ath-problems-summary";
    heading.textContent = diagnostics.length + (diagnostics.length === 1 ? " problem" : " problems") + " · " + filePath;
    list.appendChild(heading);
    diagnostics.forEach(item => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ath-problem-item";
      row.textContent = (item.severity === "warning" ? "⚠ " : "● ") + item.startLineNumber + ":" + item.startColumn + "  " + item.message;
      row.addEventListener("click", () => {
        const group = this.activeTab === filePath ? this.activeGroup : (this.groupTabs.secondary === filePath ? "secondary" : "primary");
        this.activateGroup(group);
        const targetEditor = group === "secondary" ? this.secondaryEditor : this.primaryEditor;
        targetEditor?.setPosition({ lineNumber: item.startLineNumber, column: item.startColumn });
        targetEditor?.revealLineInCenter(item.startLineNumber);
        targetEditor?.focus();
      });
      list.appendChild(row);
    });
  }

  async refreshGitDecorations(filePath = this.activeTab) {
    if (!filePath || !this.monacoEditor || !this.monacoReady) return;
    try {
      const response = await fetch("/api/workspace/git/status", {
        headers: { Authorization: "Bearer " + (localStorage.getItem("token") || "") }
      });
      if (!response.ok) return;
      const data = await response.json();
      const status = (data.files || []).find(item => item.path === filePath);
      const tabEl = this.tabsContainer?.querySelector('[data-path="' + CSS.escape(filePath) + '"]');
      if (tabEl) {
        if (status) tabEl.dataset.gitStatus = status.kind;
        else delete tabEl.dataset.gitStatus;
      }
      document.querySelectorAll("#file-tree [data-path], #file-tree [data-file-path]").forEach(element => {
        const path = element.dataset.path || element.dataset.filePath;
        const item = (data.files || []).find(file => file.path === path);
        if (item) element.dataset.gitStatus = item.kind;
        else delete element.dataset.gitStatus;
      });
      if (this.activeTab !== filePath) return;
      const model = this.monacoEditor.getModel();
      if (!model) return;
      const markers = data.changedLines?.[filePath] || [];
      const decorations = markers.map(marker => ({
        range: new monaco.Range(marker.line, 1, marker.line, 1),
        options: {
          isWholeLine: true,
          className: marker.kind === "added" ? "git-added-line" : "git-modified-line",
          glyphMarginClassName: marker.kind === "added" ? "git-added-glyph" : "git-modified-glyph",
          overviewRuler: { color: marker.kind === "added" ? "#3fb950" : "#d29922", position: monaco.editor.OverviewRulerLane.Left }
        }
      }));
      const previous = this.gitDecorationIds.get(filePath) || [];
      this.gitDecorationIds.set(filePath, model.deltaDecorations(previous, decorations));
    } catch (error) {
      console.warn("Git decoration refresh failed:", error);
    }
  }

  startLiveStream(filePath) {
    if (!filePath) return;
    if (!this.openTabs.has(filePath)) {
      this.openTabs.set(filePath, { content: "", isDirty: true, language: this.detectLanguage(filePath), version: null });
      this.createTabElement(filePath);
    }
    this.selectTab(filePath);
    const hud = document.getElementById("editor-streaming-hud");
    const label = document.getElementById("hud-file-label");
    const added = document.getElementById("hud-lines-added");
    if (hud && label) { hud.style.display = "flex"; label.textContent = "Writing live: " + filePath; if (added) added.textContent = "🟢 +0 lines"; }
    this.editorView?.classList.add("streaming");
    this.tabsContainer?.querySelector('[data-path="' + CSS.escape(filePath) + '"]')?.classList.add("tab-streaming");
  }

  appendLiveStream(filePath, content) {
    if (!this.openTabs.has(filePath)) this.startLiveStream(filePath);
    if (this.activeTab !== filePath) this.selectTab(filePath);
    const tab = this.openTabs.get(filePath);
    if (tab) { tab.content = content; tab.isDirty = true; }
    this.setEditorValue(content, tab?.language || this.detectLanguage(filePath));
    if (this.monacoEditor) this.monacoEditor.revealLine(this.monacoEditor.getModel().getLineCount());
    const count = document.getElementById("hud-lines-added");
    if (count) count.textContent = "🟢 +" + content.split("\n").length + " lines";
  }

  async finishLiveStream(filePath, finalContent) {
    const tab = this.openTabs.get(filePath);
    if (tab) { tab.content = finalContent || tab.content; tab.isDirty = false; this.updateTabUI(filePath); }
    if (this.activeTab === filePath) this.setEditorValue(tab?.content || "", tab?.language || this.detectLanguage(filePath));
    this.editorView?.classList.remove("streaming");
    const hud = document.getElementById("editor-streaming-hud");
    const label = document.getElementById("hud-file-label");
    if (hud && label) { label.textContent = "✨ Completed: " + filePath; setTimeout(() => { hud.style.display = "none"; }, 3500); }
    this.tabsContainer?.querySelector('[data-path="' + CSS.escape(filePath) + '"]')?.classList.remove("tab-streaming");
    try {
      const current = this.openTabs.get(filePath);
      const response = await fetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.getItem("token") || ""), ...(current?.version ? { "If-Match": '"' + current.version + '"' } : { "If-None-Match": "*" }) },
        body: JSON.stringify({ path: filePath, content: finalContent || current?.content || "" })
      });
      if (response.ok) { const saved = await response.json().catch(() => ({})); if (current && saved.version) current.version = saved.version; }
      else if (response.status === 409) window.app?.logTerminal("Could not save " + filePath + ": another collaborator changed it. Reload before retrying.", "warning");
    } catch (error) { window.app?.logTerminal("Stream save failed: " + error.message, "error"); }
    this.saveStateToCache();
    await window.app?.loadWorkspaceFiles?.();
  }

  updateFileContent(filePath, content) {
    const tab = this.openTabs.get(filePath);
    if (!tab) return;
    tab.content = content;
    tab.isDirty = false;
    if (this.activeTab === filePath) this.setEditorValue(content, tab.language || this.detectLanguage(filePath));
    this.updateTabUI(filePath);
    this.saveStateToCache();
  }

  async saveCurrentFile() {
    if (!this.activeTab || !this.openTabs.has(this.activeTab)) return;
    const tab = this.openTabs.get(this.activeTab);
    if (this.monacoEditor && this.activeTab) tab.content = this.monacoEditor.getValue();
    const filePath = this.activeTab;
    try {
      const response = await fetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.getItem("token") || ""), ...(tab.version ? { "If-Match": '"' + tab.version + '"' } : { "If-None-Match": "*" }) },
        body: JSON.stringify({ path: filePath, content: tab.content })
      });
      if (response.status === 409) {
        const conflict = await response.json().catch(() => ({}));
        throw new Error(conflict.message || "This file changed in another session. Reload it before saving.");
      }
      if (!response.ok) throw new Error("Save failed (" + response.status + ")");
      const saved = await response.json().catch(() => ({}));
      tab.version = saved.version || tab.version;
      tab.isDirty = false;
      tab.hasRemoteConflict = false;
      this.updateTabUI(filePath);
      this.saveStateToCache();
      window.app?.logTerminal("Saved " + filePath, "success");
    } catch (err) { window.app?.logTerminal("Failed to save " + filePath + ": " + err.message, "error"); }
  }

  async handleRemoteFileChange(event) {
    if (event?.actor && event.actor === window.app?.currentUser?.id) return;
    const filePath = event?.path;
    if (!filePath || !this.openTabs.has(filePath)) return;
    const tab = this.openTabs.get(filePath);
    if (tab.isDirty) {
      tab.hasRemoteConflict = true;
      this.updateTabUI(filePath);
      window.app?.logTerminal("Another collaborator changed " + filePath + ". Your local draft was kept; reload before saving.", "warning");
      return;
    }
    try {
      const response = await fetch("/api/workspace/file?path=" + encodeURIComponent(filePath), { headers: { Authorization: "Bearer " + (localStorage.getItem("token") || "") } });
      if (!response.ok) return;
      const data = await response.json();
      tab.content = data.content;
      tab.version = data.version || null;
      tab.isDirty = false;
      tab.hasRemoteConflict = false;
      if (this.activeTab === filePath) this.setEditorValue(data.content, tab.language);
      this.updateTabUI(filePath);
      this.saveStateToCache();
    } catch (error) { console.warn("Collaborative file refresh failed:", error); }
  }

  updateTabUI(filePath) {
    const tabEl = this.tabsContainer?.querySelector('[data-path="' + CSS.escape(filePath) + '"]');
    if (!tabEl) return;
    const tab = this.openTabs.get(filePath);
    const title = filePath.split("/").pop();
    tabEl.querySelector(".tab-title").textContent = title + (tab?.isDirty ? " •" : "") + (tab?.hasRemoteConflict ? " ⚠" : "");
    tabEl.title = tab?.hasRemoteConflict ? "Remote changes detected — reload before saving" : filePath;
  }

  detectLanguage(filePath) {
    const ext = filePath.split(".").pop().toLowerCase();
    const map = { js:"javascript", mjs:"javascript", cjs:"javascript", jsx:"javascript", ts:"typescript", tsx:"typescript", py:"python", html:"html", htm:"html", css:"css", scss:"scss", less:"less", json:"json", jsonc:"json", md:"markdown", mdx:"markdown", sh:"shell", bash:"shell", sql:"sql", yml:"yaml", yaml:"yaml", xml:"xml", svg:"xml", java:"java", c:"c", h:"c", cpp:"cpp", cc:"cpp", rs:"rust", go:"go", php:"php", rb:"ruby", cs:"csharp", kt:"kotlin", swift:"swift", dockerfile:"dockerfile", toml:"ini", ini:"ini", graphql:"graphql", vue:"html", svelte:"html" };
    return map[ext] || (filePath.toLowerCase().endsWith("/dockerfile") ? "dockerfile" : "plaintext");
  }

  openQuickOpen() {
    this.showEditorDialog("Quick Open", "Type a filename to filter the workspace file list.", "filename", async value => {
      const files = Array.from(document.querySelectorAll("#file-tree [data-path], #file-tree [data-file-path]"))
        .map(el => el.dataset.path || el.dataset.filePath).filter(Boolean);
      const match = files.sort((a,b) => this.fuzzyScore(value,a) - this.fuzzyScore(value,b))[0];
      if (match) await this.openFile(match);
      else window.app?.logTerminal("No matching file found in the loaded explorer tree.", "warning");
    });
  }

  fuzzyScore(query, value) {
    const q = query.toLowerCase().replace(/\s/g, "");
    const v = value.toLowerCase();
    let at = 0, score = 0;
    for (const ch of q) { at = v.indexOf(ch, at); if (at < 0) return 1e9; score += at++; }
    return score + v.length * 0.01;
  }

  openWorkspaceSearch() {
    const input = document.getElementById("search-input");
    if (input) { input.focus(); input.placeholder = "Search workspace / web…"; }
    document.querySelector('[data-view="search"]')?.click();
  }

  openCommandPalette() {
    const actions = [
      ["Save File", () => this.saveCurrentFile()],
      ["Find", () => this.monacoEditor?.getAction("actions.find").run()],
      ["Replace", () => this.monacoEditor?.getAction("editor.action.startFindReplaceAction").run()],
      ["Quick Open", () => this.openQuickOpen()],
      ["Open in Other Group", () => this.openInOtherGroup()],
      ["Search Workspace", () => this.openWorkspaceSearch()],
      ["Toggle Minimap", () => this.monacoEditor?.updateOptions({ minimap: { enabled: !this.monacoEditor.getOption(monaco.editor.EditorOption.minimap).enabled } })],
      ["Toggle Word Wrap", () => this.monacoEditor?.updateOptions({ wordWrap: this.monacoEditor.getOption(monaco.editor.EditorOption.wordWrap) === "on" ? "off" : "on" })],
      ["Format Document", () => this.monacoEditor?.getAction("editor.action.formatDocument").run()],
      ["Go to Line", () => this.monacoEditor?.getAction("editor.action.gotoLine").run()],
      ["Keyboard Shortcuts", () => this.showShortcutHelp()]
    ];
    this.showEditorDialog("Command Palette", "Choose a command or type to filter.", "command", value => {
      const item = actions.find(([name]) => name.toLowerCase().includes(value.toLowerCase()));
      if (item) item[1]();
    }, actions.map(([name]) => name));
  }

  showEditorDialog(title, description, placeholder, onSubmit, options = []) {
    this.closeEditorDialog();
    const overlay = document.createElement("div");
    overlay.className = "editor-dialog-overlay";
    overlay.id = "editor-dialog";
    const panel = document.createElement("div");
    panel.className = "editor-dialog";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const help = document.createElement("p");
    help.textContent = description;
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.autocomplete = "off";
    const list = document.createElement("div");
    list.className = "editor-dialog-options";
    options.forEach(option => { const row = document.createElement("button"); row.textContent = option; row.addEventListener("click", () => { this.closeEditorDialog(); onSubmit(option); }); list.appendChild(row); });
    const run = document.createElement("button");
    run.className = "primary-btn";
    run.textContent = "Open";
    run.addEventListener("click", () => { const value = input.value.trim(); this.closeEditorDialog(); if (value) onSubmit(value); });
    input.addEventListener("keydown", e => { if (e.key === "Enter") run.click(); });
    panel.append(heading, help, input, list, run);
    overlay.appendChild(panel);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) this.closeEditorDialog(); });
    document.body.appendChild(overlay);
    input.focus();
  }

  closeEditorDialog() { document.getElementById("editor-dialog")?.remove(); }

  showShortcutHelp() {
    this.showEditorDialog("ATH IDE Keyboard Shortcuts", "Core editor shortcuts", "Search commands", () => {}, [
      "Ctrl/Cmd + S — Save file", "Ctrl/Cmd + F — Find in file", "Ctrl/Cmd + H — Replace in file",
      "Ctrl/Cmd + P — Quick open", "Ctrl/Cmd + Shift + P — Command palette",
      "Ctrl/Cmd + Shift + F — Workspace search", "Alt + Up/Down — Move line",
      "Ctrl/Cmd + D — Add next occurrence", "Alt + Click — Multi-cursor", "F2 — Rename symbol", "F12 — Go to definition"
    ]);
  }
}
window.editorManager = new EditorManager();
