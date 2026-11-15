import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LinuxPtyBackend } from "./linuxPtyBackend.js";

test("interactive Linux PTY uses the isolated workspace and namespace launcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ath-linux-pty-"));
  let spawnArgs;
  let fakePty;
  const fakePtyImpl = {
    spawn(binary, args, options) {
      spawnArgs = { binary, args, options };
      fakePty = {
        pid: 4321,
        onData(callback) { this.dataHandler = callback; },
        onExit(callback) { this.exitHandler = callback; },
        write(value) { this.lastWrite = value; },
        resize(cols, rows) { this.lastSize = [cols, rows]; },
        kill() { this.killed = true; },
      };
      return fakePty;
    },
  };
  try {
    const backend = new LinuxPtyBackend({
      platform: "linux",
      ptyImpl: fakePtyImpl,
      fsAccess: async () => {},
      spawnProcess: () => new EventEmitter(),
    });
    let output = "";
    const process = await backend.spawnShell({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      workspaceDir: root,
      cwd: root,
      cols: 90,
      rows: 30,
      onData: value => { output += value; },
    });
    assert.equal(process.pid, 4321);
    assert.equal(spawnArgs.binary, "systemd-run");
    assert.ok(spawnArgs.args.includes("--unshare-user"));
    assert.ok(spawnArgs.args.includes("--unshare-pid"));
    assert.ok(spawnArgs.args.includes("--unshare-net"));
    assert.ok(spawnArgs.args.includes("-i"));
    assert.ok(!spawnArgs.args.includes("-lc"));
    assert.deepEqual(spawnArgs.options.env, {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor",
    });
    fakePty.dataHandler("terminal ready");
    assert.equal(output, "terminal ready");
    backend.write("session-a", "pwd\r");
    assert.equal(fakePty.lastWrite, "pwd\r");
    backend.resize("session-a", 100, 40);
    assert.deepEqual(fakePty.lastSize, [100, 40]);
    backend.kill("session-a");
    assert.equal(fakePty.killed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
