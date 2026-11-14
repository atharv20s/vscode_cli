import test from "node:test";
import assert from "node:assert/strict";
import { workspaceNetworkName } from "./dockerWorkspaceRuntime.js";

test("workspace network names are stable and isolated by workspace identity", () => {
  const first = workspaceNetworkName("workspace-user-a");
  const second = workspaceNetworkName("workspace-user-b");
  assert.equal(first, workspaceNetworkName("workspace-user-a"));
  if (first !== "none") {
    assert.notEqual(first, second);
    assert.match(first, /^athide-net-[a-f0-9]{16}$/);
    assert.match(second, /^athide-net-[a-f0-9]{16}$/);
  }
});

test("shared named network overrides cannot join separate workspaces", () => {
  const first = workspaceNetworkName("workspace-user-a", "ath-ide-internal");
  const second = workspaceNetworkName("workspace-user-b", "ath-ide-internal");
  if (first !== "none") {
    assert.notEqual(first, second);
    assert.match(first, /^athide-net-[a-f0-9]{16}$/);
  }
});

test("repo-agent network override none remains networkless", () => {
  assert.equal(workspaceNetworkName("repo-agent-task", "none"), "none");
});


import path from "node:path";
import { workspaceSeccompProfilePath, workspaceSecurityOptions } from "./dockerWorkspaceRuntime.js";

test("workspace seccomp profile path is absolute and configurable", () => {
  assert.equal(workspaceSeccompProfilePath({ DOCKER_SECCOMP_PROFILE: "/opt/ath/seccomp.json" }), "/opt/ath/seccomp.json");
  assert.equal(path.isAbsolute(workspaceSeccompProfilePath({})), true);
});

test("workspace security options require an absolute explicit seccomp profile", () => {
  assert.deepEqual(workspaceSecurityOptions("/etc/ath-ide/seccomp-workspace.json"), [
    "no-new-privileges", "seccomp=/etc/ath-ide/seccomp-workspace.json",
  ]);
  assert.throws(() => workspaceSecurityOptions("relative/profile.json"), /absolute/);
});
