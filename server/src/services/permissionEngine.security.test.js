import test from "node:test";
import assert from "node:assert/strict";
import { classifyFileOperationForPolicy } from "./permissionEngine.js";

test("secret files cannot be read through file tools", () => {
  for (const path of [".env", ".env.production", "keys/id_rsa", "certs/private.pem", ".aws/credentials", "infra/terraform.tfstate"]) {
    assert.equal(classifyFileOperationForPolicy("read", path), "DENY", path);
  }
});

test("sensitive project configuration changes require approval", () => {
  for (const path of ["package.json", "package-lock.json", ".github/workflows/deploy.yml", "Dockerfile", "server/src/config/env.js"]) {
    assert.equal(classifyFileOperationForPolicy("write", path), "ASK", path);
  }
  assert.equal(classifyFileOperationForPolicy("edit", "src/App.jsx"), "ALLOW");
  assert.equal(classifyFileOperationForPolicy("delete", "src/App.jsx"), "ASK");
});
