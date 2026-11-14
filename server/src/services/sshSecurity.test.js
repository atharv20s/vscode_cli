import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStrictSSHOptions,
  resolveRemoteWorkspacePath,
  shellQuote,
  validateDockerContainer,
  validateSSHHost,
  validateSSHUsername,
} from "./sshSecurity.js";

test("SSH always verifies host keys and uses the user's known_hosts", () => {
  const args = buildStrictSSHOptions({ port: 2222, connectTimeout: 5 });
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("UpdateHostKeys=yes"));
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(!args.includes("UserKnownHostsFile=/dev/null"));
  assert.ok(!args.includes("StrictHostKeyChecking=no"));
});

test("SSH target and port validation rejects option injection", () => {
  assert.throws(() => validateSSHHost("-oProxyCommand=evil"), TypeError);
  assert.throws(() => validateSSHUsername("ubuntu;id"), TypeError);
  assert.throws(() => buildStrictSSHOptions({ port: 70000 }), TypeError);
});

test("remote paths remain under the configured workspace", () => {
  assert.equal(resolveRemoteWorkspacePath("/srv/workspaces/a", "src/index.js"), "/srv/workspaces/a/src/index.js");
  assert.equal(resolveRemoteWorkspacePath("/srv/workspaces/a", "/srv/workspaces/a/src"), "/srv/workspaces/a/src");
  assert.throws(() => resolveRemoteWorkspacePath("/srv/workspaces/a", "../../etc"), /escapes/);
  assert.throws(() => resolveRemoteWorkspacePath("/srv/workspaces/a", "/etc"), /escapes/);
});

test("remote shell arguments are quoted and container names are validated", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(validateDockerContainer("ath-ide-worker_1"), "ath-ide-worker_1");
  assert.throws(() => validateDockerContainer("worker;id"), TypeError);
});
