"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  Activity,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  File,
  FilePlus2,
  Folder,
  FolderGit2,
  GitCompare,
  ListTree,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Save,
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
  const [currentDir, setCurrentDir] = useState(".");
  const [activeFile, setActiveFile] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileVersion, setFileVersion] = useState<string | null>(null);
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
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [editorVisible, setEditorVisible] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"files" | "chats" | "repos">("files");
  const [previewUrl, setPreviewUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [repoPrompt, setRepoPrompt] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);

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
    const data = await api.json<{ entries: FileEntry[] }>("/api/workspace/files?path=" + encodeURIComponent(directory));
    setFiles(data.entries || []);
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

  const initialize = useCallback(async () => {
    try {
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
    try {
      const data = await api.json<any>("/api/workspace/file?path=" + encodeURIComponent(filePath));
      setActiveFile(filePath);
      setOpenTabs(prev => prev.includes(filePath) ? prev : [...prev, filePath]);
      setFileContent(data.content || "");
      setSavedContent(data.content || "");
      setFileVersion(data.version || null);
      setDiffView(null);
      setShowInlineEdit(false);
      setEditorVisible(true);
    } catch (error: any) { setNotice(error.message); }
  }, []);

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
      setNotice("Saved " + activeFile);
      await refreshFiles(currentDir);
    } catch (error: any) {
      setNotice((error as any).status === 409 ? "Save conflict: reload before saving." : error.message);
    }
  }, [activeFile, currentDir, fileContent, fileVersion, refreshFiles]);

  const createFile = () => {
    const name = window.prompt("New relative file path:", "src/index.js");
    if (!name?.trim()) return;
    const clean = name.trim();
    setActiveFile(clean);
    setOpenTabs(prev => prev.includes(clean) ? prev : [...prev, clean]);
    setFileContent("");
    setSavedContent("");
    setFileVersion(null);
    setEditorVisible(true);
  };

  // Global keyboard shortcuts matching Antigravity
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
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
  const filteredMentions = useMemo(() => {
    if (mentionQuery === null) return [];
    return files.filter(f => !f.isDirectory && f.path.toLowerCase().includes(mentionQuery)).slice(0, 8);
  }, [files, mentionQuery]);
  const filteredSlash = useMemo(() => {
    if (slashQuery === null) return [];
    return SLASH_ACTIONS.filter(a => a.cmd.slice(1).includes(slashQuery));
  }, [slashQuery]);

  const activeTitle = conversations.find(c => c.id === conversationId)?.title || "New Conversation";

  return (
    <main className="h-screen bg-[#0a0a0a] text-neutral-200 flex flex-col overflow-hidden select-none">
      {/* Top Bar */}
      <header className="h-11 shrink-0 border-b border-neutral-800/80 flex items-center justify-between px-3 bg-[#111111]">
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
          <select className="bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-[11px] text-neutral-300 max-w-36 outline-none" value={workspaceId} onChange={e => changeWorkspace(e.target.value)}>
            {sessions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button onClick={() => setShowCreateWorkspace(v => !v)} className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200" title="New Workspace"><Plus size={14} /></button>
          <button onClick={openShareModal} className="flex items-center gap-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 rounded px-2.5 py-1 text-[11px]" title="Share Workspace">
            <Share2 size={12} /><span>Share</span>
          </button>
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
                <select value={sharePermission} onChange={e => setSharePermission(e.target.value as "edit" | "view")} className="bg-[#0a0a0a] border border-neutral-700 rounded px-3 py-2 text-xs text-neutral-200">
                  <option value="edit">Can edit files &amp; terminal</option>
                  <option value="view">View only</option>
                </select>
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

      {/* Main 3-Pane Body */}
      <div className="flex-1 min-h-0 flex">
        {/* Left Sidebar */}
        {sidebarVisible && (
          <aside className="w-60 shrink-0 border-r border-neutral-800/80 bg-[#111111] flex flex-col min-h-0">
            <div className="p-2.5 border-b border-neutral-800/80 space-y-2">
              <button onClick={() => { openConversation(""); promptRef.current?.focus(); }} className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#1a1a1c] hover:bg-[#222225] border border-neutral-800 text-xs font-medium text-neutral-200">
                <span className="flex items-center gap-2"><MessageSquarePlus size={14} />New Conversation</span>
                <span className="text-[10px] text-neutral-500">Ctrl+L</span>
              </button>
              <div className="grid grid-cols-3 gap-1 bg-[#0a0a0a] p-0.5 rounded-lg border border-neutral-800/80 text-[11px]">
                <button onClick={() => setSidebarTab("files")} className={"py-1 rounded " + (sidebarTab === "files" ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}>Files</button>
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
                    <button key={entry.path} onClick={() => openFile(entry)} className={"w-full flex items-center gap-2 px-2 py-1.5 rounded text-left " + (activeFile === entry.path ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200")}>
                      {entry.isDirectory ? <Folder size={13} className="text-neutral-400 shrink-0" /> : <File size={13} className="text-neutral-500 shrink-0" />}
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ))}
                  {!files.length && <div className="text-[11px] text-neutral-600 p-2">Empty directory</div>}
                </div>
              </div>
            )}

            {sidebarTab === "chats" && (
              <div className="flex-1 overflow-auto p-1.5 space-y-0.5 text-xs">
                {conversations.map(c => (
                  <button key={c.id} onClick={() => openConversation(c.id)} className={"w-full text-left px-2.5 py-2 rounded-md truncate " + (conversationId === c.id ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200")}>
                    {c.title || "Untitled conversation"}
                  </button>
                ))}
                {!conversations.length && <div className="text-[11px] text-neutral-600 p-2">No saved conversations yet.</div>}
              </div>
            )}

            {sidebarTab === "repos" && (
              <div className="flex-1 min-h-0 flex flex-col p-2.5 space-y-2 text-xs overflow-auto">
                <div className="text-[10px] text-neutral-500 flex items-center gap-1.5"><FolderGit2 size={12} />{workerStatus}</div>
                <form onSubmit={createRepoTask} className="space-y-2">
                  <select value={selectedRepo} onChange={e => setSelectedRepo(e.target.value)} className="w-full bg-[#0a0a0a] border border-neutral-800 rounded p-1.5 text-xs text-neutral-200">
                    <option value="">Select repository</option>
                    {repos.map(r => <option key={r.full_name} value={r.full_name}>{r.full_name}</option>)}
                  </select>
                  <textarea value={repoPrompt} onChange={e => setRepoPrompt(e.target.value)} placeholder="Describe repo change…" className="w-full h-16 bg-[#0a0a0a] border border-neutral-800 rounded p-2 text-xs text-neutral-200 outline-none" />
                  <button disabled={!selectedRepo || !repoPrompt.trim() || repoBusy} className="w-full bg-neutral-200 text-black font-medium disabled:opacity-30 rounded py-1.5 text-xs">
                    {repoBusy ? "Queueing…" : "Queue Task"}
                  </button>
                </form>
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
        <section className="flex-1 min-w-0 flex flex-col bg-[#0a0a0a]">
          <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 space-y-4 select-text">
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
                  <select value={model} onChange={e => setModel(e.target.value)} className="bg-transparent text-neutral-400 hover:text-neutral-200 text-[11px] outline-none cursor-pointer max-w-44">
                    {models.map(item => <option key={item.key} value={item.key} disabled={!item.configured} className="bg-[#141414]">{item.name} · {item.tier}{item.configured ? "" : " (off)"}</option>)}
                  </select>
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
          <section className="w-[48%] min-w-[340px] border-l border-neutral-800/80 flex flex-col min-h-0 bg-[#0a0a0a]">
            {/* Editor Tabs & Actions */}
            <div className="h-10 shrink-0 border-b border-neutral-800/80 flex items-center justify-between px-2.5 bg-[#111111] gap-2">
              <div className="flex items-center gap-1 overflow-x-auto min-w-0">
                {openTabs.map(tab => (
                  <button key={tab} onClick={() => openFileByPath(tab)} className={"flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] shrink-0 " + (activeFile === tab ? "bg-[#1c1c1e] text-white border border-neutral-800" : "text-neutral-500 hover:text-neutral-300")}>
                    <File size={11} />
                    <span className="max-w-28 truncate">{tab.split("/").pop()}</span>
                    {activeFile === tab && dirty && <span className="text-amber-400">●</span>}
                  </button>
                ))}
                {!openTabs.length && <span className="text-[11px] text-neutral-500 px-1">No file open</span>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {activeFile && <>
                  <button onClick={() => setShowInlineEdit(v => !v)} className={"flex items-center gap-1 rounded px-2 py-1 text-[11px] " + (showInlineEdit ? "bg-neutral-200 text-black" : "bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border border-neutral-800")} title="Inline AI Edit (Ctrl+K)"><Sparkles size={11} />Edit</button>
                  <button onClick={openGitDiff} className={"flex items-center gap-1 rounded px-2 py-1 text-[11px] " + (diffView && !diffView.isAiEdit ? "bg-neutral-200 text-black" : "hover:bg-neutral-800 text-neutral-400")} title="Git Diff"><GitCompare size={12} /></button>
                  <button onClick={openSymbolOutline} className="p-1.5 hover:bg-neutral-800 rounded text-neutral-400" title="Symbol Outline"><ListTree size={13} /></button>
                </>}
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

            <div className="flex-1 min-h-0">
              {activeFile ? (
                diffView ? (
                  <DiffEditor height="100%" theme="vs-dark" language={languageFor(activeFile)} original={diffView.original} modified={diffView.modified} options={{ renderSideBySide: true, readOnly: true, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false }} />
                ) : (
                  <Editor height="100%" theme="vs-dark" language={languageFor(activeFile)} value={fileContent} onMount={editor => { editorRef.current = editor; }} onChange={v => setFileContent(v || "")} options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false, tabSize: 2 }} />
                )
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-neutral-600 gap-3">
                  <Code2 size={32} />
                  <div className="text-xs">Open a file from the sidebar or press Ctrl+K to edit</div>
                  <button onClick={createFile} className="text-xs px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded border border-neutral-700">New File</button>
                </div>
              )}
            </div>

            {terminalVisible && (
              <div className="h-56 shrink-0 border-t border-neutral-800/80 bg-[#0a0a0a] flex flex-col">
                <div className="h-8 flex items-center justify-between px-3 border-b border-neutral-800/80 bg-[#111111] text-[10px] text-neutral-400 uppercase tracking-wider">
                  <span className="flex items-center gap-1.5"><SquareTerminal size={12} />Terminal</span>
                  <span className="text-neutral-500">Linux PTY · Ctrl+J</span>
                </div>
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
    </main>
  );
}
