import fs from "fs/promises";
import path from "path";
import { config } from "../config/env.js";

const SKIP = new Set([".git","node_modules",".next","dist","build","coverage",".cache",".agent-runs","vendor","target"]);
const INSTRUCTION_FILES = ["AGENTS.md","CLAUDE.md","GEMINI.md",".github/copilot-instructions.md"];
const SENSITIVE_PATH = /(^|\/)(\.env(?!\.(example|sample|template)$)[^/]*|\.npmrc|\.pypirc|\.netrc|credentials?\.json|secrets?\.(json|ya?ml)|id_rsa|id_ed25519)(\/|$)|\.(pem|key|p12|pfx)$/i;
const CONTEXT_FILES = ["README.md","package.json","pnpm-workspace.yaml","pyproject.toml","requirements.txt","pytest.ini","Cargo.toml","go.mod","pom.xml","build.gradle","Makefile"];
const SOURCE_EXT = new Set([".js",".jsx",".ts",".tsx",".mjs",".cjs",".py",".go",".rs",".java",".kt",".vue",".svelte"]);
const IMPORT_RE = /(?:from\s*|import\s*|require\s*\(|import\s*\()\s*["']([^"']+)["']/g;

function words(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9_./-]{2,}/g) || []);
}
function estimateTokens(value) {
  // Conservative fallback only; model-specific tokenizers can replace this.
  return Math.ceil(String(value || "").length / 3.5);
}
async function safeRead(root, relative, maxBytes = 24000) {
  try {
    const absoluteRoot = await fs.realpath(root);
    const target = path.resolve(absoluteRoot, relative);
    const rel = path.relative(absoluteRoot, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return "";
    let current = absoluteRoot;
    const segments = rel.split(path.sep).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return "";
      if (i < segments.length - 1 && !stat.isDirectory()) return "";
      if (i === segments.length - 1 && (!stat.isFile() || stat.size > maxBytes)) return "";
    }
    return await fs.readFile(target, "utf8");
  } catch { return ""; }
}
function resolveImport(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [base, ...[".js",".jsx",".ts",".tsx",".mjs",".cjs",".py",".go",".rs",".json"].map(ext => base + ext),
    ...["index.js","index.ts","index.tsx","__init__.py"].map(file => base + "/" + file)];
  return candidates.find(candidate => knownFiles.has(candidate)) || null;
}

export async function buildRepositoryContext(root, prompt, options = {}) {
  const files = [];
  const fileSet = new Set();
  let visited = 0;
  async function walk(dir, prefix = "") {
    if (visited >= 5000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= 5000) return;
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (relative.split("/").some(part => SKIP.has(part)) || SENSITIVE_PATH.test(relative)) continue;
      visited++;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) { files.push(relative); fileSet.add(relative); }
    }
  }
  await walk(root);

  const promptWords = words(prompt);
  const ranked = files.filter(name => SOURCE_EXT.has(path.extname(name).toLowerCase()) || CONTEXT_FILES.includes(name))
    .map(name => {
      const tokens = words(name);
      let score = 0;
      for (const token of promptWords) if (tokens.has(token)) score += 5;
      if (/test|spec/i.test(name) && /test|bug|fix|verify|regression/i.test(prompt)) score += 4;
      if (/route|controller|service|model|schema|config|auth|api|store|db/i.test(name)) score += 2;
      if (CONTEXT_FILES.includes(name)) score += 3;
      return { name, score };
    }).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));

  const instructions = [];
  for (const file of INSTRUCTION_FILES) {
    const content = await safeRead(root, file, 16000);
    if (content) instructions.push({ path: file, content });
  }

  const selected = new Set(CONTEXT_FILES.filter(file => fileSet.has(file)));
  const primary = ranked.slice(0, Math.max(16, Math.min(36, options.maxPrimaryFiles || 24)));
  for (const item of primary) selected.add(item.name);

  // Expand one hop through relative imports from selected source files. This
  // catches actual dependencies/call sites that filename-only ranking misses.
  const importEdges = [];
  for (const name of Array.from(selected)) {
    if (!SOURCE_EXT.has(path.extname(name).toLowerCase())) continue;
    const content = await safeRead(root, name, 24000);
    if (!content) continue;
    IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      const target = resolveImport(name, match[1], fileSet);
      if (target && !SENSITIVE_PATH.test(target)) {
        importEdges.push({ from: name, to: target });
        if (selected.size < 60) selected.add(target);
      }
    }
  }

  const samples = [];
  const maxFileChars = options.maxFileChars || 24000;
  for (const file of selected) {
    if (SENSITIVE_PATH.test(file)) continue;
    const content = await safeRead(root, file, maxFileChars);
    if (content) samples.push({ path: file, content });
  }
  const packageJson = samples.find(item => item.path === "package.json");
  let scripts = {};
  if (packageJson) {
    try { scripts = JSON.parse(packageJson.content).scripts || {}; } catch {}
  }
  return {
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    filePaths: files,
    truncated: visited >= 5000,
    directoryMap: files.slice(0, 500).join("\n"),
    instructions,
    samples,
    retrievedFiles: ranked.slice(0, 40),
    importEdges,
    scripts,
    promptKeywords: Array.from(promptWords).slice(0, 100),
  };
}

export function formatRepositoryContext(context, options = {}) {
  const budget = Math.max(2048, Number(options.maxTokens || config.llmContextBudgetTokens || 24000));
  const maxChars = Math.floor(budget * 3.5);
  // Instructions and task-relevant files outrank a verbose directory listing.
  let output = "";
  for (const item of context.instructions || []) {
    const section = "## Project instructions: " + item.path + "\n" + item.content + "\n\n";
    if (output.length + section.length > Math.floor(maxChars * 0.2)) break;
    output += section;
  }
  const relationships = (context.importEdges || []).slice(0, 100)
    .map(edge => edge.from + " imports " + edge.to).join("\n");
  const inventory = "## Repository inventory\nFiles discovered: " + context.fileCount +
    (context.truncated ? " (inventory capped)" : "") + "\n" +
    (context.directoryMap || "").slice(0, Math.floor(maxChars * 0.12));
  const graph = relationships ? "\n\n## Relevant dependency relationships\n" + relationships : "";
  output += (output ? "\n\n" : "") + inventory + graph;
  for (const sample of context.samples || []) {
    const section = "\n\n## Source: " + sample.path + "\n" + sample.content;
    if (output.length + section.length > maxChars) continue;
    output += section;
  }
  return output.slice(0,maxChars);
}
