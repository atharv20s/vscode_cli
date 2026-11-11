/**
 * Per-user Docker workspace runtime.
 *
 * Each authenticated workspace receives a long-lived, resource-limited
 * container with only that user's workspace bind-mounted at /workspace.
 * Requires a Docker Engine on the same worker host as the API process.
 */
import { spawn, execFileSync } from "child_process";
import path from "path";
import crypto from "crypto";
import { config } from "../config/env.js";

function containerName(workspaceId) {
  const digest = crypto.createHash("sha256").update(String(workspaceId)).digest("hex").slice(0, 24);
  return `athide-${digest}`;
}

class DockerWorkspaceRuntime {
  constructor() {
    this.containers = new Map();
  }

  async ensureContainer(workspaceId, workspaceDir) {
    if (config.executionRuntime !== "docker") {
      throw new Error("Docker workspace runtime is disabled. Set EXECUTION_RUNTIME=docker on a worker with Docker Engine access.");
    }
    if (!workspaceId || !path.isAbsolute(workspaceDir)) {
      throw new Error("A workspace identity and absolute workspace directory are required.");
    }

    const name = containerName(workspaceId);
    const existing = this.containers.get(name);
    if (existing?.workspaceDir === workspaceDir) return name;

    const docker = config.dockerBinary;
    try {
      execFileSync(docker, ["inspect", name], { stdio: "ignore", timeout: 10000 });
      execFileSync(docker, ["start", name], { stdio: "ignore", timeout: 15000 });
    } catch {
      const uid = config.dockerWorkspaceUid;
      const gid = config.dockerWorkspaceGid;
      const processUid = typeof process.getuid === "function" ? process.getuid() : uid;
      const processGid = typeof process.getgid === "function" ? process.getgid() : gid;
      if (processUid === 0) {
        execFileSync("chown", ["-R", `${uid}:${gid}`, workspaceDir], { stdio: "ignore", timeout: 30000 });
      } else if (processUid !== uid || processGid !== gid) {
        throw new Error("Docker workspace UID/GID must match the API worker user, or the worker must run with permission to chown workspace files.");
      }
      const args = [
        "run", "-d", "--name", name,
        "--label", "app=ath-ide",
        "--label", `workspace=${name}`,
        "--restart", "unless-stopped",
        "--memory", "1g",
        "--memory-swap", "1g",
        "--cpus", "1",
        "--pids-limit", "256",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--user", `${uid}:${gid}`,
        "-e", "HOME=/tmp",
        "--network", "bridge",
        "-v", `${workspaceDir}:/workspace:rw`,
        "-w", "/workspace",
        config.dockerImage,
        "sleep", "infinity",
      ];
      try {
        execFileSync(docker, args, { stdio: "pipe", timeout: 60000 });
      } catch (error) {
        const detail = error.stderr?.toString?.() || error.message;
        throw new Error(`Unable to provision isolated workspace container: ${detail}`);
      }
    }

    this.containers.set(name, { workspaceDir, workspaceId: String(workspaceId) });
    return name;
  }

  async execute({ workspaceId, workspaceDir, cwd = workspaceDir, command, timeout = 45000, signal }) {
    const name = await this.ensureContainer(workspaceId, workspaceDir);
    const relativeCwd = path.relative(workspaceDir, cwd || workspaceDir);
    if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
      throw new Error("Execution working directory is outside the workspace.");
    }
    const containerCwd = path.posix.join("/workspace", relativeCwd.split(path.sep).join("/"));
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const child = spawn(config.dockerBinary, [
        "exec", "-w", containerCwd, name, "/bin/bash", "-lc", command,
      ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        finish({ success: false, output: "Command aborted.", exitCode: -1 });
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ success: false, output: output + "\\nCommand timed out.", exitCode: -1 });
      }, timeout);

      child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
      child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });
      child.on("error", error => finish({ success: false, output: error.message, exitCode: 1 }));
      child.on("close", code => finish({
        success: code === 0,
        output: output.trim(),
        exitCode: code ?? 1,
      }));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async stop(workspaceId) {
    const name = containerName(workspaceId);
    try {
      execFileSync(config.dockerBinary, ["rm", "-f", name], { stdio: "ignore", timeout: 15000 });
    } catch {}
    this.containers.delete(name);
  }
}

export const dockerWorkspaceRuntime = new DockerWorkspaceRuntime();
