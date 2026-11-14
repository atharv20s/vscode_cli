import path from "node:path";
import { realpath, stat, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../../websocket/eventBus.js";

const SYSTEM_PATHS = ["/usr", "/usr/local", "/bin", "/sbin", "/lib", "/lib64"];
const ETC_FILES = ["/etc/hosts", "/etc/resolv.conf", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/ssl/certs/ca-certificates.crt"];
const SAFE_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  TERM: "dumb",
};

export function makeUnitName(operationId = "task") {
  const safe = String(operationId).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48) || "task";
  return `athide-${safe}.scope`;
}

export function buildBubblewrapArgs({ workspaceRoot, workingDirectory, command, networkMode = "none", systemPaths = SYSTEM_PATHS, etcFiles = ETC_FILES }) {
  if (!["none", "host"].includes(networkMode)) throw new Error("LINUX_SANDBOX_NETWORK must be 'none' or 'host'.");
  const args = [
    "--die-with-parent", "--new-session",
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
  ];
  if (networkMode === "none") args.push("--unshare-net");
  else args.push("--share-net");

  for (const mountPath of systemPaths) args.push("--ro-bind", mountPath, mountPath);
  args.push("--dir", "/etc", "--dir", "/etc/ssl", "--dir", "/etc/ssl/certs");
  for (const file of etcFiles) args.push("--ro-bind", file, file);
  args.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/workspace",
    "--bind", workspaceRoot, "/workspace",
    "--chdir", workingDirectory,
    "--clearenv",
    "--setenv", "HOME", "/tmp",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", SAFE_ENV.PATH,
    "--setenv", "LANG", SAFE_ENV.LANG,
    "--setenv", "TERM", SAFE_ENV.TERM,
    "--", "/bin/bash", "--noprofile", "--norc", "-lc", command,
  );
  return args;
}

async function resolveWorkspacePaths(workspaceDir, cwd) {
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) throw new Error("A workspace root is required for Linux sandbox execution.");
  const root = await realpath(workspaceDir);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error("Workspace root is not a directory.");
  const requestedCwd = cwd ? (path.isAbsolute(cwd) ? cwd : path.resolve(root, cwd)) : root;
  const workingDirectory = await realpath(requestedCwd);
  const cwdStat = await stat(workingDirectory);
  if (!cwdStat.isDirectory()) throw new Error("Command working directory is not a directory.");
  const relative = path.relative(root, workingDirectory);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Command working directory escapes the assigned workspace.");
  }
  return {
    root,
    workingDirectory: relative ? path.posix.join("/workspace", relative.split(path.sep).join("/")) : "/workspace",
  };
}

function publish(topic, data, metadata) {
  try { eventBus.publish(topic, data, metadata); }
  catch (error) { logger.warn("Linux sandbox event publication failed", { topic, error: error.message }); }
}

class LinuxSandboxBackend {
  constructor(options = {}) {
    this.spawnProcess = options.spawnProcess || spawn;
    this.fsAccess = options.fsAccess || access;
    this.platform = options.platform || process.platform;
  }

  async execute({ workspaceId = "default", workspaceDir, cwd, command, timeout = 45000, signal = null, operationId }) {
    if (this.platform !== "linux") throw new Error("EXECUTION_RUNTIME=linux requires a Linux worker host.");
    if (typeof command !== "string" || !command.trim()) throw new Error("A non-empty command is required.");
    if (signal?.aborted) return { success: false, output: "Command aborted before launch.", exitCode: -1 };
    const { root, workingDirectory } = await resolveWorkspacePaths(workspaceDir, cwd);
    const required = [config.linuxSandbox.systemdRunBinary, config.linuxSandbox.bubblewrapBinary, "/bin/bash"];
    for (const binary of required) {
      if (binary.startsWith("/")) await this.fsAccess(binary).catch(() => { throw new Error(`Required Linux sandbox binary is unavailable: ${binary}`); });
    }

    const unit = makeUnitName(operationId);
    const args = [
      "--user", "--scope", "--wait", "--collect", "--pipe", "--quiet",
      `--unit=${unit}`,
      `--property=MemoryMax=${config.linuxSandbox.memoryMax}`,
      `--property=CPUQuota=${config.linuxSandbox.cpuQuota}`,
      `--property=TasksMax=${config.linuxSandbox.tasksMax}`,
      "--",
      config.linuxSandbox.bubblewrapBinary,
      ...buildBubblewrapArgs({
        workspaceRoot: root,
        workingDirectory,
        command,
        networkMode: config.linuxSandbox.networkMode,
        systemPaths: await Promise.all(SYSTEM_PATHS.map(async mountPath => {
          try { await this.fsAccess(mountPath); return mountPath; } catch { return null; }
        })).then(paths => paths.filter(Boolean)),
        etcFiles: await Promise.all(ETC_FILES.map(async file => {
          try { await this.fsAccess(file); return file; } catch { return null; }
        })).then(paths => paths.filter(Boolean)),
      }),
    ];

    const metadata = { workspaceId, operationId, source: "linux_sandbox", actor: "agent" };
    publish(EVENT_TOPICS.AGENT_COMMAND_REQUESTED, { command, cwd: workingDirectory, runtime: "linux" }, metadata);
    const startedAt = Date.now();
    const maxOutput = config.linuxSandbox.maxOutputBytes;
    let output = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let child;

    const stopScope = () => new Promise(resolve => {
      let stopper;
      try {
        stopper = this.spawnProcess(config.linuxSandbox.systemctlBinary, ["--user", "stop", unit], {
          env: SAFE_ENV, stdio: "ignore", windowsHide: true,
        });
      } catch { resolve(); return; }
      stopper.once("error", resolve);
      stopper.once("close", resolve);
    });

    return new Promise((resolve, reject) => {
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ ...result, output: output || result.output || "", durationMs: Date.now() - startedAt });
      };
      const onAbort = async () => {
        if (settled) return;
        aborted = true;
        await stopScope();
        child?.kill("SIGTERM");
        finish({ success: false, exitCode: -1, output: "Command aborted by user." });
      };
      const timer = setTimeout(async () => {
        if (settled) return;
        timedOut = true;
        await stopScope();
        child?.kill("SIGTERM");
        finish({ success: false, exitCode: -1, output: `Command timed out after ${Math.round(timeout / 1000)}s.` });
      }, Math.max(1000, timeout));

      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        child = this.spawnProcess(config.linuxSandbox.systemdRunBinary, args, {
          cwd: root,
          env: SAFE_ENV,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
        return;
      }

      const collect = chunk => {
        if (output.length < maxOutput) output += chunk.toString("utf8").slice(0, maxOutput - output.length);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", error => {
        logger.error("Linux sandbox spawn failed", { operationId, error: error.message });
        finish({ success: false, exitCode: 127, output: error.message });
      });
      child.once("close", code => {
        if (settled) return;
        const exitCode = Number.isInteger(code) ? code : 1;
        const success = exitCode === 0 && !timedOut && !aborted;
        publish(success ? EVENT_TOPICS.AGENT_COMMAND_COMPLETED : EVENT_TOPICS.AGENT_COMMAND_FAILED, {
          command, exitCode, durationMs: Date.now() - startedAt, runtime: "linux",
        }, metadata);
        finish({ success, exitCode, output });
      });
      publish(EVENT_TOPICS.AGENT_COMMAND_STARTED, { command, runtime: "linux", unit }, metadata);
    });
  }
}

export const linuxSandboxBackend = new LinuxSandboxBackend();
export { LinuxSandboxBackend, resolveWorkspacePaths };
