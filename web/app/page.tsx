"use client";

import React, { useEffect, useState } from "react";
import {
  Terminal,
  Cpu,
  Layers,
  Radio,
  Sparkles,
  GitBranch,
  FolderGit2,
  Play,
  Send,
  CheckCircle2,
  Database,
  Server,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";

export default function Home() {
  const [clusterNodes, setClusterNodes] = useState<any[]>([]);
  const [kafkaStatus, setKafkaStatus] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [inputPrompt, setInputPrompt] = useState("");
  const [timeline, setTimeline] = useState<any[]>([
    {
      role: "assistant",
      content:
        "Welcome to **ATH IDE Next.js Studio**! Connected to distributed cluster with Kafka queues, database sharding, and multi-tier LLM failover.",
    },
  ]);

  useEffect(() => {
    // 1. Auto-provision guest or resume session
    const initAuth = async () => {
      try {
        const guestRes = await fetch("/api/auth/guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (guestRes.ok) {
          const data = await guestRes.json();
          api.setTokens(data.accessToken || data.token, data.refreshToken || "");
          setUser(data.user);
        }
      } catch (err) {
        console.warn("Guest auth error", err);
      }
    };

    // 2. Poll cluster nodes and Kafka state
    const fetchCluster = async () => {
      try {
        const [nodeRes, kafkaRes] = await Promise.all([
          fetch("/api/cluster/nodes"),
          fetch("/api/kafka/status"),
        ]);
        if (nodeRes.ok) {
          const data = await nodeRes.json();
          setClusterNodes(data.nodes || []);
        }
        if (kafkaRes.ok) {
          const data = await kafkaRes.json();
          setKafkaStatus(data);
        }
      } catch (err) {
        console.warn("Cluster poll error", err);
      }
    };

    initAuth();
    fetchCluster();
    const timer = setInterval(fetchCluster, 8000);
    return () => clearInterval(timer);
  }, []);

  const handleSendPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputPrompt.trim()) return;

    setTimeline((prev) => [
      ...prev,
      { role: "user", content: inputPrompt },
      {
        role: "assistant",
        content: `Executing agent loop via distributed queue for: "${inputPrompt}"...`,
      },
    ]);
    setInputPrompt("");
  };

  return (
    <div className="flex flex-col h-screen bg-[#0b0f19] text-slate-100 font-sans">
      {/* Topbar */}
      <header className="h-12 border-b border-slate-800 px-4 flex items-center justify-between bg-[#0f172a]/60 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-600 shadow-lg shadow-indigo-500/30">
            <Terminal className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold tracking-wide text-sm">
            ATH <span className="text-indigo-400">IDE</span>
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
            Next.js App Router
          </span>
        </div>

        {/* Distributed Cluster Status */}
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
            <Server className="w-3.5 h-3.5 animate-pulse" />
            <span>Nodes Online: {clusterNodes.length || 1}</span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400">
            <Layers className="w-3.5 h-3.5" />
            <span>Kafka: {kafkaStatus?.connected ? "Cluster Connected" : "Local Event Queue"}</span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-400">
            <Database className="w-3.5 h-3.5" />
            <span>DB: Sharded Neon Cloud</span>
          </div>
        </div>

        {/* User Identity */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-indigo-600/30 border border-indigo-500 flex items-center justify-center text-xs font-bold text-indigo-300">
            {user?.username ? user.username.slice(0, 2).toUpperCase() : "G"}
          </div>
          <span className="text-xs text-slate-300 font-medium">
            @{user?.username || "Guest User"}
          </span>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Side: File Explorer / Cluster Health */}
        <div className="w-64 border-r border-slate-800 bg-[#0e1526]/50 p-3 flex flex-col gap-4">
          <div>
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
              Distributed Topology
            </div>
            <div className="space-y-1.5">
              {clusterNodes.map((node, i) => (
                <div
                  key={node.instanceId || i}
                  className="p-2 rounded bg-slate-800/40 border border-slate-700/50 text-xs flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                    <span className="font-mono text-[11px] text-slate-300 truncate max-w-[120px]">
                      {node.instanceId}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400">{node.port || 3001}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-slate-800 pt-3">
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
              Architecture Tiers
            </div>
            <ul className="text-xs text-slate-400 space-y-1.5">
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Dual Token Auth (15m/30d)</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Apache Kafka Queue Engine</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Database Sharding Router</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Multi-Pod K8s Sticky WS</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Terraform GCP IaC</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Center: Monaco Editor & Terminal */}
        <div className="flex-1 flex flex-col border-r border-slate-800">
          <div className="h-9 border-b border-slate-800 bg-[#0d1322] px-3 flex items-center gap-2 text-xs text-slate-300">
            <FolderGit2 className="w-3.5 h-3.5 text-indigo-400" />
            <span>workspace / app.js</span>
          </div>

          <div className="flex-1 bg-[#090d16] p-4 font-mono text-xs text-slate-300 overflow-auto">
            <pre className="leading-relaxed">
              <code>{`// ATH IDE — High-Performance Distributed Node
import { clusterManager } from "./services/clusterManager.js";
import { kafkaService } from "./services/kafkaService.js";
import { shardManager } from "./db/shardManager.js";

// Active Node Instance: ${clusterNodes[0]?.instanceId || "node_init"}
console.log("Cluster Online: " + ${clusterNodes.length || 1} + " node(s)");
`}</code>
            </pre>
          </div>

          {/* Bottom Interactive Terminal Bar */}
          <div className="h-28 border-t border-slate-800 bg-[#0a0e1a] p-2 flex flex-col font-mono text-xs">
            <div className="text-[11px] text-slate-500 pb-1 flex items-center justify-between">
              <span>TERMINAL — POWERSHELL / BASH SANDBOX</span>
              <span className="text-emerald-400">READY</span>
            </div>
            <div className="flex-1 text-slate-400 text-xs overflow-y-auto">
              <div>[node] Initialized cluster coordinator and sharding ring.</div>
              <div>[kafka] Subscribed to topic 'ath-ide.tasks' on consumer group.</div>
              <div className="text-emerald-400">[status] All systems operational.</div>
            </div>
          </div>
        </div>

        {/* Right Side: Cursor AI Assistant Timeline */}
        <div className="w-80 bg-[#0d1322] flex flex-col">
          <div className="h-9 border-b border-slate-800 px-3 flex items-center justify-between text-xs font-semibold text-slate-300">
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              Agent Assistant
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
              Devstral + OpenRouter
            </span>
          </div>

          <div className="flex-1 p-3 overflow-y-auto space-y-3 text-xs">
            {timeline.map((msg, i) => (
              <div
                key={i}
                className={`p-2.5 rounded-lg leading-relaxed ${
                  msg.role === "user"
                    ? "bg-indigo-600 text-white ml-4"
                    : "bg-slate-800/60 border border-slate-700/60 text-slate-200 mr-4"
                }`}
              >
                {msg.content}
              </div>
            ))}
          </div>

          {/* Input Bar */}
          <form onSubmit={handleSendPrompt} className="p-2 border-t border-slate-800 flex gap-2">
            <input
              type="text"
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              placeholder="Ask agent or execute command..."
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-xs text-white font-medium flex items-center justify-center transition"
            >
              <Send className="w-3 h-3" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
