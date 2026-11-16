import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseLspFrames, sendLanguageServerMessage } from "./lspService.js";

test("LSP parser buffers partial frames and emits complete JSON-RPC messages", () => {
  const state = { buffer: Buffer.alloc(0) };
  const messages = [];
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { capabilities: {} } }));
  const frame = Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]);
  parseLspFrames(state, frame.subarray(0, 11), message => messages.push(message));
  assert.equal(messages.length, 0);
  parseLspFrames(state, frame.subarray(11), message => messages.push(message));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 7, result: { capabilities: {} } }]);
});

test("LSP parser handles multiple frames in one stdout chunk", () => {
  const state = { buffer: Buffer.alloc(0) };
  const messages = [];
  const encode = message => {
    const body = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]);
  };
  parseLspFrames(state, Buffer.concat([encode({ jsonrpc: "2.0", id: 1 }), encode({ jsonrpc: "2.0", id: 2 })]), message => messages.push(message));
  assert.deepEqual(messages.map(message => message.id), [1, 2]);
});

test("LSP parser rejects oversized frames and malformed headers", () => {
  const state = { buffer: Buffer.alloc(0) };
  assert.throws(() => parseLspFrames(state, Buffer.from("Content-Length: 2097153\r\n\r\n"), () => {}), /allowed size/);
  assert.throws(() => parseLspFrames({ buffer: Buffer.alloc(0) }, Buffer.from("X-Length: 1\r\n\r\nx"), () => {}), /Content-Length/);
});

test("LSP client file URIs cannot escape the active workspace", () => {
  const writes = [];
  const workspaceRoot = path.resolve("/tmp/ath-lsp-workspace");
  const ws = {
    languageServer: {
      closed: false,
      workspaceRoot,
      workspaceService: {
        resolvePath(relative) {
          return { safe: relative === "." || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) };
        }
      },
      child: { stdin: { writable: true, write(frame) { writes.push(frame); } } }
    }
  };
  sendLanguageServerMessage(ws, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: "file:///tmp/ath-lsp-workspace/src/index.ts" } }
  });
  assert.equal(writes.length, 1);
  assert.throws(() => sendLanguageServerMessage(ws, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: "file:///etc/passwd" } }
  }), /restricted to the active workspace/);
});
