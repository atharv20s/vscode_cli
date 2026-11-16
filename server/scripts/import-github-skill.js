#!/usr/bin/env node
/**
 * Import one Agent Skills-compatible SKILL.md from GitHub.
 * Usage: npm run skills:import -- owner/repo path/to/skill [ref] [--force]
 * Downloads Markdown only; imported content is never executed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/skills");
const MAX_BYTES = 32 * 1024;

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("SKILL.md must include Agent Skills YAML frontmatter.");
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(name|description):\s*(.*?)\s*$/);
    if (field) fields[field[1]] = field[2].replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name || "") || fields.name.length > 64) throw new Error("Frontmatter name must be a lowercase hyphenated skill ID (max 64 characters).");
  if (!fields.description || fields.description.length > 1024) throw new Error("Frontmatter description is required and must be at most 1024 characters.");
  return fields;
}

async function main() {
  const [repository, skillPath, refArg, ...flags] = process.argv.slice(2);
  if (!repository || !skillPath || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Usage: npm run skills:import -- owner/repo path/to/skill [ref] [--force]");
  const [owner, repo] = repository.split("/");
  const segments = skillPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length || segments.some(part => part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("Skill path contains an invalid path segment.");
  const filePath = segments.at(-1) === "SKILL.md" ? segments : [...segments, "SKILL.md"];
  const ref = refArg && !refArg.startsWith("--") ? refArg : "main";
  const force = flags.includes("--force") || refArg === "--force";
  const encodedPath = filePath.map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`);
  url.searchParams.set("ref", ref);
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ATH-IDE-Skill-Importer" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${repository}/${filePath.join("/")}`);
  const remote = await response.json();
  if (remote.type !== "file" || remote.encoding !== "base64" || typeof remote.content !== "string") throw new Error("GitHub path must resolve to a regular text file.");
  if (Number(remote.size) > MAX_BYTES) throw new Error("SKILL.md exceeds the 32 KiB import limit.");
  const content = Buffer.from(remote.content.replace(/\n/g, ""), "base64").toString("utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new Error("Decoded SKILL.md exceeds the 32 KiB import limit.");
  const metadata = parseFrontmatter(content);
  const targetDir = path.resolve(ROOT, metadata.name);
  const relative = path.relative(ROOT, targetDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Resolved skill directory is outside the skill root.");
  const targetFile = path.join(targetDir, "SKILL.md");
  try {
    await fs.access(targetFile);
    if (!force) throw new Error(`Skill '${metadata.name}' already exists. Pass --force to replace it.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(targetDir, { recursive: true });
  const rootReal = await fs.realpath(ROOT);
  const dirStat = await fs.lstat(targetDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("Skill destination must be a regular directory, not a symlink.");
  const targetDirReal = await fs.realpath(targetDir);
  const realRelative = path.relative(rootReal, targetDirReal);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("Skill destination resolves outside the skill root.");
  try {
    const fileStat = await fs.lstat(targetFile);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("Skill destination file must be a regular file, not a symlink.");
    if (!force) throw new Error(`Skill '${metadata.name}' already exists. Pass --force to replace it.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.writeFile(targetFile, content.endsWith("\n") ? content : content + "\n", { encoding: "utf8", flag: force ? "w" : "wx" });
  process.stdout.write(`Imported ${metadata.name} from ${repository}@${ref}/${filePath.join("/")}\n`);
  process.stdout.write(`Destination: ${path.relative(path.resolve(ROOT, ".."), targetFile)}\n`);
  process.stdout.write("Review imported instructions before enabling them in production.\n");
}

main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
