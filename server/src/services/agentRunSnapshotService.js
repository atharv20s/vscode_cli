import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 10000;
const MAX_BYTES = 100 * 1024 * 1024;
const IGNORED = new Set(["node_modules", ".cache", ".next", "dist", "build", ".ath-locks", ".ath-agent-runs"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};

function storageRoot(workspace) {
  const identity = hash(String(workspace.workspaceId || workspace.workspaceRoot)).slice(0, 32);
  return path.join(path.dirname(workspace.workspaceRoot), ".ath-agent-run-snapshots", identity);
}

async function walk(root) {
  const entries = [];
  const stack = [{ absolute: root, relative: "" }];
  let totalBytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const children = await fs.readdir(current.absolute, { withFileTypes: true });
    for (const child of children) {
      if (!current.relative && IGNORED.has(child.name)) continue;
      if (child.name === ".git") continue;
      const relative = current.relative ? current.relative + "/" + child.name : child.name;
      const absolute = path.join(current.absolute, child.name);
      if (child.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        entries.push({ path: relative, type: "symlink", target, digest: hash(target) });
      } else if (child.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        stack.push({ absolute, relative });
      } else if (child.isFile()) {
        const stat = await fs.stat(absolute);
        totalBytes += stat.size;
        if (entries.length >= MAX_FILES || totalBytes > MAX_BYTES) {
          const error = new Error("Agent run snapshot exceeds its file or size budget.");
          error.code = "SNAPSHOT_LIMIT";
          throw error;
        }
        const bytes = await fs.readFile(absolute);
        entries.push({ path: relative, type: "file", digest: hash(bytes), size: bytes.length });
      }
      if (entries.length > MAX_FILES) {
        const error = new Error("Agent run snapshot exceeds its file-count budget.");
        error.code = "SNAPSHOT_LIMIT";
        throw error;
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, totalBytes };
}

async function copySnapshotFiles(root, destination, entries) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const source = path.join(root, ...entry.path.split("/"));
    const target = path.join(destination, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target);
  }
}

async function readGitIndex(root) {
  const gitDir = path.join(root, ".git");
  try {
    const stat = await fs.lstat(gitDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const index = path.join(gitDir, "index");
    const indexStat = await fs.lstat(index);
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > 16 * 1024 * 1024) return null;
    return await fs.readFile(index);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function capture(workspace, runDir, phase) {
  const root = path.resolve(workspace.workspaceRoot);
  const { entries, totalBytes } = await walk(root);
  const filesDir = path.join(runDir, phase);
  await copySnapshotFiles(root, filesDir, entries);
  const index = await readGitIndex(root);
  if (index) await fs.writeFile(path.join(runDir, phase + "-git-index"), index, { mode: 0o600 });
  return {
    entries,
    totalBytes,
    gitIndex: index ? { digest: hash(index), size: index.length } : null,
  };
}

function validateEditorState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tabs = Array.isArray(value.tabs) ? value.tabs.slice(0, 40) : [];
  let bytes = 0;
  const safeTabs = tabs.filter(tab => tab && typeof tab.path === "string" && tab.path.length <= 1024 &&
    typeof tab.content === "string" && !tab.path.startsWith("/") && !tab.path.split(/[\\/]/).includes(".."))
    .map(tab => {
      bytes += Buffer.byteLength(tab.content, "utf8");
      return { path: tab.path, content: tab.content, version: typeof tab.version === "string" ? tab.version : null, isDirty: tab.isDirty === true };
    });
  if (bytes > 3 * 1024 * 1024) {
    const error = new Error("Open editor buffers exceed the 3 MB snapshot limit.");
    error.code = "EDITOR_SNAPSHOT_LIMIT";
    throw error;
  }
  return {
    activeTab: typeof value.activeTab === "string" ? value.activeTab : null,
    activeGroup: value.activeGroup === "secondary" ? "secondary" : "primary",
    tabs: safeTabs,
  };
}

export async function createAgentRunSnapshot(workspace, editorState = {}) {
  const root = path.resolve(workspace.workspaceRoot);
  const base = storageRoot(workspace);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const runId = crypto.randomUUID();
  const runDir = path.join(base, runId);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  try {
    const before = await capture(workspace, runDir, "before");
    const record = {
      version: 1, runId, workspaceId: String(workspace.workspaceId), createdAt: new Date().toISOString(),
      root, before, editorState: validateEditorState(editorState), after: null, state: "captured",
    };
    await fs.writeFile(path.join(runDir, "snapshot.json"), JSON.stringify(record), { mode: 0o600 });
    return { runId, fileCount: before.entries.length, bytes: before.totalBytes };
  } catch (error) {
    await fs.rm(runDir, { recursive: true, force: true });
    throw error;
  }
}

async function readRecord(workspace, runId) {
  if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) {
    const error = new Error("Invalid agent run ID.");
    error.code = "INVALID_RUN_ID";
    throw error;
  }
  const runDir = path.join(storageRoot(workspace), runId);
  const record = JSON.parse(await fs.readFile(path.join(runDir, "snapshot.json"), "utf8"));
  if (record.version !== 1 || record.workspaceId !== String(workspace.workspaceId) || record.root !== path.resolve(workspace.workspaceRoot)) {
    const error = new Error("Agent run snapshot does not belong to this workspace.");
    error.code = "SNAPSHOT_SCOPE_MISMATCH";
    throw error;
  }
  return { runDir, record };
}

export async function completeAgentRunSnapshot(workspace, runId) {
  const { runDir, record } = await readRecord(workspace, runId);
  if (record.state !== "captured") return { runId, state: record.state };
  record.after = await capture(workspace, runDir, "after");
  record.completedAt = new Date().toISOString();
  record.state = "completed";
  const temporary = path.join(runDir, "snapshot.json.tmp");
  await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(temporary, path.join(runDir, "snapshot.json"));
  return { runId, state: record.state, changedFiles: record.before.entries.filter(item => {
    const after = record.after.entries.find(value => value.path === item.path);
    return !after || after.digest !== item.digest || after.type !== item.type;
  }).length + record.after.entries.filter(item => !record.before.entries.some(value => value.path === item.path)).length };
}

async function restoreTree(workspace, runDir, entries) {
  const root = path.resolve(workspace.workspaceRoot);
  const desired = new Map(entries.map(item => [item.path, item]));
  const current = await walk(root);
  for (const item of current.entries.slice().sort((a, b) => b.path.length - a.path.length)) {
    if (desired.has(item.path) && desired.get(item.path).type === item.type) continue;
    const target = path.join(root, ...item.path.split("/"));
    if (!inside(root, target)) throw new Error("Snapshot path escaped the workspace.");
    await fs.rm(target, { recursive: true, force: true });
  }
  for (const item of entries.filter(value => value.type === "directory").sort((a, b) => a.path.length - b.path.length)) {
    const target = path.join(root, ...item.path.split("/"));
    if (!inside(root, target)) throw new Error("Snapshot directory escaped the workspace.");
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
  }
  for (const item of entries.filter(value => value.type !== "directory")) {
    const target = path.join(root, ...item.path.split("/"));
    if (!inside(root, target)) throw new Error("Snapshot file escaped the workspace.");
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.rm(target, { recursive: true, force: true });
    if (item.type === "symlink") await fs.symlink(item.target, target);
    else {
      const source = path.join(runDir, "before", ...item.path.split("/"));
      const bytes = await fs.readFile(source);
      if (hash(bytes) !== item.digest) throw new Error("Stored snapshot file failed integrity verification: " + item.path);
      const temporary = target + ".ath-restore-" + crypto.randomBytes(5).toString("hex");
      await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, target);
    }
  }
}

export async function rollbackAgentRunSnapshot(workspace, runId) {
  const { runDir, record } = await readRecord(workspace, runId);
  if (record.state !== "completed" || !record.after) {
    const error = new Error("This agent run has no completed post-run snapshot and cannot be rolled back yet.");
    error.code = "SNAPSHOT_NOT_COMPLETED";
    throw error;
  }
  const current = await walk(path.resolve(workspace.workspaceRoot));
  const currentIndex = await readGitIndex(path.resolve(workspace.workspaceRoot));
  const currentIndexDigest = currentIndex ? hash(currentIndex) : null;
  const fingerprint = entries => JSON.stringify(entries.map(item => [item.path, item.type, item.digest || item.target || ""]).sort((a, b) => a[0].localeCompare(b[0])));
  if (fingerprint(current.entries) !== fingerprint(record.after.entries) ||
      currentIndexDigest !== (record.after.gitIndex?.digest || null)) {
    const error = new Error("Workspace changed after this agent run. Rollback refused to avoid overwriting newer work.");
    error.code = "SNAPSHOT_ROLLBACK_CONFLICT";
    throw error;
  }
  await restoreTree(workspace, runDir, record.before.entries);
  if (record.before.gitIndex) {
    const gitDir = path.join(workspace.workspaceRoot, ".git");
    const stat = await fs.lstat(gitDir).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Git metadata changed; cannot safely restore the index.");
    const bytes = await fs.readFile(path.join(runDir, "before-git-index"));
    if (hash(bytes) !== record.before.gitIndex.digest) throw new Error("Stored Git index snapshot failed integrity verification.");
    const target = path.join(gitDir, "index");
    const temporary = target + ".ath-restore-" + crypto.randomBytes(5).toString("hex");
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } else {
    const gitDir = path.join(workspace.workspaceRoot, ".git");
    const stat = await fs.lstat(gitDir).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.rm(path.join(gitDir, "index"), { force: true });
  }
  return { runId, restored: true, editorState: record.editorState, restoredFiles: record.before.entries.length };
}
