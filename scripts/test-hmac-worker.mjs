import crypto from "crypto";
import https from "https";

const SECRET = "3a89f9e1c2b5d4e7f8a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcde";
const WORKER_HOST = "worker.13.201.213.156.sslip.io";

function signRequest(method, path, body) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto.createHmac("sha256", SECRET)
    .update(timestamp).update(".").update(nonce).update(".")
    .update(method.toUpperCase()).update(".").update(path).update(".")
    .update(body).digest("hex");
  return {
    "x-worker-timestamp": timestamp,
    "x-worker-nonce": nonce,
    "x-worker-signature": signature,
  };
}

const body = JSON.stringify({ workspaceId: crypto.createHash("sha256").update("test-auth-verify").digest("hex") });
const headers = {
  "content-type": "application/json",
  "content-length": Buffer.byteLength(body),
  ...signRequest("POST", "/v1/pull", body),
};

const req = https.request({
  hostname: WORKER_HOST,
  port: 443,
  path: "/v1/workspace/pull",
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...signRequest("POST", "/v1/workspace/pull", body),
  },
}, res => {
  let data = "";
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    console.log(`Worker Response HTTP ${res.statusCode}:`, data);
  });
});

req.on("error", err => console.error("Request error:", err));
req.write(body);
req.end();
