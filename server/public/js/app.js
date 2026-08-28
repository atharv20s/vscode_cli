/**
 * Agentic AI Studio — Main Application Controller (Cursor-Style IDE)
 */

class App {
  constructor() {
    this.currentMode = "agent";
    this.currentModel = "devstral";
    this.token = localStorage.getItem("token") || "";
    this.currentAssistantMessageEl = null;
    this.currentAssistantContent = "";
    this.currentThinkingEl = null;
    this.currentThinkingContent = "";
    this.sessionTokens = 0;
    this.chatHistory = [];

    this.init();
  }

  async init() {
    this.handleUrlAuth();
    await this.ensureUserToken();
    this.setupEventListeners();
    this.initResizers();
    this.initWebSocket();
    this.initPreviewUI();
    this.restoreChatFromCache();
    await this.loadWorkspaceFiles();
    await this.loadMcpServers();
    this.checkAuthStatus();
  }

  /**
   * Auto-provisions or restores a persistent guest JWT token if not authenticated.
   */
  async ensureUserToken() {
    let guestId = localStorage.getItem("ath_guest_id");
    if (!guestId) {
      guestId = "gst_" + Math.random().toString(36).slice(2, 12);
      localStorage.setItem("ath_guest_id", guestId);
    }

    if (!this.token) {
      try {
        const res = await fetch("/api/auth/guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guestId }),
        });
        if (res.ok) {
          const data = await res.json();
          this.token = data.token;
          localStorage.setItem("token", data.token);
          this.guestUser = data.user;
        }
      } catch (e) {
        console.warn("Guest identity auto-provisioning note:", e);
      }
    }
  }

  /**
   * Handle OAuth token in URL query params if returning from GitHub redirect.
   */
  handleUrlAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    const ghToken = urlParams.get("github_token");

    if (token) {
      this.token = token;
      localStorage.setItem("token", token);
    }
    if (ghToken) {
      localStorage.setItem("github_user_token", ghToken);
    }

    if (token || ghToken) {
      window.history.replaceState({}, document.title, window.location.pathname);
      this.logTerminal("Successfully authenticated with GitHub!", "success");
    }

    // Check if redirect requested GitHub modal (e.g. if OAuth not yet configured)
    if (urlParams.get("github_modal") === "true") {
      const ghModal = document.getElementById("github-connect-modal");
      if (ghModal) ghModal.classList.remove("hidden");
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  /**
   * Initialize WebSocket connection and event handlers.
   */
  initWebSocket() {
    window.wsClient.connect(this.token);

    // Agent Streaming Events
    window.wsClient.on("turn_start", (data) => {
      this.logTerminal(`[Agent] Turn ${data.turn}/${data.maxTurns} started...`, "info");
      const agentStateEl = document.getElementById("status-agent-state");
      if (agentStateEl) agentStateEl.textContent = "Agent: Task execution started";
      const turnEl = document.getElementById("status-turn-count");
      if (turnEl) turnEl.textContent = `Turn: ${data.turn}/${data.maxTurns}`;
    });

    window.wsClient.on("thinking_start", () => {
      this.createThinkingCard();
      const agentStateEl = document.getElementById("status-agent-state");
      if (agentStateEl) agentStateEl.textContent = "Agent: Thinking...";
    });

    window.wsClient.on("thinking_delta", (data) => {
      this.appendThinking(data.content || "");
    });

    window.wsClient.on("thinking_end", () => {
      if (this.currentThinkingEl) {
        const pulse = this.currentThinkingEl.querySelector(".thinking-pulse");
        if (pulse) pulse.style.display = "none";
      }
    });

    window.wsClient.on("text_delta", (data) => {
      this.appendAssistantText(data.content || "");
    });

    window.wsClient.on("tool_start", (data) => {
      this.renderToolStart(data);
      const agentStateEl = document.getElementById("status-agent-state");
      if (agentStateEl) agentStateEl.textContent = `Agent: Running ${data.name}...`;
    });

    window.wsClient.on("tool_result", (data) => {
      this.renderToolResult(data);
      // Auto-refresh file tree and open file if files were written
      if (["write_file", "edit_file"].includes(data.name)) {
        this.loadWorkspaceFiles();
        if (data.args?.path) {
          window.editorManager?.openFile(data.args.path);
        }
      }
    });

    window.wsClient.on("done", (data) => {
      this.finalizeMessage();
      this.setGeneratingState(false);
      this.loadWorkspaceFiles();
      if (data.totalTokens) {
        this.sessionTokens += data.totalTokens;
        document.getElementById("session-token-count").textContent = `${this.sessionTokens} tokens`;
      }
      if (data.aborted) {
        this.logTerminal(`[Agent] Task aborted by user.`, "info");
      } else {
        this.logTerminal(`[Agent] Task completed successfully.`, "success");
      }
      const agentStateEl = document.getElementById("status-agent-state");
      if (agentStateEl) agentStateEl.textContent = "Agent: Idle";
    });

    window.wsClient.on("aborted", (data) => {
      this.finalizeMessage();
      this.setGeneratingState(false);
      this.logTerminal(`[Agent] Generation stopped.`, "info");
      const agentStateEl = document.getElementById("status-agent-state");
      if (agentStateEl) agentStateEl.textContent = "Agent: Idle";
    });

    window.wsClient.on("error", (data) => {
      this.renderError(data.message || "An unexpected error occurred.");
      this.finalizeMessage();
      this.setGeneratingState(false);
      this.logTerminal(`[Agent Error] ${data.message}`, "error");
      const agentStateEl = document.getElementById("status-agent-state");
      if (agentStateEl) agentStateEl.textContent = "Agent: Stopped/Error";
    });

    window.wsClient.on("connected", (data) => {
      if (data && data.workspace) {
        const workspacePathEl = document.getElementById("status-workspace-path");
        if (workspacePathEl) workspacePathEl.textContent = `WS: ${data.workspace}`;
      }
    });

    // Terminal State & Output Listeners
    window.wsClient.on("open", () => {
      window.wsClient.send("terminal.init", {
        shell: this.currentShell || "powershell",
        cols: this.term ? this.term.cols : 80,
        rows: this.term ? this.term.rows : 24
      });
    });

    if (window.wsClient.isConnected) {
      window.wsClient.send("terminal.init", {
        shell: this.currentShell || "powershell",
        cols: this.term ? this.term.cols : 80,
        rows: this.term ? this.term.rows : 24
      });
    }

    window.wsClient.on("terminal.output", (data) => {
      if (data && data.text && this.term) {
        this.term.write(data.text);
      }
    });

    window.wsClient.on("terminal_output", (data) => {
      if (data && data.text && this.term) {
        this.term.write(data.text);
      }
    });

    window.wsClient.on("terminal.state", (data) => {
      if (!data) return;
      const dot = document.getElementById("term-status-dot");
      const stateLabel = document.getElementById("term-state-label");
      const shellLabel = document.getElementById("term-shell-label");
      const cwdLabel = document.getElementById("term-cwd-label");
      const pidLabel = document.getElementById("term-pid-label");

      if (stateLabel) stateLabel.textContent = data.state === "ready" ? "Ready" : data.state;
      if (shellLabel && data.shell) shellLabel.textContent = data.shell;
      if (cwdLabel && data.cwd) {
        const parts = data.cwd.replace(/\\/g, "/").split("/");
        cwdLabel.textContent = parts.slice(-2).join("/");
      }
      if (pidLabel) pidLabel.textContent = data.pid ? `PID: ${data.pid}` : "PID: --";
      if (dot) {
        dot.style.background = data.state === "ready" || data.state === "running" ? "#10b981" : "#f59e0b";
      }
    });

    window.wsClient.on("terminal.exit", (data) => {
      if (this.term) {
        this.term.write(`\r\n[System] Terminal session exited with code ${data.code}.\r\n`);
      }
    });

    window.wsClient.on("terminal_exit", (data) => {
      if (this.term) {
        this.term.write(`\r\n[System] Terminal session exited with code ${data.code}.\r\n`);
      }
    });

    // Agent Background Task Banner Listeners
    window.wsClient.on("agent.command.started", (data) => {
      const banner = document.getElementById("agent-exec-banner");
      const label = document.getElementById("agent-exec-label");
      if (banner && label) {
        label.textContent = `Agent executing: ${data.command || "background task"}`;
        banner.style.display = "flex";
        this.activeBgOperationId = data.operationId;
      }
    });

    window.wsClient.on("agent.command.completed", () => {
      const banner = document.getElementById("agent-exec-banner");
      if (banner) {
        banner.style.display = "none";
      }
      this.activeBgOperationId = null;
    });

    // File System Sync Listener
    window.wsClient.on("file.changed", () => {
      this.loadWorkspaceFiles();
    });
  }

  /**
   * Setup UI Event Listeners
   */
  setupEventListeners() {
    // Before Unload Session Guard & Cloud Sync Warning
    window.addEventListener("beforeunload", (e) => {
      const isGuest = !this.currentUser || this.currentUser.isGuest;
      const hasChats = this.chatHistory.length > 0;
      if (isGuest && hasChats) {
        const msg = "You are currently in guest mode. Sign in or connect your GitHub account to permanently save your projects and conversations in the cloud!";
        e.preventDefault();
        e.returnValue = msg;
        return msg;
      }
    });

    // Mode Switcher
    document.querySelectorAll(".mode-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mode-chip").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentMode = btn.dataset.mode;
        this.logTerminal(`Mode changed to: ${this.currentMode.toUpperCase()}`, "info");
      });
    });

    // Activity Bar Navigation
    document.querySelectorAll(".activity-btn[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".activity-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const view = btn.dataset.view;
        document.querySelectorAll(".sidebar-view").forEach((v) => v.classList.remove("active"));
        const targetView = document.getElementById(`view-${view}`);
        if (targetView) targetView.classList.add("active");
      });
    });

    // Bottom Panel Tabs
    document.querySelectorAll(".panel-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".panel-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const panel = tab.dataset.panel;
        document.querySelectorAll(".panel-view").forEach((p) => p.classList.remove("active"));
        const targetPanel = document.getElementById(`panel-${panel}`);
        if (targetPanel) targetPanel.classList.add("active");
      });
    });

    // Bottom Panel Collapse
    const togglePanelBtn = document.getElementById("btn-toggle-panel");
    const bottomPanel = document.getElementById("bottom-panel");
    if (togglePanelBtn && bottomPanel) {
      togglePanelBtn.addEventListener("click", () => {
        bottomPanel.classList.toggle("collapsed");
      });
    }

    // Explorer Header Actions (New File, New Folder, Refresh)
    const btnNewFile = document.getElementById("btn-new-file");
    const btnNewFolder = document.getElementById("btn-new-folder");
    const btnRefreshFiles = document.getElementById("btn-refresh-files");

    if (btnNewFile) btnNewFile.addEventListener("click", () => this.createNewFile());
    if (btnNewFolder) btnNewFolder.addEventListener("click", () => this.createNewFolder());
    if (btnRefreshFiles) btnRefreshFiles.addEventListener("click", () => this.loadWorkspaceFiles());

    // Send AI Message
    const sendBtn = document.getElementById("btn-send-agent");
    const stopBtn = document.getElementById("btn-stop-agent");
    const composerInput = document.getElementById("composer-input");

    if (sendBtn && composerInput) {
      sendBtn.addEventListener("click", () => this.sendMessage());
      composerInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener("click", () => this.stopGeneration());
    }

    // Image Attachments & Multimodal Paste / Drop
    this.pendingImages = [];
    const imgInput = document.getElementById("composer-image-input");
    if (imgInput) {
      imgInput.addEventListener("change", (e) => {
        if (e.target.files) this.handleImageFiles(Array.from(e.target.files));
        imgInput.value = "";
      });
    }

    if (composerInput) {
      composerInput.addEventListener("paste", (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imgFiles = [];
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) imgFiles.push(file);
          }
        }
        if (imgFiles.length > 0) {
          this.handleImageFiles(imgFiles);
        }
      });
    }

    const composerBox = document.querySelector(".composer-container");
    if (composerBox) {
      composerBox.addEventListener("dragover", (e) => {
        e.preventDefault();
        composerBox.style.borderColor = "var(--primary-light)";
      });
      composerBox.addEventListener("dragleave", () => {
        composerBox.style.borderColor = "";
      });
      composerBox.addEventListener("drop", (e) => {
        e.preventDefault();
        composerBox.style.borderColor = "";
        if (e.dataTransfer?.files) {
          const imgFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (imgFiles.length > 0) this.handleImageFiles(imgFiles);
        }
      });
    }

    // Thread Selector Menu Dropdown
    const threadsMenuBtn = document.getElementById("btn-threads-menu");
    const threadsPopover = document.getElementById("inline-threads-popover");

    if (threadsMenuBtn && threadsPopover) {
      threadsMenuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = threadsPopover.style.display === "none" || !threadsPopover.style.display;
        threadsPopover.style.display = isHidden ? "block" : "none";
        if (isHidden) {
          this.loadInlineThreads();
        }
      });

      document.addEventListener("click", (e) => {
        if (!threadsPopover.contains(e.target) && e.target !== threadsMenuBtn) {
          threadsPopover.style.display = "none";
        }
      });
    }

    // New Chat Button
    const newChatBtn = document.getElementById("btn-new-chat");
    if (newChatBtn) newChatBtn.addEventListener("click", () => this.startNewConversation());

    // Clear Conversation Button
    const clearChatBtn = document.getElementById("btn-clear-chat");
    if (clearChatBtn) {
      clearChatBtn.addEventListener("click", () => {
        this.clearChatHistory();
      });
    }

    // Refresh Files button
    const refreshFilesBtn = document.getElementById("btn-refresh-files");
    if (refreshFilesBtn) {
      refreshFilesBtn.addEventListener("click", () => this.loadWorkspaceFiles());
    }

    // New File Button
    const newFileBtn = document.getElementById("btn-new-file");
    if (newFileBtn) {
      newFileBtn.addEventListener("click", async () => {
        const fileName = prompt("Enter new file path (e.g., src/index.js):");
        if (fileName) {
          await fetch("/api/workspace/file", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify({ path: fileName, content: "" }),
          });
          await this.loadWorkspaceFiles();
          window.editorManager.openFile(fileName);
        }
      });
    }

    // Settings / Preferences Modal
    const settingsBtn = document.getElementById("btn-settings");
    const settingsModal = document.getElementById("settings-modal");
    const savePrefBtn = document.getElementById("btn-save-settings");

    if (settingsBtn && settingsModal) {
      settingsBtn.addEventListener("click", () => {
        const savedFont = localStorage.getItem("ath_editor_font_size") || "14";
        const savedShell = localStorage.getItem("ath_terminal_shell") || "powershell";
        const savedWrap = localStorage.getItem("ath_editor_word_wrap") || "on";

        const fontSelect = document.getElementById("pref-font-size");
        const shellPrefSelect = document.getElementById("pref-default-shell");
        const wrapSelect = document.getElementById("pref-word-wrap");

        if (fontSelect) fontSelect.value = savedFont;
        if (shellPrefSelect) shellPrefSelect.value = savedShell;
        if (wrapSelect) wrapSelect.value = savedWrap;

        settingsModal.classList.remove("hidden");
      });
    }

    if (savePrefBtn) {
      savePrefBtn.addEventListener("click", () => {
        const fontVal = document.getElementById("pref-font-size")?.value || "14";
        const shellVal = document.getElementById("pref-default-shell")?.value || "powershell";
        const wrapVal = document.getElementById("pref-word-wrap")?.value || "on";

        localStorage.setItem("ath_editor_font_size", fontVal);
        localStorage.setItem("ath_terminal_shell", shellVal);
        localStorage.setItem("ath_editor_word_wrap", wrapVal);

        if (window.editorManager?.editor) {
          window.editorManager.editor.updateOptions({
            fontSize: parseInt(fontVal, 10),
            wordWrap: wrapVal,
          });
        }

        const shellSelect = document.getElementById("terminal-shell-select");
        if (shellSelect) {
          shellSelect.value = shellVal;
          this.currentShell = shellVal;
        }

        settingsModal?.classList.add("hidden");
        this.logTerminal("Studio preferences applied.", "success");
      });
    }

    // Model Selector & Tier
    const modelSelect = document.getElementById("model-select");
    if (modelSelect) {
      const savedModel = localStorage.getItem("ath_selected_model") || "devstral";
      modelSelect.value = savedModel;
      this.currentModel = savedModel;
      modelSelect.addEventListener("change", (e) => {
        this.currentModel = e.target.value;
        localStorage.setItem("ath_selected_model", this.currentModel);
        this.logTerminal(`[Model] Active reasoning tier set to ${this.currentModel}`, "info");
      });
    }

    // Terminal Shell Selector
    const shellSelect = document.getElementById("terminal-shell-select");
    const promptLabel = document.getElementById("terminal-prompt-label");
    this.currentShell = localStorage.getItem("ath_terminal_shell") || "powershell";
    if (shellSelect) {
      shellSelect.value = this.currentShell;
      if (promptLabel) {
        promptLabel.textContent = this.currentShell === "wsl" ? "wsl:bash$" : (this.currentShell === "cmd" ? "cmd$" : "pwsh$");
      }
      shellSelect.addEventListener("change", (e) => {
        this.currentShell = e.target.value;
        localStorage.setItem("ath_terminal_shell", this.currentShell);
        if (promptLabel) {
          promptLabel.textContent = this.currentShell === "wsl" ? "wsl:bash$" : (this.currentShell === "cmd" ? "cmd$" : "pwsh$");
        }
        this.logTerminal(`[Terminal] Switched environment to ${this.currentShell.toUpperCase()}`, "info");
        // Re-initialize terminal via WebSocket
        window.wsClient.send("terminal_init", { shell: this.currentShell });
      });
    }

    // Top Bar Sign In / Sign Up buttons
    const btnTopSignIn = document.getElementById("btn-top-signin");
    const btnTopSignUp = document.getElementById("btn-top-signup");
    const authModal = document.getElementById("auth-modal");
    const authModalTitle = document.getElementById("auth-modal-title");
    const authFormContainer = document.getElementById("auth-form-container");
    const authProfileContainer = document.getElementById("auth-profile-container");
    const tabLogin = document.getElementById("tab-auth-login");
    const tabRegister = document.getElementById("tab-auth-register");
    const authInputEmail = document.getElementById("auth-input-email");
    const authInputPassword = document.getElementById("auth-input-password");
    const btnSubmitAuth = document.getElementById("btn-submit-auth");
    const authErrorMsg = document.getElementById("auth-error-msg");
    let authMode = "login"; // "login" | "register"

    const openAuthModal = (mode = "login") => {
      authMode = mode;
      if (authModal) authModal.classList.remove("hidden");
      if (authFormContainer) authFormContainer.classList.remove("hidden");
      if (authProfileContainer) authProfileContainer.classList.add("hidden");
      if (authErrorMsg) authErrorMsg.style.display = "none";

      if (mode === "login") {
        if (tabLogin) {
          tabLogin.classList.add("active");
          tabLogin.style.borderBottom = "2px solid var(--accent)";
          tabLogin.style.color = "#fff";
        }
        if (tabRegister) {
          tabRegister.classList.remove("active");
          tabRegister.style.borderBottom = "2px solid transparent";
          tabRegister.style.color = "var(--text-muted)";
        }
        if (btnSubmitAuth) btnSubmitAuth.textContent = "Sign In";
        if (authModalTitle) authModalTitle.innerHTML = '<i data-lucide="log-in"></i> Account Sign In';
      } else {
        if (tabRegister) {
          tabRegister.classList.add("active");
          tabRegister.style.borderBottom = "2px solid var(--accent)";
          tabRegister.style.color = "#fff";
        }
        if (tabLogin) {
          tabLogin.classList.remove("active");
          tabLogin.style.borderBottom = "2px solid transparent";
          tabLogin.style.color = "var(--text-muted)";
        }
        if (btnSubmitAuth) btnSubmitAuth.textContent = "Create Account";
        if (authModalTitle) authModalTitle.innerHTML = '<i data-lucide="user-plus"></i> Create New Account';
      }
      if (window.lucide) window.lucide.createIcons();
    };

    if (btnTopSignIn) btnTopSignIn.addEventListener("click", () => openAuthModal("login"));
    if (btnTopSignUp) btnTopSignUp.addEventListener("click", () => openAuthModal("register"));

    // User Profile Dropdown Popover
    const userProfileBtn = document.getElementById("user-profile-btn");
    const accountPopover = document.getElementById("account-popover");
    const popoverLogoutBtn = document.getElementById("btn-popover-logout");
    const popoverGithubBtn = document.getElementById("btn-popover-github");

    if (userProfileBtn && accountPopover) {
      userProfileBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = accountPopover.style.display === "none" || !accountPopover.style.display;
        accountPopover.style.display = isHidden ? "block" : "none";
      });

      document.addEventListener("click", (e) => {
        if (!accountPopover.contains(e.target) && e.target !== userProfileBtn) {
          accountPopover.style.display = "none";
        }
      });
    }

    if (popoverGithubBtn) {
      popoverGithubBtn.addEventListener("click", () => {
        if (accountPopover) accountPopover.style.display = "none";
        document.getElementById("github-connect-modal")?.classList.remove("hidden");
      });
    }

    if (popoverLogoutBtn) {
      popoverLogoutBtn.addEventListener("click", () => {
        if (accountPopover) accountPopover.style.display = "none";
        this.logout();
      });
    }

    if (tabLogin && tabRegister) {
      tabLogin.addEventListener("click", () => {
        authMode = "login";
        tabLogin.classList.add("active");
        tabLogin.style.borderBottomColor = "var(--accent)";
        tabLogin.style.color = "#fff";
        tabRegister.classList.remove("active");
        tabRegister.style.borderBottomColor = "transparent";
        tabRegister.style.color = "var(--text-muted)";
        if (btnSubmitAuth) btnSubmitAuth.textContent = "Sign In";
        if (authErrorMsg) authErrorMsg.style.display = "none";
      });

      tabRegister.addEventListener("click", () => {
        authMode = "register";
        tabRegister.classList.add("active");
        tabRegister.style.borderBottomColor = "var(--accent)";
        tabRegister.style.color = "#fff";
        tabLogin.classList.remove("active");
        tabLogin.style.borderBottomColor = "transparent";
        tabLogin.style.color = "var(--text-muted)";
        if (btnSubmitAuth) btnSubmitAuth.textContent = "Create Account";
        if (authErrorMsg) authErrorMsg.style.display = "none";
      });
    }

    if (btnSubmitAuth) {
      btnSubmitAuth.addEventListener("click", async () => {
        const email = authInputEmail?.value.trim();
        const password = authInputPassword?.value;

        if (!email || !password) {
          if (authErrorMsg) {
            authErrorMsg.textContent = "Please enter your email address and password.";
            authErrorMsg.style.display = "block";
          }
          return;
        }

        btnSubmitAuth.disabled = true;
        btnSubmitAuth.textContent = authMode === "login" ? "Signing In..." : "Creating Account...";
        if (authErrorMsg) authErrorMsg.style.display = "none";

        try {
          const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
          const payload = { email, password };

          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.message || "Authentication failed.");

          this.token = data.token;
          this.currentUser = data.user;
          localStorage.setItem("token", data.token);

          if (data.githubToken) {
            localStorage.setItem("github_user_token", data.githubToken);
            await this.loadGitHubRepos();
          }

          this.updateUserUI(data.user);
          authModal.classList.add("hidden");
          this.logTerminal(`Successfully authenticated as ${data.user.email || data.user.username}`, "success");
        } catch (err) {
          if (authErrorMsg) {
            authErrorMsg.textContent = err.message;
            authErrorMsg.style.display = "block";
          }
        } finally {
          btnSubmitAuth.disabled = false;
          btnSubmitAuth.textContent = authMode === "login" ? "Sign In" : "Create Account";
        }
      });
    }

    // Connect GitHub button from inside profile
    const connectGhFromProfile = document.getElementById("btn-connect-gh-from-profile");
    if (connectGhFromProfile) {
      connectGhFromProfile.addEventListener("click", () => {
        authModal.classList.add("hidden");
        const ghModal = document.getElementById("github-connect-modal");
        if (ghModal) ghModal.classList.remove("hidden");
      });
    }

    // Logout button
    const logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        this.token = null;
        this.currentUser = null;
        localStorage.removeItem("token");
        localStorage.removeItem("github_user_token");
        this.updateUserUI(null);
        authModal.classList.add("hidden");
        this.logTerminal("Logged out successfully.", "info");
      });
    }

    // GitHub Modal Triggers
    const ghBtn = document.getElementById("github-btn");
    const ghModal = document.getElementById("github-connect-modal");
    const inlineGhBtn = document.getElementById("btn-connect-gh-inline");

    const openGhModal = () => {
      if (ghModal) ghModal.classList.remove("hidden");
    };

    if (ghBtn) ghBtn.addEventListener("click", openGhModal);
    if (inlineGhBtn) inlineGhBtn.addEventListener("click", openGhModal);

    // Direct Token Connect Button
    const directTokenBtn = document.getElementById("btn-connect-direct-token");
    const directTokenInput = document.getElementById("input-direct-gh-token");

    if (directTokenBtn && directTokenInput) {
      directTokenBtn.addEventListener("click", async () => {
        const tokenVal = directTokenInput.value.trim();
        if (!tokenVal) {
          alert("Please enter a GitHub Personal Access Token.");
          return;
        }

        directTokenBtn.disabled = true;
        directTokenBtn.textContent = "Connecting...";

        try {
          // If already logged in, link to existing account
          const endpoint = this.token ? "/api/auth/connect-github" : "/api/auth/token-login";
          const headers = {
            "Content-Type": "application/json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          };

          const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ token: tokenVal }),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.message || "Failed to connect token");

          if (data.token) {
            this.token = data.token;
            localStorage.setItem("token", data.token);
          }
          localStorage.setItem("github_user_token", tokenVal);

          if (ghModal) ghModal.classList.add("hidden");

          const userObj = data.user || data.githubUser || { username: "Connected" };
          this.currentUser = { ...this.currentUser, ...userObj, hasGithub: true };
          this.updateUserUI(this.currentUser);

          this.logTerminal(`Connected to GitHub as @${userObj.username}`, "success");
          await this.loadGitHubRepos();
        } catch (err) {
          alert(`GitHub Connection Error: ${err.message}`);
          this.logTerminal(`GitHub Error: ${err.message}`, "error");
        } finally {
          directTokenBtn.disabled = false;
          directTokenBtn.innerHTML = '<i data-lucide="check-circle"></i> Connect & Save';
          if (window.lucide) window.lucide.createIcons();
        }
      });
    }

    // Terminal Input & Right-Click to Paste
    this.initTerminalUI();
  }

  async executeTerminalCommand(cmd) {
    if (!cmd) return;
    if (window.wsClient.isConnected) {
      window.wsClient.send("terminal_input", { command: cmd + "\r" });
    }
  }

  /**
   * Load files in the workspace with inline Delete & Move actions.
   */
  async loadWorkspaceFiles() {
    const fileTree = document.getElementById("file-tree");
    if (!fileTree) return;

    try {
      const headers = {};
      if (this.token && this.token !== "null" && this.token !== "undefined") {
        headers["Authorization"] = `Bearer ${this.token}`;
      }

      const response = await fetch("/api/workspace/files", { headers });
      const data = await response.json();

      if (data.entries && data.entries.length > 0) {
        fileTree.innerHTML = "";
        data.entries.forEach((item) => {
          const itemEl = document.createElement("div");
          itemEl.className = `tree-item ${item.isDirectory ? "dir" : "file"}`;
          itemEl.dataset.path = item.path;

          itemEl.innerHTML = `
            <div class="tree-item-left" title="${this.escapeHtml(item.path)}">
              <i data-lucide="${item.isDirectory ? "folder" : "file-code"}" class="tree-icon"></i>
              <span class="tree-item-name">${this.escapeHtml(item.name)}</span>
            </div>
            <div class="tree-item-actions">
              <button class="tree-act-btn btn-move-item" title="Rename / Move"><i data-lucide="folder-input" style="width:13px;height:13px;"></i></button>
              <button class="tree-act-btn delete btn-delete-item" title="Delete"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
            </div>
          `;

          // Click to open file in editor
          const leftEl = itemEl.querySelector(".tree-item-left");
          if (!item.isDirectory && leftEl) {
            leftEl.addEventListener("click", () => {
              window.editorManager?.openFile(item.path);
            });
          }

          // Inline Move / Rename on click
          const moveBtn = itemEl.querySelector(".btn-move-item");
          if (moveBtn) {
            moveBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              this.startInlineRename(itemEl, item.path);
            });
          }

          // Inline Delete confirmation on click
          const deleteBtn = itemEl.querySelector(".btn-delete-item");
          if (deleteBtn) {
            deleteBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              this.startInlineDeleteConfirm(itemEl, item.path, item.name);
            });
          }

          fileTree.appendChild(itemEl);
        });
        if (window.lucide) window.lucide.createIcons();
      } else {
        fileTree.innerHTML = `<div class="empty-hint" style="padding:14px;color:var(--text-dim);">Workspace is empty. Click + above to create files.</div>`;
      }
    } catch (err) {
      // Auto-retry once after 1.5s in case server was starting up
      if (!this._fileRetryCount) {
        this._fileRetryCount = 1;
        setTimeout(() => {
          this._fileRetryCount = 0;
          this.loadWorkspaceFiles();
        }, 1500);
      }
      fileTree.innerHTML = `
        <div style="padding:14px;color:#ef4444;font-size:12px;">
          Failed to load files: ${this.escapeHtml(err.message)}
          <br>
          <button onclick="app.loadWorkspaceFiles()" class="secondary-btn" style="margin-top:8px;font-size:11px;padding:4px 8px;">Retry</button>
        </div>
      `;
    }
  }

  /**
   * Inline Rename / Move directly inside Explorer tree row (No popups).
   */
  startInlineRename(itemEl, currentPath) {
    const leftEl = itemEl.querySelector(".tree-item-left");
    const actionsEl = itemEl.querySelector(".tree-item-actions");
    if (!leftEl) return;

    const originalHtml = leftEl.innerHTML;
    if (actionsEl) actionsEl.style.display = "none";

    leftEl.innerHTML = `
      <i data-lucide="edit-2" class="tree-icon" style="color:var(--accent-light);"></i>
      <input type="text" class="inline-tree-input" value="${this.escapeHtml(currentPath)}" style="flex:1;background:rgba(0,0,0,0.6);border:1px solid var(--accent);color:#fff;border-radius:3px;padding:2px 6px;font-size:12px;outline:none;" />
    `;
    if (window.lucide) window.lucide.createIcons();

    const input = leftEl.querySelector(".inline-tree-input");
    if (!input) return;

    input.focus();
    input.select();
    let committed = false;

    const commitRename = async () => {
      if (committed) return;
      committed = true;
      const newPath = input.value.trim();
      if (newPath && newPath !== currentPath) {
        try {
          const res = await fetch("/api/workspace/move", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.token || ""}`,
            },
            body: JSON.stringify({ from: currentPath, to: newPath }),
          });
          const data = await res.json();
          if (data.success) {
            this.logTerminal(`[Workspace] Moved "${currentPath}" -> "${newPath}"`, "success");
            if (window.editorManager?.openTabs?.has(currentPath)) {
              window.editorManager.closeTab(currentPath);
              window.editorManager.openFile(newPath);
            }
          }
        } catch (err) {
          this.logTerminal(`Move error: ${err.message}`, "error");
        }
      }
      await this.loadWorkspaceFiles();
    };

    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        await commitRename();
      } else if (e.key === "Escape") {
        committed = true;
        leftEl.innerHTML = originalHtml;
        if (actionsEl) actionsEl.style.display = "";
        if (window.lucide) window.lucide.createIcons();
      }
    });

    input.addEventListener("blur", () => {
      setTimeout(commitRename, 200);
    });
  }

  /**
   * Inline Delete confirmation right on the item row (Zero alert/confirm popups).
   */
  startInlineDeleteConfirm(itemEl, filePath, fileName) {
    const originalContent = itemEl.innerHTML;
    itemEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:2px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:4px;">
        <span style="font-size:11px;color:#fca5a5;font-weight:600;padding-left:4px;">Delete "${this.escapeHtml(fileName)}"?</span>
        <div style="display:flex;gap:4px;">
          <button class="inline-confirm-yes" style="background:#ef4444;border:none;color:#fff;border-radius:3px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;">Delete</button>
          <button class="inline-confirm-no" style="background:rgba(255,255,255,0.1);border:none;color:#fff;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;">Cancel</button>
        </div>
      </div>
    `;

    const yesBtn = itemEl.querySelector(".inline-confirm-yes");
    const noBtn = itemEl.querySelector(".inline-confirm-no");

    yesBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.token || ""}` },
        });
        const data = await res.json();
        if (data.success) {
          this.logTerminal(`[Workspace] Deleted ${filePath}`, "info");
          if (window.editorManager?.openTabs?.has(filePath)) {
            window.editorManager.closeTab(filePath);
          }
        }
      } catch (err) {
        this.logTerminal(`Delete error: ${err.message}`, "error");
      }
      await this.loadWorkspaceFiles();
    });

    noBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      itemEl.innerHTML = originalContent;
      if (window.lucide) window.lucide.createIcons();
    });
  }

  /**
   * Create a new empty file using inline VS Code input row (No browser prompt).
   */
  createNewFile() {
    const fileTree = document.getElementById("file-tree");
    if (!fileTree) return;

    const existing = document.getElementById("inline-new-item-row");
    if (existing) existing.remove();

    const row = document.createElement("div");
    row.id = "inline-new-item-row";
    row.className = "tree-item inline-create active";
    row.innerHTML = `
      <div class="tree-item-left" style="width:100%;gap:6px;">
        <i data-lucide="file-code" class="tree-icon" style="color:var(--accent-light);"></i>
        <input type="text" id="inline-create-input" placeholder="filename.js, index.html..." style="flex:1;background:rgba(0,0,0,0.7);border:1px solid var(--accent);color:#fff;border-radius:3px;padding:3px 6px;font-size:12px;outline:none;" />
      </div>
    `;
    fileTree.prepend(row);
    if (window.lucide) window.lucide.createIcons();

    const input = document.getElementById("inline-create-input");
    if (input) {
      input.focus();
      let finished = false;

      const commit = async () => {
        if (finished) return;
        finished = true;
        const val = input.value.trim();
        row.remove();
        if (val) {
          try {
            const res = await fetch("/api/workspace/file", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.token || ""}`,
              },
              body: JSON.stringify({ path: val, content: "" }),
            });
            const data = await res.json();
            if (data.success) {
              this.logTerminal(`[Workspace] Created file "${val}"`, "success");
              await this.loadWorkspaceFiles();
              window.editorManager?.openFile(val);
            }
          } catch (err) {
            this.logTerminal(`Create file error: ${err.message}`, "error");
          }
        }
      };

      input.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          await commit();
        } else if (e.key === "Escape") {
          finished = true;
          row.remove();
        }
      });

      input.addEventListener("blur", () => {
        setTimeout(commit, 200);
      });
    }
  }

  /**
   * Create a new folder using inline VS Code input row (No browser prompt).
   */
  createNewFolder() {
    const fileTree = document.getElementById("file-tree");
    if (!fileTree) return;

    const existing = document.getElementById("inline-new-item-row");
    if (existing) existing.remove();

    const row = document.createElement("div");
    row.id = "inline-new-item-row";
    row.className = "tree-item dir inline-create active";
    row.innerHTML = `
      <div class="tree-item-left" style="width:100%;gap:6px;">
        <i data-lucide="folder" class="tree-icon" style="color:var(--accent-orange);"></i>
        <input type="text" id="inline-create-input" placeholder="folder name (e.g. src, games)..." style="flex:1;background:rgba(0,0,0,0.7);border:1px solid var(--accent-orange);color:#fff;border-radius:3px;padding:3px 6px;font-size:12px;outline:none;" />
      </div>
    `;
    fileTree.prepend(row);
    if (window.lucide) window.lucide.createIcons();

    const input = document.getElementById("inline-create-input");
    if (input) {
      input.focus();
      let finished = false;

      const commit = async () => {
        if (finished) return;
        finished = true;
        const val = input.value.trim();
        row.remove();
        if (val) {
          try {
            const res = await fetch("/api/workspace/folder", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.token || ""}`,
              },
              body: JSON.stringify({ path: val }),
            });
            const data = await res.json();
            if (data.success) {
              this.logTerminal(`[Workspace] Created folder "${val}"`, "success");
              await this.loadWorkspaceFiles();
            }
          } catch (err) {
            this.logTerminal(`Create folder error: ${err.message}`, "error");
          }
        }
      };

      input.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          await commit();
        } else if (e.key === "Escape") {
          finished = true;
          row.remove();
        }
      });

      input.addEventListener("blur", () => {
        setTimeout(commit, 200);
      });
    }
  }

  /**
   * Load MCP servers status
   */
  async loadMcpServers() {
    const mcpContainer = document.getElementById("mcp-server-list");
    if (!mcpContainer) return;

    try {
      const response = await fetch("/api/health");
      const data = await response.json();
      const mcpStatus = data.mcp || {};

      const serverNames = Object.keys(mcpStatus);
      if (serverNames.length > 0) {
        mcpContainer.innerHTML = "";
        serverNames.forEach((name) => {
          const s = mcpStatus[name];
          const card = document.createElement("div");
          card.className = "mcp-server-card";
          card.innerHTML = `
            <div class="mcp-server-title">
              <span>${name}</span>
              <span class="badge">${s.connected ? "Connected" : "Inactive"}</span>
            </div>
            <div style="margin-top:6px;">
              ${(s.tools || []).map((t) => `<span class="mcp-tool-chip">${t}</span>`).join("")}
            </div>
          `;
          mcpContainer.appendChild(card);
        });
      } else {
        mcpContainer.innerHTML = `
          <div class="empty-hint" style="font-size:12px;color:var(--text-dim);line-height:1.4;">
            No external MCP servers connected. Add servers in <code>server/mcp_config.json</code> to expose filesystem, GitHub, or database tools.
          </div>
        `;
      }
    } catch (err) {
      console.warn("MCP status error:", err);
    }
  }

  /**
   * Check Auth status and load user profile & GitHub repos
   */
  async checkAuthStatus() {
    if (!this.token) {
      this.updateUserUI(null);
      return;
    }

    try {
      const response = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (response.ok) {
        const data = await response.json();
        this.currentUser = data.user;
        if (data.user?.isGuest) {
          this.updateUserUI(null); // Keep Sign In / Sign Up chips active
        } else {
          this.updateUserUI(data.user);
        }
        if (data.user?.hasGithub || localStorage.getItem("github_user_token")) {
          await this.loadGitHubRepos();
        }
      } else {
        this.updateUserUI(null);
      }
    } catch {
      this.updateUserUI(null);
    }
  }

  /**
   * Update top bar and badges when user logs in/out.
   */
  updateUserUI(user) {
    const loggedOutActions = document.getElementById("logged-out-actions");
    const loggedInProfile = document.getElementById("logged-in-profile");
    const profileEmail = document.getElementById("user-profile-email");
    const popoverEmail = document.getElementById("popover-user-email");
    const avatarBadge = document.getElementById("user-avatar-badge");
    const ghBtn = document.getElementById("github-btn");
    const ghLabel = document.getElementById("github-user-label");

    if (user && (user.email || user.username)) {
      if (loggedOutActions) loggedOutActions.style.display = "none";
      if (loggedInProfile) loggedInProfile.style.display = "flex";

      const displayEmail = user.email || user.username || "User";
      if (profileEmail) profileEmail.textContent = displayEmail;
      if (popoverEmail) popoverEmail.textContent = displayEmail;
      if (avatarBadge) avatarBadge.textContent = displayEmail[0].toUpperCase();

      if (user.hasGithub || localStorage.getItem("github_user_token")) {
        if (ghBtn) ghBtn.style.borderColor = "var(--success)";
        if (ghLabel) ghLabel.textContent = `GitHub: Linked`;
      } else {
        if (ghBtn) ghBtn.style.borderColor = "";
        if (ghLabel) ghLabel.textContent = `GitHub`;
      }
    } else {
      if (loggedOutActions) loggedOutActions.style.display = "flex";
      if (loggedInProfile) loggedInProfile.style.display = "none";
      if (ghBtn) ghBtn.style.borderColor = "";
      if (ghLabel) ghLabel.textContent = `GitHub`;
    }
    if (window.lucide) window.lucide.createIcons();
  }

  logout() {
    this.token = null;
    this.currentUser = null;
    localStorage.removeItem("token");
    localStorage.removeItem("github_user_token");
    this.updateUserUI(null);
    const reposList = document.getElementById("github-repo-list");
    if (reposList) {
      reposList.innerHTML = `<div class="empty-hint" style="padding:14px;color:var(--text-dim);">Not connected to GitHub.</div>`;
    }
    this.logTerminal("User logged out.", "info");
  }

  /**
   * Render User Profile Card in Auth Modal.
   */
  renderProfileCard() {
    if (!this.currentUser) return;
    const usernameEl = document.getElementById("profile-username-display");
    const emailEl = document.getElementById("profile-email-display");
    const avatarEl = document.getElementById("profile-avatar-img");
    const ghStatusEl = document.getElementById("profile-github-status");

    if (usernameEl) usernameEl.textContent = `@${this.currentUser.username}`;
    if (emailEl) emailEl.textContent = this.currentUser.email || "No email registered";
    if (avatarEl) {
      avatarEl.src = this.currentUser.avatarUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${this.currentUser.username}`;
    }
    if (ghStatusEl) {
      const hasGh = this.currentUser.hasGithub || localStorage.getItem("github_user_token");
      ghStatusEl.innerHTML = hasGh
        ? '<i data-lucide="check-circle" style="color:#22c55e;"></i> <span style="color:#22c55e;font-weight:600;">GitHub Token Linked & Active</span>'
        : '<i data-lucide="alert-circle" style="color:#f59e0b;"></i> <span style="color:#f59e0b;">GitHub Token Not Linked</span>';
    }
    if (window.lucide) window.lucide.createIcons();
  }

  /**
   * Load GitHub Repositories
   */
  async loadGitHubRepos() {
    const repoList = document.getElementById("github-repo-list");
    if (!repoList) return;

    try {
      const ghToken = localStorage.getItem("github_user_token") || "";
      const response = await fetch("/api/github/repos", {
        headers: {
          Authorization: `Bearer ${this.token || ""}`,
          "X-GitHub-Token": ghToken,
        },
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data.repos && data.repos.length > 0) {
        repoList.innerHTML = "";
        data.repos.forEach((repo) => {
          const item = document.createElement("div");
          item.className = "tree-item";
          item.style.padding = "8px 0";
          item.innerHTML = `
            <i data-lucide="git-fork" class="tree-icon"></i>
            <div>
              <div style="font-weight:500;color:var(--text-main);">${repo.name}</div>
              <div style="font-size:11px;color:var(--text-dim);">${repo.language} • ${repo.stars} stars</div>
            </div>
          `;
          repoList.appendChild(item);
        });
        lucide.createIcons();
      }
    } catch { }
  }

  /**
   * Save Chat History to Local Storage Cache
   */
  saveChatToCache() {
    try {
      const cacheKey = "ath_chat_history_" + (this.currentUser?.id || "guest");
      localStorage.setItem(cacheKey, JSON.stringify(this.chatHistory.slice(-100)));
    } catch { }
  }

  /**
   * Restore Chat History from Local Storage Cache
   */
  restoreChatFromCache() {
    try {
      const cacheKey = "ath_chat_history_" + (this.currentUser?.id || "guest");
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return;

      const items = JSON.parse(raw);
      if (Array.isArray(items) && items.length > 0) {
        this.chatHistory = items;
        const timeline = document.getElementById("ai-timeline");
        if (timeline) {
          // Clear default greeting if we have past history
          timeline.innerHTML = "";
          items.forEach((msg) => {
            if (msg.role === "user") {
              const msgEl = document.createElement("div");
              msgEl.className = "chat-msg user";
              msgEl.innerHTML = `<div class="chat-bubble">${this.escapeHtml(msg.content)}</div>`;
              timeline.appendChild(msgEl);
            } else if (msg.role === "assistant") {
              const msgEl = document.createElement("div");
              msgEl.className = "chat-msg agent";
              const bubble = document.createElement("div");
              bubble.className = "chat-bubble";
              bubble.innerHTML = window.marked ? marked.parse(msg.content) : this.escapeHtml(msg.content);
              msgEl.appendChild(bubble);
              timeline.appendChild(msgEl);

              if (window.hljs) {
                bubble.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
              }
              this.attachCopyButtons(bubble);
            }
          });
          timeline.scrollTop = timeline.scrollHeight;
        }
      }
    } catch (e) {
      console.warn("Chat restore notice:", e);
    }
  }

  /**
   * Clear Chat History from DOM and Local Storage Cache
   */
  clearChatHistory() {
    this.chatHistory = [];
    const cacheKey = "ath_chat_history_" + (this.currentUser?.id || "guest");
    localStorage.removeItem(cacheKey);

    const timeline = document.getElementById("ai-timeline");
    if (timeline) {
      timeline.innerHTML = `
        <div class="ai-greeting">
          <div class="greeting-avatar">
            <i data-lucide="bot"></i>
          </div>
          <div class="greeting-content">
            <h3>Hello! I'm your ATH AI Pair Programmer.</h3>
            <p>I can create files, write code, run shell tests, search the web with Tavily, and manage your workspace.</p>
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }
    this.logTerminal("Chat history cleared.", "info");
  }

  /**
   * Handle incoming image files for multimodal prompt.
   */
  handleImageFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = (e) => {
        this.pendingImages.push(e.target.result);
        this.renderImagePreviews();
      };
      reader.readAsDataURL(file);
    }
  }

  /**
   * Render pending image thumbnails in composer.
   */
  renderImagePreviews() {
    const container = document.getElementById("composer-image-previews");
    if (!container) return;

    if (!this.pendingImages || this.pendingImages.length === 0) {
      container.style.display = "none";
      container.innerHTML = "";
      return;
    }

    container.style.display = "flex";
    container.innerHTML = this.pendingImages
      .map(
        (dataUrl, i) => `
        <div style="position:relative;width:44px;height:44px;border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.15);background:#000;">
          <img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;" />
          <button onclick="app.removeImagePreview(${i})" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.7);color:#fff;border:none;border-radius:50%;width:14px;height:14px;font-size:10px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;">&times;</button>
        </div>`
      )
      .join("");
  }

  removeImagePreview(index) {
    if (this.pendingImages && this.pendingImages[index]) {
      this.pendingImages.splice(index, 1);
      this.renderImagePreviews();
    }
  }

  /**
   * Send User Message to AI Agent
   */
  sendMessage() {
    try {
      const composerInput = document.getElementById("composer-input");
      if (!composerInput) return;
      const text = composerInput.value.trim();
      const images = this.pendingImages ? [...this.pendingImages] : [];
      if (!text && images.length === 0) return;

      if (!this.currentConversationId) {
        this.currentConversationId = `conv_${Date.now()}`;
        localStorage.setItem("ath_current_conv_id", this.currentConversationId);
      }

      composerInput.value = "";
      this.pendingImages = [];
      this.renderImagePreviews();

      // 1. Render User Message in Timeline
      this.renderUserMessage(text, images);
      this.chatHistory.push({ role: "user", content: text, images, timestamp: Date.now() });
      this.saveChatToCache();

      // 2. Prepare Assistant Message Placeholder
      this.prepareAssistantMessage();
      this.setGeneratingState(true);

      // 3. Ensure WebSocket is connected & Send with Live Environment Context
      if (!window.wsClient.isConnected) {
        window.wsClient.connect(this.token);
      }

      const recentTerminal = (this.terminalHistory || [])
        .slice(-25)
        .map((l) => l.text)
        .join("\n");
      const activeFile = window.editorManager?.activeTab || null;
      const openFiles = Array.from(window.editorManager?.openTabs?.keys() || []);
      const activeContent = activeFile ? window.editorManager?.openTabs?.get(activeFile)?.content?.slice(0, 3000) : null;

      window.wsClient.send("chat", {
        message: text,
        images,
        conversationId: this.currentConversationId,
        model: this.currentModel || "devstral",
        mode: this.currentMode || "agent",
        context: {
          terminal: {
            shell: this.currentShell || "powershell",
            lastError: this.lastTerminalError,
            recentOutput: recentTerminal,
          },
          editor: {
            activeFile,
            openFiles,
            activeContent,
          },
        },
      });
    } catch (err) {
      console.error("Failed to send message:", err);
      this.setGeneratingState(false);
      this.renderError(err.message);
    }
  }

  /**
   * Stop Active AI Generation
   */
  stopGeneration() {
    window.wsClient.send("abort", {});
    this.setGeneratingState(false);
    this.logTerminal("Sent stop signal to AI agent.", "info");
  }

  /**
   * Toggle Generating State in UI (Send vs Stop button)
   */
  setGeneratingState(isGenerating) {
    const sendBtn = document.getElementById("btn-send-agent");
    const stopBtn = document.getElementById("btn-stop-agent");
    if (sendBtn && stopBtn) {
      if (isGenerating) {
        sendBtn.style.display = "none";
        stopBtn.style.display = "flex";
      } else {
        sendBtn.style.display = "flex";
        stopBtn.style.display = "none";
      }
    }
  }

  /**
   * Start a New Conversation
   */
  startNewConversation() {
    this.currentConversationId = `conv_${Date.now()}`;
    localStorage.setItem("ath_current_conv_id", this.currentConversationId);
    this.clearChatHistory();
    const titleEl = document.getElementById("current-thread-title");
    if (titleEl) titleEl.textContent = "New Thread";
    const popover = document.getElementById("inline-threads-popover");
    if (popover) popover.style.display = "none";
    const historyModal = document.getElementById("chat-history-modal");
    if (historyModal) historyModal.classList.add("hidden");
    this.logTerminal("Started a new conversation thread.", "info");
  }

  /**
   * Load Saved Conversations Inline in AI Sidebar
   */
  async loadInlineThreads() {
    const listEl = document.getElementById("inline-threads-list");
    if (!listEl) return;
    listEl.innerHTML = '<div class="empty-hint" style="padding:6px;font-size:12px;">Loading threads...</div>';

    try {
      const res = await fetch("/api/agent/conversations", {
        headers: { Authorization: `Bearer ${this.token || ""}` },
      });
      const data = await res.json();
      if (!data.conversations || data.conversations.length === 0) {
        listEl.innerHTML = '<div class="empty-hint" style="padding:6px;font-size:12px;color:var(--text-dim);">No saved threads yet.</div>';
        return;
      }

      listEl.innerHTML = "";
      data.conversations.forEach((conv) => {
        const item = document.createElement("div");
        item.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;cursor:pointer;background:rgba(255,255,255,0.03);";
        item.onmouseenter = () => item.style.background = "rgba(255,255,255,0.08)";
        item.onmouseleave = () => item.style.background = "rgba(255,255,255,0.03)";

        const titleDiv = document.createElement("div");
        titleDiv.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#f8fafc;margin-right:8px;";
        titleDiv.textContent = conv.title || "Untitled Conversation";
        titleDiv.title = conv.title || "";
        titleDiv.addEventListener("click", () => {
          this.switchConversation(conv);
          const popover = document.getElementById("inline-threads-popover");
          if (popover) popover.style.display = "none";
        });

        // Instant delete button
        const delBtn = document.createElement("button");
        delBtn.className = "icon-btn";
        delBtn.style.cssText = "padding:2px;opacity:0.6;background:none;border:none;color:#ef4444;cursor:pointer;display:flex;align-items:center;";
        delBtn.title = "Delete thread immediately";
        delBtn.innerHTML = '<i data-lucide="trash-2" style="width:12px;height:12px;"></i>';
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          item.style.opacity = "0.3";
          try {
            await fetch(`/api/agent/conversations/${conv.id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${this.token || ""}` },
            });
            item.remove();
            if (this.currentConversationId === conv.id) {
              this.startNewConversation();
            }
          } catch (err) {
            item.style.opacity = "1";
          }
        });

        item.appendChild(titleDiv);
        item.appendChild(delBtn);
        listEl.appendChild(item);
      });
      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      listEl.innerHTML = `<div style="padding:6px;font-size:11px;color:#ef4444;">Error loading: ${err.message}</div>`;
    }
  }

  /**
   * Switch Active Conversation
   */
  switchConversation(conv) {
    this.currentConversationId = conv.id;
    localStorage.setItem("ath_current_conv_id", conv.id);
    const titleEl = document.getElementById("current-thread-title");
    if (titleEl) titleEl.textContent = conv.title || "Conversation";

    const popover = document.getElementById("inline-threads-popover");
    if (popover) popover.style.display = "none";

    const timeline = document.getElementById("ai-timeline");
    if (timeline) {
      timeline.innerHTML = "";
      try {
        const msgs = typeof conv.messages === "string" ? JSON.parse(conv.messages) : (conv.messages || []);
        this.chatHistory = msgs;
        this.saveChatToCache();
        this.restoreChatFromCache();
      } catch {
        this.clearChatHistory();
      }
    }
    this.logTerminal(`Switched to conversation: "${conv.title}"`, "info");
  }

  suggestPrompt(text, autoSend = false) {
    const composerInput = document.getElementById("composer-input");
    if (composerInput) {
      composerInput.value = text;
      composerInput.focus();
      if (autoSend) {
        this.sendMessage();
      }
    }
  }

  insertCommand(cmd) {
    const composerInput = document.getElementById("composer-input");
    if (composerInput) {
      const current = composerInput.value.trim();
      composerInput.value = `${cmd}${current}`;
      composerInput.focus();
      // Scroll cursor to end
      composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
    }
  }

  renderUserMessage(text, images = []) {
    const timeline = document.getElementById("ai-timeline");
    const msgEl = document.createElement("div");
    msgEl.className = "chat-msg user";

    let imgHtml = "";
    if (images && images.length > 0) {
      imgHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
        ${images.map((img) => `<img src="${img}" style="max-width:140px;max-height:100px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);object-fit:cover;" />`).join("")}
      </div>`;
    }

    msgEl.innerHTML = `
      <div class="chat-bubble" style="display:flex;flex-direction:column;gap:6px;">
        ${imgHtml}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <span>${this.escapeHtml(text || (images.length > 0 ? "Attached image" : ""))}</span>
          <button class="edit-prompt-btn" title="Edit prompt" style="opacity:0.6;background:none;border:none;color:#fff;cursor:pointer;padding:2px;display:flex;align-items:center;">
            <i data-lucide="edit-3" style="width:12px;height:12px;"></i>
          </button>
        </div>
      </div>
    `;
    const editBtn = msgEl.querySelector(".edit-prompt-btn");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        const composerInput = document.getElementById("composer-input");
        if (composerInput) {
          composerInput.value = text;
          composerInput.focus();
        }
      });
    }
    timeline.appendChild(msgEl);
    timeline.scrollTop = timeline.scrollHeight;
    if (window.lucide) window.lucide.createIcons();
  }

  prepareAssistantMessage() {
    const timeline = document.getElementById("ai-timeline");
    const msgEl = document.createElement("div");
    msgEl.className = "chat-msg agent";
    msgEl.innerHTML = `<div class="chat-bubble"><span class="cursor-typing">Thinking...</span></div>`;
    timeline.appendChild(msgEl);
    timeline.scrollTop = timeline.scrollHeight;

    this.currentAssistantMessageEl = msgEl.querySelector(".chat-bubble");
    this.currentAssistantContent = "";
    this.currentThinkingEl = null;
    this.currentThinkingContent = "";
  }

  createThinkingCard() {
    if (!this.currentAssistantMessageEl) return;

    const thinkingCard = document.createElement("div");
    thinkingCard.className = "thinking-card";
    thinkingCard.innerHTML = `
      <div class="thinking-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
        <div class="thinking-pulse"></div>
        <span>Agent Reasoning Chain</span>
      </div>
      <div class="thinking-body"></div>
    `;

    this.currentAssistantMessageEl.insertBefore(thinkingCard, this.currentAssistantMessageEl.firstChild);
    this.currentThinkingEl = thinkingCard.querySelector(".thinking-body");
    this.currentThinkingContent = "";
  }

  appendThinking(text) {
    if (!this.currentThinkingEl) {
      this.createThinkingCard();
    }
    this.currentThinkingContent += text;
    this.currentThinkingEl.textContent = this.currentThinkingContent;
  }

  detectTargetFile() {
    const raw = this.currentAssistantContent || "";
    // Check if filename is mentioned in assistant text (e.g. landing_page.html or in `app.js`)
    const match = raw.match(/(?:file|named|in|into|created?|create|make)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)[`"']?/i);
    if (match) return match[1].replace(/[`"']/g, "");

    // Check last user prompt
    const lastUserMsg = this.chatHistory?.filter((m) => m.role === "user").pop()?.content || "";
    const userMatch = lastUserMsg.match(/(?:in|into|to|file|create|make)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)[`"']?/i);
    if (userMatch) return userMatch[1].replace(/[`"']/g, "");

    return "index.html";
  }

  appendAssistantText(text) {
    if (!this.currentAssistantMessageEl) return;
    this.currentAssistantContent += text;

    // 1. Detect if code is being generated and stream live into Editor
    const codeBlockMatch = this.currentAssistantContent.match(/```(?:html|css|js|javascript|python|py|json|sh|bash|md)?\s*\n([\s\S]*)$/);
    if (codeBlockMatch) {
      const targetFile = this.detectTargetFile();
      const currentStreamingCode = codeBlockMatch[1].replace(/```$/, "");

      if (window.editorManager && currentStreamingCode.length > 5) {
        window.editorManager.appendLiveStream(targetFile, currentStreamingCode);
        this.activeStreamingFile = targetFile;
      }
    }

    // 2. Render markdown in timeline
    if (window.marked) {
      this.currentAssistantMessageEl.innerHTML = marked.parse(this.currentAssistantContent);
    } else {
      this.currentAssistantMessageEl.textContent = this.currentAssistantContent;
    }

    const timeline = document.getElementById("ai-timeline");
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }

  renderToolStart(data) {
    if (!this.currentAssistantMessageEl) return;

    const card = document.createElement("div");
    card.className = "artifact-card";
    card.id = `tool-call-${data.id}`;
    card.setAttribute("data-tool-start", Date.now().toString());

    let iconName = "terminal";
    let displayName = data.name;
    if (data.name.includes("plan")) iconName = "clipboard-list";
    else if (data.name.includes("image")) iconName = "image";
    else if (data.name.includes("git")) iconName = "git-branch";
    else if (data.name.includes("file")) iconName = "file-text";
    else if (data.name.includes("preview")) iconName = "play";
    else if (data.name.includes("diagnose")) iconName = "activity";

    const detailText = data.args?.command || data.args?.path || data.args?.title || data.args?.prompt || "";

    card.innerHTML = `
      <div class="artifact-header" onclick="const b = this.nextElementSibling; if(b) b.style.display = b.style.display === 'none' ? 'block' : 'none'">
        <div class="artifact-title">
          <i data-lucide="${iconName}" style="width:14px;height:14px;color:var(--accent-light);"></i>
          <span>${displayName}</span>
          ${detailText ? `<span style="opacity:0.6;font-weight:400;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(detailText.slice(0, 40))}</span>` : ""}
        </div>
        <span class="artifact-badge badge-running">running</span>
      </div>
      <div class="artifact-body" style="display:block;">
        <div class="tool-status-hint" style="color:var(--text-dim);font-size:11px;font-family:var(--font-mono);">Executing ${data.name}...</div>
      </div>
    `;
    this.currentAssistantMessageEl.appendChild(card);
    if (window.lucide) window.lucide.createIcons();
    const timeline = document.getElementById("ai-timeline");
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }

  renderToolResult(data) {
    const toolsLog = document.getElementById("tools-execution-log");
    const logItem = document.createElement("div");
    logItem.className = `term-line ${data.success ? "success" : "error"}`;
    logItem.textContent = `[Tool Result: ${data.name}] ${data.output?.slice(0, 150) || ""}`;
    if (toolsLog) toolsLog.appendChild(logItem);

    const card = document.getElementById(`tool-call-${data.id}`);
    if (card) {
      const startTime = parseInt(card.getAttribute("data-tool-start") || "0", 10);
      const elapsedMs = startTime ? Date.now() - startTime : null;
      const durationTag = elapsedMs ? ` (${elapsedMs}ms)` : "";

      const badge = card.querySelector(".artifact-badge");
      if (badge) {
        badge.className = `artifact-badge ${data.success ? "badge-success" : "badge-error"}`;
        badge.textContent = (data.success ? "completed" : "failed") + durationTag;
      }

      const body = card.querySelector(".artifact-body");
      if (body) {
        // Special Visual rendering for image generation
        if (data.name === "generate_image" && data.assetPath) {
          body.innerHTML = `
            <div class="image-artifact-container">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Generated visual asset: <code>${data.assetPath}</code></div>
              <img src="/api/workspace/file?path=${encodeURIComponent(data.assetPath)}" class="image-artifact-preview" />
              <div style="margin-top:6px;display:flex;gap:6px;">
                <button onclick="window.editorManager?.openFile('${data.assetPath}')" class="btn" style="padding:4px 8px;font-size:11px;">Open in Editor</button>
              </div>
            </div>
          `;
        } else if (data.name === "create_plan" || data.name === "update_plan") {
          // Special plan rendering
          body.innerHTML = `
            <div class="plan-artifact-container">
              <div style="font-size:12px;font-weight:600;color:var(--text-main);margin-bottom:6px;">${this.escapeHtml(data.output || "Plan Created")}</div>
              <button onclick="window.editorManager?.openFile('task.md')" class="btn btn-primary" style="padding:4px 8px;font-size:11px;">View Task Roadmap</button>
            </div>
          `;
        } else if (data.name === "generate_walkthrough") {
          body.innerHTML = `
            <div class="walkthrough-artifact-container">
              <div class="walkthrough-summary" style="font-size:11px;line-height:1.5;">${this.escapeHtml(data.output)}</div>
              <button onclick="window.editorManager?.openFile('walkthrough.md')" class="btn btn-primary" style="padding:4px 8px;font-size:11px;">Open Walkthrough Document</button>
            </div>
          `;
        } else {
          // Standard collapsible output block
          body.innerHTML = `
            <div class="tool-output-block">${this.escapeHtml(data.output || data.error || "(no output)")}</div>
          `;
        }
      }
      if (window.lucide) window.lucide.createIcons();
    }
    const timeline = document.getElementById("ai-timeline");
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }

  finalizeMessage() {
    if (this.currentAssistantMessageEl) {
      // 1. If code was actively streamed into editor, finalize and commit it
      if (this.activeStreamingFile && window.editorManager) {
        const codeBlockRegex = /```(?:html|css|js|javascript|python|py|json|sh|bash)?\s*\n([\s\S]+?)```/g;
        let lastCode = "";
        let m;
        while ((m = codeBlockRegex.exec(this.currentAssistantContent)) !== null) {
          lastCode = m[1].trim();
        }
        if (lastCode) {
          window.editorManager.finishLiveStream(this.activeStreamingFile, lastCode);
        }
      }

      // 2. Highlight any code blocks in final message
      if (window.hljs) {
        this.currentAssistantMessageEl.querySelectorAll("pre code").forEach((el) => {
          hljs.highlightElement(el);
        });
      }
      if (this.currentAssistantContent) {
        this.chatHistory.push({ role: "assistant", content: this.currentAssistantContent, timestamp: Date.now() });
        this.saveChatToCache();

        // 3. Auto-detect HTML / Web App files to render interactive Preview Card & Auto-Launch
        const htmlMatch = this.currentAssistantContent.match(/(?:[a-zA-Z0-9_\-./]+)\.html/i) || (this.activeStreamingFile?.endsWith(".html") ? [this.activeStreamingFile] : null);
        if (htmlMatch && htmlMatch[0]) {
          const targetFile = htmlMatch[0].replace(/[`"']/g, "");
          const previewCard = document.createElement("div");
          previewCard.className = "live-preview-action-card";
          previewCard.style.cssText = "margin-top:12px;padding:10px 14px;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.35);border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:12px;";
          previewCard.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
              <i data-lucide="globe" style="width:20px;height:20px;color:#c084fc;flex-shrink:0;"></i>
              <div>
                <div style="font-size:12px;font-weight:600;color:#f8fafc;">Live Web Preview Ready</div>
                <div style="font-size:11px;color:#cbd5e1;font-family:var(--font-mono);">${this.escapeHtml(targetFile)}</div>
              </div>
            </div>
            <button onclick="app.openPreview('${targetFile}')" class="btn btn-primary" style="background:#a855f7;color:#fff;border:none;padding:6px 14px;font-size:11px;font-weight:600;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:5px;box-shadow:0 2px 8px rgba(168,85,247,0.4);">
              <i data-lucide="play" style="width:12px;height:12px;"></i>
              <span>Launch Live Preview</span>
            </button>
          `;
          this.currentAssistantMessageEl.appendChild(previewCard);
          if (window.lucide) window.lucide.createIcons();

          // If prompt contains start / run / play / preview / launch, auto-open immediately
          const lastUserPrompt = this.chatHistory.filter(m => m.role === "user").slice(-1)[0]?.content || "";
          if (/start|run|play|preview|launch|open|show/i.test(lastUserPrompt)) {
            this.openPreview(targetFile);
          }
        }
      }
    }
    this.currentAssistantMessageEl = null;
    this.currentAssistantContent = "";
    this.activeStreamingFile = null;
  }

  /**
   * Attach 1-click Copy button to all markdown code blocks.
   */
  attachCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-code-btn")) return;

      const btn = document.createElement("button");
      btn.className = "copy-code-btn";
      btn.innerHTML = `<i data-lucide="copy"></i> Copy`;

      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const codeEl = pre.querySelector("code");
        const textToCopy = codeEl ? codeEl.innerText : pre.innerText;

        try {
          await navigator.clipboard.writeText(textToCopy);
          btn.innerHTML = `<i data-lucide="check"></i> Copied!`;
          btn.classList.add("copied");
          setTimeout(() => {
            btn.innerHTML = `<i data-lucide="copy"></i> Copy`;
            btn.classList.remove("copied");
            lucide.createIcons();
          }, 2000);
        } catch (err) {
          console.warn("Copy failed:", err);
        }
      });

      pre.style.position = "relative";
      pre.appendChild(btn);
    });
    lucide.createIcons();
  }

  /**
   * Initialize Draggable Panel Resizers (Sidebar, Chat, and Terminal)
   */
  initResizers() {
    // 1. Sidebar Resizer
    const resizerSidebar = document.getElementById("resizer-sidebar");
    const sidebar = document.getElementById("primary-sidebar");
    if (resizerSidebar && sidebar) {
      let isResizing = false;

      resizerSidebar.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isResizing = true;
        resizerSidebar.classList.add("resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      window.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const newWidth = Math.max(160, Math.min(e.clientX - 48, 600));
        sidebar.style.width = `${newWidth}px`;
      });

      window.addEventListener("mouseup", () => {
        if (isResizing) {
          isResizing = false;
          resizerSidebar.classList.remove("resizing");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
    }

    // 2. Chat Panel Resizer
    const resizerChat = document.getElementById("resizer-chat");
    const chatPanel = document.getElementById("ai-panel");
    if (resizerChat && chatPanel) {
      let isResizing = false;

      resizerChat.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isResizing = true;
        resizerChat.classList.add("resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      window.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const newWidth = Math.max(280, Math.min(window.innerWidth - e.clientX, 850));
        chatPanel.style.width = `${newWidth}px`;
      });

      window.addEventListener("mouseup", () => {
        if (isResizing) {
          isResizing = false;
          resizerChat.classList.remove("resizing");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
    }

    // 3. Bottom Terminal Resizer
    const resizerTerminal = document.getElementById("resizer-terminal");
    const bottomPanel = document.getElementById("bottom-panel");
    if (resizerTerminal && bottomPanel) {
      let isResizing = false;

      resizerTerminal.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isResizing = true;
        resizerTerminal.classList.add("resizing");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      });

      window.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const newHeight = Math.max(60, Math.min(window.innerHeight - e.clientY, 600));
        bottomPanel.style.height = `${newHeight}px`;
      });

      window.addEventListener("mouseup", () => {
        if (isResizing) {
          isResizing = false;
          resizerTerminal.classList.remove("resizing");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
    }
  }

  renderError(msg) {
    if (this.currentAssistantMessageEl) {
      this.currentAssistantMessageEl.innerHTML += `<div class="term-line error" style="margin-top:8px;">⚠️ ${this.escapeHtml(msg)}</div>`;
    }
  }

  logTerminal(text, type = "normal") {
    const termLogs = document.getElementById("terminal-output-logs");
    if (!termLogs) return;

    if (!this.terminalHistory) this.terminalHistory = [];
    this.terminalHistory.push({ text, type, timestamp: Date.now() });
    if (this.terminalHistory.length > 60) this.terminalHistory.shift();

    // Use <pre> for multi-line output to preserve formatting
    const isMultiLine = text.includes("\n");
    const line = document.createElement(isMultiLine ? "pre" : "div");
    line.className = `term-line ${type}`;
    line.textContent = text;
    if (isMultiLine) {
      line.style.cssText = "margin:0 0 4px 0;white-space:pre-wrap;word-break:break-word;";
    }
    termLogs.appendChild(line);

    // If error occurs, render 1-click "⚡ Ask AI to Fix" button
    if (type === "error" && text.length > 5 && !text.startsWith("[Agent Error]")) {
      const fixBtn = document.createElement("button");
      fixBtn.className = "term-fix-btn";
      fixBtn.style.cssText = "margin: 4px 0 8px 0; display: inline-flex; align-items: center; gap: 6px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 4px; padding: 3px 10px; font-size: 11px; font-weight: 600; cursor: pointer;";
      fixBtn.innerHTML = `⚡ <span>Ask AI to Fix This Error</span>`;
      fixBtn.onclick = () => {
        const composer = document.getElementById("composer-input");
        if (composer) {
          composer.value = `Fix this terminal error: \`${text.replace(/[\n\r]+/g, " ").slice(0, 150)}\``;
          this.sendMessage();
        }
      };
      termLogs.appendChild(fixBtn);
    }

    termLogs.scrollTop = termLogs.scrollHeight;
  }

  initTerminalUI() {
    const container = document.getElementById("terminal-container");
    if (!container) return;

    const term = new Terminal({
      theme: {
        background: '#0d0e12',
        foreground: '#e2e8f0',
        cursor: '#6366f1',
        black: '#000000',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#6366f1',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#cbd5e1'
      },
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 1000
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    this.term = term;
    this.fitAddon = fitAddon;

    let lineBuffer = "";

    term.onData((data) => {
      if (window.wsClient.isConnected) {
        // 1. Stream raw keystroke to user interactive PTY
        window.wsClient.send("terminal.input", { data });

        // 2. Track submitted commands on Enter
        if (data === "\r") {
          const submittedCmd = lineBuffer.trim();
          if (submittedCmd) {
            window.wsClient.send("terminal.command.submitted", {
              command: submittedCmd,
              cwd: "workspace",
            });
          }
          lineBuffer = "";
        } else if (data === "\u007f" || data === "\b") {
          lineBuffer = lineBuffer.slice(0, -1);
        } else if (data.length === 1 && data >= " ") {
          lineBuffer += data;
        }
      }
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
        if (window.wsClient.isConnected) {
          window.wsClient.send("terminal.resize", { cols: term.cols, rows: term.rows });
        }
      } catch (err) {
        console.warn("Resize error:", err);
      }
    };

    setTimeout(handleResize, 100);
    window.addEventListener("resize", handleResize);

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(container);

    const clearTermBtn = document.getElementById("btn-clear-terminal");
    if (clearTermBtn) {
      clearTermBtn.addEventListener("click", () => {
        term.clear();
      });
    }

    const pasteTermBtn = document.getElementById("btn-paste-terminal");
    if (pasteTermBtn) {
      pasteTermBtn.addEventListener("click", async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text && window.wsClient.isConnected) {
            window.wsClient.send("terminal.paste", { text });
          }
        } catch (err) {
          console.warn("Paste error:", err);
        }
      });
    }

    const stopBgBtn = document.getElementById("btn-stop-bg-task");
    if (stopBgBtn) {
      stopBgBtn.addEventListener("click", () => {
        if (this.activeBgOperationId && window.wsClient.isConnected) {
          window.wsClient.send("agent.command.stop", { operationId: this.activeBgOperationId });
          const banner = document.getElementById("agent-exec-banner");
          if (banner) banner.style.display = "none";
        }
      });
    }
  }

  initPreviewUI() {
    const previewContainer = document.getElementById("live-preview-view");
    const previewIframe = document.getElementById("live-preview-iframe");
    const previewInput = document.getElementById("preview-url-input");
    const refreshBtn = document.getElementById("btn-preview-refresh");
    const closeBtn = document.getElementById("btn-preview-close");
    const externalBtn = document.getElementById("btn-preview-external");
    const stopBtn = document.getElementById("btn-preview-stop");
    const statusBadge = document.getElementById("preview-status-badge");
    const statusText = document.getElementById("preview-status-text");

    if (refreshBtn && previewIframe) {
      refreshBtn.addEventListener("click", () => {
        const url = previewInput?.value || previewIframe.src;
        if (url && url !== "about:blank") {
          previewIframe.src = url;
        }
      });
    }

    if (closeBtn && previewContainer) {
      closeBtn.addEventListener("click", () => {
        previewContainer.style.display = "none";
      });
    }

    if (externalBtn && previewInput) {
      externalBtn.addEventListener("click", () => {
        const url = previewInput.value;
        if (url && url !== "about:blank") {
          window.open(url, "_blank");
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        if (window.wsClient.isConnected) {
          window.wsClient.send("preview.stop", {});
        }
      });
    }

    if (previewInput) {
      previewInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && previewIframe) {
          previewIframe.src = previewInput.value;
        }
      });
    }

    // Tab bar Live Preview Button
    const livePreviewBtn = document.getElementById("btn-live-preview");
    if (livePreviewBtn) {
      livePreviewBtn.addEventListener("click", () => {
        const activeFile = window.editorManager?.activeFile || "index.html";
        this.openPreview(activeFile);
      });
    }

    // Live preview event listeners
    window.wsClient.on("preview.started", () => {
      if (statusText) statusText.textContent = "Starting...";
      if (statusBadge) {
        statusBadge.style.color = "#f59e0b";
        statusBadge.style.borderColor = "rgba(245,158,11,0.3)";
        statusBadge.style.background = "rgba(245,158,11,0.1)";
      }
    });

    window.wsClient.on("preview.ready", (data) => {
      if (!data?.url) return;
      if (previewContainer) previewContainer.style.display = "flex";
      if (previewIframe) previewIframe.src = data.url;
      if (previewInput) previewInput.value = data.url;
      if (statusText) statusText.textContent = `Running (Port ${data.port || 3000})`;
      if (statusBadge) {
        statusBadge.style.color = "#10b981";
        statusBadge.style.borderColor = "rgba(16,185,129,0.3)";
        statusBadge.style.background = "rgba(16,185,129,0.1)";
      }
    });

    window.wsClient.on("preview.stopped", () => {
      if (statusText) statusText.textContent = "Stopped";
      if (statusBadge) {
        statusBadge.style.color = "#94a3b8";
        statusBadge.style.borderColor = "rgba(148,163,184,0.3)";
        statusBadge.style.background = "rgba(148,163,184,0.1)";
      }
    });

    window.wsClient.on("preview.failed", (data) => {
      if (statusText) statusText.textContent = "Failed";
      if (statusBadge) {
        statusBadge.style.color = "#ef4444";
        statusBadge.style.borderColor = "rgba(239,68,68,0.3)";
        statusBadge.style.background = "rgba(239,68,68,0.1)";
      }
      this.logTerminal(`[Preview Error] ${data?.error || "Preview failed to start"}`, "error");
    });

    // Live Server Health & Execution/Compilation Queue Monitor
    window.wsClient.on("system.health", (metrics) => {
      const healthDot = document.getElementById("health-pulse-dot");
      const healthText = document.getElementById("status-server-text");
      const queueText = document.getElementById("status-queue-text");

      if (healthText) {
        healthText.textContent = `Host: ${metrics.status.toUpperCase()} (${metrics.cpuPercent}% CPU | ${metrics.processRssMB || metrics.memoryUsedMB}MB)`;
      }
      if (healthDot) {
        if (metrics.status === "healthy") healthDot.style.background = "#10b981";
        else if (metrics.status === "degraded") healthDot.style.background = "#f59e0b";
        else healthDot.style.background = "#ef4444";
      }
      if (queueText) {
        queueText.textContent = `Queue: ${metrics.queue?.running || 0} active / ${metrics.queue?.queued || 0} waiting`;
      }
    });

    window.wsClient.on("queue.job_enqueued", (data) => {
      const queueText = document.getElementById("status-queue-text");
      if (queueText) {
        queueText.textContent = `Queue: #${data.position} in queue`;
      }
    });
  }

  /**
   * Opens any file or URL in the embedded Live Web Preview pane.
   * @param {string} target - file path (e.g. 'synth.html') or full URL
   */
  openPreview(target = "index.html") {
    const previewContainer = document.getElementById("live-preview-view");
    const previewIframe = document.getElementById("live-preview-iframe");
    const previewInput = document.getElementById("preview-url-input");
    const statusBadge = document.getElementById("preview-status-badge");
    const statusText = document.getElementById("preview-status-text");

    let url = target || "index.html";
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      const cleanPath = url.startsWith("/") ? url.slice(1) : url;
      url = `/preview/${cleanPath}`;
    }

    if (previewIframe) previewIframe.src = url;
    if (previewInput) previewInput.value = url;
    if (previewContainer) previewContainer.style.display = "flex";
    if (statusText) statusText.textContent = "Live Web App (Ready)";
    if (statusBadge) {
      statusBadge.style.color = "#10b981";
      statusBadge.style.borderColor = "rgba(16,185,129,0.3)";
      statusBadge.style.background = "rgba(16,185,129,0.1)";
    }
  }

  escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

window.app = new App();
