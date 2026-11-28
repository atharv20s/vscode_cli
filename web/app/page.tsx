"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Columns2,
  Copy,
  File,
  FilePlus2,
  Folder,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCompare,
  KeyRound,
  ListTree,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Share2,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Users,
  X,
  Zap,
} from "lucide-react";
import TerminalPanel from "@/components/TerminalPanel";
import { api } from "@/lib/api";

type WorkspaceSession = { id: string; name: string; createdAt: string };
type FileEntry = { name: string; path: string; isDirectory: boolean; size: number };
type ChatMessage = { role: "user" | "assistant"; content: string; thinking?: string; activity?: string[] };
type ModelOption = { key: string; name: string; tier: string; provider: string; id: string; configured: boolean; multimodal?: boolean };
type RepoOption = { full_name: string; name: string; owner: { login: string }; default_branch: string };
type AgentTask = { id: string; owner: string; repo: string; status: string; pr_url?: string; error?: string };
type ConversationOption = { id: string; title: string; model?: string; messages: string | any[] };
type ShareLink = { id: string; workspaceId: string; permission: string; expiresAt: string; createdAt?: string };
type DiffViewState = { title: string; original: string; modified: string; isAiEdit?: boolean } | null;

const SLASH_ACTIONS = [
  { cmd: "/fix", label: "Fix errors in active file", insert: "Inspect and fix any bugs or errors in " },
  { cmd: "/explain", label: "Explain active file", insert: "Explain how this file works: " },
  { cmd: "/test", label: "Write & run tests", insert: "Write unit tests and run them for " },
  { cmd: "/refactor", label: "Refactor cleanly", insert: "Refactor for readability and performance: " },
  { cmd: "/clear", label: "Start a fresh conversation", insert: "__CLEAR__" },
];

const defineObsidianTheme = (monaco: any) => {
  monaco.editor.defineTheme("ath-obsidian", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0a0a0a",
      "editor.lineHighlightBackground": "#141416",
      "editorCursor.foreground": "#ffffff",
      "editorLineNumber.foreground": "#404040",
      "editorLineNumber.activeForeground": "#a3a3a3",
      "editorGutter.background": "#0a0a0a",
      "editor.selectionBackground": "#262629",
      "editorIndentGuide.background1": "#1c1c1e",
      "editorIndentGuide.activeBackground1": "#3f3f46",
      "editorWidget.background": "#141416",
      "editorWidget.border": "#262626",
    },
  });
};

type DropdownOption = { value: string; label: string; sublabel?: string; disabled?: boolean };

function DarkDropdown({
  value,
  options,
  onChange,
  placeholder = "Select…",
  align = "left",
  direction = "down",
  className = "",
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  align?: "left" | "right";
  direction?: "down" | "up";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = options.find(o => o.value === value);

  return (
    <div ref={ref} className={"relative inline-block " + className}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-2 bg-[#161618] hover:bg-[#1e1e22] border border-neutral-800/90 hover:border-neutral-700 rounded-lg px-2.5 py-1 text-[11px] text-neutral-200 transition-colors outline-none"
      >
        <span className="truncate">{current?.label || placeholder}</span>
        <ChevronDown size={12} className={"text-neutral-500 shrink-0 transition-transform " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <div
          className={
            "absolute z-50 min-w-[180px] max-h-60 overflow-auto rounded-xl border border-neutral-800 bg-[#141416]/95 backdrop-blur-md shadow-2xl p-1 " +
            (align === "right" ? "right-0 " : "left-0 ") +
            (direction === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5")
          }
        >
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              disabled={opt.disabled}
              onClick={() => {
                if (opt.disabled) return;
                onChange(opt.value);
                setOpen(false);
              }}
              className={
                "w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-[11px] transition-colors " +
                (opt.disabled
                  ? "text-neutral-600 cursor-not-allowed"
                  : opt.value === value
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-300 hover:bg-neutral-800/70 hover:text-white")
              }
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{opt.label}</div>
                {opt.sublabel && <div className="text-[10px] text-neutral-500 truncate">{opt.sublabel}</div>}
              </div>
              {opt.value === value && <Check size={12} className="text-neutral-200 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const languageFor = (file: string) => {
  const ext = file.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", py: "python", html: "html", css: "css", md: "markdown",
    yml: "yaml", yaml: "yaml", rs: "rust", go: "go", sql: "sql", sh: "shell", ps1: "powershell",
  };
  return map[ext] || "plaintext";
};

export default function Home() {
  const [apiStatus, setApiStatus] = useState("Connecting…");
  const [workerStatus, setWorkerStatus] = useState("Not configured");
  const [workspaceId, setWorkspaceId] = useState("default");
  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [allFiles, setAllFiles] = useState<FileEntry[]>([]);
  const [currentDir, setCurrentDir] = useState(".");
  const [activeFile, setActiveFile] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileVersion, setFileVersion] = useState<string | null>(null);
  const [tabBuffers, setTabBuffers] = useState<Record<string, { content: string; savedContent: string; version: string | null }>>({});
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [gitBranch, setGitBranch] = useState("main");
  const [gitFileStatuses, setGitFileStatuses] = useState<Record<string, string>>({});
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ file: string; line: number; text: string }>>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [dialogState, setDialogState] = useState<
    | null
    | { kind: "new-file" | "new-folder"; title: string; placeholder: string; defaultValue: string }
    | { kind: "rename"; title: string; entry: FileEntry; defaultValue: string }
    | { kind: "delete"; title: string; entry: FileEntry }
  >(null);
  const [dialogInput, setDialogInput] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("devstral");
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Welcome to ATH IDE. Ask anything, use `@` to mention files, or `/` for quick actions." },
  ]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [bottomTab, setBottomTab] = useState<"terminal" | "problems">("terminal");
  const [diagnostics, setDiagnostics] = useState<Array<{ line: number; column: number; severity: string; message: string }>>([]);
  const [splitFile, setSplitFile] = useState("");
  const [splitContent, setSplitContent] = useState("");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [editorVisible, setEditorVisible] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"files" | "search" | "chats" | "repos">("files");
  const [previewUrl, setPreviewUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [repoPrompt, setRepoPrompt] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [commitBusy, setCommitBusy] = useState(false);
  const [githubUser, setGithubUser] = useState<{ username: string; hasGithub: boolean } | null>(null);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [githubTokenInput, setGithubTokenInput] = useState("");
  const [githubConnectBusy, setGithubConnectBusy] = useState(false);

  // Share & Collaboration
  const [showShareModal, setShowShareModal] = useState(false);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [sharePermission, setSharePermission] = useState<"edit" | "view">("edit");
  const [latestShareUrl, setLatestShareUrl] = useState("");
  const [shareBusy, setShareBusy] = useState(false);

  // Inline AI Edit & Diff
  const [diffView, setDiffView] = useState<DiffViewState>(null);
  const [showInlineEdit, setShowInlineEdit] = useState(false);
  const [inlineEditPrompt, setInlineEditPrompt] = useState("");
  const [inlineEditBusy, setInlineEditBusy] = useState(false);

  // Approvals (Approve / Disapprove / Approve All)
  const [pendingPermissions, setPendingPermissions] = useState<Array<{ permissionId: string; resource: string; action: string; payload: any }>>([]);
  const [approveAllEnabled, setApproveAllEnabled] = useState(false);

  // @ mention & / slash menus
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);

  const wsSenderRef = useRef<((type: string, payload?: Record<string, unknown>) => void) | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const editorRef = useRef<any>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const clearPreview = useCallback(() => setPreviewUrl(""), []);

  const refreshFiles = useCallback(async (directory = ".") => {
    const [data, allData] = await Promise.all([
      api.json<{ entries: FileEntry[] }>("/api/workspace/files?path=" + encodeURIComponent(directory)),
      api.json<{ entries: FileEntry[] }>("/api/workspace/files?path=.&recursive=1").catch(() => ({ entries: [] })),
    ]);
    setFiles(data.entries || []);
    if (allData.entries?.length) setAllFiles(allData.entries);
    api.json<{ branch?: string; files?: Array<{ path: string; kind: string }> }>("/api/workspace/git/status").then(g => {
      if (g?.branch) setGitBranch(g.branch);
      const map: Record<string, string> = {};
      for (const item of g?.files || []) map[item.path] = item.kind;
      setGitFileStatuses(map);
    }).catch(() => {});
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const data = await api.json<{ tasks: AgentTask[] }>("/api/github/agent-tasks");
      setTasks(data.tasks || []);
    } catch { /* optional */ }
  }, []);

  const loadConversations = useCallback(async (restoreLatest = false) => {
    const data = await api.json<{ conversations: ConversationOption[] }>("/api/agent/conversations");
    const list = data.conversations || [];
    setConversations(list);
    if (restoreLatest && list.length) {
      const latest = list[0];
      setConversationId(latest.id);
      let stored: any[] = [];
      try { stored = typeof latest.messages === "string" ? JSON.parse(latest.messages) : latest.messages || []; } catch { stored = []; }
      const visible = stored
        .filter(item => (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
        .map(item => ({ role: item.role as "user" | "assistant", content: item.content }));
      setMessages(visible.length ? visible : [{ role: "assistant", content: "Welcome back to ATH IDE." }]);
    }
  }, []);

  const openConversation = useCallback((id: string) => {
    if (!id) {
      setConversationId(null);
      setMessages([{ role: "assistant", content: "New conversation started. Ask anything, `@` to mention files, `/` for actions." }]);
      return;
    }
    const selected = conversations.find(item => item.id === id);
    if (!selected) return;
    setConversationId(selected.id);
    let stored: any[] = [];
    try { stored = typeof selected.messages === "string" ? JSON.parse(selected.messages) : selected.messages || []; } catch { stored = []; }
    const visible = stored
      .filter(item => (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
      .map(item => ({ role: item.role as "user" | "assistant", content: item.content }));
    setMessages(visible.length ? visible : [{ role: "assistant", content: selected.title || "Conversation loaded." }]);
  }, [conversations]);

  const connectGithubRedirect = () => {
    if (typeof window === "undefined") return;
    window.location.href = "/api/auth/github?redirect=" + encodeURIComponent(window.location.origin);
  };

  const submitGithubToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubTokenInput.trim() || githubConnectBusy) return;
    setGithubConnectBusy(true);
    try {
      const data = await api.json<{ token?: string; githubUser?: { username: string } }>("/api/auth/connect-github", {
        method: "POST",
        body: JSON.stringify({ token: githubTokenInput.trim() }),
      });
      if (data?.token) {
        api.setTokens(data.token, "");
      }
      if (data?.githubUser?.username) {
        setGithubUser({ username: data.githubUser.username, hasGithub: true });
      }
      setGithubTokenInput("");
      setShowGithubModal(false);
      setSidebarTab("repos");
      await initialize();
      setNotice("GitHub account connected and saved to database.");
    } catch (error: any) {
      setNotice(error.message || "Invalid GitHub token.");
    } finally {
      setGithubConnectBusy(false);
    }
  };

  const initialize = useCallback(async () => {
    try {
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        const oauthToken = params.get("token");
        const authErr = params.get("auth_error");
        const githubSetup = params.get("github_setup") || params.get("github_modal");
        if (oauthToken) {
          api.setTokens(oauthToken, "");
          window.history.replaceState({}, "", window.location.pathname + window.location.hash);
          setSidebarTab("repos");
          setNotice("GitHub connected successfully.");
        } else if (githubSetup) {
          window.history.replaceState({}, "", window.location.pathname + window.location.hash);
          setSidebarTab("repos");
          setShowGithubModal(true);
        } else if (authErr) {
          window.history.replaceState({}, "", window.location.pathname + window.location.hash);
          setNotice("GitHub login error: " + authErr);
        }
      }
      if (!api.getAccessToken()) {
        const guest = await fetch("/api/auth/guest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        let auth: any = {};
        try { auth = await guest.json(); } catch {
          throw new Error(`API backend returned status ${guest.status}. Verify backend server is running.`);
        }
        if (!guest.ok || !auth.accessToken) throw new Error(auth.message || `Guest auth failed (${guest.status}).`);
        api.setTokens(auth.accessToken, auth.refreshToken || "");
      }

      const health = await api.json<any>("/api/health");
      setApiStatus(health.status === "ok" ? "Online" : "Degraded");
      const [modelData, sessionData, conversationData] = await Promise.all([
        api.json<any>("/api/agent/models"),
        api.json<any>("/api/workspace/sessions"),
        api.json<any>("/api/agent/conversations"),
      ]);
      const modelList = (modelData.models || []) as ModelOption[];
      setModels(modelList);
      const savedConversations = (conversationData.conversations || []) as ConversationOption[];
      setConversations(savedConversations);
      if (savedConversations.length) {
        const latest = savedConversations[0];
        setConversationId(latest.id);
        let stored: any[] = [];
        try { stored = typeof latest.messages === "string" ? JSON.parse(latest.messages) : latest.messages || []; } catch { stored = []; }
        const visible = stored
          .filter(item => (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
          .map(item => ({ role: item.role as "user" | "assistant", content: item.content }));
        if (visible.length) setMessages(visible);
      }
      const configured = modelList.find(item => item.configured);
      if (configured) setModel(configured.key);

      const list = (sessionData.sessions || []) as WorkspaceSession[];
      setSessions(list);
      const saved = api.getWorkspaceId();
      const selected = list.some(item => item.id === saved) ? saved : "default";
      api.setWorkspaceId(selected);
      setWorkspaceId(selected);
      await refreshFiles(".");
      try {
        const me = await api.json<{ user?: { username: string; hasGithub: boolean } }>("/api/auth/me");
        if (me?.user) setGithubUser({ username: me.user.username, hasGithub: Boolean(me.user.hasGithub) });
      } catch { /* optional */ }
      try {
        const poolResponse = await api.fetchWithAuth("/api/github/worker-pool");
        if (poolResponse.ok) {
          const pool = await poolResponse.json();
          setWorkerStatus(pool.onlineWorkers + " online · " + pool.busyWorkers + " busy");
        }
        const repoData = await api.json<any>("/api/github/repos");
        setRepos(repoData.repos || []);
        if (repoData.repos?.length) setSelectedRepo(repoData.repos[0].full_name || "");
        await loadTasks();
      } catch {
        setWorkerStatus("GitHub not connected");
      }
    } catch (error: any) {
      setApiStatus("Offline");
      setNotice(error.message || "Could not connect to ATH IDE.");
    }
  }, [loadTasks, refreshFiles]);

  useEffect(() => { initialize(); }, [initialize]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, pendingPermissions]);

  const changeWorkspace = async (id: string) => {
    api.setWorkspaceId(id);
    setWorkspaceId(id);
    setCurrentDir(".");
    setActiveFile("");
    setOpenTabs([]);
    setFileContent("");
    setSavedContent("");
    setFileVersion(null);
    setDiffView(null);
    setShowInlineEdit(false);
    await refreshFiles(".");
  };

  const createWorkspace = async () => {
    if (!workspaceName.trim()) return;
    try {
      const data = await api.json<{ session: WorkspaceSession }>("/api/workspace/sessions", { method: "POST", body: JSON.stringify({ name: workspaceName }) });
      setSessions(prev => [...prev, data.session]);
      setWorkspaceName("");
      setShowCreateWorkspace(false);
      await changeWorkspace(data.session.id);
      setNotice("Workspace created.");
    } catch (error: any) { setNotice(error.message); }
  };

  const openFileByPath = useCallback(async (filePath: string) => {
    if (activeFile && activeFile !== filePath) {
      setTabBuffers(prev => ({
        ...prev,
        [activeFile]: { content: fileContent, savedContent, version: fileVersion },
      }));
    }
    const cached = tabBuffers[filePath];
    if (cached && cached.content !== cached.savedContent) {
      setActiveFile(filePath);
      setOpenTabs(prev => prev.includes(filePath) ? prev : [...prev, filePath]);
      setFileContent(cached.content);
      setSavedContent(cached.savedContent);
      setFileVersion(cached.version);
      setDiffView(null);
      setShowInlineEdit(false);
      setEditorVisible(true);
      return;
    }
    try {
      const data = await api.json<any>("/api/workspace/file?path=" + encodeURIComponent(filePath));
      const content = data.content || "";
      const version = data.version || null;
      setActiveFile(filePath);
      setOpenTabs(prev => prev.includes(filePath) ? prev : [...prev, filePath]);
      setFileContent(content);
      setSavedContent(content);
      setFileVersion(version);
      setTabBuffers(prev => ({ ...prev, [filePath]: { content, savedContent: content, version } }));
      setDiffView(null);
      setShowInlineEdit(false);
      setEditorVisible(true);
    } catch (error: any) { setNotice(error.message); }
  }, [activeFile, fileContent, fileVersion, savedContent, tabBuffers]);

  const openFile = async (entry: FileEntry) => {
    if (entry.isDirectory) {
      const next = currentDir === "." ? entry.name : currentDir + "/" + entry.name;
      setCurrentDir(next);
      await refreshFiles(next);
      return;
    }
    await openFileByPath(entry.path);
  };

  const saveFile = useCallback(async () => {
    if (!activeFile) return;
    const headers: Record<string, string> = {};
    if (fileVersion) headers["If-Match"] = '"' + fileVersion + '"';
    else headers["If-None-Match"] = "*";
    try {
      const data = await api.json<any>("/api/workspace/file", { method: "POST", headers, body: JSON.stringify({ path: activeFile, content: fileContent }) });
      setFileVersion(data.version || null);
      setSavedContent(fileContent);
      setTabBuffers(prev => ({ ...prev, [activeFile]: { content: fileContent, savedContent: fileContent, version: data.version || null } }));
      setNotice("Saved " + activeFile);
      void runDiagnostics(activeFile, fileContent);
      await refreshFiles(currentDir);
    } catch (error: any) {
      setNotice((error as any).status === 409 ? "Save conflict: reload before saving." : error.message);
    }
  }, [activeFile, currentDir, fileContent, fileVersion, refreshFiles]);

  const createFile = () => {
    const base = currentDir === "." ? "src/index.js" : currentDir + "/index.js";
    setDialogInput(base);
    setDialogState({ kind: "new-file", title: "New File", placeholder: "src/index.js", defaultValue: base });
  };

  const createFolder = () => {
    const base = currentDir === "." ? "src" : currentDir + "/new-folder";
    setDialogInput(base);
    setDialogState({ kind: "new-folder", title: "New Folder", placeholder: "src/components", defaultValue: base });
  };

  const deleteEntry = (entry: FileEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    setDialogState({ kind: "delete", title: `Delete ${entry.name}?`, entry });
  };

  const renameEntry = (entry: FileEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    setDialogInput(entry.path);
    setDialogState({ kind: "rename", title: `Rename ${entry.name}`, entry, defaultValue: entry.path });
  };

  const submitDialog = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogState) return;
    const val = dialogInput.trim();
    if (dialogState.kind === "new-file") {
      if (!val) return;
      setActiveFile(val);
      setOpenTabs(prev => prev.includes(val) ? prev : [...prev, val]);
      setFileContent("");
      setSavedContent("");
      setFileVersion(null);
      setEditorVisible(true);
      setDialogState(null);
    } else if (dialogState.kind === "new-folder") {
      if (!val) return;
      try {
        await api.json("/api/workspace/folder", { method: "POST", body: JSON.stringify({ path: val }) });
        await refreshFiles(currentDir);
        setNotice("Folder created.");
      } catch (error: any) { setNotice(error.message || "Failed to create folder."); }
      setDialogState(null);
    } else if (dialogState.kind === "rename") {
      if (!val || val === dialogState.entry.path) { setDialogState(null); return; }
      try {
        await api.json("/api/workspace/move", { method: "POST", body: JSON.stringify({ source: dialogState.entry.path, destination: val }) });
        setOpenTabs(prev => prev.map(t => t === dialogState.entry.path ? val : t));
        if (activeFile === dialogState.entry.path) setActiveFile(val);
        await refreshFiles(currentDir);
        setNotice("Renamed to " + val);
      } catch (error: any) { setNotice(error.message || "Failed to rename."); }
      setDialogState(null);
    } else if (dialogState.kind === "delete") {
      const target = dialogState.entry;
      try {
        await api.json("/api/workspace/file?path=" + encodeURIComponent(target.path), { method: "DELETE" });
        setOpenTabs(prev => prev.filter(t => t !== target.path));
        if (activeFile === target.path) {
          setActiveFile("");
          setFileContent("");
          setSavedContent("");
        }
        await refreshFiles(currentDir);
        setNotice("Deleted " + target.path);
      } catch (error: any) { setNotice(error.message || "Failed to delete."); }
      setDialogState(null);
    }
  };

  const runWorkspaceSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!searchQuery.trim() || searchBusy) return;
    setSearchBusy(true);
    try {
      const data = await api.json<{ results: Array<{ file: string; line: number; text: string }> }>("/api/workspace/search?q=" + encodeURIComponent(searchQuery.trim()));
      setSearchResults(data.results || []);
    } catch (error: any) { setNotice(error.message || "Search failed."); }
    finally { setSearchBusy(false); }
  };

  const runActiveFile = () => {
    if (!activeFile) return;
    setTerminalVisible(true);
    const ext = activeFile.split(".").pop()?.toLowerCase() || "";
    const cmd =
      ext === "py" ? `python3 "${activeFile}"\r` :
      ext === "sh" ? `bash "${activeFile}"\r` :
      ext === "ts" ? `npx tsx "${activeFile}"\r` :
      `node "${activeFile}"\r`;
    wsSenderRef.current?.("terminal_input", { data: cmd });
  };

  // Global keyboard shortcuts matching Antigravity & VS Code
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowQuickOpen(false);
        setDialogState(null);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "p") {
        e.preventDefault();
        setQuickOpenQuery("");
        setShowQuickOpen(v => !v);
      } else if (e.shiftKey && key === "f") {
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("search");
      } else if (key === "s") {
        e.preventDefault();
        void saveFile();
      } else if (key === "k") {
        e.preventDefault();
        if (activeFile) setShowInlineEdit(v => !v);
      } else if (key === "j" || e.key === "`") {
        e.preventDefault();
        setTerminalVisible(v => !v);
      } else if (key === "b") {
        e.preventDefault();
        setSidebarVisible(v => !v);
      } else if (key === "l") {
        e.preventDefault();
        openConversation("");
        promptRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeFile, openConversation, saveFile]);

  const handlePromptChange = (val: string) => {
    setPrompt(val);
    const matchAt = val.match(/(?:^|\s)@([^\s]*)$/);
    if (matchAt) setMentionQuery(matchAt[1].toLowerCase());
    else setMentionQuery(null);

    const matchSlash = val.match(/^\/([^\s]*)$/);
    if (matchSlash) setSlashQuery(matchSlash[1].toLowerCase());
    else setSlashQuery(null);
  };

  const insertMention = (filePath: string) => {
    setPrompt(prev => prev.replace(/(?:^|\s)@([^\s]*)$/, (m) => (m.startsWith(" ") ? " " : "") + "@" + filePath + " "));
    setMentionQuery(null);
    promptRef.current?.focus();
  };

  const applySlashAction = (action: typeof SLASH_ACTIONS[number]) => {
    setSlashQuery(null);
    if (action.insert === "__CLEAR__") {
      setPrompt("");
      openConversation("");
      return;
    }
    setPrompt(action.insert + (activeFile ? `@${activeFile} ` : ""));
    promptRef.current?.focus();
  };

  const sendPrompt = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const message = prompt.trim();
    if (!message || busy) return;
    setPrompt("");
    setMentionQuery(null);
    setSlashQuery(null);
    setBusy(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setMessages(prev => [...prev, { role: "user", content: message }, { role: "assistant", content: "", activity: [] }]);
    try {
      const response = await api.fetchWithAuth("/api/agent/chat", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ message, model, conversationId }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Agent request failed (" + response.status + ")");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleFrame = (frame: string) => {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const text = line.slice(5).trim();
          if (!text || text === "[DONE]") continue;
          let evt: any;
          try { evt = JSON.parse(text); } catch { continue; }
          const data = evt.data || {};
          if (evt.type === "conversation_started" && data.conversationId) {
            setConversationId(data.conversationId);
          } else if (evt.type === "conversation_updated" && data.conversationId) {
            setConversationId(data.conversationId);
            void loadConversations(false);
          } else if (evt.type === "thinking_delta") {
            const delta = data.content || data.text || "";
            setMessages(prev => prev.map((item, idx) => idx === prev.length - 1 ? { ...item, thinking: (item.thinking || "") + delta } : item));
          } else if (evt.type === "text_delta") {
            const delta = data.content || data.text || "";
            setMessages(prev => prev.map((item, idx) => idx === prev.length - 1 ? { ...item, content: item.content + delta } : item));
          } else if (evt.type === "text_complete" && data.content) {
            setMessages(prev => prev.map((item, idx) => idx === prev.length - 1 ? { ...item, content: data.content } : item));
          } else if (evt.type === "tool_start" || evt.type === "tool_result" || evt.type === "model_selected" || evt.type === "usage") {
            const detail =
              evt.type === "model_selected" ? `Model: ${data.provider}/${data.model}` :
              evt.type === "usage" ? `Tokens: ${data.totalTokens || 0}` :
              evt.type === "tool_start" ? `Running ${data.name || "tool"}` :
              `${data.name || "Tool"} ${data.success ? "✓" : "✗"}`;
            setMessages(prev => prev.map((item, idx) => idx === prev.length - 1 ? { ...item, activity: [...(item.activity || []), detail].slice(-20) } : item));
          } else if (evt.type === "error") {
            setMessages(prev => prev.map((item, idx) => idx === prev.length - 1 ? { ...item, content: item.content + "\n\nError: " + (data.message || "Agent error") } : item));
          }
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        frames.forEach(handleFrame);
      }
      if (buffer.trim()) handleFrame(buffer);
      await refreshFiles(".");
      setCurrentDir(".");
      if (activeFile && fileContent === savedContent) {
        try {
          const updated = await api.json<any>("/api/workspace/file?path=" + encodeURIComponent(activeFile));
          setFileContent(updated.content || "");
          setSavedContent(updated.content || "");
          setFileVersion(updated.version || null);
        } catch { /* ignore */ }
      }
      await loadConversations(false);
    } catch (error: any) {
      if (error.name !== "AbortError") {
        setMessages(prev => prev.map((item, idx) => idx === prev.length - 1 ? { ...item, content: item.content + "\n\n" + error.message } : item));
      }
    } finally {
      abortControllerRef.current = null;
      setBusy(false);
    }
  };

  const createRepoTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedRepo || !repoPrompt.trim() || repoBusy) return;
    const [owner, name] = selectedRepo.split("/");
    if (!owner || !name) return;
    setRepoBusy(true);
    try {
      await api.json("/api/github/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/agent-tasks", { method: "POST", body: JSON.stringify({ prompt: repoPrompt }) });
      setRepoPrompt("");
      await loadTasks();
      setNotice("Repository coding task queued.");
    } catch (error: any) { setNotice(error.message); }
    finally { setRepoBusy(false); }
  };

  const cloneAndOpenRepo = async () => {
    if (!selectedRepo || cloneBusy) return;
    const [owner, name] = selectedRepo.split("/");
    if (!owner || !name) return;
    setCloneBusy(true);
    try {
      const data = await api.json<{ session: WorkspaceSession; repo: string }>(
        "/api/github/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/clone",
        { method: "POST" }
      );
      if (data.session) {
        setSessions(prev => [...prev, data.session]);
        await changeWorkspace(data.session.id);
        setSidebarTab("files");
        setNotice("Cloned and opened " + data.repo);
      }
    } catch (error: any) {
      setNotice(error.message || "Failed to clone repository.");
    } finally {
      setCloneBusy(false);
    }
  };

  const commitAndPush = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commitMsg.trim() || commitBusy) return;
    setCommitBusy(true);
    try {
      await api.json("/api/workspace/git/commit-push", {
        method: "POST",
        body: JSON.stringify({ message: commitMsg.trim(), push: true }),
      });
      setCommitMsg("");
      await refreshFiles(currentDir);
      setNotice("Committed and pushed to GitHub.");
    } catch (error: any) {
      setNotice(error.message || "Commit/push failed.");
    } finally {
      setCommitBusy(false);
    }
  };

  const loadShares = useCallback(async () => {
    try {
      const data = await api.json<{ shares: ShareLink[] }>("/api/workspace/collaboration/shares?workspaceId=" + encodeURIComponent(workspaceId));
      setShares(data.shares || []);
    } catch (error: any) { setNotice(error.message || "Could not load share links."); }
  }, [workspaceId]);

  const openShareModal = async () => {
    setShowShareModal(true);
    setLatestShareUrl("");
    await loadShares();
  };

  const createShareLink = async () => {
    if (shareBusy) return;
    setShareBusy(true);
    try {
      const data = await api.json<{ share: ShareLink; url: string }>("/api/workspace/collaboration/shares", {
        method: "POST",
        body: JSON.stringify({ workspaceId, permission: sharePermission, expiresInHours: 168 }),
      });
      let shareUrl = data.url;
      try {
        const parsed = new URL(data.url);
        if (parsed.hash && typeof window !== "undefined") shareUrl = window.location.origin + "/" + parsed.hash;
      } catch { /* ignore */ }
      setLatestShareUrl(shareUrl);
      await loadShares();
      setNotice("Share link created (" + sharePermission + ").");
    } catch (error: any) { setNotice(error.message || "Failed to create share link."); }
    finally { setShareBusy(false); }
  };

  const revokeShareLink = async (shareId: string) => {
    try {
      await api.json("/api/workspace/collaboration/shares/" + encodeURIComponent(shareId), { method: "DELETE" });
      setShares(prev => prev.filter(item => item.id !== shareId));
      setNotice("Share link revoked.");
    } catch (error: any) { setNotice(error.message || "Failed to revoke share link."); }
  };

  const openGitDiff = async () => {
    if (!activeFile) return;
    if (diffView && !diffView.isAiEdit) { setDiffView(null); return; }
    try {
      const data = await api.json<{ file: string; original: string; modified: string; isNew?: boolean }>("/api/workspace/git/diff?file=" + encodeURIComponent(activeFile));
      setDiffView({ title: (data.isNew ? "New file: " : "Git HEAD vs Working: ") + data.file, original: data.original || "", modified: fileContent, isAiEdit: false });
    } catch (error: any) { setNotice(error.message || "Git diff unavailable."); }
  };

  const runInlineAiEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeFile || !inlineEditPrompt.trim() || inlineEditBusy) return;
    setInlineEditBusy(true);
    try {
      const instruction = [
        `Edit the file "${activeFile}" according to this instruction: ${inlineEditPrompt.trim()}`,
        "Return ONLY the complete updated file contents inside a single code block, with no extra explanation.",
        "",
        "```" + languageFor(activeFile),
        fileContent,
        "```",
      ].join("\n");
      const response = await api.fetchWithAuth("/api/agent/chat", { method: "POST", body: JSON.stringify({ message: instruction, model }) });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Inline AI edit failed (" + response.status + ")");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resultText = "";
      const parseFrame = (frame: string) => {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const text = line.slice(5).trim();
          if (!text || text === "[DONE]") continue;
          try {
            const evt = JSON.parse(text);
            if (evt.type === "text_delta") resultText += (evt.data?.content || evt.data?.text || "");
            else if (evt.type === "text_complete" && evt.data?.content) resultText = evt.data.content;
            else if (evt.type === "error") throw new Error(evt.data?.message || "Inline edit error");
          } catch (err: any) {
            if (err?.message && err.message !== "Unexpected end of JSON input") throw err;
          }
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        frames.forEach(parseFrame);
      }
      if (buffer.trim()) parseFrame(buffer);
      let proposed = resultText.trim();
      const fenceMatch = proposed.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/);
      if (fenceMatch) proposed = fenceMatch[1];
      if (!proposed) throw new Error("AI returned an empty edit.");
      setDiffView({ title: "AI Edit Preview: " + activeFile, original: fileContent, modified: proposed, isAiEdit: true });
      setShowInlineEdit(false);
      setInlineEditPrompt("");
    } catch (error: any) { setNotice(error.message || "Inline AI edit failed."); }
    finally { setInlineEditBusy(false); }
  };

  const acceptDiffEdit = () => {
    if (!diffView?.isAiEdit) return;
    setFileContent(diffView.modified);
    setDiffView(null);
    setNotice("AI edit applied. Press Ctrl+S to save.");
  };

  const openSymbolOutline = () => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    editorRef.current.getAction("editor.action.quickOutline")?.run();
  };

  const runDiagnostics = useCallback(async (filePath: string, content: string) => {
    if (!filePath) { setDiagnostics([]); return; }
    try {
      const data = await api.json<{ diagnostics?: Array<{ line: number; column: number; severity: string; message: string }> }>("/api/workspace/diagnostics", {
        method: "POST",
        body: JSON.stringify({ path: filePath, content }),
      });
      setDiagnostics(data.diagnostics || []);
    } catch { /* diagnostics optional */ }
  }, []);

  const toggleSplitEditor = async () => {
    if (splitFile) {
      setSplitFile("");
      setSplitContent("");
      return;
    }
    const candidate = openTabs.find(t => t !== activeFile) || activeFile;
    if (!candidate) return;
    try {
      const data = await api.json<any>("/api/workspace/file?path=" + encodeURIComponent(candidate));
      setSplitFile(candidate);
      setSplitContent(data.content || "");
    } catch { /* ignore */ }
  };

  const deleteConversationById = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.json("/api/agent/conversations/" + encodeURIComponent(id), { method: "DELETE" });
      setConversations(prev => prev.filter(c => c.id !== id));
      if (conversationId === id) openConversation("");
      setNotice("Conversation deleted.");
    } catch (error: any) { setNotice(error.message || "Failed to delete conversation."); }
  };

  const handlePermissionRequested = useCallback((req: { permissionId: string; resource: string; action: string; payload: any }) => {
    if (!req?.permissionId) return;
    setPendingPermissions(prev => prev.some(p => p.permissionId === req.permissionId) ? prev : [...prev, req]);
  }, []);

  const handlePermissionResolved = useCallback((res: { permissionId: string; granted: boolean }) => {
    if (!res?.permissionId) return;
    setPendingPermissions(prev => prev.filter(p => p.permissionId !== res.permissionId));
  }, []);

  const respondPermission = (permissionId: string, granted: boolean, approveAll = false) => {
    wsSenderRef.current?.("permission.resolve", {
      permissionId,
      granted,
      approveAll,
      reason: granted ? (approveAll ? "Approved all by user" : "Approved by user") : "Disapproved by user",
    });
    if (granted && approveAll) {
      setApproveAllEnabled(true);
      setPendingPermissions([]);
    } else {
      setPendingPermissions(prev => prev.filter(p => p.permissionId !== permissionId));
    }
  };

  const toggleApproveAll = () => {
    const next = !approveAllEnabled;
    setApproveAllEnabled(next);
    wsSenderRef.current?.("permission.approve_all", { enabled: next });
    if (next) setPendingPermissions([]);
  };

  const dirty = Boolean(activeFile && fileContent !== savedContent);
  const filePool = allFiles.length ? allFiles : files;
  const filteredMentions = useMemo(() => {
    if (mentionQuery === null) return [];
    return filePool.filter(f => !f.isDirectory && f.path.toLowerCase().includes(mentionQuery)).slice(0, 8);
  }, [filePool, mentionQuery]);
  const quickOpenMatches = useMemo(() => {
    const q = quickOpenQuery.trim().toLowerCase();
    const list = filePool.filter(f => !f.isDirectory);
    if (!q) return list.slice(0, 12);
    return list.filter(f => f.path.toLowerCase().includes(q)).slice(0, 12);
  }, [filePool, quickOpenQuery]);
  const filteredSlash = useMemo(() => {
    if (slashQuery === null) return [];
    return SLASH_ACTIONS.filter(a => a.cmd.slice(1).includes(slashQuery));
  }, [slashQuery]);

  const activeTitle = conversations.find(c => c.id === conversationId)?.title || "New Conversation";

  return (
    <main className="h-screen bg-[#0a0a0a] text-neutral-200 flex flex-col overflow-hidden select-none relative">
      {/* Single Full-IDE Shadow Background */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-center bg-no-repeat bg-cover opacity-[0.15] z-0"
        style={{ backgroundImage: "url('/images/shadow-bg.jpg')" }}
      />
      {/* Top Bar */}
      <header className="h-11 shrink-0 border-b border-neutral-800/80 flex items-center justify-between px-3 bg-[#111111]/90 backdrop-blur-sm relative z-10">
        <div className="flex items-center gap-2.5 min-w-0">
          <button onClick={() => setSidebarVisible(v => !v)} className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200" title="Toggle Sidebar (Ctrl+B)">
            <PanelLeft size={15} />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-white font-bold text-xs">A</div>
            <span className="text-xs font-medium text-neutral-200 truncate">{workspaceId}</span>
            <span className="text-neutral-600">/</span>
            <span className="text-xs text-neutral-400 truncate max-w-52">{activeTitle}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-neutral-900 border border-neutral-800 text-[11px] text-neutral-400">
            <span className={"w-1.5 h-1.5 rounded-full " + (apiStatus === "Online" ? "bg-emerald-400" : "bg-amber-400")} />
            {apiStatus}
          </span>
          <DarkDropdown
            value={workspaceId}
            onChange={val => changeWorkspace(val)}
            options={sessions.map(item => ({ value: item.id, label: item.name }))}
            align="right"
            className="w-36"
          />
          <button onClick={() => setShowCreateWorkspace(v => !v)} className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200" title="New Workspace"><Plus size={14} /></button>
          <button onClick={openShareModal} className="flex items-center gap-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 rounded px-2.5 py-1 text-[11px]" title="Share Workspace">
            <Share2 size={12} /><span>Share</span>
          </button>
          {githubUser?.hasGithub ? (
            <span className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded bg-neutral-900 border border-neutral-800 text-[11px] text-neutral-300" title="Connected to GitHub">
              <FolderGit2 size={12} className="text-emerald-400" />@{githubUser.username}
            </span>
          ) : (
            <button onClick={connectGithubRedirect} className="hidden sm:flex items-center gap-1.5 bg-neutral-100 hover:bg-white text-black font-medium rounded px-2.5 py-1 text-[11px]" title="Connect GitHub via OAuth">
              <FolderGit2 size={12} /><span>Connect GitHub</span>
            </button>
          )}
          <button onClick={() => setEditorVisible(v => !v)} className={"p-1.5 rounded hover:bg-neutral-800 " + (editorVisible ? "text-neutral-200" : "text-neutral-500")} title="Toggle Editor & Terminal">
            <PanelRight size={15} />
          </button>
        </div>
      </header>

      {showCreateWorkspace && (
        <div className="px-4 py-2 border-b border-neutral-800 flex gap-2 bg-[#141414]">
          <input className="bg-[#0a0a0a] border border-neutral-700 rounded px-3 py-1 text-xs outline-none" placeholder="Workspace name" value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} />
          <button className="bg-neutral-200 text-black font-medium rounded px-3 text-xs" onClick={createWorkspace}>Create</button>
          <button className="text-neutral-400" onClick={() => setShowCreateWorkspace(false)}><X size={14} /></button>
        </div>
      )}

      {notice && (
        <button onClick={() => setNotice("")} className="text-left text-[11px] px-4 py-1.5 bg-neutral-900 text-neutral-300 border-b border-neutral-800 flex items-center justify-between">
          <span>{notice}</span>
          <span className="text-neutral-500">dismiss</span>
        </button>
      )}

      {/* GitHub Connect / OAuth Setup Modal */}
      {showGithubModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowGithubModal(false)}>
          <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-[#141416] shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-neutral-100"><FolderGit2 size={15} />Connect GitHub</div>
              <button onClick={() => setShowGithubModal(false)} className="text-neutral-400 hover:text-neutral-200"><X size={15} /></button>
            </div>
            <div className="p-4 space-y-4 text-xs">
              <form onSubmit={submitGithubToken} className="space-y-2.5">
                <div className="text-neutral-300 font-medium">Instant Connect (Personal Access Token)</div>
                <p className="text-[11px] text-neutral-500">
                  Generate a token with <span className="font-mono text-neutral-300">repo</span> scope on{" "}
                  <a href="https://github.com/settings/tokens/new?scopes=repo,read:user,user:email&description=ATH-IDE" target="_blank" rel="noreferrer" className="text-neutral-200 underline">
                    GitHub Tokens
                  </a>{" "}
                  and paste it below:
                </p>
                <input
                  type="password"
                  autoFocus
                  value={githubTokenInput}
                  onChange={e => setGithubTokenInput(e.target.value)}
                  placeholder="ghp_... or github_pat_..."
                  className="w-full bg-[#0a0a0a] border border-neutral-700 focus:border-neutral-500 rounded-lg px-3 py-2 text-xs text-neutral-100 font-mono outline-none"
                />
                <button disabled={!githubTokenInput.trim() || githubConnectBusy} className="w-full bg-neutral-100 hover:bg-white disabled:opacity-30 text-black font-medium rounded-lg py-2 text-xs">
                  {githubConnectBusy ? "Connecting…" : "Save & Connect GitHub"}
                </button>
              </form>
              <div className="pt-3 border-t border-neutral-800 space-y-1.5 text-[11px] text-neutral-500">
                <div className="text-neutral-300 font-medium">Want 1-click OAuth Redirect?</div>
                <p>Replace the placeholder <span className="font-mono text-neutral-300">GITHUB_CLIENT_ID</span> &amp; <span className="font-mono text-neutral-300">GITHUB_CLIENT_SECRET</span> in <span className="font-mono text-neutral-300">.env</span> with your GitHub OAuth App credentials.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Share Modal */}
      {showShareModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-neutral-800 bg-[#141414] shadow-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-neutral-100"><Users size={15} />Share Workspace</div>
              <button onClick={() => setShowShareModal(false)} className="text-neutral-400 hover:text-neutral-200"><X size={15} /></button>
            </div>
            <div className="p-4 space-y-4 text-xs">
              <div className="flex items-center gap-2">
                <DarkDropdown
                  value={sharePermission}
                  onChange={val => setSharePermission(val as "edit" | "view")}
                  options={[
                    { value: "edit", label: "Can edit files & terminal" },
                    { value: "view", label: "View only" },
                  ]}
                  className="w-48"
                />
                <button onClick={createShareLink} disabled={shareBusy} className="flex-1 bg-neutral-100 hover:bg-white disabled:opacity-40 text-black font-medium rounded px-3 py-2">
                  {shareBusy ? "Creating…" : "Create Share Link"}
                </button>
              </div>
              {latestShareUrl && (
                <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-2">
                  <input readOnly value={latestShareUrl} className="flex-1 bg-transparent text-emerald-200 outline-none text-[11px] select-all" />
                  <button onClick={() => { navigator.clipboard?.writeText(latestShareUrl); setNotice("Share URL copied."); }} className="flex items-center gap-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 px-2 py-1 rounded"><Copy size={12} />Copy</button>
                </div>
              )}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Active Share Links ({shares.length})</div>
                <div className="max-h-44 overflow-auto space-y-1.5">
                  {shares.map(item => (
                    <div key={item.id} className="flex items-center justify-between px-3 py-2 rounded bg-[#0a0a0a] border border-neutral-800">
                      <div>
                        <span className="font-medium text-neutral-200">{item.permission.toUpperCase()}</span>
                        <span className="ml-2 text-neutral-500">Expires {new Date(item.expiresAt).toLocaleDateString()}</span>
                      </div>
                      <button onClick={() => revokeShareLink(item.id)} className="text-rose-400 hover:text-rose-300 flex items-center gap-1"><Trash2 size={12} />Revoke</button>
                    </div>
                  ))}
                  {!shares.length && <div className="text-neutral-500 py-2">No active share links.</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Obsidian Action Dialog (New File / New Folder / Rename / Delete) */}
      {dialogState && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setDialogState(null)}>
          <form onSubmit={submitDialog} className="w-full max-w-md rounded-xl border border-neutral-800 bg-[#141416] shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-100">{dialogState.title}</span>
              <button type="button" onClick={() => setDialogState(null)} className="text-neutral-400 hover:text-neutral-200"><X size={14} /></button>
            </div>
            <div className="p-4 space-y-4">
              {dialogState.kind === "delete" ? (
                <p className="text-xs text-neutral-400">Are you sure you want to permanently delete <span className="font-mono text-neutral-200">{dialogState.entry.path}</span>?</p>
              ) : (
                <input
                  autoFocus
                  value={dialogInput}
                  onChange={e => setDialogInput(e.target.value)}
                  placeholder={dialogState.kind === "rename" ? "" : dialogState.placeholder}
                  className="w-full bg-[#0a0a0a] border border-neutral-700 focus:border-neutral-500 rounded-lg px-3 py-2 text-xs text-neutral-100 outline-none font-mono"
                />
              )}
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => setDialogState(null)} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs">Cancel</button>
                <button type="submit" className={"px-3.5 py-1.5 rounded-lg text-xs font-medium " + (dialogState.kind === "delete" ? "bg-rose-600 hover:bg-rose-500 text-white" : "bg-neutral-100 hover:bg-white text-black")}>
                  {dialogState.kind === "delete" ? "Delete" : "Confirm"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Quick Open Palette (Ctrl+P) */}
      {showQuickOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center pt-20 p-4" onClick={() => setShowQuickOpen(false)}>
          <div className="w-full max-w-xl rounded-xl border border-neutral-800 bg-[#141416] shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-neutral-800">
              <Search size={14} className="text-neutral-400" />
              <input
                autoFocus
                value={quickOpenQuery}
                onChange={e => setQuickOpenQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && quickOpenMatches.length) {
                    e.preventDefault();
                    void openFileByPath(quickOpenMatches[0].path);
                    setShowQuickOpen(false);
                  }
                }}
                placeholder="Go to file by name… (Enter to open, Esc to close)"
                className="flex-1 bg-transparent text-xs text-neutral-100 placeholder:text-neutral-500 outline-none"
              />
              <span className="text-[10px] text-neutral-500">Ctrl+P</span>
            </div>
            <div className="max-h-72 overflow-auto p-1.5 space-y-0.5">
              {quickOpenMatches.map(f => (
                <button
                  key={f.path}
                  onClick={() => { void openFileByPath(f.path); setShowQuickOpen(false); }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-neutral-800/80 text-left text-xs text-neutral-200"
                >
                  <span className="flex items-center gap-2 truncate"><File size={13} className="text-neutral-400 shrink-0" />{f.name}</span>
                  <span className="text-[10px] text-neutral-500 truncate ml-3">{f.path}</span>
                </button>
              ))}
              {!quickOpenMatches.length && <div className="text-xs text-neutral-500 p-3 text-center">No matching files</div>}
            </div>
          </div>
        </div>
      )}

      {/* Main 3-Pane Body */}
      <div className="flex-1 min-h-0 flex relative z-10">
        {/* Left Sidebar */}
        {sidebarVisible && (
          <aside className="w-60 shrink-0 border-r border-neutral-800/80 bg-[#111111]/85 backdrop-blur-sm flex flex-col min-h-0">
            <div className="p-2.5 border-b border-neutral-800/80 space-y-2">
              <button onClick={() => { openConversation(""); promptRef.current?.focus(); }} className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#1a1a1c] hover:bg-[#222225] border border-neutral-800 text-xs font-medium text-neutral-200">
                <span className="flex items-center gap-2"><MessageSquarePlus size={14} />New Conversation</span>
                <span className="text-[10px] text-neutral-500">Ctrl+L</span>
              </button>
              <div className="grid grid-cols-4 gap-1 bg-[#0a0a0a] p-0.5 rounded-lg border border-neutral-800/80 text-[11px]">
                <button onClick={() => setSidebarTab("files")} className={"py-1 rounded " + (sidebarTab === "files" ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}>Files</button>
                <button onClick={() => setSidebarTab("search")} className={"py-1 rounded " + (sidebarTab === "search" ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}>Search</button>
                <button onClick={() => setSidebarTab("chats")} className={"py-1 rounded " + (sidebarTab === "chats" ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}>Chats</button>
                <button onClick={() => setSidebarTab("repos")} className={"py-1 rounded " + (sidebarTab === "repos" ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}>Repos</button>
              </div>
            </div>

            {sidebarTab === "files" && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-3 py-2 text-[11px] text-neutral-500 flex items-center justify-between border-b border-neutral-800/60">
                  <span className="truncate">{currentDir}</span>
                  <div className="flex items-center gap-1.5">
                    <button onClick={createFile} title="New File" className="hover:text-neutral-200"><FilePlus2 size={13} /></button>
                    <button onClick={createFolder} title="New Folder" className="hover:text-neutral-200"><FolderPlus size={13} /></button>
                    <button onClick={() => { setCurrentDir("."); refreshFiles("."); }} title="Refresh" className="hover:text-neutral-200"><RefreshCw size={12} /></button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-1.5 text-xs space-y-0.5">
                  {currentDir !== "." && (
                    <button className="w-full text-left px-2 py-1 text-neutral-400 hover:bg-neutral-800/60 rounded flex items-center gap-2" onClick={() => { const next = currentDir.split("/").slice(0, -1).join("/") || "."; setCurrentDir(next); refreshFiles(next); }}>
                      <ChevronLeft size={13} />..
                    </button>
                  )}
                  {files.map(entry => (
                    <div key={entry.path} onClick={() => openFile(entry)} className={"group cursor-pointer w-full flex items-center justify-between gap-1 px-2 py-1.5 rounded text-left " + (activeFile === entry.path ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200")}>
                      <div className="flex items-center gap-2 min-w-0">
                        {entry.isDirectory ? <Folder size={13} className="text-neutral-400 shrink-0" /> : <File size={13} className="text-neutral-500 shrink-0" />}
                        <span className={"truncate " + (gitFileStatuses[entry.path] === "modified" ? "text-amber-300" : gitFileStatuses[entry.path] === "added" ? "text-emerald-300" : gitFileStatuses[entry.path] === "deleted" ? "text-rose-400 line-through" : "")}>{entry.name}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {gitFileStatuses[entry.path] && (
                          <span className={"text-[9px] font-bold px-1 " + (gitFileStatuses[entry.path] === "modified" ? "text-amber-400" : gitFileStatuses[entry.path] === "added" ? "text-emerald-400" : "text-rose-400")}>
                            {gitFileStatuses[entry.path] === "modified" ? "M" : gitFileStatuses[entry.path] === "added" ? "A" : "D"}
                          </span>
                        )}
                        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                          <button type="button" onClick={e => renameEntry(entry, e)} className="p-0.5 hover:text-white" title="Rename"><Pencil size={11} /></button>
                          <button type="button" onClick={e => deleteEntry(entry, e)} className="p-0.5 hover:text-rose-400" title="Delete"><Trash2 size={11} /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!files.length && <div className="text-[11px] text-neutral-600 p-2">Empty directory</div>}
                </div>
              </div>
            )}

            {sidebarTab === "search" && (
              <div className="flex-1 min-h-0 flex flex-col p-2 space-y-2 text-xs">
                <form onSubmit={runWorkspaceSearch} className="flex items-center gap-1.5">
                  <input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Find in files… (Ctrl+Shift+F)"
                    className="flex-1 bg-[#0a0a0a] border border-neutral-800 rounded px-2.5 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-600"
                  />
                  <button disabled={searchBusy} className="p-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"><Search size={13} /></button>
                </form>
                <div className="flex-1 overflow-auto space-y-1">
                  {searchResults.map((hit, idx) => (
                    <button
                      key={idx}
                      onClick={async () => {
                        await openFileByPath(hit.file);
                        setTimeout(() => {
                          editorRef.current?.revealLineInCenter(hit.line);
                          editorRef.current?.setPosition({ lineNumber: hit.line, column: 1 });
                          editorRef.current?.focus();
                        }, 120);
                      }}
                      className="w-full text-left p-2 rounded bg-[#0a0a0a] hover:bg-neutral-800/70 border border-neutral-800/70 space-y-0.5"
                    >
                      <div className="flex items-center justify-between text-[11px] text-neutral-300 font-medium">
                        <span className="truncate">{hit.file}</span>
                        <span className="text-neutral-500 ml-2">:{hit.line}</span>
                      </div>
                      <div className="text-[10px] font-mono text-neutral-500 truncate">{hit.text}</div>
                    </button>
                  ))}
                  {!searchResults.length && <div className="text-[11px] text-neutral-600 p-2">{searchBusy ? "Searching…" : "Enter a keyword to search across workspace files."}</div>}
                </div>
              </div>
            )}

            {sidebarTab === "chats" && (
              <div className="flex-1 overflow-auto p-1.5 space-y-0.5 text-xs">
                {conversations.map(c => (
                  <div key={c.id} onClick={() => openConversation(c.id)} className={"group cursor-pointer w-full flex items-center justify-between gap-1 px-2.5 py-2 rounded-md " + (conversationId === c.id ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200")}>
                    <span className="truncate">{c.title || "Untitled conversation"}</span>
                    <button type="button" onClick={e => deleteConversationById(c.id, e)} className="opacity-0 group-hover:opacity-100 hover:text-rose-400 p-0.5 transition-opacity shrink-0" title="Delete chat"><Trash2 size={11} /></button>
                  </div>
                ))}
                {!conversations.length && <div className="text-[11px] text-neutral-600 p-2">No saved conversations yet.</div>}
              </div>
            )}

            {sidebarTab === "repos" && (
              <div className="flex-1 min-h-0 flex flex-col p-2.5 space-y-2.5 text-xs overflow-auto">
                {!githubUser?.hasGithub ? (
                  <div className="rounded-xl border border-neutral-800 bg-[#0a0a0a] p-3 space-y-2.5">
                    <div className="text-xs font-medium text-neutral-200 flex items-center gap-1.5"><FolderGit2 size={14} />Connect GitHub</div>
                    <p className="text-[11px] text-neutral-500 leading-relaxed">Authorize with GitHub to browse your repositories, queue autonomous coding tasks, and open draft PRs.</p>
                    <button onClick={connectGithubRedirect} className="w-full bg-neutral-100 hover:bg-white text-black font-medium rounded-lg py-2 text-xs flex items-center justify-center gap-2">
                      <FolderGit2 size={13} />Continue with GitHub
                    </button>
                    <button onClick={() => setShowGithubModal(true)} className="w-full bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border border-neutral-800 rounded-lg py-1.5 text-[11px]">
                      Or connect with GitHub Token
                    </button>
                  </div>
                ) : (
                  <div className="text-[10px] text-neutral-400 flex items-center justify-between gap-1">
                    <span className="flex items-center gap-1.5 truncate"><FolderGit2 size={12} className="text-emerald-400 shrink-0" />@{githubUser.username}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" onClick={() => initialize()} className="p-1 hover:text-white rounded" title="Refresh GitHub repos"><RefreshCw size={11} /></button>
                      <button type="button" onClick={() => setShowGithubModal(true)} className="p-1 hover:text-white rounded" title="Update GitHub Token"><KeyRound size={11} /></button>
                    </div>
                  </div>
                )}
                {githubUser?.hasGithub && (
                  <>
                    <div className="space-y-1.5 pb-2 border-b border-neutral-800">
                      <DarkDropdown
                        value={selectedRepo}
                        onChange={val => setSelectedRepo(val)}
                        placeholder="Select repository"
                        options={repos.map(r => ({ value: r.full_name, label: r.full_name }))}
                        className="w-full"
                      />
                      <button type="button" onClick={cloneAndOpenRepo} disabled={!selectedRepo || cloneBusy} className="w-full bg-neutral-100 hover:bg-white disabled:opacity-30 text-black font-medium rounded-lg py-1.5 text-xs">
                        {cloneBusy ? "Cloning into IDE…" : "Clone & Open in IDE"}
                      </button>
                    </div>

                    <form onSubmit={commitAndPush} className="space-y-1.5 pb-2 border-b border-neutral-800">
                      <div className="text-[10px] uppercase tracking-wider text-neutral-500">Source Control ({gitBranch})</div>
                      <input
                        value={commitMsg}
                        onChange={e => setCommitMsg(e.target.value)}
                        placeholder="Commit message…"
                        className="w-full bg-[#0a0a0a] border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-200 outline-none"
                      />
                      <button disabled={!commitMsg.trim() || commitBusy} className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white font-medium rounded-lg py-1.5 text-xs">
                        {commitBusy ? "Pushing…" : "Commit & Push"}
                      </button>
                    </form>

                    <form onSubmit={createRepoTask} className="space-y-1.5">
                      <div className="text-[10px] uppercase tracking-wider text-neutral-500">Autonomous PR Task</div>
                      <textarea value={repoPrompt} onChange={e => setRepoPrompt(e.target.value)} placeholder="Describe PR change…" className="w-full h-14 bg-[#0a0a0a] border border-neutral-800 rounded p-2 text-xs text-neutral-200 outline-none" />
                      <button disabled={!selectedRepo || !repoPrompt.trim() || repoBusy} className="w-full bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-medium disabled:opacity-30 rounded-lg py-1.5 text-xs">
                        {repoBusy ? "Queueing…" : "Queue PR Task"}
                      </button>
                    </form>
                  </>
                )}
                <div className="space-y-1.5 pt-2 border-t border-neutral-800">
                  {tasks.map(t => (
                    <div key={t.id} className="rounded border border-neutral-800 bg-[#0a0a0a] p-2 text-[11px]">
                      <div className="font-medium text-neutral-200 truncate">{t.owner}/{t.repo}</div>
                      <div className="text-neutral-500">{t.status}</div>
                      {t.pr_url && <a href={t.pr_url} target="_blank" rel="noreferrer" className="text-neutral-200 underline mt-1 inline-block">Open draft PR</a>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-auto p-2.5 border-t border-neutral-800/80 text-[10px] text-neutral-500 flex items-center justify-between">
              <span>Linux Sandbox · Shortcuts</span>
              <span>Ctrl+K / Ctrl+J</span>
            </div>
          </aside>
        )}

        {/* Center Pane: Antigravity Conversation */}
        <section className="flex-1 min-w-0 flex flex-col bg-[#0a0a0a]/65 relative overflow-hidden">
          <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 space-y-4 select-text relative z-10">
            {messages.map((item, index) => (
              <div key={index} className={item.role === "user" ? "flex justify-end" : "space-y-2"}>
                {item.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl bg-[#1c1c1e] border border-neutral-800 px-4 py-2.5 text-[13px] text-neutral-100 whitespace-pre-wrap break-words">
                    {item.content}
                  </div>
                ) : (
                  <div className="space-y-2 max-w-full">
                    {item.thinking ? (
                      <details open={!item.content && busy && index === messages.length - 1} className="rounded-lg border border-neutral-800/90 bg-[#111111] px-3 py-2 text-xs text-neutral-400">
                        <summary className="cursor-pointer select-none font-medium text-neutral-300 flex items-center gap-1.5">
                          <ChevronRight size={13} className="inline" />Thought Process
                        </summary>
                        <div className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-400">{item.thinking}</div>
                      </details>
                    ) : null}

                    {item.activity?.length ? (
                      <div className="space-y-1">
                        {item.activity.map((line, i) => (
                          <div key={i} className="text-[11px] text-neutral-400 bg-[#111111] border border-neutral-800/70 rounded-md px-2.5 py-1 flex items-center gap-2">
                            <Activity size={11} className="text-neutral-500 shrink-0" />
                            <span className="truncate font-mono">{line}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="text-[13px] text-neutral-200 leading-relaxed whitespace-pre-wrap break-words">
                      {item.content || (busy && index === messages.length - 1 ? (item.thinking ? "Generating response…" : "Thinking…") : "")}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* 3-Option Approval Cards */}
            {pendingPermissions.map(req => (
              <div key={req.permissionId} className="rounded-xl border border-amber-500/30 bg-[#141414] p-3.5 text-xs space-y-2.5">
                <div className="font-semibold text-amber-300 uppercase text-[10px] tracking-wider">Approval Required · {req.resource}.{req.action}</div>
                <div className="font-mono text-[11px] text-neutral-200 bg-[#0a0a0a] border border-neutral-800 rounded-lg p-2.5 break-all">{req.payload?.command || req.payload?.path || JSON.stringify(req.payload)}</div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => respondPermission(req.permissionId, true, false)} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg py-1.5 font-medium">Approve</button>
                  <button type="button" onClick={() => respondPermission(req.permissionId, false, false)} className="flex-1 bg-neutral-800 hover:bg-rose-600/80 text-neutral-200 rounded-lg py-1.5 font-medium">Disapprove</button>
                  <button type="button" onClick={() => respondPermission(req.permissionId, true, true)} className="flex-1 bg-neutral-100 hover:bg-white text-black rounded-lg py-1.5 font-medium">Approve All</button>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Antigravity Prompt Composer */}
          <div className="p-3 sm:px-5 sm:pb-4 relative">
            {filteredMentions.length > 0 && (
              <div className="absolute bottom-full left-5 right-5 mb-1 rounded-lg border border-neutral-800 bg-[#141414] shadow-2xl p-1 z-30">
                <div className="text-[10px] text-neutral-500 px-2 py-1 uppercase">Mention file</div>
                {filteredMentions.map(f => (
                  <button key={f.path} type="button" onClick={() => insertMention(f.path)} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-neutral-800 text-xs text-neutral-200 flex items-center gap-2">
                    <File size={12} className="text-neutral-400" />{f.path}
                  </button>
                ))}
              </div>
            )}

            {filteredSlash.length > 0 && (
              <div className="absolute bottom-full left-5 right-5 mb-1 rounded-lg border border-neutral-800 bg-[#141414] shadow-2xl p-1 z-30">
                <div className="text-[10px] text-neutral-500 px-2 py-1 uppercase">Slash Actions</div>
                {filteredSlash.map(a => (
                  <button key={a.cmd} type="button" onClick={() => applySlashAction(a)} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-neutral-800 text-xs text-neutral-200 flex items-center justify-between">
                    <span className="font-mono text-neutral-100">{a.cmd}</span>
                    <span className="text-neutral-500 text-[11px]">{a.label}</span>
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={sendPrompt} className="rounded-xl border border-neutral-800 bg-[#161618] focus-within:border-neutral-600 transition-colors">
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={e => handlePromptChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendPrompt();
                  }
                }}
                placeholder="Ask anything, @ to mention, / for actions"
                className="w-full h-20 resize-none bg-transparent px-3.5 pt-3 text-[13px] text-neutral-100 placeholder:text-neutral-500 outline-none"
              />
              <div className="flex items-center justify-between px-3 pb-2.5 pt-1 text-xs">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={createFile} className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200" title="New file"><Plus size={14} /></button>
                  <DarkDropdown
                    value={model}
                    onChange={val => setModel(val)}
                    direction="up"
                    options={models.map(item => ({
                      value: item.key,
                      label: item.name,
                      sublabel: item.tier + (item.configured ? "" : " (not configured)"),
                      disabled: !item.configured,
                    }))}
                    className="w-40"
                  />
                  <button type="button" onClick={toggleApproveAll} className={"flex items-center gap-1 text-[11px] px-2 py-0.5 rounded " + (approveAllEnabled ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300")} title="Turbo: auto-approve safe/asked commands">
                    <Zap size={11} className={approveAllEnabled ? "text-amber-400" : ""} />
                    {approveAllEnabled ? "Turbo" : "Ask"}
                  </button>
                </div>
                {busy ? (
                  <button type="button" onClick={() => abortControllerRef.current?.abort()} className="w-7 h-7 rounded-full bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center text-rose-400" title="Stop">
                    <Square size={11} fill="currentColor" />
                  </button>
                ) : (
                  <button disabled={!prompt.trim()} className="w-7 h-7 rounded-full bg-neutral-200 hover:bg-white disabled:opacity-25 flex items-center justify-center text-black" title="Send (Enter)">
                    <Send size={12} />
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>

        {/* Right Pane: Monaco Editor + DiffEditor + Linux Terminal */}
        {editorVisible && (
          <section className="w-[48%] min-w-[340px] border-l border-neutral-800/80 flex flex-col min-h-0 bg-[#0a0a0a]/70">
            {/* Editor Tabs & Actions */}
            <div className="h-10 shrink-0 border-b border-neutral-800/80 flex items-center justify-between px-2.5 bg-[#111111] gap-2">
              <div className="flex items-center gap-1 overflow-x-auto min-w-0">
                {openTabs.map(tab => (
                  <div key={tab} className={"group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-md text-[11px] shrink-0 transition-colors " + (activeFile === tab ? "bg-[#1c1c1e] text-white border border-neutral-800" : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900")}>
                    <button onClick={() => openFileByPath(tab)} className="flex items-center gap-1.5">
                      <File size={11} />
                      <span className="max-w-28 truncate">{tab.split("/").pop()}</span>
                      {((activeFile === tab && dirty) || (activeFile !== tab && tabBuffers[tab] && tabBuffers[tab].content !== tabBuffers[tab].savedContent)) && <span className="text-amber-400">●</span>}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = openTabs.filter(t => t !== tab);
                        setOpenTabs(next);
                        if (activeFile === tab) {
                          if (next.length) void openFileByPath(next[next.length - 1]);
                          else { setActiveFile(""); setFileContent(""); setSavedContent(""); setDiffView(null); }
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 hover:text-white rounded p-0.5 transition-opacity"
                      title="Close tab"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {!openTabs.length && <span className="text-[11px] text-neutral-500 px-1">No file open</span>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {activeFile && <>
                  <button onClick={() => setShowInlineEdit(v => !v)} className={"flex items-center gap-1 rounded px-2 py-1 text-[11px] " + (showInlineEdit ? "bg-neutral-200 text-black" : "bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border border-neutral-800")} title="Inline AI Edit (Ctrl+K)"><Sparkles size={11} />Edit</button>
                  <button onClick={openGitDiff} className={"flex items-center gap-1 rounded px-2 py-1 text-[11px] " + (diffView && !diffView.isAiEdit ? "bg-neutral-200 text-black" : "hover:bg-neutral-800 text-neutral-400")} title="Git Diff"><GitCompare size={12} /></button>
                  <button onClick={openSymbolOutline} className="p-1.5 hover:bg-neutral-800 rounded text-neutral-400" title="Symbol Outline"><ListTree size={13} /></button>
                  <button onClick={toggleSplitEditor} className={"p-1.5 hover:bg-neutral-800 rounded " + (splitFile ? "text-white bg-neutral-800" : "text-neutral-400")} title="Toggle Split Editor"><Columns2 size={13} /></button>
                </>}
                {activeFile && <button onClick={runActiveFile} className="flex items-center gap-1 bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 border border-emerald-500/30 rounded px-2 py-1 text-[11px]" title="Run active file in Linux Terminal"><Play size={11} />Run</button>}
                <button disabled={!activeFile || !dirty} onClick={saveFile} className="flex items-center gap-1 bg-neutral-200 text-black disabled:opacity-25 rounded px-2 py-1 text-[11px] font-medium" title="Save (Ctrl+S)"><Save size={11} />Save</button>
                <button onClick={() => setTerminalVisible(v => !v)} className={"p-1.5 rounded hover:bg-neutral-800 " + (terminalVisible ? "text-neutral-200" : "text-neutral-500")} title="Toggle Terminal (Ctrl+J)"><SquareTerminal size={13} /></button>
              </div>
            </div>

            {showInlineEdit && activeFile && (
              <form onSubmit={runInlineAiEdit} className="px-3 py-2 border-b border-neutral-800 bg-[#141414] flex items-center gap-2">
                <Sparkles size={13} className="text-neutral-300 shrink-0" />
                <input value={inlineEditPrompt} onChange={e => setInlineEditPrompt(e.target.value)} placeholder={`AI Edit ${activeFile}…`} className="flex-1 bg-[#0a0a0a] border border-neutral-700 rounded px-2.5 py-1 text-xs text-neutral-100 outline-none" autoFocus />
                <button disabled={inlineEditBusy || !inlineEditPrompt.trim()} className="bg-neutral-200 text-black font-medium disabled:opacity-40 rounded px-2.5 py-1 text-xs">{inlineEditBusy ? "…" : "Preview"}</button>
                <button type="button" onClick={() => setShowInlineEdit(false)} className="text-neutral-400 hover:text-neutral-200"><X size={13} /></button>
              </form>
            )}

            {diffView && (
              <div className="px-3 py-1.5 border-b border-neutral-800 bg-[#161618] flex items-center justify-between text-xs">
                <span className="text-neutral-300 font-medium truncate">{diffView.title}</span>
                <div className="flex items-center gap-1.5">
                  {diffView.isAiEdit && <button onClick={acceptDiffEdit} className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 rounded text-[11px]"><Check size={12} />Accept</button>}
                  <button onClick={() => setDiffView(null)} className="flex items-center gap-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 px-2.5 py-1 rounded text-[11px]"><X size={12} />Close</button>
                </div>
              </div>
            )}

            {activeFile && (
              <div className="h-6 shrink-0 px-3 border-b border-neutral-800/50 bg-[#0a0a0a] flex items-center gap-1 text-[11px] text-neutral-500 truncate">
                <span>{workspaceId}</span>
                {activeFile.split("/").map((seg, i, arr) => (
                  <React.Fragment key={i}>
                    <ChevronRight size={10} className="text-neutral-700 shrink-0" />
                    <span className={i === arr.length - 1 ? "text-neutral-300 font-medium" : ""}>{seg}</span>
                  </React.Fragment>
                ))}
              </div>
            )}

            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 min-h-0">
              {activeFile ? (
                diffView ? (
                  <DiffEditor height="100%" theme="ath-obsidian" beforeMount={defineObsidianTheme} language={languageFor(activeFile)} original={diffView.original} modified={diffView.modified} options={{ renderSideBySide: true, readOnly: true, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false }} />
                ) : (
                  <Editor
                    height="100%"
                    theme="ath-obsidian"
                    beforeMount={defineObsidianTheme}
                    language={languageFor(activeFile)}
                    value={fileContent}
                    onMount={editor => {
                      editorRef.current = editor;
                      editor.onDidChangeCursorPosition((e: any) => {
                        setCursorPos({ line: e.position.lineNumber, col: e.position.column });
                      });
                    }}
                    onChange={v => setFileContent(v || "")}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineHeight: 20,
                      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace',
                      fontLigatures: true,
                      cursorBlinking: "smooth",
                      cursorSmoothCaretAnimation: "on",
                      cursorStyle: "line",
                      cursorWidth: 2,
                      smoothScrolling: true,
                      renderLineHighlight: "all",
                      bracketPairColorization: { enabled: true },
                      guides: { bracketPairs: true, indentation: true },
                      mouseWheelZoom: true,
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      tabSize: 2,
                      padding: { top: 12, bottom: 12 },
                    }}
                  />
                )
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-neutral-500 gap-3">
                  <Code2 size={32} className="text-neutral-400" />
                  <div className="text-xs text-neutral-400">Open a file from the sidebar or press Ctrl+K to edit</div>
                  <button onClick={createFile} className="text-xs px-3 py-1.5 bg-neutral-900/90 hover:bg-neutral-800 text-neutral-200 rounded-lg border border-neutral-700">New File</button>
                </div>
              )}
              </div>
              {splitFile && (
                <div className="w-1/2 min-w-0 min-h-0 border-l border-neutral-800 flex flex-col">
                  <div className="h-7 shrink-0 px-2.5 bg-[#111111] border-b border-neutral-800 flex items-center justify-between text-[11px] text-neutral-300">
                    <span className="truncate">{splitFile}</span>
                    <button onClick={() => { setSplitFile(""); setSplitContent(""); }} className="text-neutral-500 hover:text-white"><X size={12} /></button>
                  </div>
                  <div className="flex-1 min-h-0">
                    <Editor
                      height="100%"
                      theme="ath-obsidian"
                      beforeMount={defineObsidianTheme}
                      language={languageFor(splitFile)}
                      value={splitContent}
                      options={{ minimap: { enabled: false }, fontSize: 13, readOnly: true, automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 12, bottom: 12 } }}
                    />
                  </div>
                </div>
              )}
            </div>

            {terminalVisible && (
              <div className="h-56 shrink-0 border-t border-neutral-800/80 bg-[#0a0a0a] flex flex-col">
                <div className="h-8 flex items-center justify-between px-3 border-b border-neutral-800/80 bg-[#111111] text-[10px] text-neutral-400 uppercase tracking-wider">
                  <div className="flex items-center gap-3">
                    <button onClick={() => setBottomTab("terminal")} className={"flex items-center gap-1.5 py-1 " + (bottomTab === "terminal" ? "text-white font-semibold" : "text-neutral-500 hover:text-neutral-300")}><SquareTerminal size={12} />Terminal</button>
                    <button onClick={() => { setBottomTab("problems"); void runDiagnostics(activeFile, fileContent); }} className={"flex items-center gap-1.5 py-1 " + (bottomTab === "problems" ? "text-white font-semibold" : "text-neutral-500 hover:text-neutral-300")}><AlertTriangle size={11} />Problems ({diagnostics.length})</button>
                  </div>
                  <span className="text-neutral-500">Linux PTY · Ctrl+J</span>
                </div>
                {bottomTab === "terminal" ? (
                  <div className="flex-1 min-h-0 p-1.5">
                    <TerminalPanel
                      workspaceId={workspaceId}
                      apiStatus={apiStatus === "Online" ? "API online" : apiStatus}
                      onPreviewReady={setPreviewUrl}
                      onPreviewStopped={clearPreview}
                      onPermissionRequested={handlePermissionRequested}
                      onPermissionResolved={handlePermissionResolved}
                      onRegisterWsSender={fn => { wsSenderRef.current = fn; }}
                    />
                  </div>
                ) : (
                  <div className="flex-1 overflow-auto p-2 space-y-1 text-xs">
                    {diagnostics.map((d, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          editorRef.current?.revealLineInCenter(d.line);
                          editorRef.current?.setPosition({ lineNumber: d.line, column: d.column || 1 });
                          editorRef.current?.focus();
                        }}
                        className="w-full text-left px-2.5 py-1.5 rounded bg-[#111111] hover:bg-neutral-800/70 border border-neutral-800/80 flex items-center justify-between gap-2"
                      >
                        <span className="flex items-center gap-2 truncate">
                          <AlertTriangle size={12} className={d.severity === "error" ? "text-rose-400 shrink-0" : "text-amber-400 shrink-0"} />
                          <span className="text-neutral-200 truncate">{d.message}</span>
                        </span>
                        <span className="text-[10px] text-neutral-500 shrink-0">Ln {d.line}:{d.column || 1}</span>
                      </button>
                    ))}
                    {!diagnostics.length && <div className="text-[11px] text-neutral-500 p-2">No problems detected in {activeFile || "workspace"}.</div>}
                  </div>
                )}
              </div>
            )}

            {previewUrl && (
              <div className="h-8 shrink-0 border-t border-neutral-800 bg-[#111111] flex items-center px-3 text-xs text-emerald-400">
                Preview: <a className="ml-2 underline" href={previewUrl} target="_blank" rel="noreferrer">{previewUrl}</a>
              </div>
            )}
          </section>
        )}
      </div>

      {/* Bottom IDE Status Bar */}
      <footer className="h-6 shrink-0 border-t border-neutral-800/80 bg-[#111111]/90 backdrop-blur-sm px-3 flex items-center justify-between text-[10px] text-neutral-500 relative z-10">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-neutral-300"><GitBranch size={11} />{gitBranch}</span>
          <span className="flex items-center gap-1"><span className={"w-1.5 h-1.5 rounded-full " + (apiStatus === "Online" ? "bg-emerald-400" : "bg-amber-400")} />{apiStatus}</span>
          <span>Linux Sandbox</span>
        </div>
        <div className="flex items-center gap-3">
          {activeFile && <>
            <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
            <span className="uppercase">{languageFor(activeFile)}</span>
            <span>Spaces: 2</span>
            <span>UTF-8</span>
          </>}
          <button onClick={() => { setQuickOpenQuery(""); setShowQuickOpen(true); }} className="hover:text-neutral-200">Quick Open (Ctrl+P)</button>
        </div>
      </footer>
    </main>
  );
}
