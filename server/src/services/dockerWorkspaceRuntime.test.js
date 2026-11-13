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

test("Docker's shared bridge is never used as the implicit workspace network", () => {
  const network = workspaceNetworkName("workspace-user-a", "bridge");
  if (network !== "none") assert.match(network, /^athide-net-[a-f0-9]{16}$/);
});
