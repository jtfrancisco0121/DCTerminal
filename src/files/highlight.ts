/**
 * Syntax highlighting for the file preview. Only a small set of languages is
 * registered so the bundle stays small. highlight.js escapes the source, so
 * the returned HTML is safe to set as innerHTML.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  patch: "diff",
  go: "go",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  markdown: "markdown",
  php: "php",
  ps1: "powershell",
  psm1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sql: "sql",
  swift: "swift",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  yaml: "yaml",
};

const BY_NAME: Record<string, keyof typeof LANGUAGES> = {
  dockerfile: "bash",
  makefile: "bash",
  ".gitignore": "bash",
  ".env": "bash",
};

/** Highlight past this size costs more than it helps. */
export const HIGHLIGHT_LIMIT = 200_000;

export function languageFor(path: string): string | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && !name.startsWith(".")) return null;
  const ext = name.slice(dot + 1);
  return BY_EXTENSION[ext] ?? null;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function highlightCode(text: string, path: string): { html: string; language: string | null } {
  const language = languageFor(path);
  if (!language || text.length > HIGHLIGHT_LIMIT) {
    return { html: escapeHtml(text), language: null };
  }
  try {
    return { html: hljs.highlight(text, { language, ignoreIllegals: true }).value, language };
  } catch {
    return { html: escapeHtml(text), language: null };
  }
}
