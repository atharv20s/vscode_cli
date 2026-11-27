"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { Activity, Bot, Check, ChevronLeft, Code2, Copy, File, FilePlus2, Folder, GitCompare, ListTree, Plus, RefreshCw, Save, Send, Share2, Sparkles, SquareTerminal, Trash2, Users, X } from "lucide-react";
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

const languageFor = (file: string) => {
  const ext = file.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", py: "python", html: "html", css: "css", md: "markdown", yml: "yaml", yaml: "yaml", rs: "rust", go: "go", sql: "sql", sh: "shell", ps1: "powershell" };
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
  const [fileContent, setFileContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileVersion, setFileVersion] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("devstral");
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: "Welcome to ATH IDE. Chat, file editing, model discovery, workspace sessions and your terminal connect to the backend." }]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState("Connecting to the workspace terminal…\r\n");
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalConnected, setTerminalConnected] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [previewUrl, setPreviewUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [repoPrompt, setRepoPrompt] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "tasks">("chat");
  const [showShareModal, setShowShareModal] = useState(false);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [sharePermission, setSharePermission] = useState<"edit" | "view">("edit");
  const [latestShareUrl, setLatestShareUrl] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [diffView, setDiffView] = useState<DiffViewState>(null);
  const [showInlineEdit, setShowInlineEdit] = useState(false);
  const [inlineEditPrompt, setInlineEditPrompt] = useState("");
  const [inlineEditBusy, setInlineEditBusy] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<Array<{ permissionId: string; resource: string; action: string; payload: any }>>([]);
  const [approveAllEnabled, setApproveAllEnabled] = useState(false);
  const wsSenderRef = useRef<((type: string, payload?: Record<string, unknown>) => void) | null>(null);
  const editorRef = useRef<any>(null);
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
    } catch { /* GitHub integration is optional until connected. */ }
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
      setMessages(visible.length ? visible : [{ role: "assistant", content: "Welcome back to ATH IDE. Your conversation is saved." }]);
    }
  }, []);

  const openConversation = (id: string) => {
    if (!id) {
      setConversationId(null);
      setMessages([{ role: "assistant", content: "New chat. Your next message will start a saved conversation." }]);
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
  };

  const initialize = useCallback(async () => {
    try {
      if (!api.getAccessToken()) {
        const guest = await fetch("/api/auth/guest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        let auth: any = {};
        try {
          auth = await guest.json();
        } catch {
          throw new Error(`API backend returned status ${guest.status} (non-JSON response). Verify backend server is running.`);
        }
        if (!guest.ok || !auth.accessToken) throw new Error(auth.message || `Could not initialize guest authentication (${guest.status}).`);
        api.setTokens(auth.accessToken, auth.refreshToken || "");
      }

      const health = await api.json<any>("/api/health");
      setApiStatus(health.status === "ok" ? "API online" : "API degraded");
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
        setWorkerStatus("Connect GitHub / configure Redis");
      }
    } catch (error: any) {
      setApiStatus("API unavailable");
      setNotice(error.message || "Could not connect to ATH IDE.");
    }
  }, [loadTasks, refreshFiles]);

  useEffect(() => { initialize(); }, [initialize]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const changeWorkspace = async (id: string) => {
    api.setWorkspaceId(id);
    setWorkspaceId(id);
    setCurrentDir(".");
    setActiveFile("");
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

  const openFile = async (entry: FileEntry) => {
    if (entry.isDirectory) {
      const next = currentDir === "." ? entry.name : currentDir + "/" + entry.name;
      setCurrentDir(next);
      await refreshFiles(next);
      return;
    }
    try {
      const data = await api.json<any>("/api/workspace/file?path=" + encodeURIComponent(entry.path));
      setActiveFile(entry.path);
      setFileContent(data.content || "");
      setSavedContent(data.content || "");
      setFileVersion(data.version || null);
      setDiffView(null);
      setShowInlineEdit(false);
    } catch (error: any) { setNotice(error.message); }
  };

  const saveFile = async () => {
    if (!activeFile) return;
    const headers: Record<string, string> = {};
    if (fileVersion) headers["If-Match"] = '"' + fileVersion + '"';
    else headers["If-None-Match"] = "*";
    try {
      const data = await api.json<any>("/api/workspace/file", { method: "POST", headers, body: JSON.stringify({ path: activeFile, content: fileContent }) });
      setFileVersion(data.version || null);
      setSavedContent(fileContent);
      setNotice("File saved. Version " + String(data.version || "").slice(0, 10));
      await refreshFiles(currentDir);
    } catch (error: any) {
      const status = (error as any).status;
      setNotice(status === 409 ? "Save conflict: another session changed this file. Re-open it before saving." : error.message);
    }
  };

  const createFile = () => {
    const name = window.prompt("New relative file path:", "src/index.js");
    if (!name?.trim()) return;
    setActiveFile(name.trim());
    setFileContent("");
    setSavedContent("");
    setFileVersion(null);
  };

  const sendPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || busy) return;
    setPrompt("");
    setBusy(true);
    setMessages(prev => [...prev, { role: "user", content: message }, { role: "assistant", content: "", activity: ["Request sent to the agent API"] }]);
    try {
      const response = await api.fetchWithAuth("/api/agent/chat", {
        method: "POST",
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
          let event: any;
          try { event = JSON.parse(text); } catch { continue; }
          const data = event.data || {};
          if (event.type === "conversation_started" && data.conversationId) {
            setConversationId(data.conversationId);
          } else if (event.type === "conversation_updated" && data.conversationId) {
            setConversationId(data.conversationId);
            void loadConversations(false);
          } else if (event.type === "thinking_delta") {
            const delta = data.content || data.text || "";
            setMessages(prev => prev.map((item, index) => index === prev.length - 1 ? { ...item, thinking: (item.thinking || "") + delta } : item));
          } else if (event.type === "text_delta") {
            const delta = data.content || data.text || "";
            setMessages(prev => prev.map((item, index) => index === prev.length - 1 ? { ...item, content: item.content + delta } : item));
          } else if (event.type === "text_complete" && data.content) {
            setMessages(prev => prev.map((item, index) => index === prev.length - 1 ? { ...item, content: data.content } : item));
          } else if (event.type === "tool_start" || event.type === "tool_result" || event.type === "model_selected" || event.type === "usage") {
            const detail = event.type === "model_selected" ? "Model " + data.provider + "/" + data.model + " (" + data.tier + ")" :
              event.type === "usage" ? "Tokens " + (data.totalTokens || 0) :
              event.type === "tool_start" ? "Running " + (data.name || "tool") :
              (data.name || "Tool") + (data.success ? " completed" : " failed");
            setMessages(prev => prev.map((item, index) => index === prev.length - 1 ? { ...item, activity: [...(item.activity || []), detail].slice(-16) } : item));
          } else if (event.type === "error") {
            setMessages(prev => prev.map((item, index) => index === prev.length - 1 ? { ...item, content: item.content + "\n\nError: " + (data.message || "Agent error") } : item));
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
        } catch { /* file may have been deleted or moved */ }
      }
      await loadConversations(false);
    } catch (error: any) {
      setMessages(prev => prev.map((item, index) => index === prev.length - 1 ? { ...item, content: item.content + "\n\n" + error.message } : item));
    } finally { setBusy(false); }
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
    } catch (error: any) {
      setNotice(error.message || "Could not load share links.");
    }
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
        if (parsed.hash && typeof window !== "undefined") {
          shareUrl = window.location.origin + "/" + parsed.hash;
        }
      } catch { /* fallback to backend url */ }
      setLatestShareUrl(shareUrl);
      await loadShares();
      setNotice("Share link created (" + sharePermission + " access).");
    } catch (error: any) {
      setNotice(error.message || "Failed to create share link.");
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShareLink = async (shareId: string) => {
    try {
      await api.json("/api/workspace/collaboration/shares/" + encodeURIComponent(shareId), { method: "DELETE" });
      setShares(prev => prev.filter(item => item.id !== shareId));
      setNotice("Share link revoked.");
    } catch (error: any) {
      setNotice(error.message || "Failed to revoke share link.");
    }
  };

  const openGitDiff = async () => {
    if (!activeFile) return;
    if (diffView && !diffView.isAiEdit) {
      setDiffView(null);
      return;
    }
    try {
      const data = await api.json<{ file: string; original: string; modified: string; isNew?: boolean }>("/api/workspace/git/diff?file=" + encodeURIComponent(activeFile));
      setDiffView({
        title: (data.isNew ? "New file: " : "Git HEAD vs Working: ") + data.file,
        original: data.original || "",
        modified: fileContent,
        isAiEdit: false,
      });
    } catch (error: any) {
      setNotice(error.message || "Git diff unavailable for this workspace.");
    }
  };

  const runInlineAiEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeFile || !inlineEditPrompt.trim() || inlineEditBusy) return;
    setInlineEditBusy(true);
    try {
      const instruction = [
        `Edit the file "${activeFile}" according to this instruction: ${inlineEditPrompt.trim()}`,
        "Return ONLY the complete updated file contents inside a single code block, with no extra explanation before or after.",
        "",
        "Current file contents:",
        "```" + languageFor(activeFile),
        fileContent,
        "```",
      ].join("\n");

      const response = await api.fetchWithAuth("/api/agent/chat", {
        method: "POST",
        body: JSON.stringify({ message: instruction, model }),
      });
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

      setDiffView({
        title: "AI Edit Preview: " + activeFile,
        original: fileContent,
        modified: proposed,
        isAiEdit: true,
      });
      setShowInlineEdit(false);
      setInlineEditPrompt("");
    } catch (error: any) {
      setNotice(error.message || "Inline AI edit failed.");
    } finally {
      setInlineEditBusy(false);
    }
  };

  const acceptDiffEdit = () => {
    if (!diffView?.isAiEdit) return;
    setFileContent(diffView.modified);
    setDiffView(null);
    setNotice("AI edit applied to editor. Click Save to persist.");
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
  const configuredModels = useMemo(() => models.filter(item => item.configured), [models]);

  return (
    <main className="h-screen bg-[#080d16] text-slate-100 flex flex-col overflow-hidden">
      <header className="h-14 shrink-0 border-b border-slate-800 flex items-center justify-between px-4 bg-[#0d1422]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center"><Code2 size={18}/></div>
          <div><div className="font-semibold tracking-wide">ATH <span className="text-indigo-400">IDE</span></div><div className="text-[10px] text-slate-500">Autonomous development studio</div></div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5 text-slate-400"><span className={"w-2 h-2 rounded-full " + (apiStatus === "API online" ? "bg-emerald-400" : "bg-amber-400")}/>{apiStatus}</span>
          <span className="hidden 2xl:inline text-slate-500">Repo workers: {workerStatus}</span>
          <select className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 max-w-48" value={workspaceId} onChange={event => changeWorkspace(event.target.value)}>
            {sessions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="p-2 rounded hover:bg-slate-800" title="Create workspace" onClick={() => setShowCreateWorkspace(value => !value)}><Plus size={16}/></button>
          <button className="flex items-center gap-1.5 bg-indigo-600/20 hover:bg-indigo-600/35 text-indigo-300 border border-indigo-500/30 rounded px-2.5 py-1.5" title="Share workspace" onClick={openShareModal}><Share2 size={14}/><span>Share</span></button>
        </div>
      </header>

      {showCreateWorkspace && <div className="px-4 py-2 border-b border-slate-800 flex gap-2 bg-slate-900"><input className="bg-slate-950 border border-slate-700 rounded px-3 py-1 text-sm" placeholder="Workspace name" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)}/><button className="bg-indigo-600 rounded px-3 text-sm" onClick={createWorkspace}>Create</button><button className="text-slate-400" onClick={() => setShowCreateWorkspace(false)}><X size={16}/></button></div>}
      {showShareModal && <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
        <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-[#0d1422] shadow-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold"><Users size={16} className="text-indigo-400"/>Share Workspace</div>
            <button onClick={() => setShowShareModal(false)} className="text-slate-400 hover:text-slate-200"><X size={16}/></button>
          </div>
          <div className="p-4 space-y-4 text-xs">
            <div className="flex items-center gap-2">
              <select value={sharePermission} onChange={event => setSharePermission(event.target.value as "edit" | "view")} className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-xs">
                <option value="edit">Can edit files &amp; terminal</option>
                <option value="view">View only</option>
              </select>
              <button onClick={createShareLink} disabled={shareBusy} className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded px-3 py-2 font-medium text-white">
                {shareBusy ? "Creating link…" : "Create Share Link"}
              </button>
            </div>
            {latestShareUrl && <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-2">
              <input readOnly value={latestShareUrl} className="flex-1 bg-transparent text-emerald-200 outline-none text-[11px]" />
              <button onClick={() => { navigator.clipboard?.writeText(latestShareUrl); setNotice("Share URL copied to clipboard."); }} className="flex items-center gap-1 bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 px-2 py-1 rounded"><Copy size={12}/>Copy</button>
            </div>}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Active Share Links ({shares.length})</div>
              <div className="max-h-44 overflow-auto space-y-1.5">
                {shares.map(item => <div key={item.id} className="flex items-center justify-between px-3 py-2 rounded bg-slate-900 border border-slate-800">
                  <div>
                    <span className="font-medium text-slate-200">{item.permission.toUpperCase()}</span>
                    <span className="ml-2 text-slate-500">Expires {new Date(item.expiresAt).toLocaleDateString()}</span>
                  </div>
                  <button onClick={() => revokeShareLink(item.id)} className="text-rose-400 hover:text-rose-300 flex items-center gap-1" title="Revoke link"><Trash2 size={13}/>Revoke</button>
                </div>)}
                {!shares.length && <div className="text-slate-500 py-2">No active share links for this workspace.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>}
      {notice && <button onClick={() => setNotice("")} className="text-left text-xs px-4 py-2 bg-amber-500/10 text-amber-300 border-b border-amber-900/50">{notice}<span className="float-right">dismiss</span></button>}

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[230px_minmax(0,1fr)_390px]">
        <aside className="hidden xl:flex flex-col border-r border-slate-800 min-h-0 bg-[#0b111d]">
          <div className="h-11 px-3 flex items-center justify-between border-b border-slate-800 text-xs font-semibold uppercase tracking-wider text-slate-400"><span>Explorer</span><button onClick={createFile} title="New file"><FilePlus2 size={15}/></button></div>
          <div className="px-3 py-2 text-[11px] text-slate-500 flex items-center justify-between"><span className="truncate">{currentDir}</span><button onClick={() => { setCurrentDir("."); refreshFiles("."); }}><RefreshCw size={13}/></button></div>
          <div className="overflow-auto p-2 text-sm">
            {currentDir !== "." && <button className="w-full text-left px-2 py-1 text-slate-400 hover:bg-slate-800 rounded flex items-center gap-2" onClick={() => { const next = currentDir.split("/").slice(0, -1).join("/") || "."; setCurrentDir(next); refreshFiles(next); }}><ChevronLeft size={13}/>Back</button>}
            {files.map(entry => <button key={entry.path} onClick={() => openFile(entry)} className={"w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-slate-800 " + (activeFile === entry.path ? "bg-indigo-500/15 text-indigo-200" : "text-slate-300")}>
              {entry.isDirectory ? <Folder size={14} className="text-amber-300"/> : <File size={14} className="text-slate-500"/>}<span className="truncate">{entry.name}</span>
            </button>)}
            {!files.length && <div className="text-xs text-slate-600 p-2">No files in this directory.</div>}
          </div>
          <div className="mt-auto p-3 border-t border-slate-800 text-[10px] text-slate-500">Per-user workspace · atomic saves · quota protected</div>
        </aside>

        <section className="min-w-0 min-h-0 flex flex-col">
          <div className="h-10 shrink-0 border-b border-slate-800 flex items-center justify-between px-3 bg-[#0b111d]">
            <div className="text-xs text-slate-400 flex items-center gap-2 truncate"><File size={14}/>{activeFile || "No file open"}{dirty ? <span className="text-amber-300">● unsaved</span> : null}</div>
            <div className="flex items-center gap-1.5">
              {activeFile && <>
                <button onClick={() => setShowInlineEdit(v => !v)} className={"flex items-center gap-1 rounded px-2 py-1 text-xs " + (showInlineEdit ? "bg-indigo-600 text-white" : "bg-slate-800/80 hover:bg-slate-800 text-indigo-300")} title="Inline AI Edit"><Sparkles size={13}/>AI Edit</button>
                <button onClick={openGitDiff} className={"flex items-center gap-1 rounded px-2 py-1 text-xs " + (diffView && !diffView.isAiEdit ? "bg-indigo-600 text-white" : "hover:bg-slate-800 text-slate-300")} title="Compare with Git HEAD"><GitCompare size={13}/>Diff</button>
                <button onClick={openSymbolOutline} className="p-1.5 hover:bg-slate-800 rounded text-slate-300" title="Symbol Outline"><ListTree size={14}/></button>
              </>}
              <button disabled={!activeFile || !dirty} onClick={saveFile} className="flex items-center gap-1.5 bg-indigo-600 disabled:opacity-30 rounded px-2.5 py-1 text-xs"><Save size={13}/>Save</button>
              <button onClick={() => setTerminalVisible(value => !value)} className="p-1.5 hover:bg-slate-800 rounded" title="Toggle terminal"><SquareTerminal size={15}/></button>
            </div>
          </div>
          {showInlineEdit && activeFile && <form onSubmit={runInlineAiEdit} className="px-3 py-2 border-b border-slate-800 bg-slate-900/90 flex items-center gap-2">
            <Sparkles size={14} className="text-indigo-400 shrink-0"/>
            <input value={inlineEditPrompt} onChange={e => setInlineEditPrompt(e.target.value)} placeholder={`Describe how AI should edit ${activeFile}…`} className="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none focus:border-indigo-500" autoFocus/>
            <button disabled={inlineEditBusy || !inlineEditPrompt.trim()} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded px-3 py-1.5 text-xs text-white">{inlineEditBusy ? "Generating…" : "Preview Edit"}</button>
            <button type="button" onClick={() => setShowInlineEdit(false)} className="text-slate-400 hover:text-slate-200 p-1"><X size={14}/></button>
          </form>}
          {diffView && <div className="px-3 py-1.5 border-b border-slate-800 bg-indigo-950/40 flex items-center justify-between text-xs">
            <span className="text-indigo-200 font-medium truncate">{diffView.title}</span>
            <div className="flex items-center gap-2">
              {diffView.isAiEdit && <button onClick={acceptDiffEdit} className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 rounded"><Check size={13}/>Accept Edit</button>}
              <button onClick={() => setDiffView(null)} className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded"><X size={13}/>Close Diff</button>
            </div>
          </div>}
          <div className="flex-1 min-h-0">
            {activeFile ? (diffView ?
              <DiffEditor height="100%" theme="vs-dark" language={languageFor(activeFile)} original={diffView.original} modified={diffView.modified} options={{ renderSideBySide: true, readOnly: true, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false }} /> :
              <Editor height="100%" theme="vs-dark" language={languageFor(activeFile)} value={fileContent} onMount={editor => { editorRef.current = editor; }} onChange={value => setFileContent(value || "")} options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false, tabSize: 2 }} />) :
              <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-3"><Code2 size={38}/><div className="text-sm">Open a file or create a new one</div><button onClick={createFile} className="text-xs px-3 py-2 bg-indigo-600 text-white rounded">Create file</button></div>}
          </div>
          {terminalVisible && <div className="h-60 shrink-0 border-t border-slate-800 bg-[#080c13] flex flex-col">
            <div className="h-9 flex items-center justify-between px-3 border-b border-slate-800 text-[11px] text-slate-400 uppercase">
              <span className="flex items-center gap-2"><SquareTerminal size={14}/>Interactive terminal</span>
              <span className="text-slate-500">xterm.js · Linux PTY</span>
            </div>
            <div className="flex-1 min-h-0 p-2"><TerminalPanel workspaceId={workspaceId} apiStatus={apiStatus} onPreviewReady={setPreviewUrl} onPreviewStopped={clearPreview} onPermissionRequested={handlePermissionRequested} onPermissionResolved={handlePermissionResolved} onRegisterWsSender={fn => { wsSenderRef.current = fn; }}/></div>
          </div>}
          {previewUrl && <div className="h-9 shrink-0 border-t border-slate-800 flex items-center px-3 text-xs text-emerald-300">Preview ready: <a className="ml-2 underline" href={previewUrl} target="_blank" rel="noreferrer">{previewUrl}</a></div>}
        </section>

        <aside className="min-h-0 border-l border-slate-800 flex flex-col bg-[#0b111d]">
          <div className="h-11 shrink-0 border-b border-slate-800 px-3 flex items-center gap-2">
            <button onClick={() => setActiveTab("chat")} className={"text-xs px-2 py-1 rounded " + (activeTab === "chat" ? "bg-indigo-600 text-white" : "text-slate-400") }><Bot size={14} className="inline mr-1"/>Agent</button>
            <button onClick={() => setActiveTab("tasks")} className={"text-xs px-2 py-1 rounded " + (activeTab === "tasks" ? "bg-indigo-600 text-white" : "text-slate-400")}>Repo tasks ({tasks.length})</button>
            {activeTab === "chat" && <>
              <select value={conversationId || ""} onChange={event => openConversation(event.target.value)} className="ml-auto min-w-0 max-w-28 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[10px]" title="Saved conversations">
                <option value="">New chat</option>
                {conversations.map(item => <option key={item.id} value={item.id}>{item.title || "Untitled chat"}</option>)}
              </select>
              <button onClick={() => openConversation("")} className="p-1.5 rounded hover:bg-slate-800 text-slate-400" title="New chat"><Plus size={14}/></button>
            </>}
            {activeTab === "chat" && <select value={model} onChange={event => setModel(event.target.value)} className="ml-auto bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs max-w-40">{models.map(item => <option key={item.key} value={item.key} disabled={!item.configured}>{item.name} · {item.tier}{item.configured ? "" : " (not configured)"}</option>)}</select>}
          </div>
          {activeTab === "chat" ? <>
            <div className="flex-1 overflow-auto p-3 space-y-4">
              {messages.map((item, index) => <div key={index} className={"text-sm rounded-lg p-3 " + (item.role === "user" ? "bg-indigo-600/15 border border-indigo-500/20 ml-5" : "bg-slate-900 border border-slate-800 mr-2")}>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">{item.role === "user" ? "You" : "ATH Agent"}</div>
                {item.thinking ? <details open={!item.content && busy && index === messages.length - 1} className="mb-2.5 rounded border border-slate-800 bg-slate-950/70 px-2.5 py-1.5 text-[11px] text-slate-400">
                  <summary className="cursor-pointer select-none font-medium text-indigo-300/90 hover:text-indigo-200">Thought Process</summary>
                  <div className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-400">{item.thinking}</div>
                </details> : null}
                <div className="whitespace-pre-wrap break-words leading-relaxed text-[13px]">{item.content || (busy && index === messages.length - 1 ? (item.thinking ? "Generating response…" : "Thinking…") : "")}</div>
                {item.activity?.length ? <div className="mt-3 pt-2 border-t border-slate-800 space-y-1">{item.activity.map((line, i) => <div key={i} className="text-[10px] text-slate-500 flex gap-1.5"><Activity size={11}/>{line}</div>)}</div> : null}
              </div>)}
              {pendingPermissions.map(req => <div key={req.permissionId} className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-2">
                <div className="font-semibold text-amber-300 uppercase text-[10px] tracking-wider">Approval Required · {req.resource}.{req.action}</div>
                <div className="font-mono text-[11px] text-slate-200 bg-slate-950/80 rounded p-2 break-all">{req.payload?.command || req.payload?.path || JSON.stringify(req.payload)}</div>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => respondPermission(req.permissionId, true, false)} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded py-1.5 font-medium">Approve</button>
                  <button type="button" onClick={() => respondPermission(req.permissionId, false, false)} className="flex-1 bg-rose-600/80 hover:bg-rose-600 text-white rounded py-1.5 font-medium">Disapprove</button>
                  <button type="button" onClick={() => respondPermission(req.permissionId, true, true)} className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded py-1.5 font-medium" title="Auto-approve safe/asked commands for this session">Approve All</button>
                </div>
              </div>)}
              <div ref={bottomRef}/>
            </div>
            <form onSubmit={sendPrompt} className="p-3 border-t border-slate-800">
              <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Ask ATH to inspect, build, debug or modify this workspace…" className="w-full h-24 resize-none bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs outline-none focus:border-indigo-500"/>
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600">{configuredModels.length} models</span>
                  <button type="button" onClick={toggleApproveAll} className={"text-[10px] px-2 py-0.5 rounded border " + (approveAllEnabled ? "bg-indigo-600/25 border-indigo-500/40 text-indigo-300" : "border-slate-800 text-slate-500 hover:text-slate-300")} title="Toggle Approve All for this workspace">
                    Approve All: {approveAllEnabled ? "ON" : "OFF"}
                  </button>
                </div>
                <button disabled={busy || !prompt.trim()} className="flex items-center gap-2 px-3 py-2 rounded bg-indigo-600 disabled:opacity-40 text-xs"><Send size={13}/>{busy ? "Working…" : "Send"}</button>
              </div>
            </form>
          </> : <>
            <div className="p-3 border-b border-slate-800">
              <form onSubmit={createRepoTask} className="space-y-2">
                <select value={selectedRepo} onChange={event => setSelectedRepo(event.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs"><option value="">Select a connected repository</option>{repos.map(repo => <option key={repo.full_name} value={repo.full_name}>{repo.full_name}</option>)}</select>
                <textarea value={repoPrompt} onChange={event => setRepoPrompt(event.target.value)} placeholder="Describe the repository change…" className="w-full h-20 bg-slate-950 border border-slate-700 rounded p-2 text-xs"/>
                <button disabled={!selectedRepo || !repoPrompt.trim() || repoBusy} className="w-full bg-indigo-600 disabled:opacity-40 rounded py-2 text-xs">{repoBusy ? "Queueing…" : "Queue coding task"}</button>
              </form>
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {tasks.map(task => <div key={task.id} className="rounded border border-slate-800 bg-slate-900 p-3 text-xs"><div className="font-medium">{task.owner}/{task.repo}</div><div className="mt-1 text-slate-500">{task.status}</div>{task.pr_url && <a href={task.pr_url} target="_blank" rel="noreferrer" className="inline-block mt-2 text-indigo-300 underline">Open draft PR</a>}{task.error && <div className="mt-1 text-rose-300">{task.error}</div>}</div>)}
              {!tasks.length && <div className="text-xs text-slate-500">No repository tasks yet. Connect GitHub to enable this panel.</div>}
            </div>
            <button onClick={loadTasks} className="p-3 border-t border-slate-800 text-xs text-slate-400 flex items-center gap-2"><RefreshCw size={13}/>Refresh task status</button>
          </>}
        </aside>
      </div>
    </main>
  );
}
