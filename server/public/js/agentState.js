(function (root) {
  "use strict";
  const transitions = {
    idle: ["planning", "editing"],
    planning: ["editing", "verifying", "awaiting_approval", "idle"],
    editing: ["verifying", "awaiting_approval", "idle"],
    verifying: ["awaiting_approval", "idle"],
    awaiting_approval: ["editing", "verifying", "idle"]
  };
  class AgentStateMachine {
    constructor() { this.state = "idle"; this.runId = null; this.updatedAt = Date.now(); this.listeners = new Set(); }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    transition(next, detail = {}) {
      if (!Object.prototype.hasOwnProperty.call(transitions, next) || !transitions[this.state].includes(next)) {
        throw new Error("Invalid agent state transition: " + this.state + " -> " + next);
      }
      const previous = this.state; this.state = next; this.updatedAt = Date.now();
      if (detail.runId) this.runId = detail.runId;
      if (next === "idle") this.runId = null;
      const event = { previous, state: next, runId: this.runId, ...detail };
      this.listeners.forEach(listener => { try { listener(event); } catch {} });
      return this.state;
    }
  }
  root.AgentStateMachine = AgentStateMachine;
})(window);
