/**
 * Code Editor & Multi-Tab Workspace Manager
 */

class EditorManager {
  constructor() {
    this.openTabs = new Map(); // path -> { content, isDirty, language }
    this.activeTab = null;
    this.tabsContainer = document.getElementById("tabs-container");
    this.welcomeScreen = document.getElementById("editor-welcome");
    this.editorView = document.getElementById("code-editor-view");
    this.saveBtn = document.getElementById("btn-save-file");

    this.initEventListeners();
    this.restoreStateFromCache();
  }

  initEventListeners() {
    if (this.saveBtn) {
      this.saveBtn.addEventListener("click", () => this.saveCurrentFile());
    }

    // Ctrl+S / Cmd+S shortcut
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        this.saveCurrentFile();
      }
    });

    // Make editor content editable & auto-cache drafts
    if (this.editorView) {
      this.editorView.setAttribute("contenteditable", "true");
      this.editorView.addEventListener("input", () => {
        if (this.activeTab && this.openTabs.has(this.activeTab)) {
          const tab = this.openTabs.get(this.activeTab);
          tab.content = this.editorView.innerText;
          tab.isDirty = true;
          this.updateTabUI(this.activeTab);
          this.saveStateToCache();
        }
      });
    }
  }

  /**
   * Save open tabs and active file to LocalStorage Cache.
   */
  saveStateToCache() {
    try {
      const tabsArray = [];
      for (const [path, data] of this.openTabs.entries()) {
        tabsArray.push({ path, content: data.content, isDirty: data.isDirty });
      }
      localStorage.setItem("ath_cached_editor_tabs", JSON.stringify(tabsArray));
      localStorage.setItem("ath_cached_active_tab", this.activeTab || "");
    } catch {}
  }

  /**
   * Restore open tabs and active file from LocalStorage Cache.
   */
  restoreStateFromCache() {
    try {
      const rawTabs = localStorage.getItem("ath_cached_editor_tabs");
      const activeTab = localStorage.getItem("ath_cached_active_tab");
      if (!rawTabs) return;

      const tabs = JSON.parse(rawTabs);
      if (Array.isArray(tabs) && tabs.length > 0) {
        tabs.forEach((tab) => {
          this.openTabs.set(tab.path, {
            content: tab.content,
            isDirty: tab.isDirty || false,
            language: this.detectLanguage(tab.path),
          });
          this.createTabElement(tab.path);
        });

        const targetTab = (activeTab && this.openTabs.has(activeTab)) ? activeTab : tabs[0].path;
        this.selectTab(targetTab);
      }
    } catch (e) {
      console.warn("Editor cache restore notice:", e);
    }
  }

  /**
   * Open a file in a new or existing editor tab.
   */
  async openFile(filePath) {
    if (this.openTabs.has(filePath)) {
      this.selectTab(filePath);
      return;
    }

    try {
      const response = await fetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to read ${filePath}`);
      }

      const data = await response.json();
      const language = this.detectLanguage(filePath);

      this.openTabs.set(filePath, {
        content: data.content,
        isDirty: false,
        language,
      });

      this.createTabElement(filePath);
      this.selectTab(filePath);
      this.saveStateToCache();
    } catch (err) {
      console.error("Open file error:", err);
      app.logTerminal(`Error opening ${filePath}: ${err.message}`, "error");
    }
  }

  /**
   * Create tab DOM element.
   */
  createTabElement(filePath) {
    const tab = document.createElement("div");
    tab.className = "editor-tab";
    tab.dataset.path = filePath;

    const fileName = filePath.split("/").pop();
    tab.innerHTML = `
      <span class="tab-title">${fileName}</span>
      <button class="tab-close-btn" title="Close Tab">&times;</button>
    `;

    tab.addEventListener("click", (e) => {
      if (!e.target.classList.contains("tab-close-btn")) {
        this.selectTab(filePath);
      }
    });

    tab.querySelector(".tab-close-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(filePath);
    });

    this.tabsContainer.appendChild(tab);
  }

  /**
   * Select and display active tab.
   */
  selectTab(filePath) {
    this.activeTab = filePath;
    const activeFileEl = document.getElementById("status-active-file");
    if (activeFileEl) {
      activeFileEl.textContent = filePath;
    }
    const tabData = this.openTabs.get(filePath);
    if (!tabData) return;

    // Update tab bar UI
    document.querySelectorAll(".editor-tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.path === filePath);
    });

    // Hide welcome, show editor
    if (this.welcomeScreen) this.welcomeScreen.style.display = "none";
    if (this.editorView) {
      this.editorView.style.display = "block";
      this.editorView.innerText = tabData.content;
    }
    this.saveStateToCache();
  }

  /**
   * Close a tab.
   */
  closeTab(filePath) {
    this.openTabs.delete(filePath);
    const tabEl = this.tabsContainer.querySelector(`[data-path="${filePath}"]`);
    if (tabEl) tabEl.remove();

    if (this.activeTab === filePath) {
      const remainingKeys = Array.from(this.openTabs.keys());
      if (remainingKeys.length > 0) {
        this.selectTab(remainingKeys[remainingKeys.length - 1]);
      } else {
        this.activeTab = null;
        if (this.welcomeScreen) this.welcomeScreen.style.display = "flex";
        if (this.editorView) this.editorView.style.display = "none";
        const activeFileEl = document.getElementById("status-active-file");
        if (activeFileEl) activeFileEl.textContent = "No file open";
      }
    }
    this.saveStateToCache();
  }

  /**
   * Start Live Real-time Streaming into the Editor
   */
  startLiveStream(filePath) {
    if (!filePath) return;

    if (!this.openTabs.has(filePath)) {
      this.openTabs.set(filePath, {
        content: "",
        isDirty: true,
        language: this.detectLanguage(filePath),
      });
      this.createTabElement(filePath);
    }

    this.selectTab(filePath);

    // Show live streaming HUD
    const hud = document.getElementById("editor-streaming-hud");
    const hudLabel = document.getElementById("hud-file-label");
    const hudAdded = document.getElementById("hud-lines-added");
    if (hud && hudLabel) {
      hud.style.display = "flex";
      hudLabel.textContent = `Writing live: ${filePath}`;
      if (hudAdded) hudAdded.textContent = "🟢 +0 lines";
    }

    if (this.editorView) {
      this.editorView.classList.add("streaming");
    }

    // Set tab pulsing indicator
    const tabEl = this.tabsContainer?.querySelector(`[data-path="${filePath}"]`);
    if (tabEl) {
      tabEl.classList.add("tab-streaming");
    }
  }

  /**
   * Stream incoming code content in real-time
   */
  appendLiveStream(filePath, currentContent) {
    if (!this.openTabs.has(filePath)) {
      this.startLiveStream(filePath);
    }

    if (this.activeTab !== filePath) {
      this.selectTab(filePath);
    }

    const tab = this.openTabs.get(filePath);
    if (tab) {
      tab.content = currentContent;
      tab.isDirty = true;
    }

    if (this.editorView) {
      this.editorView.innerText = currentContent;
      this.editorView.scrollTop = this.editorView.scrollHeight;
    }

    // Update lines count
    const lines = currentContent.split("\n").length;
    const hudAdded = document.getElementById("hud-lines-added");
    if (hudAdded) {
      hudAdded.textContent = `🟢 +${lines} lines`;
    }
  }

  /**
   * Finish Live Streaming and commit file
   */
  async finishLiveStream(filePath, finalContent) {
    if (this.openTabs.has(filePath)) {
      const tab = this.openTabs.get(filePath);
      tab.content = finalContent || tab.content;
      tab.isDirty = false;
      this.updateTabUI(filePath);
    }

    if (this.editorView) {
      this.editorView.classList.remove("streaming");
      if (finalContent) {
        this.editorView.innerText = finalContent;
      }
    }

    const hud = document.getElementById("editor-streaming-hud");
    const hudLabel = document.getElementById("hud-file-label");
    if (hud && hudLabel) {
      hudLabel.textContent = `✨ Completed: ${filePath}`;
      setTimeout(() => {
        if (hud) hud.style.display = "none";
      }, 3500);
    }

    const tabEl = this.tabsContainer?.querySelector(`[data-path="${filePath}"]`);
    if (tabEl) {
      tabEl.classList.remove("tab-streaming");
    }

    // Auto save to workspace on backend
    try {
      await fetch("/api/workspace/file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
        },
        body: JSON.stringify({
          path: filePath,
          content: finalContent || this.openTabs.get(filePath)?.content || "",
        }),
      });
    } catch {}

    this.saveStateToCache();
    if (window.app?.loadWorkspaceFiles) {
      await window.app.loadWorkspaceFiles();
    }
  }

  /**
   * Update active tab content externally (e.g. When AI Agent writes to file).
   */
  updateFileContent(filePath, newContent) {
    if (this.openTabs.has(filePath)) {
      const tab = this.openTabs.get(filePath);
      tab.content = newContent;
      tab.isDirty = false;
      if (this.activeTab === filePath && this.editorView) {
        this.editorView.innerText = newContent;
      }
      this.saveStateToCache();
    }
  }

  /**
   * Save current file to server.
   */
  async saveCurrentFile() {
    if (!this.activeTab || !this.openTabs.has(this.activeTab)) return;

    const tab = this.openTabs.get(this.activeTab);
    const filePath = this.activeTab;

    try {
      const response = await fetch("/api/workspace/file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
        },
        body: JSON.stringify({
          path: filePath,
          content: tab.content,
        }),
      });

      if (!response.ok) throw new Error("Save failed");

      tab.isDirty = false;
      this.updateTabUI(filePath);
      this.saveStateToCache();
      app.logTerminal(`Saved ${filePath}`, "success");
    } catch (err) {
      app.logTerminal(`Failed to save ${filePath}: ${err.message}`, "error");
    }
  }

  updateTabUI(filePath) {
    const tabEl = this.tabsContainer.querySelector(`[data-path="${filePath}"]`);
    if (!tabEl) return;
    const tabData = this.openTabs.get(filePath);
    const fileName = filePath.split("/").pop();
    tabEl.querySelector(".tab-title").textContent = `${fileName}${tabData?.isDirty ? " •" : ""}`;
  }

  detectLanguage(filePath) {
    const ext = filePath.split(".").pop().toLowerCase();
    const map = {
      js: "javascript",
      py: "python",
      html: "html",
      css: "css",
      json: "json",
      md: "markdown",
      sh: "bash",
      sql: "sql",
    };
    return map[ext] || "plaintext";
  }
}

window.editorManager = new EditorManager();
