import crypto from "crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function objectStoreConfig() {
  const bucket = process.env.WORKSPACE_OBJECT_STORE_BUCKET || "";
  const accessKey = process.env.WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID || "";
  const secretKey = process.env.WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY || "";
  const region = process.env.WORKSPACE_OBJECT_STORE_REGION || "us-east-1";
  const endpoint = process.env.WORKSPACE_OBJECT_STORE_ENDPOINT || `https://s3.${region}.amazonaws.com`;
  if (!bucket || !accessKey || !secretKey) return null;
  const base = new URL(endpoint);
  if (base.protocol !== "https:") throw new Error("Workspace object storage endpoint must use HTTPS.");
  return { bucket, accessKey, secretKey, region, base };
}

function signedRequest(method, key, body = Buffer.alloc(0)) {
  const config = objectStoreConfig();
  if (!config) return null;
  const encodedBucket = encodeURIComponent(config.bucket);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const pathname = (config.base.pathname.replace(/\/$/, "") + "/" + encodedBucket + "/" + encodedKey).replace(/\/+/g, "/");
  const host = config.base.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalHeaders = "host:" + host + "\n" + "x-amz-content-sha256:" + payloadHash + "\n" + "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = dateStamp + "/" + config.region + "/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac("AWS4" + config.secretKey, dateStamp);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = "AWS4-HMAC-SHA256 Credential=" + config.accessKey + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  return {
    url: new URL(pathname, config.base.origin),
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization,
      "content-type": "application/json",
    },
  };
}

export function isWorkspaceObjectStoreConfigured() {
  return Boolean(objectStoreConfig());
}

export async function putWorkspaceSnapshot(workspaceId, snapshot) {
  const body = Buffer.from(JSON.stringify(snapshot));
  const signed = signedRequest("PUT", "workspaces/" + workspaceId + "/snapshot.json", body);
  if (!signed) return false;
  const response = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
  if (!response.ok) throw new Error("Workspace snapshot upload failed with HTTP " + response.status + ".");
  return true;
}

export async function getWorkspaceSnapshot(workspaceId) {
  const signed = signedRequest("GET", "workspaces/" + workspaceId + "/snapshot.json");
  if (!signed) return null;
  const response = await fetch(signed.url, { method: "GET", headers: signed.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Workspace snapshot restore failed with HTTP " + response.status + ".");
  const snapshot = await response.json();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.files)) {
    throw new Error("Stored workspace snapshot has an unsupported format.");
  }
  return snapshot;
}
