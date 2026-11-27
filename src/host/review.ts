// Keep / Undo review of the agent's changes in the real editor: CodeLens over each hunk the
// agent wrote (and Keep file / Undo file at the top), decorations on the undecided ones, a
// "Review changes" picker, next / previous hunk, Keep all / Undo all, and staging only the
// kept hunks. Decisions are kept per session in workspace state. The hunk logic is in
// src/core/review.ts.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileSides } from "../core/patch";
import {
  countDecisions,
  fileHunks,
  fromLines,
  eolOf,
  keptPatch,
  placeHunks,
  pruneDecisions,
  putSession,
  readStore,
  toLines,
  undoEdit,
  type Decision,
  type FileHunks,
  type Hunk,
  type Placement,
  type ReviewStore,
} from "../core/review";
import type { FileChange, ReviewCounts, ReviewView } from "../shared/model";
import type { GitAPI } from "./gitApi";
import type { Logger } from "./log";

export const REVIEW_KEY = "opencodeSidecar.review";
/** True while the open session has agent changes left to review (the next / previous keys). */
const ACTIVE_CONTEXT = "opencodeSidecar.reviewActive";

export const REVIEW_COMMANDS = {
  review: "opencodeSidecar.reviewChanges",
  next: "opencodeSidecar.nextAgentChange",
  previous: "opencodeSidecar.previousAgentChange",
  keep: "opencodeSidecar.keepAgentChange",
  undo: "opencodeSidecar.undoAgentChange",
  keepFile: "opencodeSidecar.keepAgentFile",
  undoFile: "opencodeSidecar.undoAgentFile",
  keepAll: "opencodeSidecar.keepAllAgentChanges",
  undoAll: "opencodeSidecar.undoAllAgentChanges",
  stage: "opencodeSidecar.stageKeptChanges",
  /** The "You edited this since — compare" CodeLens (hidden from the palette). */
  diff: "opencodeSidecar.openAgentChangeDiff",
} as const;

/** The CodeLens over an agent change edited since, in place of Undo. */
export const EDITED_SINCE = "You edited this since — compare";

/** What the review needs from the session (implemented by the chat view's controller). */
export interface ReviewSource {
  /** The open session's agent changes; null when there is no session or they are unavailable. */
  session(): { id: string; files: FileChange[]; version: number } | null;
  sides(file: string): FileSides | null;
  patch(file: string): string;
  /** Absolute path inside the session's folder, or null (outside it: not reviewed). */
  resolve(file: string): string | null;
  git(): GitAPI | undefined;
  /** The review changed: push the view state. */
  changed(): void;
  /** Opens the agent-only diff of one file, or of every file. */
  openDiff(file?: string): Promise<void>;
}

interface Entry {
  file: string;
  uri: vscode.Uri;
  status: FileChange["status"];
  hunks: FileHunks;
  sides: FileSides | null;
  /** Where each hunk sits in the document, as last checked (by hunk id). */
  placements: Map<string, Placement>;
}

type Located = { entry: Entry; hunk: Hunk; at: { start: number; end: number } };

export class AgentReview implements vscode.Disposable, vscode.CodeLensProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private sessionId: string | null = null;
  private version = -1;
  private entries: Entry[] = [];
  private byUri = new Map<string, Entry>();
  private store: ReviewStore;
  private docTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.addedBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.deletedBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    after: { color: new vscode.ThemeColor("descriptionForeground"), margin: "0 0 0 2em" },
  });
  private readonly changedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "dashed",
    borderColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.warningForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(
    private readonly state: vscode.Memento,
    private readonly source: ReviewSource,
    private readonly log: Logger,
  ) {
    this.store = readStore(state.get(REVIEW_KEY));
    const c = REVIEW_COMMANDS;
    this.disposables.push(
      this.lensEmitter,
      this.added,
      this.removed,
      this.changedType,
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.byUri.has(e.document.uri.toString())) this.scheduleDocs();
      }),
      vscode.workspace.onDidOpenTextDocument((d) => {
        if (this.byUri.has(d.uri.toString())) this.scheduleDocs();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.commands.registerCommand(c.review, () => this.showReview()),
      vscode.commands.registerCommand(c.next, () => this.go(1)),
      vscode.commands.registerCommand(c.previous, () => this.go(-1)),
      vscode.commands.registerCommand(c.keep, (uri?: vscode.Uri, id?: string) => this.keep(uri, id)),
      vscode.commands.registerCommand(c.undo, (uri?: vscode.Uri, id?: string) => this.undo(uri, id)),
      vscode.commands.registerCommand(c.keepFile, (uri?: vscode.Uri) => this.keepFile(uri)),
      vscode.commands.registerCommand(c.undoFile, (uri?: vscode.Uri) => this.undoFile(uri)),
      vscode.commands.registerCommand(c.keepAll, () => this.keepAll()),
      vscode.commands.registerCommand(c.undoAll, () => this.undoAll()),
      vscode.commands.registerCommand(c.stage, () => this.stageKept()),
      vscode.commands.registerCommand(c.diff, (file?: string) => this.source.openDiff(file)),
    );
  }

  // ------------------------------------------------------------ session data

  /** Rebuilds the hunks when the open session or its agent changes changed (cheap otherwise). */
  sync(): void {
    const s = this.source.session();
    const id = s?.id ?? null;
    const version = s?.version ?? -1;
    if (id === this.sessionId && version === this.version) return;
    this.sessionId = id;
    this.version = version;
    this.entries = [];
    this.byUri.clear();
    if (s) {
      for (const f of s.files) {
        const abs = this.source.resolve(f.path);
        if (!abs) continue; // outside the folder: not reviewed
        const sides = this.source.sides(f.path);
        const entry: Entry = {
          file: f.path,
          uri: vscode.Uri.file(abs),
          status: f.status,
          hunks: fileHunks(sides, this.source.patch(f.path)),
          sides,
          placements: new Map(),
        };
        this.entries.push(entry);
        this.byUri.set(entry.uri.toString(), entry);
      }
      // Decisions for hunks the agent's changes no longer contain are dropped.
      const present: Record<string, string[]> = {};
      for (const e of this.entries) present[e.file] = ids(e);
      const files = pruneDecisions(this.store[s.id]?.files ?? {}, present);
      if (JSON.stringify(files) !== JSON.stringify(this.store[s.id]?.files ?? {})) this.saveSession(files);
    }
    void this.refreshAll();
  }

  private decisions(file: string): Record<string, Decision> | undefined {
    return this.sessionId ? this.store[this.sessionId]?.files[file] : undefined;
  }

  private setDecisions(changes: Array<{ file: string; id: string; decision: Decision | null }>): void {
    if (!this.sessionId || !changes.length) return;
    const files = structuredClone(this.store[this.sessionId]?.files ?? {});
    for (const c of changes) {
      const d = (files[c.file] ??= {});
      if (c.decision) d[c.id] = c.decision;
      else delete d[c.id];
      if (!Object.keys(d).length) delete files[c.file];
    }
    this.saveSession(files);
  }

  private saveSession(files: ReviewStore[string]["files"]): void {
    if (!this.sessionId) return;
    this.store = putSession(this.store, this.sessionId, files, Date.now());
    void this.state.update(REVIEW_KEY, this.store);
  }

  /** The text of an agent-changed file now: the open document, else the file on disk (null: missing). */
  private async currentText(entry: Entry): Promise<string | null> {
    const doc = this.openDoc(entry.uri);
    if (doc) return doc.getText();
    try {
      return await fs.promises.readFile(entry.uri.fsPath, "utf8");
    } catch {
      return null;
    }
  }

  private openDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  /** Re-places one file's hunks against its text; an undone hunk whose agent lines are back (Ctrl+Z) is undecided again. */
  private place(entry: Entry, text: string | null): void {
    entry.placements.clear();
    if (entry.hunks.kind !== "hunks") return;
    const current = toLines(text ?? "");
    const placed = placeHunks(entry.hunks.after, current, entry.hunks.hunks);
    const reopened: Array<{ file: string; id: string; decision: null }> = [];
    entry.hunks.hunks.forEach((h, i) => {
      entry.placements.set(h.id, placed[i]);
      if (
        entry.status === "modified" &&
        text !== null &&
        placed[i].kind === "ok" &&
        this.decisions(entry.file)?.[h.id] === "undone"
      )
        reopened.push({ file: entry.file, id: h.id, decision: null });
    });
    this.setDecisions(reopened);
  }

  private async refreshAll(): Promise<void> {
    const version = this.version;
    for (const e of this.entries) {
      const text = await this.currentText(e);
      if (version !== this.version) return;
      this.place(e, text);
    }
    this.changedAll();
  }

  private scheduleDocs(): void {
    clearTimeout(this.docTimer);
    this.docTimer = setTimeout(() => {
      for (const e of this.entries) {
        const doc = this.openDoc(e.uri);
        if (doc) this.place(e, doc.getText());
      }
      this.changedAll();
    }, 120);
  }

  private changedAll(): void {
    this.decorate();
    this.lensEmitter.fire();
    const active = this.entries.some((e) => this.counts(e).undecided > 0);
    if (active !== this.active) {
      this.active = active;
      void vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT, active);
    }
    this.source.changed();
  }

  private counts(e: Entry): ReviewCounts {
    const c = countDecisions(ids(e), this.decisions(e.file));
    if (e.hunks.kind === "file") c.fileOnly = true;
    else
      for (const h of e.hunks.hunks)
        if (!this.decisions(e.file)?.[h.id] && e.placements.get(h.id)?.kind === "changed") c.changed++;
    return c;
  }

  /** Counts for the webview's changes strip; null when nothing is reviewable. */
  view(): ReviewView | null {
    if (!this.entries.length) return null;
    const v: ReviewView = { files: {}, undecided: 0, kept: 0, undone: 0 };
    for (const e of this.entries) {
      const c = this.counts(e);
      v.files[e.file] = c;
      v.undecided += c.undecided;
      v.kept += c.kept;
      v.undone += c.undone;
    }
    return v;
  }

  // ------------------------------------------------------------ editor

  private decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const e = this.byUri.get(editor.document.uri.toString());
      const added: vscode.DecorationOptions[] = [];
      const removed: vscode.DecorationOptions[] = [];
      const changed: vscode.DecorationOptions[] = [];
      if (e && e.hunks.kind === "hunks") {
        const last = Math.max(0, editor.document.lineCount - 1);
        for (const h of e.hunks.hunks) {
          if (this.decisions(e.file)?.[h.id]) continue;
          const p = e.placements.get(h.id);
          if (!p) continue;
          if (p.kind === "changed") {
            const line = Math.min(p.near, last);
            changed.push({
              range: new vscode.Range(line, 0, line, 0),
              hoverMessage: "Agent change edited since: open the diff to compare.",
            });
            continue;
          }
          const hover = hoverFor(h);
          if (p.end > p.start)
            added.push({
              range: new vscode.Range(p.start, 0, Math.min(p.end - 1, last), 0),
              hoverMessage: hover,
            });
          if (h.oldLines.length && p.end === p.start) {
            const line = Math.min(p.start, last);
            const n = h.oldLines.length;
            removed.push({
              range: new vscode.Range(line, 0, line, 0),
              hoverMessage: hover,
              renderOptions: {
                after: { contentText: `−${n} line${n === 1 ? "" : "s"} removed by the agent` },
              },
            });
          }
        }
      }
      editor.setDecorations(this.added, added);
      editor.setDecorations(this.removed, removed);
      editor.setDecorations(this.changedType, changed);
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const e = this.byUri.get(doc.uri.toString());
    if (!e) return [];
    const c = this.counts(e);
    if (c.undecided === 0) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lens = (range: vscode.Range, title: string, command: string, args: unknown[], tooltip?: string) =>
      new vscode.CodeLens(range, { title, command, arguments: args, tooltip });
    const out = [
      lens(top, `Agent changes: ${c.undecided} to review`, REVIEW_COMMANDS.review, [], "Review every file"),
      lens(
        top,
        "Keep file",
        REVIEW_COMMANDS.keepFile,
        [doc.uri],
        "Keep the agent's changes left in this file",
      ),
      lens(
        top,
        e.status === "added" ? "Undo file (delete)" : "Undo file",
        REVIEW_COMMANDS.undoFile,
        [doc.uri],
        "Undo the agent's changes left in this file",
      ),
    ];
    if (e.hunks.kind !== "hunks" || e.status !== "modified") return out;
    const last = Math.max(0, doc.lineCount - 1);
    for (const h of e.hunks.hunks) {
      if (this.decisions(e.file)?.[h.id]) continue;
      const p = e.placements.get(h.id);
      if (!p) continue;
      if (p.kind === "changed") {
        const r = new vscode.Range(Math.min(p.near, last), 0, Math.min(p.near, last), 0);
        out.push(
          lens(
            r,
            EDITED_SINCE,
            REVIEW_COMMANDS.diff,
            [e.file],
            "Compare with what the agent wrote. Undo is off for this change, so your edit stays.",
          ),
          lens(r, "Keep", REVIEW_COMMANDS.keep, [doc.uri, h.id], "Mark this agent change reviewed"),
        );
        continue;
      }
      const r = new vscode.Range(Math.min(p.start, last), 0, Math.min(p.start, last), 0);
      out.push(
        lens(r, "Keep", REVIEW_COMMANDS.keep, [doc.uri, h.id], "Keep this agent change"),
        lens(r, "Undo", REVIEW_COMMANDS.undo, [doc.uri, h.id], "Put back what was here before the agent"),
      );
    }
    return out;
  }

  // ------------------------------------------------------------ commands

  private entryFor(uri?: vscode.Uri): Entry | undefined {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    return u ? this.byUri.get(u.toString()) : undefined;
  }

  /** The hunk with this id, or the undecided one at (or nearest after) the cursor. */
  private hunkFor(entry: Entry, id?: string): Hunk | undefined {
    if (entry.hunks.kind !== "hunks") return undefined;
    if (id) return entry.hunks.hunks.find((h) => h.id === id);
    const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const open = entry.hunks.hunks.filter((h) => !this.decisions(entry.file)?.[h.id]);
    const at = (h: Hunk) => {
      const p = entry.placements.get(h.id);
      return p?.kind === "ok" ? p : null;
    };
    return (
      open.find((h) => {
        const p = at(h);
        return p && line >= p.start && line <= Math.max(p.start, p.end - 1);
      }) ?? open.find((h) => (at(h)?.start ?? -1) >= line)
    );
  }

  async keep(uri?: vscode.Uri, id?: string): Promise<void> {
    const e = this.entryFor(uri);
    const h = e && this.hunkFor(e, id);
    if (!e || !h) return;
    this.setDecisions([{ file: e.file, id: h.id, decision: "kept" }]);
    this.changedAll();
  }

  /** Puts one hunk's baseline lines back in the document (a WorkspaceEdit, so Ctrl+Z undoes it). */
  async undo(uri?: vscode.Uri, id?: string): Promise<boolean> {
    const e = this.entryFor(uri);
    const h = e && this.hunkFor(e, id);
    if (!e || !h || e.hunks.kind !== "hunks") return false;
    const doc = await vscode.workspace.openTextDocument(e.uri);
    const located = this.locate(e, h, doc);
    if (!located) {
      const pick = await vscode.window.showWarningMessage(
        `This change in ${path.basename(e.file)} was edited since the agent made it. Open the diff to compare.`,
        "Open diff",
      );
      if (pick) await this.source.openDiff(e.file);
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    this.addUndo(edit, doc, located);
    if (!(await vscode.workspace.applyEdit(edit))) return false;
    this.setDecisions([{ file: e.file, id: h.id, decision: "undone" }]);
    this.place(e, doc.getText());
    this.changedAll();
    return true;
  }

  /** Where a hunk is in the document right now, or null when its lines changed since. */
  private locate(e: Entry, h: Hunk, doc: vscode.TextDocument): Located | null {
    if (e.hunks.kind !== "hunks") return null;
    const i = e.hunks.hunks.indexOf(h);
    const p = placeHunks(e.hunks.after, toLines(doc.getText()), [h])[0];
    return i >= 0 && p.kind === "ok" ? { entry: e, hunk: h, at: p } : null;
  }

  private addUndo(edit: vscode.WorkspaceEdit, doc: vscode.TextDocument, l: Located): void {
    const u = undoEdit(doc.getText(), l.at, l.hunk);
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(u.start), doc.positionAt(u.end)), u.text);
  }

  async keepFile(uri?: vscode.Uri): Promise<void> {
    const e = this.entryFor(uri);
    if (!e) return;
    this.setDecisions(this.undecided(e).map((id) => ({ file: e.file, id, decision: "kept" as const })));
    this.changedAll();
  }

  private undecided(e: Entry): string[] {
    return ids(e).filter((id) => !this.decisions(e.file)?.[id]);
  }

  async undoFile(uri?: vscode.Uri, confirmed = false): Promise<{ undone: number; left: number }> {
    const e = this.entryFor(uri);
    if (!e) return { undone: 0, left: 0 };
    const open = this.undecided(e);
    if (!open.length) return { undone: 0, left: 0 };
    const mark = (list: string[]) => {
      this.setDecisions(list.map((id) => ({ file: e.file, id, decision: "undone" as const })));
      this.changedAll();
    };
    const name = path.basename(e.file);
    if (e.status === "added") {
      const text = await this.currentText(e);
      const edited = text !== null && e.sides !== null && text !== e.sides.after;
      if (!confirmed) {
        const ok = await vscode.window.showWarningMessage(
          `Delete ${name}? The agent created it.${edited ? " You changed it since, and those changes go too." : ""}`,
          { modal: true },
          "Delete file",
        );
        if (!ok) return { undone: 0, left: open.length };
      }
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(e.uri, { ignoreIfNotExists: true });
      if (!(await vscode.workspace.applyEdit(edit))) return { undone: 0, left: open.length };
      mark(open);
      return { undone: open.length, left: 0 };
    }
    if (e.status === "deleted") {
      if (!e.sides) {
        void vscode.window.showWarningMessage(
          `Sidecar can't restore ${name}: OpenCode's snapshot of it can't be read (binary or incomplete). Rewind with code restores it.`,
        );
        return { undone: 0, left: open.length };
      }
      if (fs.existsSync(e.uri.fsPath)) {
        void vscode.window.showWarningMessage(`${name} exists again, so it was left as it is.`);
        return { undone: 0, left: open.length };
      }
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(e.uri, { ignoreIfExists: true });
      edit.insert(e.uri, new vscode.Position(0, 0), e.sides.before);
      if (!(await vscode.workspace.applyEdit(edit))) return { undone: 0, left: open.length };
      mark(open);
      return { undone: open.length, left: 0 };
    }
    const doc = await vscode.workspace.openTextDocument(e.uri);
    if (e.hunks.kind === "file") {
      // Too large to split, or binary: the whole file goes back only while it is exactly the agent's.
      if (!e.sides || toLines(doc.getText()).join("") !== toLines(e.sides.after).join("")) {
        void vscode.window.showWarningMessage(
          e.sides
            ? `${name} changed since the agent's edit, so it can't be undone as a whole. Open the diff to compare.`
            : `Sidecar can't undo ${name} (binary or an incomplete snapshot). Rewind with code restores it.`,
        );
        return { undone: 0, left: open.length };
      }
      const edit = new vscode.WorkspaceEdit();
      const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(e.uri, all, fromLines(toLines(e.sides.before), eolOf(doc.getText())));
      if (!(await vscode.workspace.applyEdit(edit))) return { undone: 0, left: open.length };
      mark(open);
      return { undone: open.length, left: 0 };
    }
    const hunks = e.hunks.hunks;
    const located = open
      .map((id) => hunks.find((h) => h.id === id))
      .map((h) => (h ? this.locate(e, h, doc) : null))
      .filter((l): l is Located => !!l);
    if (located.length) {
      const edit = new vscode.WorkspaceEdit();
      for (const l of located) this.addUndo(edit, doc, l);
      if (!(await vscode.workspace.applyEdit(edit))) return { undone: 0, left: open.length };
      this.setDecisions(located.map((l) => ({ file: e.file, id: l.hunk.id, decision: "undone" as const })));
      this.place(e, doc.getText());
      this.changedAll();
    }
    const left = open.length - located.length;
    if (left && !confirmed)
      void vscode.window.showWarningMessage(
        `${left} change${left === 1 ? "" : "s"} in ${name} ${left === 1 ? "was" : "were"} edited since and left as ${left === 1 ? "it is" : "they are"}. Open the diff to compare.`,
      );
    return { undone: located.length, left };
  }

  private totals(): { undecided: number; files: number } {
    let undecided = 0;
    let files = 0;
    for (const e of this.entries) {
      const n = this.undecided(e).length;
      undecided += n;
      if (n) files++;
    }
    return { undecided, files };
  }

  async keepAll(confirmed = false): Promise<void> {
    const t = this.totals();
    if (!t.undecided) {
      void vscode.window.showInformationMessage("No agent changes left to review.");
      return;
    }
    if (!confirmed) {
      const ok = await vscode.window.showWarningMessage(
        `Keep all ${t.undecided} agent change${plural(t.undecided)} left in ${t.files} file${plural(t.files)}?`,
        { modal: true },
        "Keep all",
      );
      if (!ok) return;
    }
    this.setDecisions(
      this.entries.flatMap((e) =>
        this.undecided(e).map((id) => ({ file: e.file, id, decision: "kept" as const })),
      ),
    );
    this.changedAll();
  }

  async undoAll(confirmed = false): Promise<void> {
    const t = this.totals();
    if (!t.undecided) {
      void vscode.window.showInformationMessage("No agent changes left to review.");
      return;
    }
    const created = this.entries.filter((e) => e.status === "added" && this.undecided(e).length).length;
    if (!confirmed) {
      const ok = await vscode.window.showWarningMessage(
        `Undo all ${t.undecided} agent change${plural(t.undecided)} left in ${t.files} file${plural(t.files)}?` +
          (created
            ? ` ${created} file${plural(created)} the agent created ${created === 1 ? "is" : "are"} deleted.`
            : "") +
          " Changes you edited since are left as they are.",
        { modal: true },
        "Undo all",
      );
      if (!ok) return;
    }
    let undone = 0;
    let left = 0;
    for (const e of [...this.entries]) {
      const r = await this.undoFile(e.uri, true);
      undone += r.undone;
      left += r.left;
    }
    const dirty = vscode.workspace.textDocuments.some((d) => d.isDirty && this.byUri.has(d.uri.toString()));
    const msg =
      `Undid ${undone} agent change${plural(undone)}.` +
      (left
        ? ` ${left} edited since ${left === 1 ? "was" : "were"} left as ${left === 1 ? "it is" : "they are"}.`
        : "") +
      (dirty ? " Save the files to keep the result." : "");
    const pick = await vscode.window.showInformationMessage(msg, ...(dirty ? ["Save all"] : []));
    if (pick) await vscode.workspace.saveAll(false);
  }

  /** Goes to the next (1) or previous (-1) undecided hunk, across files in the strip's order. */
  async go(dir: 1 | -1): Promise<void> {
    const stops: Array<{ entry: Entry; line: number }> = [];
    for (const e of this.entries) {
      if (e.status === "deleted") continue;
      const open = this.undecided(e);
      if (!open.length) continue;
      if (e.hunks.kind !== "hunks") {
        stops.push({ entry: e, line: 0 });
        continue;
      }
      for (const h of e.hunks.hunks) {
        if (!open.includes(h.id)) continue;
        const p = e.placements.get(h.id);
        stops.push({ entry: e, line: p ? (p.kind === "ok" ? p.start : p.near) : h.newStart });
      }
    }
    if (!stops.length) {
      void vscode.window.showInformationMessage("No agent changes left to review.");
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const cur = editor
      ? this.entries.findIndex((e) => e.uri.toString() === editor.document.uri.toString())
      : -1;
    const line = editor?.selection.active.line ?? -1;
    const order = (s: { entry: Entry; line: number }) => [this.entries.indexOf(s.entry), s.line] as const;
    const cmp = (a: readonly [number, number], b: readonly [number, number]) => a[0] - b[0] || a[1] - b[1];
    const here = [cur, line] as const;
    const next =
      dir === 1
        ? (stops.find((s) => cmp(order(s), here) > 0) ?? stops[0])
        : ([...stops].reverse().find((s) => cmp(order(s), here) < 0) ?? stops[stops.length - 1]);
    await this.reveal(next.entry, next.line);
  }

  private async reveal(e: Entry, line: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(e.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(Math.min(line, Math.max(0, doc.lineCount - 1)), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Opens a file at its first undecided hunk (a deleted file: its diff). */
  async openFile(file: string): Promise<void> {
    const e = this.entries.find((x) => x.file === file);
    if (!e) return;
    if (e.status === "deleted" || !fs.existsSync(e.uri.fsPath)) {
      await this.source.openDiff(e.file);
      return;
    }
    const open = this.undecided(e);
    const first = e.hunks.kind === "hunks" ? e.hunks.hunks.find((h) => open.includes(h.id)) : undefined;
    const p = first && e.placements.get(first.id);
    await this.reveal(e, p ? (p.kind === "ok" ? p.start : p.near) : 0);
  }

  // ------------------------------------------------------------ review picker

  async showReview(): Promise<void> {
    this.sync();
    if (!this.entries.length) {
      void vscode.window.showInformationMessage("The agent has no changes to review in this session.");
      return;
    }
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const diffButton = { iconPath: new vscode.ThemeIcon("diff"), tooltip: "Open the diff" };
    const files: Item[] = this.entries.map((e) => {
      const slash = Math.max(e.file.lastIndexOf("/"), e.file.lastIndexOf("\\"));
      return {
        label: `$(${e.status === "added" ? "diff-added" : e.status === "deleted" ? "diff-removed" : "diff-modified"}) ${e.file.slice(slash + 1)}`,
        description: slash > 0 ? e.file.slice(0, slash) : undefined,
        detail: countsText(this.counts(e), e.status),
        buttons: [diffButton],
        run: () => this.openFile(e.file),
        file: e.file,
      } as Item & { file: string };
    });
    const t = this.totals();
    const actions: Item[] = [
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      ...(t.undecided
        ? [
            { label: "$(arrow-down) Next change", run: () => this.go(1) },
            {
              label: "$(check-all) Keep all",
              detail: `${t.undecided} left to review`,
              run: () => this.keepAll(),
            },
            {
              label: "$(discard) Undo all",
              detail: "Changes you edited since are left as they are",
              run: () => this.undoAll(),
            },
          ]
        : []),
      ...(this.entries.some((e) => this.counts(e).kept) && this.source.git()
        ? [
            {
              label: "$(add) Stage kept changes",
              detail: "Stage exactly the kept hunks in Source Control",
              run: () => this.stageKept(),
            },
          ]
        : []),
      { label: "$(diff-multiple) Open all diffs", run: () => this.source.openDiff() },
    ];
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Review agent changes";
    qp.placeholder = t.undecided
      ? `${t.undecided} change${plural(t.undecided)} to review in ${t.files} file${plural(t.files)}`
      : "Every agent change is reviewed";
    qp.items = [...files, ...actions];
    qp.matchOnDescription = true;
    qp.onDidTriggerItemButton((ev) => {
      qp.hide();
      void this.source.openDiff((ev.item as Item & { file: string }).file);
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      void item?.run?.();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  // ------------------------------------------------------------ staging

  /**
   * Stages only the kept hunks. VS Code's Git API cannot stage part of a file, so this
   * builds a patch against each file's staged version and runs `git apply --cached`
   * (execFile, no shell) in its repository.
   */
  async stageKept(): Promise<{ staged: number; skipped: number } | undefined> {
    const git = this.source.git();
    if (!git) {
      void vscode.window.showWarningMessage("Staging needs VS Code's Git extension.");
      return;
    }
    const exe = git.git?.path || "git";
    const byRepo = new Map<string, { patches: string[]; add: string[] }>();
    let staged = 0;
    let skipped = 0;
    let outside = 0;
    for (const e of this.entries) {
      const d = this.decisions(e.file);
      const kept = new Set(ids(e).filter((id) => d?.[id] === "kept"));
      if (!kept.size) continue;
      const repo = git.getRepository(e.uri);
      const root = repo?.rootUri.fsPath;
      const rel = root ? path.relative(root, e.uri.fsPath) : "";
      if (!root || !rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        outside++;
        continue;
      }
      const relPosix = rel.split(path.sep).join("/");
      const group = byRepo.get(root) ?? { patches: [], add: [] };
      byRepo.set(root, group);
      if (e.hunks.kind === "file") {
        // Binary or too large to split: the file is staged as it is.
        group.add.push(relPosix);
        staged++;
        continue;
      }
      try {
        const index = await runGit(exe, root, ["cat-file", "blob", `:${relPosix}`])
          .then((b) => b.toString("utf8"))
          .catch(() => null);
        const mode = await runGit(exe, root, ["ls-files", "-s", "--", relPosix])
          .then((b) => /^(\d{6}) /.exec(b.toString("utf8"))?.[1])
          .catch(() => undefined);
        const autocrlf = await runGit(exe, root, ["config", "--get", "core.autocrlf"])
          .then((b) => b.toString("utf8").trim().toLowerCase())
          .catch(() => "");
        const r = keptPatch({
          rel: relPosix,
          status: e.status,
          index,
          mode,
          file: e.hunks,
          kept,
          // A new file is stored with LF when Git converts line endings, else as written.
          newFileEol: autocrlf === "true" || autocrlf === "input" ? "\n" : eolOf(e.sides?.after ?? ""),
        });
        if (r.patch) group.patches.push(r.patch);
        staged += r.staged;
        skipped += r.skipped;
      } catch (err) {
        this.log.warn(`Could not prepare ${e.file} for staging: ${err instanceof Error ? err.message : err}`);
        skipped += kept.size;
      }
    }
    for (const [root, g] of byRepo) {
      try {
        if (g.patches.length)
          await runGit(exe, root, ["apply", "--cached", "--whitespace=nowarn", "-"], g.patches.join(""));
        if (g.add.length) await runGit(exe, root, ["add", "--", ...g.add]);
      } catch (err) {
        const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
        this.log.error(`git apply --cached failed in ${root}`, err);
        void vscode.window.showErrorMessage(`Git could not stage the kept changes: ${why}`);
        return;
      }
    }
    const parts = [
      staged ? `Staged ${staged} kept change${plural(staged)}.` : "Nothing new to stage.",
      skipped
        ? `${skipped} differ${skipped === 1 ? "s" : ""} from the staged version and ${skipped === 1 ? "was" : "were"} skipped.`
        : "",
      outside
        ? `${outside} file${plural(outside)} outside a Git repository ${outside === 1 ? "was" : "were"} skipped.`
        : "",
    ];
    void vscode.window.showInformationMessage(parts.filter(Boolean).join(" "));
    return { staged, skipped };
  }

  dispose(): void {
    clearTimeout(this.docTimer);
    for (const d of this.disposables) d.dispose();
  }

  /** Test hook for the acceptance harness. */
  get testApi() {
    return {
      sync: () => this.sync(),
      refresh: () => this.refreshAll(),
      entries: () =>
        this.entries.map((e) => ({
          file: e.file,
          uri: e.uri,
          hunks: e.hunks.kind === "hunks" ? e.hunks.hunks.map((h) => h.id) : [],
          counts: this.counts(e),
        })),
      undo: (uri: vscode.Uri, id: string) => this.undo(uri, id),
      keep: (uri: vscode.Uri, id: string) => this.keep(uri, id),
      stageKept: () => this.stageKept(),
      reload: () => {
        // As after a window reload: decisions read back from workspace state.
        this.store = readStore(this.state.get(REVIEW_KEY));
        this.version = -2;
        this.sync();
      },
    };
  }
}

function ids(e: Entry): string[] {
  return e.hunks.kind === "hunks" ? e.hunks.hunks.map((h) => h.id) : [e.hunks.id];
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** "2 to review · 1 kept · 1 undone", as the picker and the strip say it. */
export function countsText(c: ReviewCounts, status: FileChange["status"]): string {
  const parts = [
    c.undecided ? `${c.undecided} to review` : "reviewed",
    c.kept ? `${c.kept} kept` : "",
    c.undone ? `${c.undone} undone` : "",
    c.changed ? `${c.changed} edited since` : "",
    c.fileOnly ? "whole file" : "",
    status === "added" ? "new" : status === "deleted" ? "deleted" : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function hoverFor(h: Hunk): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const n = h.oldLines.length;
  const verb = h.newLines.length ? "replaced" : "removed";
  md.appendMarkdown(
    n ? `**Agent change** · ${verb} ${n} line${plural(n)}:` : "**Agent change** · added lines",
  );
  if (n) {
    const shown = h.oldLines.slice(0, 20).join("");
    md.appendCodeblock(shown + (n > 20 ? `… ${n - 20} more\n` : ""));
  }
  return md;
}

/** Runs Git without a shell (paths and patches never pass through one), with optional stdin. */
function runGit(exe: string, cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.toString("utf8").trim() || err.message));
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input, "utf8");
    else child.stdin?.end();
  });
}
