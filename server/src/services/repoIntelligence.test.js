import test from "node:test";
import assert from "node:assert/strict";
import { RepoIntelligenceEngine } from "./repoIntelligence.js";

test("RepoIntelligenceEngine extracts symbols and imports across multiple languages", () => {
  const engine = new RepoIntelligenceEngine();

  // Test JS/TS
  const tsCode = `
import { foo } from "./utils/helper.js";
export interface UserConfig { id: string; }
export class AuthenticationManager {
  async login() {}
}
export function verifySessionToken(token) {}
`;
  const tsResult = engine.extractSymbolsAndImports(tsCode, ".ts");
  assert.equal(tsResult.imports.includes("./utils/helper.js"), true);
  assert.equal(tsResult.symbols.some(s => s.name === "AuthenticationManager" && s.kind === "class"), true);
  assert.equal(tsResult.symbols.some(s => s.name === "verifySessionToken" && s.kind === "function"), true);
  assert.equal(tsResult.symbols.some(s => s.name === "UserConfig" && s.kind === "interface"), true);

  // Test Python
  const pyCode = `
import os, sys
from database import get_connection

class DataProcessor:
    def process(self):
        pass

def calculate_checksum(data):
    return 42
`;
  const pyResult = engine.extractSymbolsAndImports(pyCode, ".py");
  assert.equal(pyResult.imports.includes("database"), true);
  assert.equal(pyResult.symbols.some(s => s.name === "DataProcessor" && s.kind === "class"), true);
  assert.equal(pyResult.symbols.some(s => s.name === "calculate_checksum" && s.kind === "function"), true);

  // Test Go
  const goCode = `
package main
import "fmt"

type WorkerPool struct {}

func DispatchTask() {}
`;
  const goResult = engine.extractSymbolsAndImports(goCode, ".go");
  assert.equal(goResult.imports.includes("fmt"), true);
  assert.equal(goResult.symbols.some(s => s.name === "WorkerPool" && s.kind === "type"), true);
  assert.equal(goResult.symbols.some(s => s.name === "DispatchTask" && s.kind === "function"), true);
});

test("RepoIntelligenceEngine ranks relevant files using task keywords and dependency graph", () => {
  const engine = new RepoIntelligenceEngine();

  engine.updateFileInIndex("src/auth/jwt.js", {
    hash: "h1",
    mtime: 100,
    symbols: [{ name: "verifyToken", kind: "function", line: 10 }],
    imports: ["../db/users.js"],
    exports: ["verifyToken"],
    size: 200,
  });

  engine.updateFileInIndex("src/db/users.js", {
    hash: "h2",
    mtime: 100,
    symbols: [{ name: "findUserById", kind: "function", line: 5 }],
    imports: [],
    exports: ["findUserById"],
    size: 150,
  });

  engine.updateFileInIndex("src/ui/button.js", {
    hash: "h3",
    mtime: 100,
    symbols: [{ name: "renderButton", kind: "function", line: 1 }],
    imports: [],
    exports: ["renderButton"],
    size: 80,
  });

  engine.rebuildDependencyGraph();

  const results = engine.queryRelevantContext({
    task: "fix token authentication validation bug in verifyToken",
    openFiles: ["src/auth/jwt.js"],
  });

  assert.equal(results.length > 0, true);
  assert.equal(results[0].path, "src/auth/jwt.js");
  // verify dependent file src/db/users.js is ranked higher than unrelated src/ui/button.js
  const userDbResult = results.find(r => r.path === "src/db/users.js");
  const buttonResult = results.find(r => r.path === "src/ui/button.js");
  assert.equal(Boolean(userDbResult), true);
  if (buttonResult) {
    assert.equal(userDbResult.score > buttonResult.score, true);
  }
});
