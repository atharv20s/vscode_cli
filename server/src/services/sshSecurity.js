import path from "node:path";

export function validateSSHHost(host) {
  if (typeof host !== "string" || !/^[A-Za-z0-9.:%_-]+$/.test(host) || host.startsWith("-")) {
    throw new TypeError("Invalid SSH host. Use a hostname or IP address.");
  }
  return host;
}

export function validateSSHUsername(username) {
  if (typeof username !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
    throw new TypeError("Invalid SSH username.");
  }
  return username;
}

export function buildStrictSSHOptions({ port = 22, connectTimeout = 10, batchMode = true } = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new TypeError("SSH port must be an integer between 1 and 65535.");
  }
  const timeout = Number(connectTimeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
    throw new TypeError("SSH connect timeout must be between 1 and 120 seconds.");
  }
  return [
    "-p", String(numericPort),
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=yes",
    "-o", "LogLevel=ERROR",
    "-o", `ConnectTimeout=${timeout}`,
    "-o", `BatchMode=${batchMode ? "yes" : "no"}`,
  ];
}

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function resolveRemoteWorkspacePath(workspaceRoot, requestedPath = ".") {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.startsWith("/")) {
    throw new TypeError("Remote workspace root must be an absolute POSIX path.");
  }
  const root = path.posix.resolve(workspaceRoot);
  const requested = String(requestedPath || ".").replace(/\\/g, "/");
  const target = path.posix.resolve(root, requested);
  const relative = path.posix.relative(root, target);
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error("Remote working directory escapes the configured workspace.");
  }
  return target;
}

export function validateDockerContainer(container) {
  if (typeof container !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) {
    throw new TypeError("Invalid Docker container name or ID.");
  }
  return container;
}
