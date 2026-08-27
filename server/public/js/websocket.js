/**
 * WebSocket Client Wrapper for Agentic AI Studio
 *
 * Handles:
 * - Auto-reconnect with exponential backoff
 * - Event-driven message dispatching
 * - Message queueing when disconnected
 * - Heartbeat ping-pong monitoring
 */

class WebSocketClient {
  constructor(url) {
    const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
    const protocol = isHttps ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:3001";
    this.url = url || `${protocol}//${host}/ws`;
    this.ws = null;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 1000;
    this.messageQueue = [];
    this.isConnected = false;
    this.lastToken = null;
    this.pingInterval = null;

    // Auto-reconnect when user refocuses tab
    window.addEventListener("focus", () => {
      if (!this.isConnected) {
        this.connect(this.lastToken);
      }
    });

    window.addEventListener("online", () => {
      this.connect(this.lastToken);
    });
  }

  /**
   * Connect to WebSocket server.
   */
  connect(token) {
    if (token) this.lastToken = token;
    const wsUrl = this.lastToken ? `${this.url}?token=${encodeURIComponent(this.lastToken)}` : this.url;

    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.emit("open");
        this.updateStatus(true);

        // Start heartbeat ping
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping", payload: { time: Date.now() } }));
          }
        }, 15000);

        // Flush queued messages
        while (this.messageQueue.length > 0) {
          const item = this.messageQueue.shift();
          this.send(item.type, item.payload);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "pong") return; // Heartbeat ack
          this.emit(msg.type, msg.payload);
        } catch (err) {
          console.error("Failed to parse WS message:", event.data);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.updateStatus(false);
        this.emit("close");
        this.attemptReconnect();
      };

      this.ws.onerror = (err) => {
        this.emit("error", err);
      };
    } catch (err) {
      console.error("WS connection error:", err);
      this.attemptReconnect();
    }
  }

  /**
   * Attempt to reconnect with exponential backoff.
   */
  attemptReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.3, Math.min(this.reconnectAttempts, 8)), 5000);

    setTimeout(() => {
      this.connect(this.lastToken);
    }, delay);
  }

  /**
   * Register an event listener.
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Remove an event listener.
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  /**
   * Emit an event locally.
   */
  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        try {
          cb(data);
        } catch (e) {
          console.error(`Error in WS listener for '${event}':`, e);
        }
      }
    }
  }

  /**
   * Send a message to the server.
   */
  send(type, payload = {}) {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      this.messageQueue.push({ type, payload });
      this.connect(this.lastToken);
    }
  }

  /**
   * Update UI status indicator.
   */
  updateStatus(online) {
    const el = document.getElementById("connection-status");
    if (!el) return;
    if (online) {
      el.className = "status-indicator online";
      el.querySelector(".status-text").textContent = "Live";
    } else {
      el.className = "status-indicator offline";
      el.querySelector(".status-text").textContent = "Disconnected";
    }
  }
}

// Global instance
window.wsClient = new WebSocketClient();
