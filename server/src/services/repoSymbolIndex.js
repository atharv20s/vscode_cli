import fs from "fs/promises";
import path from "path";

const LANGUAGE_BY_EXTENSION = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "tsx",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
  ".json": "json",
};
const DECLARATIONS = new Set([
  "function_declaration", "function_definition", "function_item", "method_definition",
  "method_declaration", "class_declaration", "class_definition", "interface_declaration",
  "type_alias_declaration", "enum_declaration", "struct_item", "trait_item",
  "type_declaration", "constructor_declaration", "impl_item",
]);
const CALLS = new Set(["call_expression", "call", "method_invocation", "function_call", "macro_invocation"]);
const MAX_FILES = 220;
const MAX_BYTES_PER_FILE = 512 * 1024;

let runtimePromise = null;
const languagePromises = new Map();

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import("web-tree-sitter"),
      import("tree-sitter-wasm"),
    ]).then(async ([runtime, grammars]) => {
      await runtime.Parser.init();
      return { Parser: runtime.Parser, Language: runtime.Language, getWasmPath: grammars.getWasmPath };
    }).catch(error => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function camelWords(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1);
}

function firstIdentifier(node) {
  if (!node) return null;
  if (["identifier", "type_identifier", "property_identifier", "field_identifier"].includes(node.type)) return node;
  for (let index = 0; index < (node.childCount || 0); index++) {
    const found = firstIdentifier(node.child(index));
    if (found) return found;
  }
  return null;
}

function declarationName(node) {
  const named = node.childForFieldName?.("name");
  const target = named || firstIdentifier(node);
  return target?.text?.trim() || "";
}

function callName(node) {
  const target = node.childForFieldName?.("function") || node.child(0);
  const raw = target?.text || node.text || "";
  const parts = raw.match(/[A-Za-z_$][\w$]*/g);
  return parts?.at(-1) || "";
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (let index = 0; index < (node.childCount || 0); index++) walk(node.child(index), visit);
}

async function getLanguage(languageName) {
  if (!languagePromises.has(languageName)) {
    languagePromises.set(languageName, (async () => {
      const runtime = await getRuntime();
      const wasmPath = runtime.getWasmPath(languageName);
      return runtime.Language.load(wasmPath);
    })().catch(error => {
      languagePromises.delete(languageName);
      throw error;
    }));
  }
  return languagePromises.get(languageName);
}

export async function buildRepositorySymbolIndex(root, filePaths, prompt = "") {
  const runtime = await getRuntime();
  const parserCache = new Map();
  const declarations = [];
  const references = [];
  const parsedFiles = [];
  const promptTerms = new Set(camelWords(prompt));
  let parseErrors = 0;

  const candidates = filePaths
    .filter(file => LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()])
    .slice(0, MAX_FILES);

  for (const relative of candidates) {
    const languageName = LANGUAGE_BY_EXTENSION[path.extname(relative).toLowerCase()];
    let source;
    try {
      const absolute = path.resolve(root, relative);
      const realRoot = await fs.realpath(root);
      const realFile = await fs.realpath(absolute);
      const rel = path.relative(realRoot, realFile);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const stat = await fs.stat(realFile);
      if (!stat.isFile() || stat.size > MAX_BYTES_PER_FILE) continue;
      source = await fs.readFile(realFile, "utf8");
    } catch { continue; }

    try {
      let parser = parserCache.get(languageName);
      if (!parser) {
        parser = new runtime.Parser();
        parser.setLanguage(await getLanguage(languageName));
        parserCache.set(languageName, parser);
      }
      const tree = parser.parse(source);
      const foundInFile = [];
      walk(tree.rootNode, node => {
        if (DECLARATIONS.has(node.type)) {
          const name = declarationName(node);
          if (name && name.length <= 120) {
            const item = {
              name,
              path: relative,
              kind: node.type,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
            };
            declarations.push(item);
            foundInFile.push(item);
          }
        } else if (CALLS.has(node.type)) {
          const name = callName(node);
          if (name && name.length <= 120) {
            references.push({
              name,
              path: relative,
              line: node.startPosition.row + 1,
              kind: node.type,
            });
          }
        }
      });
      parsedFiles.push({ path: relative, symbols: foundInFile.length });
      tree.delete?.();
    } catch {
      parseErrors++;
    }
  }

  const declarationScores = declarations.map(item => {
    const terms = camelWords(item.name);
    const overlap = terms.filter(term => promptTerms.has(term)).length;
    const directMention = String(prompt).toLowerCase().includes(item.name.toLowerCase());
    return { ...item, score: overlap * 3 + (directMention ? 8 : 0) };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);

  const matchedNames = new Set(declarationScores.slice(0, 30).map(item => item.name.toLowerCase()));
  const matchedReferences = references.filter(item => matchedNames.has(item.name.toLowerCase())).slice(0, 80);

  for (const parser of parserCache.values()) parser.delete?.();

  return {
    available: true,
    parsedFileCount: parsedFiles.length,
    parseErrors,
    declarations: declarationScores.slice(0, 40),
    references: matchedReferences,
    parsedFiles,
  };
}
