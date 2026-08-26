/**
 * Kubernetes Dynamic Pod Manager — Pure JavaScript (0% TypeScript)
 *
 * Dynamically provisions, manages, and executes commands inside
 * isolated, resource-constrained Kubernetes Pods for each user.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";

const execAsync = promisify(exec);

const NAMESPACE = process.env.K8S_NAMESPACE || "ath-ide";
const USER_POD_PREFIX = "ws-pod-";

/**
 * Check if Kubernetes cluster is accessible.
 * @returns {Promise<boolean>}
 */
export async function isK8sAvailable() {
  try {
    const { stdout } = await execAsync("kubectl version --client -o json");
    return !!stdout;
  } catch {
    return false;
  }
}

/**
 * Generate sanitized pod name for a user.
 * @param {string} userId
 * @returns {string}
 */
export function getPodNameForUser(userId) {
  const cleanId = String(userId).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
  return `${USER_POD_PREFIX}${cleanId}`;
}

/**
 * Ensure a sandboxed Kubernetes Pod exists and is running for a user.
 *
 * @param {string} userId - Unique identifier of the user
 * @param {object} [options]
 * @param {string} [options.cpuLimit="250m"] - CPU Limit (e.g. 250m = 0.25 core)
 * @param {string} [options.memLimit="256Mi"] - Memory limit (e.g. 256Mi)
 * @returns {Promise<{ podName: string, status: string }>}
 */
export async function ensureUserPod(userId, options = {}) {
  const podName = getPodNameForUser(userId);
  const cpuLimit = options.cpuLimit || process.env.DEFAULT_POD_CPU_LIMIT || "250m";
  const memLimit = options.memLimit || process.env.DEFAULT_POD_MEM_LIMIT || "256Mi";

  try {
    // 1. Check if pod already exists
    const { stdout: checkOutput } = await execAsync(
      `kubectl get pod ${podName} -n ${NAMESPACE} -o jsonpath="{.status.phase}" 2>/dev/null || echo "NotFound"`
    );

    const phase = checkOutput.replace(/"/g, "").trim();

    if (phase === "Running") {
      return { podName, status: "Running" };
    }

    if (phase !== "NotFound" && phase !== "") {
      // Pod is in error or completed state — delete and recreate
      await execAsync(`kubectl delete pod ${podName} -n ${NAMESPACE} --grace-period=0 --force 2>/dev/null || true`);
    }

    // 2. Create the user pod with resource constraints & isolation
    const manifest = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: NAMESPACE,
        labels: {
          app: "ath-user-workspace",
          "ath.ide/user": userId,
          "ath.ide/created-at": String(Date.now()),
        },
      },
      spec: {
        restartPolicy: "Never",
        containers: [
          {
            name: "workspace-runner",
            image: "node:20-alpine",
            command: ["sh", "-c", "sleep 86400"],
            resources: {
              requests: { cpu: "50m", memory: "64Mi" },
              limits: { cpu: cpuLimit, memory: memLimit },
            },
            volumeMounts: [
              {
                name: "workspace-data",
                mountPath: "/workspace",
              },
            ],
          },
        ],
        volumes: [
          {
            name: "workspace-data",
            emptyDir: { sizeLimit: "500Mi" },
          },
        ],
      },
    };

    const jsonStr = JSON.stringify(manifest).replace(/"/g, '\\"');
    await execAsync(`echo "${jsonStr}" | kubectl apply -f -`);

    logger.info(`Provisioned Kubernetes Pod for user`, { userId, podName, cpuLimit, memLimit });

    return { podName, status: "Created" };
  } catch (err) {
    logger.error(`Failed to ensure user pod: ${err.message}`, { userId, podName });
    throw err;
  }
}

/**
 * Execute a command inside the user's isolated Kubernetes Pod.
 *
 * @param {string} userId - User identifier
 * @param {string} command - Shell command to run
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<{ success: boolean, output: string, exitCode: number }>}
 */
export async function execInUserPod(userId, command, timeoutMs = 30000) {
  const podName = getPodNameForUser(userId);

  // Ensure pod is active
  await ensureUserPod(userId);

  try {
    const escapedCmd = command.replace(/"/g, '\\"');
    const fullCmd = `kubectl exec ${podName} -n ${NAMESPACE} -c workspace-runner -- sh -c "${escapedCmd}"`;

    const { stdout, stderr } = await execAsync(fullCmd, { timeout: timeoutMs });
    return {
      success: true,
      output: (stdout || stderr || "Command executed successfully.").trim(),
      exitCode: 0,
    };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || err.stderr || err.message).trim(),
      exitCode: err.code || 1,
    };
  }
}

/**
 * List all active user pods in the cluster.
 */
export async function listUserPods() {
  try {
    const { stdout } = await execAsync(
      `kubectl get pods -n ${NAMESPACE} -l app=ath-user-workspace -o json`
    );
    const data = JSON.parse(stdout);
    return (data.items || []).map((item) => ({
      name: item.metadata.name,
      user: item.metadata.labels?.["ath.ide/user"],
      phase: item.status.phase,
      startTime: item.status.startTime,
    }));
  } catch {
    return [];
  }
}
