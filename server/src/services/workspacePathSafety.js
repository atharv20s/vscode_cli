import fs from "fs/promises";
import path from "path";

export function safeRelativeWorkspacePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || value.includes("\0")) return false;
  return value.split("/").every(part => part && part !== "." && part !== "..");
}

export async function resolveSafeWorkspacePath(root, relativePath) {
  if (!safeRelativeWorkspacePath(relativePath)) throw new Error("Unsafe workspace path.");
  const canonicalRoot = await fs.realpath(root);
  const segments = relativePath.split("/");
  let current = canonicalRoot;

  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Workspace paths cannot traverse symbolic links.");
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error("Workspace path parent is not a directory.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      current = path.join(current, ...segments.slice(index + 1));
      break;
    }
  }

  const relative = path.relative(canonicalRoot, current);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Workspace path escaped root.");
  }
  return current;
}
