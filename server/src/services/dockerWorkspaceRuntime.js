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

function workspaceNetworkName(workspaceId, override) {
  if (override) return override;
  const base = config.dockerWorkspaceNetwork;
  if (!base || base === "none" || base === "bridge") return base || "none";
  const digest = crypto.createHash("sha256").update(String(workspaceId)).digest("hex").slice(0, 16);
  return `athide-net-${digest}`;
}

function containerName(workspaceId) {
  const digest = crypto.createHash("sha256").update(String(workspaceId)).digest("hex").slice(0, 24);
  return `athide-${digest}`;
}

class DockerWorkspaceRuntime {
  constructor() {
    this.containers = new Map();
  }

  async ensureNetwork(workspaceId, override) {
    const network = workspaceNetworkName(workspaceId, override);
    if (!network || network === "none" || network === "bridge") return;
    try {
      execFileSync(config.dockerBinary, ["network", "inspect", network], { stdio: "ignore", timeout: 10000 });
    } catch {
      // Internal bridge: workspace containers can reach the host-side preview
      // proxy, but do not receive general outbound internet access.
      execFileSync(config.dockerBinary, ["network", "create", "--driver", "bridge", "--internal", network], {
        stdio: "ignore",
        timeout: 20000,
      });
    }
  }

  async getContainerAddress(workspaceId) {
    const network = workspaceNetworkName(workspaceId);
    if (network === "none") {
      throw new Error("Preview routing requires a workspace network; configure a named DOCKER_WORKSPACE_NETWORK.");
    }
    await this.ensureNetwork(workspaceId);
    const name = containerName(workspaceId);
    const raw = execFileSync(config.dockerBinary, ["inspect", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    const inspected = JSON.parse(raw)[0];
    const networks = inspected?.NetworkSettings?.Networks || {};
    const preferred = networks[network];
    const address = preferred?.IPAddress || Object.values(networks).map(item => item?.IPAddress).find(Boolean);
    if (!address) throw new Error("Workspace container has no reachable IP on the configured runtime network.");
    return address;
  }

  async ensureContainer(workspaceId, workspaceDir, options = {}) {
    const network = workspaceNetworkName(workspaceId, options.network);
    await this.ensureNetwork(workspaceId, options.network);
    if (config.executionRuntime !== "docker") {
      throw new Error("Docker workspace runtime is disabled. Set EXECUTION_RUNTIME=docker on a worker with Docker Engine access.");
    }
    if (!workspaceId || !path.isAbsolute(workspaceDir)) {
      throw new Error("A workspace identity and absolute workspace directory are required.");
    }

    const name = containerName(workspaceId);
    const existing = this.containers.get(name);
    if (options.replaceExisting) {
      try { execFileSync(config.dockerBinary, ["rm", "-f", name], { stdio: "ignore", timeout: 15000 }); } catch {}
      this.containers.delete(name);
    } else if (existing?.workspaceDir === workspaceDir) {
      return name;
    }

    const docker = config.dockerBinary;
    if (!options.replaceExisting) try {
      const raw = execFileSync(docker, ["inspect", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
      });
      const inspected = JSON.parse(raw)[0];
      const mount = inspected?.Mounts?.find(item => item.Destination === "/workspace");
      if (mount && path.resolve(mount.Source) === path.resolve(workspaceDir) &&
          inspected?.NetworkSettings?.Networks?.[network]) {
        if (!inspected.State?.Running) {
          execFileSync(docker, ["start", name], { stdio: "ignore", timeout: 15000 });
        }
        this.containers.set(name, { workspaceDir, workspaceId: String(workspaceId) });
        return name;
      }
      execFileSync(docker, ["rm", "-f", name], { stdio: "ignore", timeout: 15000 });
    } catch {
      // Container does not exist or could not be inspected; attempt a fresh one.
    }

    {
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
        "--restart", options.restartPolicy || "unless-stopped",
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
        "--network", network,
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
      const timeoutSeconds = Math.max(1, Math.ceil(timeout / 1000));
      const child = spawn(config.dockerBinary, [
        "exec", "-w", containerCwd, name,
        "/usr/bin/timeout", "--signal=TERM", "--kill-after=3s",
        `${timeoutSeconds}s`, "/bin/bash", "-lc", command,
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
      }, timeout + 5000);

      child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
      child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });
      child.on("error", error => finish({ success: false, output: error.message, exitCode: 1 }));
      child.on("close", code => {
        const timedOut = code === 124 || code === 137;
        finish({
          success: code === 0,
          output: (output + (timedOut ? "\\nCommand timed out." : "")).trim(),
          exitCode: code ?? 1,
        });
      });
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
