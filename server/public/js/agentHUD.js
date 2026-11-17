/**
 * ATH IDE 2.0 — Agent HUD & Observability Controller
 *
 * Provides a live status pill in the IDE interface showing:
 * - Active state (idle / thinking / streaming / reviewing / rollback)
 * - Session token count and estimated cost
 * - Direct hotkey helpers (Ctrl+K, Ctrl+I, Ctrl+Y, Ctrl+N)
 */

class AgentHUD {
  constructor(options = {}) {
    this.containerId = options.containerId || "agent-hud-container";
    this.tokenCount = 0;
    this.estimatedCost = 0;
    this.currentState = "idle";
    this._el = null;
  }

  mount(parent = document.body) {
    if (this._el) return;

    this._el = document.createElement("div");
    this._el.id = this.containerId;
    this._el.className = "agent-hud-bar";
    this._el.innerHTML = `
      <div class="hud-status-indicator">
        <span class="hud-dot hud-dot-idle" id="hud-status-dot"></span>
        <span class="hud-status-text" id="hud-status-text">Agent Idle</span>
      </div>
      <div class="hud-separator"></div>
      <div class="hud-metrics">
        <span id="hud-token-usage">0 tokens</span>
        <span class="hud-cost" id="hud-cost-usage">($0.000)</span>
      </div>
      <div class="hud-separator"></div>
      <div class="hud-shortcuts">
        <span class="hud-pill" title="Inline Edit at cursor">Ctrl+K Edit</span>
        <span class="hud-pill" title="Focus Composer Agent">Ctrl+I Agent</span>
        <span class="hud-pill" title="Accept proposed hunk">Ctrl+Y Accept</span>
        <span class="hud-pill" title="Reject proposed hunk">Ctrl+N Reject</span>
      </div>
    `;

    parent.appendChild(this._el);

    // Subscribe to agentState store if available
    if (typeof window !== "undefined" && window.agentState) {
      window.agentState.subscribe(state => this.updateState(state));
    }
  }

  updateState(state) {
    this.currentState = state;
    const dot = document.getElementById("hud-status-dot");
    const text = document.getElementById("hud-status-text");
    if (!dot || !text) return;

    dot.className = `hud-dot hud-dot-${state}`;
    switch (state) {
      case "thinking":
        text.textContent = "Agent Planning...";
        break;
      case "streaming":
        text.textContent = "Generating Code...";
        break;
      case "reviewing":
        text.textContent = "Reviewing Hunks (Ctrl+Y / Ctrl+N)";
        break;
      case "rollback":
        text.textContent = "Restoring Snapshot...";
        break;
      default:
        text.textContent = "Agent Ready";
    }
  }

  updateTokens(tokens, costUsd = 0) {
    this.tokenCount = tokens;
    this.estimatedCost = costUsd;
    const tokenEl = document.getElementById("hud-token-usage");
    const costEl = document.getElementById("hud-cost-usage");
    if (tokenEl) tokenEl.textContent = `${tokens.toLocaleString()} tokens`;
    if (costEl) costEl.textContent = `($${costUsd.toFixed(4)})`;
  }
}

// Auto-initialize when loaded in browser
if (typeof window !== "undefined") {
  window.AgentHUD = AgentHUD;
  window.agentHUD = new AgentHUD();
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () => {
      window.agentHUD.mount();
    });
  } else {
    window.agentHUD.mount();
  }
}
