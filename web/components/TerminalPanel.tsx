"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

type TerminalStatus = "Waiting for API" | "Connecting" | "Connected" | "Reconnecting" | "Unavailable";

export default function TerminalPanel({ workspaceId, apiStatus, onPreviewReady, onPreviewStopped }: {
  workspaceId: string;
  apiStatus: string;
  onPreviewReady?: (url: string) => void;
  onPreviewStopped?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>("Waiting for API");
  const previewReadyRef = useRef(onPreviewReady);
  const previewStoppedRef = useRef(onPreviewStopped);

  useEffect(() => { previewReadyRef.current = onPreviewReady; }, [onPreviewReady]);
  useEffect(() => { previewStoppedRef.current = onPreviewStopped; }, [onPreviewStopped]);

  useEffect(() => {
    if (!containerRef.current || apiStatus !== "API online") {
      setStatus("Waiting for API");
      return;
    }

    let disposed = false;
    let terminal: import("@xterm/xterm").Terminal | null = null;
    let fitAddon: import("@xterm/addon-fit").FitAddon | null = null;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 800;
    let openListener: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeListener: (() => void) | null = null;

    const storageKey = "ath_terminal_session:" + workspaceId;
    let terminalSessionId = sessionStorage.getItem(storageKey);
    if (!terminalSessionId) {
      terminalSessionId = crypto.randomUUID();
      sessionStorage.setItem(storageKey, terminalSessionId);
    }

    const getWebSocketUrl = () => {
      const configured = process.env.NEXT_PUBLIC_WS_URL;
      if (configured) return configured;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return protocol + "//" + window.location.hostname + ":3001/ws";
    };

    const send = (type: string, payload: Record<string, unknown> = {}) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type, payload }));
      }
    };

    const connect = () => {
      if (disposed) return;
      const token = api.getAccessToken();
      if (!token) {
        setStatus("Unavailable");
        return;
      }
      setStatus(retryDelay === 800 ? "Connecting" : "Reconnecting");
      const url = new URL(getWebSocketUrl());
      url.searchParams.set("workspace", workspaceId);
      url.searchParams.set("terminalSessionId", terminalSessionId as string);

      try {
        socket = new WebSocket(url.toString(), ["ath-auth", token]);
      } catch {
        scheduleReconnect();
        return;
      }

      socket.onopen = () => {
        retryDelay = 800;
        setStatus("Connected");
      };

      socket.onmessage = event => {
        let packet: any;
        try { packet = JSON.parse(event.data); } catch { return; }
        const payload = packet.payload || {};
        if (packet.type === "connected") {
          terminal?.reset();
          fitAddon?.fit();
          send("terminal_init", {
            shell: "bash",
            cols: terminal?.cols || 100,
            rows: terminal?.rows || 28,
          });
        } else if (packet.type === "permission.requested") {
          const permissionId = payload.permissionId;
          const details = payload.payload || {};
          if (typeof permissionId === "string" && permissionId) {
            const expired = Number(payload.expiresAt) > 0 && Number(payload.expiresAt) <= Date.now();
            const command = typeof details.command === "string" ? details.command.slice(0, 3000) : "";
            const summary = [
              "ATH IDE approval required",
              "",
              "Action: " + String(payload.resource || "operation") + "." + String(payload.action || "execute"),
              command ? "Command:\n" + command : "",
              details.path ? "File path: " + String(details.path) : "",
              details.working_dir ? "Working directory: " + String(details.working_dir) : "",
              "",
              "Build, install and test commands may execute workspace/dependency scripts.",
              "Approve only when you recognize and trust this exact operation.",
            ].filter(Boolean).join("\n");
            const granted = !expired && window.confirm(summary);
            send("permission.resolve", {
              permissionId,
              granted,
              reason: expired ? "Approval request expired." : granted ? "Approved by workspace owner." : "Rejected by workspace owner.",
            });
            terminal?.writeln(granted
              ? "\r\n\x1b[33m[ATH IDE] Approved: " + String(payload.action || "operation") + "\x1b[0m"
              : "\r\n\x1b[90m[ATH IDE] Rejected or expired: " + String(payload.action || "operation") + "\x1b[0m");
          }
        } else if (packet.type === "terminal.output") {
          const output = payload.text ?? payload.data ?? "";
          if (typeof output === "string" && output) terminal?.write(output);
        } else if (packet.type === "preview.ready") {
          if (typeof payload.url === "string") previewReadyRef.current?.(payload.url);
        } else if (packet.type === "preview.stopped") {
          previewStoppedRef.current?.();
        } else if (packet.type === "terminal.exit" || packet.type === "terminal_exit") {
          terminal?.write("\r\n[terminal process exited]\r\n");
          setStatus("Unavailable");
        } else if (packet.type === "error") {
          terminal?.write("\r\n\x1b[31m[ATH IDE] " + (payload.message || "Terminal error") + "\x1b[0m\r\n");
        }
      };

      socket.onclose = () => {
        if (!disposed) scheduleReconnect();
      };
      socket.onerror = () => {
        if (!disposed) setStatus("Reconnecting");
      };
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      setStatus("Reconnecting");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = Math.min(retryDelay * 1.8, 12000);
        connect();
      }, retryDelay);
    };

    const initialize = async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed || !containerRef.current) return;
        terminal = new Terminal({
          cursorBlink: true,
          convertEol: false,
          scrollback: 5000,
          fontFamily: 'Consolas, "Cascadia Code", "Fira Code", monospace',
          fontSize: 12,
          theme: {
            background: "#080c13",
            foreground: "#dbe4f0",
            cursor: "#a5b4fc",
            selectionBackground: "#334155",
            black: "#0b1220",
            brightBlack: "#475569",
          },
        });
        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        fitAddon.fit();
        terminal.writeln("\x1b[90mATH IDE remote terminal · " + workspaceId + "\x1b[0m");
        openListener = terminal.onData(data => send("terminal_input", { data }));
        terminal.onResize(({ cols, rows }) => send("terminal_resize", { cols, rows }));

        resizeListener = () => fitAddon?.fit();
        window.addEventListener("resize", resizeListener);
        resizeObserver = new ResizeObserver(() => fitAddon?.fit());
        resizeObserver.observe(containerRef.current);
        connect();
      } catch (error) {
        setStatus("Unavailable");
        terminal?.writeln("\x1b[31mFailed to initialize terminal: " + (error as Error).message + "\x1b[0m");
      }
    };

    void initialize();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      resizeObserver?.disconnect();
      if (resizeListener) window.removeEventListener("resize", resizeListener);
      openListener?.dispose();
      socket?.close();
      terminal?.dispose();
    };
  }, [workspaceId, apiStatus]);

  return (
    <div className="h-full w-full min-h-0 relative">
      <div className="absolute right-2 top-1 z-10 rounded bg-slate-900/90 border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">{status}</div>
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
