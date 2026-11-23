// Syntax colors for diffs, written files and code blocks.
//
// Prism (MIT) is used only as a tokenizer: `Prism.tokenize` returns a token tree, which is
// rendered here with DOM text nodes and class names, never as HTML. The colors are VS Code
// theme variables (see media/main.css, "syntax colors"), so they follow light, dark and
// high-contrast themes. Lines are tokenized one at a time, as a diff shows them; very long
// input is left plain.

import "./prismSetup";
// The main entry is Prism's core with markup, CSS, C-like and JavaScript.
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";

/** File extensions and fence names to Prism grammars. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  css: "css",
  scss: "scss",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  py: "python",
  python: "python",
  go: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  php: "php",
  rb: "ruby",
  ruby: "ruby",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  dockerfile: "docker",
  docker: "docker",
  kt: "kotlin",
  kts: "kotlin",
  kotlin: "kotlin",
  swift: "swift",
  typescript: "typescript",
  javascript: "javascript",
};

/** Lines longer than this, and blocks with more lines, are not colored. */
const MAX_LINE = 2_000;
const MAX_LINES = 1_500;

/** The grammar for a file path or a code fence's language, if Sidecar has one. */
export function grammarFor(pathOrLang: string): Prism.Grammar | null {
  const raw = pathOrLang.trim().toLowerCase();
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const key = base === "dockerfile" ? "dockerfile" : base.includes(".") ? base.split(".").pop()! : base;
  const name = ALIASES[key];
  return (name && Prism.languages[name]) || null;
}

function append(into: Node, token: string | Prism.Token | Array<string | Prism.Token>): void {
  if (typeof token === "string") {
    into.appendChild(document.createTextNode(token));
    return;
  }
  if (Array.isArray(token)) {
    for (const t of token) append(into, t);
    return;
  }
  const span = document.createElement("span");
  // Class names come from Prism's grammar definitions, never from the text.
  const alias = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  span.className = ["tk", ...[token.type, ...alias].map((n) => `tk-${n.replace(/[^\w-]/g, "")}`)].join(" ");
  append(span, token.content as string | Prism.Token | Array<string | Prism.Token>);
  into.appendChild(span);
}

/** One line of code as colored nodes (plain text when there is no grammar or it is too long). */
export function highlightLine(text: string, grammar: Prism.Grammar | null): Node[] {
  if (!grammar || !text || text.length > MAX_LINE) return [document.createTextNode(text)];
  const frag = document.createDocumentFragment();
  append(frag, Prism.tokenize(text, grammar));
  return Array.from(frag.childNodes);
}

/** A whole code block as colored nodes, keeping multi-line constructs (comments, strings) intact. */
export function highlightBlock(text: string, grammar: Prism.Grammar | null): Node[] {
  if (!grammar || text.length > MAX_LINE * 40 || text.split("\n").length > MAX_LINES)
    return [document.createTextNode(text)];
  const frag = document.createDocumentFragment();
  append(frag, Prism.tokenize(text, grammar));
  return Array.from(frag.childNodes);
}
