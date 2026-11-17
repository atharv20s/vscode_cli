(function (root) {
  "use strict";
  const transitions = {
    idle: ["planning", "editing"],
    planning: ["editing", "verifying", "awaiting_approval", "idle"],
    editing: ["verifying", "awaiting_approval", "idle"],
    verifying: ["awaiting_approval", "idle"],
    awaiting_approval: ["editing", "verifying", "idle"]
  };
  class AgentStateMachine extends EventTarget {
    constructor() { super(); this.state = "idle"; this.runId = null; this.updatedAt = Date.now(); }
    transition(next, detail = {}) {
      if (!Object.prototype.hasOwnProperty.call(transitions, next) || !transitions[this.state].includes(next)) {
        throw new Error("Invalid agent state transition: " + this.state + " -> " + next);
      }
      const previous = this.state; this.state = next; this.updatedAt = Date.now();
      if (detail.runId) this.runId = detail.runId;
      if (next === "idle") this.runId = null;
      this.dispatchEvent(new CustomEvent("change", { detail: { previous, state: next, runId: this.runId, ...detail } }));
      return this.state;
    }
  }
  root.AgentStateMachine = AgentStateMachine;
})(window);
