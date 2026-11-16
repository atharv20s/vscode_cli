import test from "node:test";
import assert from "node:assert/strict";
import { filterMcpTools } from "./mcpClient.js";

const valid = { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } };

test("MCP discovery filters tools through an explicit allowlist", () => {
  assert.deepEqual(filterMcpTools([valid, { ...valid, name: "write_file" }], ["read_file"]).map(tool => tool.name), ["read_file"]);
});

test("MCP discovery rejects malformed names and schemas", () => {
  const result = filterMcpTools([
    valid,
    { ...valid, name: "bad name" },
    { ...valid, inputSchema: [] },
    { ...valid, inputSchema: { type: "string" } },
    { ...valid, inputSchema: { type: "object", description: "x".repeat(17_000) } }
  ]);
  assert.deepEqual(result.map(tool => tool.name), ["read_file"]);
});

test("MCP discovery caps registered tool count", () => {
  const tools = Array.from({ length: 120 }, (_, index) => ({ ...valid, name: `tool_${index}` }));
  assert.equal(filterMcpTools(tools).length, 100);
});
