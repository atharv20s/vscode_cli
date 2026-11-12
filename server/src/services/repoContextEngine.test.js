import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRepositoryContext, formatRepositoryContext } from "./repoContextEngine.js";

test("repository context retrieves relevant files and project instructions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"ath-context-"));
  try {
    await fs.mkdir(path.join(root,"src"),{recursive:true});
    await fs.mkdir(path.join(root,"tests"),{recursive:true});
    await fs.writeFile(path.join(root,"AGENTS.md"),"Use the existing validation helpers. Add regression tests.");
    await fs.writeFile(path.join(root,"package.json"),JSON.stringify({
      name:"fixture",
      scripts:{test:"node --test",build:"node build.js"},
      dependencies:{}
    }));
    await fs.writeFile(path.join(root,"src","paymentService.js"),"export function validatePayment(input) { return Boolean(input); }");
    await fs.writeFile(path.join(root,"tests","paymentService.test.js"),"test('payment validation',()=>{});");
    await fs.writeFile(path.join(root,".env"),"PAYMENT_SECRET=must-not-enter-context");

    const context = await buildRepositoryContext(root,"Fix paymentService validation and add regression test");
    assert.ok(context.instructions.some(item=>item.path==="AGENTS.md"));
    assert.ok(context.filePaths.includes("src/paymentService.js"));
    assert.ok(context.retrievedFiles.some(item=>item.name==="src/paymentService.js"));
    assert.equal(context.samples.some(item=>item.path===".env"),false);
    assert.equal(JSON.stringify(context).includes("must-not-enter-context"),false);
    assert.match(formatRepositoryContext(context),/Repository inventory/);
    assert.match(formatRepositoryContext(context),/Project instructions: AGENTS.md/);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});

test("repository inventory skips dependency and build folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"ath-context-skip-"));
  try {
    await fs.mkdir(path.join(root,"node_modules","left-pad"),{recursive:true});
    await fs.mkdir(path.join(root,"dist"),{recursive:true});
    await fs.writeFile(path.join(root,"node_modules","left-pad","index.js"),"secret dependency source");
    await fs.writeFile(path.join(root,"dist","bundle.js"),"compiled bundle");
    await fs.writeFile(path.join(root,"README.md"),"# Fixture");
    const context = await buildRepositoryContext(root,"Explain the repository");
    assert.deepEqual(context.filePaths,["README.md"]);
    assert.equal(JSON.stringify(context).includes("secret dependency source"),false);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});


test("repository context expands through relative imports and respects a token budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"ath-context-graph-"));
  try {
    await fs.mkdir(path.join(root,"src","auth"),{recursive:true});
    await fs.writeFile(path.join(root,"src","auth","loginController.js"),
      'import { rotateToken } from "./tokenService.js";\\nexport async function login() { return rotateToken(); }');
    await fs.writeFile(path.join(root,"src","auth","tokenService.js"),
      "export function rotateToken() { return { accessToken: 'ok' }; }");
    await fs.writeFile(path.join(root,"README.md"),"# Authentication fixture");
    const context = await buildRepositoryContext(root,"Fix login token rotation");
    assert.ok(context.importEdges.some(edge =>
      edge.from === "src/auth/loginController.js" && edge.to === "src/auth/tokenService.js"
    ));
    assert.ok(context.samples.some(sample => sample.path === "src/auth/tokenService.js"));
    const formatted = formatRepositoryContext(context,{maxTokens:2048});
    assert.ok(formatted.length <= 2048 * 3.5);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});


test("Tree-sitter retrieval finds declarations and cross-file call sites", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ath-symbol-index-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "sessionService.js"), [
      "export function rotateAccessToken(userId) {",
      "  return userId;",
      "}",
      "export class SessionManager {}",
    ].join("\n"));
    await fs.writeFile(path.join(root, "src", "loginController.js"), [
      'import { rotateAccessToken } from "./sessionService.js";',
      "export function login(userId) {",
      "  return rotateAccessToken(userId);",
      "}",
    ].join("\n"));

    const context = await buildRepositoryContext(root, "Fix rotateAccessToken handling in login controller");
    assert.equal(context.symbolIndex.available, true, context.symbolIndex.reason || "Tree-sitter runtime unavailable");
    assert.ok(context.symbolIndex.declarations.some(item =>
      item.name === "rotateAccessToken" && item.path === "src/sessionService.js"
    ));
    assert.ok(context.symbolIndex.references.some(item =>
      item.name === "rotateAccessToken" && item.path === "src/loginController.js"
    ));
    assert.ok(context.samples.some(item => item.path === "src/sessionService.js"));
    assert.match(formatRepositoryContext(context), /Tree-sitter structural symbol matches/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
