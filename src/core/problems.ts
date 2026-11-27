// Turns VS Code's diagnostics (the Problems view) into a context attachment: the
// errors and warnings grouped by file, each with its place, source and code, and a
// few lines of code around it, so the agent can fix them without opening every file.

import * as path from "node:path";
import type { ContextAttachment, ProblemFile, ProblemItem } from "../shared/model";
import { fenceFor } from "./context";

/** The most problems one attachment lists ("Fix all problems in the workspace"). */
export const MAX_PROBLEMS = 50;
/** Lines of code shown on each side of a problem. */
export const EXCERPT_CONTEXT = 2;
const MAX_EXCERPT_LINES = 12;
const MAX_LINE_CHARS = 240;
const MAX_MESSAGE_CHARS = 2000;

export type ProblemsAttachment = Extract<ContextAttachment, { kind: "problems" }>;

/** A problem with its file, as the host collects it. */
export interface FoundProblem extends ProblemItem {
  absPath: string;
  relPath: string;
  languageId: string;
}

/**
 * `abs` relative to `root` with `/` separators, or null outside it. Windows paths are
 * compared without regard to case (VS Code reports `c:\`, OpenCode and Git `C:\`).
 */
export function workspaceRelative(root: string, abs: string): string | null {
  const p = /^[a-zA-Z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const rel = p.relative(root, abs);
  if (!rel || rel.startsWith("..") || p.isAbsolute(rel)) return null;
  return rel.split(p.sep).join("/");
}

/** A diagnostic's code as text: VS Code allows a string, a number or `{ value, target }`. */
export function diagnosticCode(code: unknown): string | undefined {
  if (typeof code === "string" || typeof code === "number") return String(code) || undefined;
  if (code && typeof code === "object" && "value" in code) return diagnosticCode(code.value);
  return undefined;
}

/** The lines around a problem (1-based `line`..`endLine`), with long lines cut. */
export function excerptAround(
  doc: readonly string[],
  line: number,
  endLine: number,
  context = EXCERPT_CONTEXT,
): { start: number; lines: string[] } | undefined {
  if (!doc.length || line < 1 || line > doc.length) return undefined;
  const start = Math.max(1, line - context);
  const end = Math.min(doc.length, Math.max(line, endLine) + context, start + MAX_EXCERPT_LINES - 1);
  const lines = doc
    .slice(start - 1, end)
    .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "…" : l));
  return { start, lines };
}

/**
 * Groups problems by file, errors first when there are more than `cap`: the files in
 * path order, each file's problems by line. `total` counts the ones left out too.
 */
export function groupProblems(
  found: readonly FoundProblem[],
  cap = MAX_PROBLEMS,
): { files: ProblemFile[]; total: number } {
  const byPlace = (a: FoundProblem, b: FoundProblem) =>
    a.relPath.localeCompare(b.relPath) || a.line - b.line || a.column - b.column;
  const kept = [...found]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || byPlace(a, b))
    .slice(0, Math.max(0, cap))
    .sort(byPlace);
  const files: ProblemFile[] = [];
  for (const p of kept) {
    let f = files.at(-1);
    if (f?.absPath !== p.absPath) {
      f = { relPath: p.relPath, absPath: p.absPath, languageId: p.languageId, problems: [] };
      files.push(f);
    }
    const item: ProblemItem = {
      severity: p.severity,
      message: p.message,
      line: p.line,
      column: p.column,
      endLine: p.endLine,
    };
    if (p.source) item.source = p.source;
    if (p.code) item.code = p.code;
    if (p.excerpt) item.excerpt = p.excerpt;
    f.problems.push(item);
  }
  return { files, total: found.length };
}

export function problemCounts(files: readonly ProblemFile[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const f of files)
    for (const p of f.problems) {
      if (p.severity === "error") errors++;
      else warnings++;
    }
  return { errors, warnings };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 errors, 1 warning in 2 files": what an attachment lists. */
export function problemsSummary(a: Pick<ProblemsAttachment, "files">): string {
  const { errors, warnings } = problemCounts(a.files);
  const kinds = [errors ? plural(errors, "error") : "", warnings ? plural(warnings, "warning") : ""]
    .filter(Boolean)
    .join(", ");
  const where = a.files.length === 1 ? a.files[0].relPath : plural(a.files.length, "file");
  return `${kinds || "no problems"} in ${where}`;
}

function sourceAndCode(p: ProblemItem): string {
  if (p.source && p.code) return `${p.source}(${p.code})`;
  return p.source ?? p.code ?? "";
}

function formatItem(p: ProblemItem): string {
  const where = p.endLine > p.line ? `lines ${p.line}-${p.endLine}` : `line ${p.line}:${p.column}`;
  const tag = sourceAndCode(p);
  let message = p.message.trim();
  if (message.length > MAX_MESSAGE_CHARS) message = message.slice(0, MAX_MESSAGE_CHARS) + "…";
  // A multi-line message (TypeScript's chains) stays under its bullet.
  const head = `- ${where}, ${p.severity}${tag ? ` ${tag}` : ""}: ${message.replace(/\r?\n/g, "\n    ")}`;
  if (!p.excerpt) return head;
  const last = p.excerpt.start + p.excerpt.lines.length - 1;
  const width = String(last).length;
  const code = p.excerpt.lines.map((l, i) => {
    const n = p.excerpt!.start + i;
    const mark = n >= p.line && n <= Math.max(p.line, p.endLine) ? ">" : " ";
    return `  ${mark} ${String(n).padStart(width)} | ${l}`.trimEnd();
  });
  return [head, ...code].join("\n");
}

/**
 * The problems as prompt text: a heading the transcript recognizes (see
 * src/shared/userText.ts), then one fenced block with each file and its problems.
 */
export function formatProblems(a: ProblemsAttachment): string {
  const shown = a.files.reduce((n, f) => n + f.problems.length, 0);
  const blocks = a.files.map((f) => [f.relPath, ...f.problems.map(formatItem)].join("\n"));
  if (a.total > shown) blocks.push(`Only the first ${shown} of ${a.total} problems are listed.`);
  const body = blocks.join("\n\n");
  const fence = fenceFor(body);
  return `Problems from VS Code (${problemsSummary(a)}):\n${fence}text\n${body}\n${fence}`;
}

/** The chip's label and tooltip. */
export function problemsChip(a: ProblemsAttachment): { label: string; detail: string } {
  const shown = a.files.reduce((n, f) => n + f.problems.length, 0);
  // A capped list says so on the chip itself.
  const count = a.total > shown ? `${shown} of ${a.total} problems` : plural(shown, "problem");
  const label =
    a.files.length === 1
      ? `${count} · ${path.posix.basename(a.files[0].relPath.replace(/\\/g, "/"))}`
      : `${count} · ${plural(a.files.length, "file")}`;
  const capped = a.total > shown ? ` (first ${shown} of ${a.total})` : "";
  const names = a.files.slice(0, 8).map((f) => f.relPath);
  if (a.files.length > names.length) names.push(`and ${a.files.length - names.length} more`);
  return { label, detail: `${problemsSummary(a)}${capped}\n${names.join("\n")}` };
}
