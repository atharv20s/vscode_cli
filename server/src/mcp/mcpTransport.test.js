import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpProcessEnv, jsonrpcRequest, jsonrpcNotification } from "./mcpTransport.js";

test("MCP child environment inherits only non-secret runtime variables", () => {
  const env = buildMcpProcessEnv({}, { PATH: "/usr/bin", HOME: "/home/ath", OPENAI_API_KEY: "secret", DATABASE_URL: "secret", NODE_ENV: "test" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/ath");
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("explicitly configured MCP environment values are passed through", () => {
  const env = buildMcpProcessEnv({ API_TOKEN: "explicit", REGION: "ap-south-1" }, { PATH: "/bin" });
  assert.equal(env.API_TOKEN, "explicit");
  assert.equal(env.REGION, "ap-south-1");
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("rejects malformed MCP environment values", () => {
  assert.throws(() => buildMcpProcessEnv({ BAD: 42 }), /Invalid MCP environment entry/);
  assert.throws(() => buildMcpProcessEnv({ "BAD=KEY": "x" }), /Invalid MCP environment entry/);
});

test("JSON-RPC messages are framed with standard fields", () => {
  assert.deepEqual(JSON.parse(jsonrpcRequest("tools/list", {}, 3)), { jsonrpc: "2.0", method: "tools/list", params: {}, id: 3 });
  assert.deepEqual(JSON.parse(jsonrpcNotification("notifications/initialized")), { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
});
