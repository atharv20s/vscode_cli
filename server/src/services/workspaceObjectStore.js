import crypto from "crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

let cachedEc2Credentials = null;

function objectStoreConfig() {
  const bucket = process.env.WORKSPACE_OBJECT_STORE_BUCKET || "";
  const accessKey = process.env.WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "";
  const secretKey = process.env.WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "";
  const sessionToken = process.env.WORKSPACE_OBJECT_STORE_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN || "";
  const useEc2Role = (process.env.WORKSPACE_OBJECT_STORE_USE_EC2_ROLE || "false").toLowerCase() === "true";
  const region = process.env.WORKSPACE_OBJECT_STORE_REGION || "us-east-1";
  const customEndpoint = process.env.WORKSPACE_OBJECT_STORE_ENDPOINT || "";
  const endpoint = customEndpoint || `https://s3.${region}.amazonaws.com`;
  const encryption = (process.env.WORKSPACE_OBJECT_STORE_SERVER_SIDE_ENCRYPTION || "AES256").trim();
  const kmsKeyId = process.env.WORKSPACE_OBJECT_STORE_KMS_KEY_ID || "";
  if (!/^[a-z0-9-]{3,32}$/.test(region)) throw new Error("Workspace object storage region is invalid.");
  if (useEc2Role && customEndpoint) throw new Error("Custom object storage endpoints are not allowed with EC2 instance-role credentials.");
  if (!bucket || (!useEc2Role && (!accessKey || !secretKey))) {
    if ((process.env.WORKSPACE_OBJECT_STORE_REQUIRED || "false").toLowerCase() === "true") {
      throw new Error("Workspace object storage is required but bucket credentials are incomplete.");
    }
    return null;
  }
  if (!["AES256", "aws:kms"].includes(encryption)) {
    throw new Error("Workspace object storage encryption must be AES256 or aws:kms.");
  }
  if (kmsKeyId && encryption !== "aws:kms") {
    throw new Error("A KMS key ID requires WORKSPACE_OBJECT_STORE_SERVER_SIDE_ENCRYPTION=aws:kms.");
  }
  if (encryption === "aws:kms" && !kmsKeyId) {
    throw new Error("KMS encryption requires WORKSPACE_OBJECT_STORE_KMS_KEY_ID.");
  }
  const base = new URL(endpoint);
  if (base.protocol !== "https:") throw new Error("Workspace object storage endpoint must use HTTPS.");
  return { bucket, accessKey, secretKey, sessionToken, useEc2Role, region, base, encryption, kmsKeyId };
}

async function resolveObjectStoreCredentials(config) {
  if (!config.useEc2Role) {
    return { accessKey: config.accessKey, secretKey: config.secretKey, sessionToken: config.sessionToken };
  }
  if (cachedEc2Credentials && Date.parse(cachedEc2Credentials.expiration) > Date.now() + 5 * 60 * 1000) {
    return cachedEc2Credentials;
  }

  const metadataBase = "http://169.254.169.254/latest";
  const tokenResponse = await fetch(metadataBase + "/api/token", {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
    redirect: "error",
    signal: AbortSignal.timeout(1500),
  });
  if (!tokenResponse.ok) throw new Error("Unable to obtain an IMDSv2 token for the S3 worker role.");
  const metadataToken = (await tokenResponse.text()).trim();
  if (!metadataToken || metadataToken.length > 4096) throw new Error("IMDSv2 returned an invalid metadata token.");

  const headers = { "X-aws-ec2-metadata-token": metadataToken };
  const roleResponse = await fetch(metadataBase + "/meta-data/iam/security-credentials/", {
    headers, redirect: "error", signal: AbortSignal.timeout(1500),
  });
  if (!roleResponse.ok) throw new Error("Unable to discover the EC2 instance role for workspace storage.");
  const roleName = (await roleResponse.text()).trim();
  if (!/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(roleName)) throw new Error("EC2 metadata returned an invalid instance role name.");

  const credentialResponse = await fetch(metadataBase + "/meta-data/iam/security-credentials/" + encodeURIComponent(roleName), {
    headers, redirect: "error", signal: AbortSignal.timeout(1500),
  });
  if (!credentialResponse.ok) throw new Error("Unable to retrieve temporary EC2 role credentials.");
  const value = await credentialResponse.json();
  const expiration = typeof value.Expiration === "string" ? value.Expiration : "";
  if (value.Code !== "Success" || typeof value.AccessKeyId !== "string" ||
      typeof value.SecretAccessKey !== "string" || typeof value.Token !== "string" ||
      !Number.isFinite(Date.parse(expiration)) || Date.parse(expiration) <= Date.now() + 60 * 1000) {
    throw new Error("EC2 instance role returned incomplete or expired credentials.");
  }
  cachedEc2Credentials = {
    accessKey: value.AccessKeyId,
    secretKey: value.SecretAccessKey,
    sessionToken: value.Token,
    expiration,
  };
  return cachedEc2Credentials;
}

async function signedRequest(method, key, body = Buffer.alloc(0)) {
  const config = objectStoreConfig();
  if (!config) return null;
  const credentials = await resolveObjectStoreCredentials(config);
  const encodedBucket = encodeURIComponent(config.bucket);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const pathname = (config.base.pathname.replace(/\/$/, "") + "/" + encodedBucket + "/" + encodedKey).replace(/\/+/g, "/");
  const host = config.base.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "content-type": "application/json",
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  if (method === "PUT") {
    headers["x-amz-server-side-encryption"] = config.encryption;
    if (config.kmsKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = config.kmsKeyId;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map(name => name + ":" + String(headers[name]).trim() + "\n").join("");
  const canonicalRequest = [method, pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = dateStamp + "/" + config.region + "/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac("AWS4" + credentials.secretKey, dateStamp);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = "AWS4-HMAC-SHA256 Credential=" + credentials.accessKey + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  return {
    url: new URL(pathname, config.base.origin),
    headers: { ...headers, authorization },
  };
}

export function isWorkspaceObjectStoreConfigured() {
  return Boolean(objectStoreConfig());
}

function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || !/^[a-f0-9]{64}$/.test(workspaceId)) {
    throw new Error("Invalid workspace identity for object storage.");
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.files) || snapshot.files.length > 4000) {
    throw new Error("Stored workspace snapshot has an unsupported format.");
  }
  let totalBytes = 0;
  const paths = new Set();
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.includes("\\") ||
        file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === "..") ||
        typeof file.content !== "string") {
      throw new Error("Workspace snapshot contains an unsafe file entry.");
    }
    if (paths.has(file.path)) throw new Error("Workspace snapshot contains duplicate file paths.");
    paths.add(file.path);
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content || bytes.length > 2 * 1024 * 1024) {
      throw new Error("Workspace snapshot contains invalid or oversized file content.");
    }
    totalBytes += bytes.length;
    if (totalBytes > 12 * 1024 * 1024) throw new Error("Workspace snapshot exceeds the 12 MB persistence limit.");
  }
}

export async function putWorkspaceSnapshot(workspaceId, snapshot) {
  validateWorkspaceId(workspaceId);
  validateSnapshot(snapshot);
  const payload = { ...snapshot };
  delete payload.integrity;
  const canonicalBody = Buffer.from(JSON.stringify(payload));
  const envelope = {
    ...payload,
    integrity: { algorithm: "sha256", digest: sha256(canonicalBody) },
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const signed = await signedRequest("PUT", "workspaces/" + workspaceId + "/snapshot.json", body);
  if (!signed) return false;
  const response = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
  if (!response.ok) throw new Error("Workspace snapshot upload failed with HTTP " + response.status + ".");
  return true;
}

export async function getWorkspaceSnapshot(workspaceId) {
  validateWorkspaceId(workspaceId);
  const signed = await signedRequest("GET", "workspaces/" + workspaceId + "/snapshot.json");
  if (!signed) return null;
  const response = await fetch(signed.url, { method: "GET", headers: signed.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Workspace snapshot restore failed with HTTP " + response.status + ".");
  const snapshot = await response.json();
  validateSnapshot(snapshot);
  if (snapshot.integrity) {
    const { integrity, ...payload } = snapshot;
    if (integrity.algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(integrity.digest || "")) {
      throw new Error("Workspace snapshot integrity metadata is invalid.");
    }
    const expected = Buffer.from(sha256(Buffer.from(JSON.stringify(payload))), "hex");
    const actual = Buffer.from(integrity.digest, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new Error("Workspace snapshot integrity check failed; refusing restore.");
    }
  }
  return snapshot;
}
