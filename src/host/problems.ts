// VS Code's diagnostics for "Fix with OpenCode": the quick fix offered on errors and
// warnings, and collecting a range's, a file's or the open folder's problems.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  diagnosticCode,
  EXCERPT_CONTEXT,
  excerptAround,
  workspaceRelative,
  type FoundProblem,
} from "../core/problems";
import type { ProblemFile } from "../shared/model";
import { classifyPath } from "../core/sensitive";

export const FIX_COMMAND = "opencodeSidecar.fixWithOpenCode";

const fixable = (d: vscode.Diagnostic) =>
  d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning;

/** "Fix with OpenCode" in the light bulb (and the Problems view's quick fixes) on errors and warnings. */
export class FixWithOpenCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const diags = context.diagnostics.filter(fixable);
    if (!diags.length) return [];
    const range = diags.map((d) => d.range).reduce((a, b) => a.union(b));
    const action = new vscode.CodeAction("Fix with OpenCode", vscode.CodeActionKind.QuickFix);
    action.diagnostics = diags;
    action.command = {
      command: FIX_COMMAND,
      title: "Fix with OpenCode",
      arguments: [document.uri, range],
    };
    return [action];
  }
}

/** A document's lines: the open editor's text (diagnostics describe it), else the file on disk. */
function linesOf(uri: vscode.Uri): string[] {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText().split(/\r?\n/);
  if (uri.scheme !== "file") return [];
  try {
    const st = fs.statSync(uri.fsPath);
    // Excerpts only: a huge file is not read for a few lines.
    if (!st.isFile() || st.size > 5 * 1024 * 1024) return [];
    return fs.readFileSync(uri.fsPath, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function languageOf(uri: vscode.Uri): string {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.languageId ?? "";
}

function toProblems(uri: vscode.Uri, diags: readonly vscode.Diagnostic[], relPath: string): FoundProblem[] {
  const absPath = uri.scheme === "file" ? uri.fsPath : uri.toString();
  const languageId = languageOf(uri);
  return diags.filter(fixable).map((d) => {
    const line = d.range.start.line + 1;
    // A range ending at column 0 of the next line does not include that line.
    const endLine =
      d.range.end.character === 0 && d.range.end.line > d.range.start.line
        ? d.range.end.line
        : d.range.end.line + 1;
    const p: FoundProblem = {
      absPath,
      relPath,
      languageId,
      severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
      message: d.message,
      line,
      column: d.range.start.character + 1,
      endLine,
    };
    if (d.source) p.source = d.source;
    const code = diagnosticCode(d.code);
    if (code) p.code = code;
    return p;
  });
}

/**
 * Adds the code around each problem, reading only the files that made the list.
 * `context` lines on each side: fewer for a workspace-wide list.
 */
export function addExcerpts(files: readonly ProblemFile[], context = EXCERPT_CONTEXT): void {
  for (const f of files) {
    // Files have a path; other documents (untitled) keep their URI.
    const uri = path.isAbsolute(f.absPath) ? vscode.Uri.file(f.absPath) : vscode.Uri.parse(f.absPath);
    const lines = linesOf(uri);
    for (const p of f.problems) {
      const excerpt = excerptAround(lines, p.line, p.endLine, context);
      if (excerpt) p.excerpt = excerpt;
    }
  }
}

/**
 * The errors and warnings of one document, or those touching `range`. `relPath` is how
 * the prompt names the file (relative to the open folder, or its path outside it).
 */
export function documentProblems(uri: vscode.Uri, relPath: string, range?: vscode.Range): FoundProblem[] {
  const diags = vscode.languages
    .getDiagnostics(uri)
    .filter((d) => !range || d.range.intersection(range) !== undefined || range.contains(d.range));
  return toProblems(uri, diags, relPath);
}

/**
 * Every error and warning in files inside `root`. Files that look sensitive (.env, keys)
 * are left out rather than sent.
 */
export function workspaceProblems(root: string): { problems: FoundProblem[]; skipped: number } {
  const problems: FoundProblem[] = [];
  let skipped = 0;
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !diags.some(fixable)) continue;
    const rel = workspaceRelative(root, uri.fsPath);
    if (!rel) continue;
    if (classifyPath(rel)) {
      skipped++;
      continue;
    }
    problems.push(...toProblems(uri, diags, rel));
  }
  return { problems, skipped };
}
