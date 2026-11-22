import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Repository Intelligence Engine for ATH IDE 3.0
 * 
 * Provides:
 * 1. Multi-language AST/regex symbol extraction (TS/JS, Python, Go, Rust).
 * 2. Bi-directional import and dependency graph.
 * 3. Symbol-to-symbol declaration and reference mapping.
 * 4. Incremental cache (hashes & mtimes) to prevent redundant parsing.
 * 5. Task-relevant context ranking combining lexical matching, dependency proximity,
 *    active editor files, and diagnostic error locations.
 */

const SUPPORTED_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py",
  ".go",
  ".rs",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out",
  ".cache", "__pycache__", "target", ".venv", "venv", "coverage"
]);

export class RepoIntelligenceEngine {
  constructor({ maxFiles = 2500 } = {}) {
    this.maxFiles = maxFiles;
    // Map<filePath, { hash, mtime, symbols: [], imports: [], exports: [] }>
    this.files = new Map();
    // Map<symbolName, Set<filePath>>
    this.symbolIndex = new Map();
    // Map<filePath, Set<filePath>> (file -> files it imports)
    this.dependencies = new Map();
    // Map<filePath, Set<filePath>> (file -> files that import it)
    this.reverseDependencies = new Map();
    this.workspaceRoot = null;
    this.lastIndexedAt = null;
  }

  /**
   * Compute a fast SHA-256 digest of content.
   */
  hashContent(content) {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  /**
   * Extract symbols and imports from code across JS/TS, Python, Go, and Rust.
   */
  extractSymbolsAndImports(code, ext) {
    const symbols = [];
    const imports = [];
    const exportsList = [];
    const lines = code.split("\n");

    if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
      // JS / TS extraction
      const importRegex = /import\s+(?:(?:\*\s+as\s+\w+)|(?:\{\s*[\w\s,]+\s*\})|(?:\w+))\s+from\s+['"]([^'"]+)['"]/g;
      const requireRegex = /(?:const|let|var)\s+(?:\{[\w\s,]+\}|\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/g;
      const funcRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/;
      const classRegex = /^(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/;
      const interfaceRegex = /^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/;
      const typeRegex = /^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/;
      const constExportRegex = /^export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        let m;
        if ((m = funcRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "function", line: i + 1 });
          if (line.startsWith("export")) exportsList.push(m[1]);
        } else if ((m = classRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "class", line: i + 1 });
          if (line.startsWith("export")) exportsList.push(m[1]);
        } else if ((m = interfaceRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "interface", line: i + 1 });
          if (line.startsWith("export")) exportsList.push(m[1]);
        } else if ((m = typeRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "type", line: i + 1 });
          if (line.startsWith("export")) exportsList.push(m[1]);
        } else if ((m = constExportRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "constant", line: i + 1 });
          exportsList.push(m[1]);
        }
      }

      let match;
      while ((match = importRegex.exec(code)) !== null) imports.push(match[1]);
      while ((match = requireRegex.exec(code)) !== null) imports.push(match[1]);

    } else if (ext === ".py") {
      // Python extraction
      const funcRegex = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/;
      const classRegex = /^class\s+([a-zA-Z0-9_]+)\s*[:\(]/;
      const importRegex = /^import\s+([a-zA-Z0-9_.,\s]+)/;
      const fromImportRegex = /^from\s+([a-zA-Z0-9_.]+)\s+import/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        let m;
        if ((m = funcRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "function", line: i + 1 });
          if (!m[1].startsWith("_")) exportsList.push(m[1]);
        } else if ((m = classRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "class", line: i + 1 });
          if (!m[1].startsWith("_")) exportsList.push(m[1]);
        } else if ((m = fromImportRegex.exec(line))) {
          imports.push(m[1]);
        } else if ((m = importRegex.exec(line))) {
          const pkgs = m[1].split(",").map(p => p.trim().split(" ")[0]);
          imports.push(...pkgs);
        }
      }

    } else if (ext === ".go") {
      // Go extraction
      const funcRegex = /^func\s+(?:\([^\)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(/;
      const typeRegex = /^type\s+([a-zA-Z0-9_]+)\s+(?:struct|interface)/;
      const importRegex = /import\s+['"]([^'"]+)['"]/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        let m;
        if ((m = funcRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "function", line: i + 1 });
          if (/^[A-Z]/.test(m[1])) exportsList.push(m[1]);
        } else if ((m = typeRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "type", line: i + 1 });
          if (/^[A-Z]/.test(m[1])) exportsList.push(m[1]);
        } else if ((m = importRegex.exec(line))) {
          imports.push(m[1]);
        }
      }

    } else if (ext === ".rs") {
      // Rust extraction
      const fnRegex = /^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/;
      const structRegex = /^(?:pub\s+)?struct\s+([a-zA-Z0-9_]+)/;
      const enumRegex = /^(?:pub\s+)?enum\s+([a-zA-Z0-9_]+)/;
      const traitRegex = /^(?:pub\s+)?trait\s+([a-zA-Z0-9_]+)/;
      const useRegex = /^use\s+([^;]+);/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        let m;
        if ((m = fnRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "function", line: i + 1 });
          if (line.startsWith("pub")) exportsList.push(m[1]);
        } else if ((m = structRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "struct", line: i + 1 });
          if (line.startsWith("pub")) exportsList.push(m[1]);
        } else if ((m = enumRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "enum", line: i + 1 });
          if (line.startsWith("pub")) exportsList.push(m[1]);
        } else if ((m = traitRegex.exec(line))) {
          symbols.push({ name: m[1], kind: "trait", line: i + 1 });
          if (line.startsWith("pub")) exportsList.push(m[1]);
        } else if ((m = useRegex.exec(line))) {
          imports.push(m[1].split("::")[0].trim());
        }
      }
    }

    return { symbols, imports: Array.from(new Set(imports)), exports: Array.from(new Set(exportsList)) };
  }

  /**
   * Resolve an import specifier to a relative file path in the workspace.
   */
  resolveImportPath(sourceFile, specifier) {
    if (!specifier.startsWith(".")) return null;
    const dir = path.dirname(sourceFile);
    const resolvedBase = path.normalize(path.join(dir, specifier)).replace(/\\/g, "/");

    const candidates = [
      resolvedBase,
      `${resolvedBase}.js`,
      `${resolvedBase}.ts`,
      `${resolvedBase}.tsx`,
      `${resolvedBase}.jsx`,
      `${resolvedBase}/index.js`,
      `${resolvedBase}/index.ts`,
    ];

    for (const c of candidates) {
      if (this.files.has(c)) return c;
    }
    return null;
  }

  /**
   * Scan directory recursively to discover candidate source files.
   */
  async scanDirectory(dir, relPath = "") {
    const results = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const subRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const sub = await this.scanDirectory(fullPath, subRel);
        results.push(...sub);
        if (results.length >= this.maxFiles) break;
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push({ relPath: subRel.replace(/\\/g, "/"), fullPath, ext });
        }
      }
    }
    return results;
  }

  /**
   * Index or incrementally update the workspace repository graph.
   */
  async indexWorkspace(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    const discovered = await this.scanDirectory(workspaceRoot);
    const discoveredSet = new Set(discovered.map(d => d.relPath));

    // Remove deleted files from internal indexes
    for (const existingPath of this.files.keys()) {
      if (!discoveredSet.has(existingPath)) {
        this.removeFileFromIndex(existingPath);
      }
    }

    // Process new or changed files
    for (const file of discovered) {
      try {
        const stat = await fs.stat(file.fullPath);
        const existing = this.files.get(file.relPath);

        // Incremental check: if mtime and size match, skip parsing
        if (existing && existing.mtime === stat.mtimeMs) {
          continue;
        }

        const content = await fs.readFile(file.fullPath, "utf8");
        const hash = this.hashContent(content);

        if (existing && existing.hash === hash) {
          existing.mtime = stat.mtimeMs;
          continue;
        }

        // Parse symbols and imports
        const { symbols, imports, exports: exportsList } = this.extractSymbolsAndImports(content, file.ext);

        // Update indices
        this.updateFileInIndex(file.relPath, {
          hash,
          mtime: stat.mtimeMs,
          symbols,
          imports,
          exports: exportsList,
          size: content.length,
        });

      } catch (err) {
        // Skip unreadable files gracefully
      }
    }

    // Rebuild dependency graphs
    this.rebuildDependencyGraph();
    this.lastIndexedAt = Date.now();

    return {
      totalFiles: this.files.size,
      totalSymbols: Array.from(this.symbolIndex.keys()).length,
      indexedAt: this.lastIndexedAt,
    };
  }

  updateFileInIndex(relPath, data) {
    this.removeFileFromIndex(relPath);
    this.files.set(relPath, data);

    for (const sym of data.symbols) {
      if (!this.symbolIndex.has(sym.name)) {
        this.symbolIndex.set(sym.name, new Set());
      }
      this.symbolIndex.get(sym.name).add(relPath);
    }
  }

  removeFileFromIndex(relPath) {
    const existing = this.files.get(relPath);
    if (!existing) return;

    for (const sym of existing.symbols) {
      const set = this.symbolIndex.get(sym.name);
      if (set) {
        set.delete(relPath);
        if (set.size === 0) this.symbolIndex.delete(sym.name);
      }
    }

    this.files.delete(relPath);
    this.dependencies.delete(relPath);
    this.reverseDependencies.delete(relPath);
  }

  rebuildDependencyGraph() {
    this.dependencies.clear();
    this.reverseDependencies.clear();

    for (const [sourcePath, data] of this.files.entries()) {
      const deps = new Set();
      for (const rawImport of data.imports) {
        const resolved = this.resolveImportPath(sourcePath, rawImport);
        if (resolved) deps.add(resolved);
      }
      this.dependencies.set(sourcePath, deps);

      for (const target of deps) {
        if (!this.reverseDependencies.has(target)) {
          this.reverseDependencies.set(target, new Set());
        }
        this.reverseDependencies.get(target).add(sourcePath);
      }
    }
  }

  /**
   * Search symbols across the repository.
   */
  findSymbols(query, { limit = 20 } = {}) {
    const qLower = query.toLowerCase();
    const results = [];

    for (const [name, fileSet] of this.symbolIndex.entries()) {
      if (name.toLowerCase().includes(qLower)) {
        for (const file of fileSet) {
          const fileData = this.files.get(file);
          const sym = fileData?.symbols.find(s => s.name === name);
          results.push({
            name,
            file,
            kind: sym?.kind || "symbol",
            line: sym?.line || 1,
            exact: name.toLowerCase() === qLower,
          });
          if (results.length >= limit) break;
        }
      }
      if (results.length >= limit) break;
    }

    return results.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
  }

  /**
   * Query task-relevant context combining lexical search, dependency proximity,
   * open editor tabs, and error locations.
   */
  queryRelevantContext({ task = "", openFiles = [], errorFiles = [], maxFiles = 8 } = {}) {
    const scores = new Map();
    const taskWords = (task.match(/[a-zA-Z0-9_]{3,}/g) || []).map(w => w.toLowerCase());

    const addScore = (file, amount) => {
      scores.set(file, (scores.get(file) || 0) + amount);
    };

    // 1. Files in active error traces receive highest priority
    for (const f of errorFiles) {
      if (this.files.has(f)) addScore(f, 50);
    }

    // 2. Open editor files receive high baseline relevance
    for (const f of openFiles) {
      if (this.files.has(f)) addScore(f, 30);
    }

    // 3. Lexical matching against paths and symbols
    for (const [file, data] of this.files.entries()) {
      const fLower = file.toLowerCase();
      for (const word of taskWords) {
        if (fLower.includes(word)) addScore(file, 10);
      }

      for (const sym of data.symbols) {
        const sLower = sym.name.toLowerCase();
        for (const word of taskWords) {
          if (sLower === word) addScore(file, 25);
          else if (sLower.includes(word)) addScore(file, 8);
        }
      }
    }

    // 4. Dependency graph proximity: boost direct imports and reverse imports of top files
    const seedFiles = Array.from(scores.entries())
      .filter(([_, score]) => score > 15)
      .map(([f]) => f);

    for (const seed of seedFiles) {
      const directDeps = this.dependencies.get(seed) || new Set();
      for (const dep of directDeps) addScore(dep, 12);

      const importedBy = this.reverseDependencies.get(seed) || new Set();
      for (const parent of importedBy) addScore(parent, 10);
    }

    // Rank files
    const ranked = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFiles);

    return ranked.map(([filePath, score]) => {
      const data = this.files.get(filePath);
      return {
        path: filePath,
        score,
        symbols: (data?.symbols || []).slice(0, 15),
        exports: data?.exports || [],
        importsCount: (this.dependencies.get(filePath) || new Set()).size,
        referencedByCount: (this.reverseDependencies.get(filePath) || new Set()).size,
      };
    });
  }

  /**
   * Format a high-signal repository map skeleton suitable for LLM injection (~800-1500 tokens).
   */
  formatRepoMap(rankedContext) {
    if (!rankedContext || !rankedContext.length) return "";
    const lines = ["### Structural Repository Map (Indexed AST Graph)"];
    for (const item of rankedContext) {
      const symSummary = item.symbols.map(s => `${s.kind} ${s.name}`).slice(0, 10).join(", ");
      lines.push(`- **${item.path}** (rank: ${Math.round(item.score)})`);
      if (symSummary) lines.push(`  Symbols: ${symSummary}`);
      if (item.exports?.length) lines.push(`  Exports: ${item.exports.slice(0, 8).join(", ")}`);
    }
    return lines.join("\n");
  }
}

// Singleton instance for the active IDE runtime
export const repoIntelligence = new RepoIntelligenceEngine();
