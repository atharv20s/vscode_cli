import fs from "fs/promises";
import path from "path";

const SKIP = new Set([".git","node_modules",".next","dist","build","coverage",".cache",".agent-runs"]);
const INSTRUCTION_FILES = ["AGENTS.md","CLAUDE.md","GEMINI.md",".github/copilot-instructions.md"];
const CONTEXT_FILES = [
  "README.md","package.json","pnpm-workspace.yaml","pyproject.toml","requirements.txt",
  "pytest.ini","Cargo.toml","go.mod","pom.xml","build.gradle","Makefile",
];

function words(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9_./-]{2,}/g) || []);
}

async function safeRead(root, relative, maxBytes = 18000) {
  try {
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return "";
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return "";
    return (await fs.readFile(target, "utf8")).slice(0, maxBytes);
  } catch {
    return "";
  }
}

export async function buildRepositoryContext(root, prompt) {
  const files = [];
  const samples = [];
  let visited = 0;

  async function walk(dir, prefix = "") {
    if (visited >= 3000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited >= 3000) return;
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (relative.split("/").some(part => SKIP.has(part))) continue;
      visited++;
      if (entry.isDirectory()) {
        files.push(relative + "/");
        await walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await walk(root);

  const promptWords = words(prompt);
  const ranked = files.filter(name => !name.endsWith("/")).map(name => {
    const tokens = words(name);
    let score = 0;
    for (const token of promptWords) if (tokens.has(token)) score += 4;
    if (/test|spec/i.test(name) && /test|bug|fix|verify/i.test(prompt)) score += 2;
    if (/route|controller|service|model|schema|config/i.test(name)) score += 1;
    return { name, score };
  }).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));

  const selected = new Set(CONTEXT_FILES.filter(name => files.includes(name)));
  for (const item of ranked.slice(0, 18)) selected.add(item.name);

  const instructions = [];
  for (const file of INSTRUCTION_FILES) {
    const content = await safeRead(root, file);
    if (content) instructions.push({ path: file, content });
  }
  const directoryMap = files.slice(0, 260).join("\n");
  for (const file of selected) {
    const content = await safeRead(root, file, 12000);
    if (content) samples.push({ path: file, content });
  }

  const packageJson = samples.find(item => item.path === "package.json");
  let scripts = {};
  if (packageJson) {
    try { scripts = JSON.parse(packageJson.content).scripts || {}; } catch {}
  }

  const retrieved = ranked.filter(item => item.score > 0).slice(0, 24);
  return {
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    filePaths: files.filter(name => !name.endsWith("/")),
    truncated: visited >= 3000,
    directoryMap,
    instructions,
    samples,
    retrievedFiles: retrieved,
    scripts,
    promptKeywords: Array.from(promptWords).slice(0, 80),
  };
}

export function formatRepositoryContext(context) {
  const parts = [
    "## Repository inventory",
    "Tracked workspace entries: " + context.fileCount + (context.truncated ? " (inventory capped)" : ""),
    context.directoryMap,
  ];
  for (const instruction of context.instructions) {
    parts.push("## Project instructions: " + instruction.path + "\n" + instruction.content);
  }
  for (const sample of context.samples) {
    parts.push("## Context file: " + sample.path + "\n" + sample.content);
  }
  return parts.join("\n\n").slice(0, 48000);
}
