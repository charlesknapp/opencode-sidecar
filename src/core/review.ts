// Per-hunk review of the agent's changes: the hunks between a file's pre-agent baseline
// and the agent's snapshot, where each one sits in the document now (the user may have
// edited since), the edit that undoes one, the stored decisions, and the patch that
// stages only the kept hunks. VS Code-free; src/host/review.ts draws and applies it.

import { createHash } from "node:crypto";
import type { ReviewCounts, RewindPreview } from "../shared/model";
import type { FileSides } from "./patch";

/**
 * A file's lines, each with its terminator normalized to "\n" (the last one may have
 * none). CRLF and LF lines compare equal; the file's own line ending is put back on write.
 */
export function toLines(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    if (nl < 0) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, nl > i && text[nl - 1] === "\r" ? nl - 1 : nl) + "\n");
    i = nl + 1;
  }
  return out;
}

/** The file's line ending, from its first line break ("\n" when it has none). */
export function eolOf(text: string): "\n" | "\r\n" {
  const nl = text.indexOf("\n");
  return nl > 0 && text[nl - 1] === "\r" ? "\r\n" : "\n";
}

export function fromLines(lines: string[], eol: "\n" | "\r\n"): string {
  return lines.map((l) => (l.endsWith("\n") ? l.slice(0, -1) + eol : l)).join("");
}

/** One changed region: lines [aStart, aEnd) of `a` became lines [bStart, bEnd) of `b`. */
export interface Block {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Diffs past this many changed lines are not worth reviewing hunk by hunk (and Myers' trace grows with its square). */
const MAX_EDIT_DISTANCE = 2000;

/** Line diff (Myers), as changed blocks in order; null when the two differ too much to diff cheaply. */
export function diffLines(a: string[], b: string[], maxD = MAX_EDIT_DISTANCE): Block[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf])
    suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ aStart: pre, aEnd: pre + n, bStart: pre, bEnd: pre + m }];
  // Lines as small integers, so the inner loop compares numbers.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const x = Int32Array.from(a.slice(pre, pre + n), intern);
  const y = Int32Array.from(b.slice(pre, pre + m), intern);
  const limit = Math.min(n + m, maxD);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d] holds v[-d..d] as it was before step d, for the walk back.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[off + k] = i;
      if (i >= n && j >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const matches: Array<[number, number]> = [];
  let i = n;
  let j = m;
  for (let d = found; d > 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d];
    const k = i - j;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevI = at(prevK);
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) matches.push([--i, --j]);
    i = prevI;
    j = prevJ;
  }
  while (i > 0 && j > 0) matches.push([--i, --j]);
  matches.reverse();
  const blocks: Block[] = [];
  let pa = 0;
  let pb = 0;
  for (const [mi, mj] of [...matches, [n, m] as [number, number]]) {
    if (mi > pa || mj > pb)
      blocks.push({ aStart: pre + pa, aEnd: pre + mi, bStart: pre + pb, bEnd: pre + mj });
    pa = mi + 1;
    pb = mj + 1;
  }
  return blocks;
}

export type Decision = "kept" | "undone";

/** One agent change: `oldLines` of the baseline (at `oldStart`) became `newLines` (at `newStart` in the snapshot). */
export interface Hunk {
  /** Content hash, stable while the change itself is the same (other edits may move it). */
  id: string;
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
}

/** Past these, a file is reviewed as a whole (Keep file / Undo file and the diff editor). */
export const MAX_HUNKS = 300;
export const MAX_REVIEW_BYTES = 2_000_000;

export type FileHunks =
  | { kind: "hunks"; hunks: Hunk[]; before: string[]; after: string[] }
  /** Reviewed as a whole: binary or an incomplete snapshot ("unavailable"), or too big to split. */
  | { kind: "file"; reason: "unavailable" | "large"; id: string };

function hash(parts: string[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

/**
 * The agent's hunks for one file. `sides` null means OpenCode's patch could not be rebuilt
 * (binary or incomplete); `patch` then identifies the file-level decision.
 */
export function fileHunks(sides: FileSides | null, patch: string): FileHunks {
  if (!sides) return { kind: "file", reason: "unavailable", id: "file:" + hash([patch]) };
  if (sides.before.length > MAX_REVIEW_BYTES || sides.after.length > MAX_REVIEW_BYTES)
    return { kind: "file", reason: "large", id: "file:" + hash([sides.before, sides.after]) };
  const before = toLines(sides.before);
  const after = toLines(sides.after);
  const blocks = diffLines(before, after);
  if (!blocks || blocks.length > MAX_HUNKS)
    return { kind: "file", reason: "large", id: "file:" + hash([sides.before, sides.after]) };
  const seen = new Map<string, number>();
  const hunks = blocks.map((b) => {
    const oldLines = before.slice(b.aStart, b.aEnd);
    const newLines = after.slice(b.bStart, b.bEnd);
    const base = hash([...oldLines, "\u0001", ...newLines]);
    // The same change twice in a file (a repeated rename, say) gets an occurrence number.
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { id: n ? `${base}.${n}` : base, oldStart: b.aStart, oldLines, newStart: b.bStart, newLines };
  });
  return { kind: "hunks", hunks, before, after };
}

/** Where a range of `from` sits in `to`, or "changed" when `to` changed lines inside it (or at an empty range's point). */
export type Placement =
  | { kind: "ok"; start: number; end: number }
  /** `near`: about where it was, for a CodeLens that opens the diff. */
  | { kind: "changed"; near: number };

/**
 * Maps line ranges of `from` onto `to` through the diff between them. A range whose lines
 * all survive unchanged moves by the lines inserted or removed above it; any change inside
 * it means it no longer matches, and nothing is guessed.
 */
export function placeRanges(
  from: string[],
  to: string[],
  ranges: Array<{ start: number; length: number }>,
): Placement[] {
  const blocks = diffLines(from, to);
  return ranges.map(({ start: s, length }) => {
    if (!blocks) return { kind: "changed", near: Math.min(s, to.length) };
    const e = s + length;
    let delta = 0;
    for (const b of blocks) {
      const ins = b.aStart === b.aEnd;
      let before: boolean;
      let after: boolean;
      if (s === e) {
        // A removal point: edits that end at it or start at it are fine; an insertion at it is not.
        before = b.aEnd < s || (b.aEnd === s && !ins);
        after = b.aStart > s || (b.aStart === s && !ins);
      } else {
        before = b.aEnd <= s;
        after = b.aStart >= e;
      }
      if (before) delta += b.bEnd - b.bStart - (b.aEnd - b.aStart);
      else if (after) break;
      else return { kind: "changed", near: Math.max(0, Math.min(b.bStart, to.length)) };
    }
    return { kind: "ok", start: s + delta, end: e + delta };
  });
}

/** Where each hunk's agent lines are in the document now. */
export function placeHunks(after: string[], current: string[], hunks: Hunk[]): Placement[] {
  return placeRanges(
    after,
    current,
    hunks.map((h) => ({ start: h.newStart, length: h.newLines.length })),
  );
}

/** Character offset of a line's start (the text's length past its last line). */
function lineOffset(text: string, line: number): number {
  let off = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf("\n", off);
    if (nl < 0) return text.length;
    off = nl + 1;
  }
  return off;
}

/** The text edit that puts a hunk's baseline lines back where the hunk now sits, in the document's line ending. */
export function undoEdit(
  current: string,
  at: { start: number; end: number },
  hunk: Hunk,
): { start: number; end: number; text: string } {
  return {
    start: lineOffset(current, at.start),
    end: lineOffset(current, at.end),
    text: fromLines(hunk.oldLines, eolOf(current)),
  };
}

// ------------------------------------------------------------------ decisions

/** Decisions per file (relative path) and hunk id, for one session. */
export type SessionDecisions = Record<string, Record<string, Decision>>;
/** What workspace state holds: per session id, its decisions and when they last changed. */
export type ReviewStore = Record<string, { at: number; files: SessionDecisions }>;

/** Sessions remembered at most (the least recently reviewed are dropped first). */
export const MAX_REVIEW_SESSIONS = 50;

/** A store read back from workspace state, with anything malformed left out. */
export function readStore(raw: unknown): ReviewStore {
  const out: ReviewStore = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [sid, entry] of Object.entries(raw as Record<string, unknown>)) {
    const e = entry as { at?: unknown; files?: unknown } | null;
    if (!e || typeof e !== "object" || !e.files || typeof e.files !== "object") continue;
    const files: SessionDecisions = {};
    for (const [file, d] of Object.entries(e.files as Record<string, unknown>)) {
      if (!d || typeof d !== "object") continue;
      const ok: Record<string, Decision> = {};
      for (const [id, v] of Object.entries(d as Record<string, unknown>))
        if (v === "kept" || v === "undone") ok[id] = v;
      if (Object.keys(ok).length) files[file] = ok;
    }
    out[sid] = { at: typeof e.at === "number" ? e.at : 0, files };
  }
  return out;
}

/**
 * Drops decisions for hunks the agent's changes no longer contain (the agent rewrote them,
 * or a later turn started from an undone one) and for files it no longer changed.
 */
export function pruneDecisions(files: SessionDecisions, present: Record<string, string[]>): SessionDecisions {
  const out: SessionDecisions = {};
  for (const [file, d] of Object.entries(files)) {
    const ids = present[file];
    if (!ids) continue;
    const keep: Record<string, Decision> = {};
    for (const id of ids) if (d[id]) keep[id] = d[id];
    if (Object.keys(keep).length) out[file] = keep;
  }
  return out;
}

/** The store with one session's decisions replaced, and the oldest sessions past the cap dropped. */
export function putSession(
  store: ReviewStore,
  id: string,
  files: SessionDecisions,
  now: number,
): ReviewStore {
  const next: ReviewStore = { ...store };
  if (Object.keys(files).length) next[id] = { at: now, files };
  else delete next[id];
  const ids = Object.keys(next).sort((a, b) => next[b].at - next[a].at);
  for (const old of ids.slice(MAX_REVIEW_SESSIONS)) delete next[old];
  return next;
}

export function countDecisions(ids: string[], decisions: Record<string, Decision> | undefined): ReviewCounts {
  const c: ReviewCounts = { undecided: 0, kept: 0, undone: 0, changed: 0, fileOnly: false };
  for (const id of ids) {
    const d = decisions?.[id];
    if (d === "kept") c.kept++;
    else if (d === "undone") c.undone++;
    else c.undecided++;
  }
  return c;
}

// ------------------------------------------------------------------ staging

/**
 * The staged (index) version with only the kept hunks applied. Each kept hunk's baseline
 * lines are found in the index version through the diff between them; a hunk the index
 * already has is counted as staged, and one whose lines differ there is skipped.
 */
export function applyKept(
  index: string[],
  file: { before: string[]; after: string[]; hunks: Hunk[] },
  kept: Set<string>,
): { lines: string[]; staged: number; already: number; skipped: number } {
  const hunks = file.hunks.filter((h) => kept.has(h.id));
  const olds = placeRanges(
    file.before,
    index,
    hunks.map((h) => ({ start: h.oldStart, length: h.oldLines.length })),
  );
  const news = placeRanges(
    file.after,
    index,
    hunks.map((h) => ({ start: h.newStart, length: h.newLines.length })),
  );
  const edits: Array<{ start: number; end: number; lines: string[] }> = [];
  let already = 0;
  let skipped = 0;
  hunks.forEach((h, i) => {
    const o = olds[i];
    const n = news[i];
    const isOld = o.kind === "ok" && same(index, o.start, h.oldLines);
    const isNew = n.kind === "ok" && same(index, n.start, h.newLines);
    // A hunk whose old and new lines both match (a pure insertion or removal with nothing
    // to tell them apart) counts as not staged yet only when the old side places.
    if (isOld && o.kind === "ok") edits.push({ start: o.start, end: o.end, lines: h.newLines });
    else if (isNew) already++;
    else skipped++;
  });
  const lines = [...index];
  for (const e of edits.sort((a, b) => b.start - a.start)) lines.splice(e.start, e.end - e.start, ...e.lines);
  return { lines, staged: edits.length, already, skipped };
}

function same(lines: string[], start: number, want: string[]): boolean {
  for (let i = 0; i < want.length; i++) if (lines[start + i] !== want[i]) return false;
  return true;
}

/** A path as Git writes it in a patch header: C-quoted when it has quotes, backslashes, control or non-ASCII characters. */
export function gitQuote(p: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/["\\\u0000-\u001f\u007f-￿]/.test(p)) return p;
  let out = '"';
  for (const byte of Buffer.from(p, "utf8")) {
    const c = String.fromCharCode(byte);
    if (c === '"' || c === "\\") out += "\\" + c;
    else if (c === "\t") out += "\\t";
    else if (c === "\n") out += "\\n";
    else if (byte < 0x20 || byte >= 0x7f) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += c;
  }
  return out + '"';
}

const CONTEXT = 3;

/**
 * A Git patch from `oldLines` (null: the file is new) to `newLines` (null: deleted), with
 * three lines of context, in `eol` line endings so it applies to the blob as stored.
 * `file` is relative to the repository root; Windows separators become "/".
 */
export function unifiedPatch(
  file: string,
  oldLines: string[] | null,
  newLines: string[] | null,
  eol: "\n" | "\r\n",
  mode = "100644",
): string {
  const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const a = oldLines ?? [];
  const b = newLines ?? [];
  // Too different to diff cheaply: one hunk that replaces the whole file.
  const blocks = diffLines(a, b) ?? [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }];
  if (!blocks.length && oldLines && newLines) return "";
  const q = (prefix: string) => gitQuote(prefix + rel);
  const out = [`diff --git ${q("a/")} ${q("b/")}`];
  if (!oldLines) out.push(`new file mode ${mode}`);
  if (!newLines) out.push(`deleted file mode ${mode}`);
  out.push(`--- ${oldLines ? q("a/") : "/dev/null"}`, `+++ ${newLines ? q("b/") : "/dev/null"}`);
  const cr = eol === "\r\n" ? "\r" : "";
  const line = (sign: string, l: string) => {
    if (l.endsWith("\n")) out.push(sign + l.slice(0, -1) + cr);
    else out.push(sign + l, "\\ No newline at end of file");
  };
  // Blocks whose context would touch are one hunk.
  const groups: Block[][] = [];
  for (const blk of blocks) {
    const last = groups[groups.length - 1];
    if (last && blk.aStart - last[last.length - 1].aEnd <= 2 * CONTEXT) last.push(blk);
    else groups.push([blk]);
  }
  for (const g of groups) {
    const aFrom = Math.max(0, g[0].aStart - CONTEXT);
    const aTo = Math.min(a.length, g[g.length - 1].aEnd + CONTEXT);
    const bFrom = g[0].bStart - (g[0].aStart - aFrom);
    const bTo = g[g.length - 1].bEnd + (aTo - g[g.length - 1].aEnd);
    const range = (from: number, len: number) => `${len === 0 ? from : from + 1},${len}`;
    out.push(`@@ -${range(aFrom, aTo - aFrom)} +${range(bFrom, bTo - bFrom)} @@`);
    let ai = aFrom;
    for (const blk of g) {
      for (; ai < blk.aStart; ai++) line(" ", a[ai]);
      for (let k = blk.aStart; k < blk.aEnd; k++) line("-", a[k]);
      for (let k = blk.bStart; k < blk.bEnd; k++) line("+", b[k]);
      ai = blk.aEnd;
    }
    for (; ai < aTo; ai++) line(" ", a[ai]);
  }
  return out.join("\n") + "\n";
}

/**
 * The patch that stages one file's kept hunks on top of its staged version (`index`, null
 * when Git does not track the file: it is then staged as a new file holding the baseline
 * plus the kept hunks). `newFileEol` is the line ending Git would store for a new file.
 */
export function keptPatch(o: {
  rel: string;
  status: "added" | "deleted" | "modified";
  index: string | null;
  mode?: string;
  file: { before: string[]; after: string[]; hunks: Hunk[] };
  kept: Set<string>;
  newFileEol: "\n" | "\r\n";
}): { patch: string; staged: number; already: number; skipped: number } {
  if (o.index === null) {
    const res = applyKept(o.file.before, o.file, o.kept);
    if (o.status === "deleted" || !res.staged) return { patch: "", ...res };
    return { patch: unifiedPatch(o.rel, null, res.lines, o.newFileEol, o.mode), ...res };
  }
  const base = toLines(o.index);
  const res = applyKept(base, o.file, o.kept);
  if (!res.staged) return { patch: "", ...res };
  const eol = o.index.includes("\n") ? eolOf(o.index) : o.newFileEol;
  const gone = o.status === "deleted" && res.lines.length === 0;
  return { patch: unifiedPatch(o.rel, base, gone ? null : res.lines, eol, o.mode), ...res };
}

// ------------------------------------------------------------------ rewind

/**
 * Files the agent's steps changed from this prompt on: each assistant message's
 * `snapshot.files` (OpenCode's revert undoes exactly these). `messages` is the session's
 * history oldest first; null when the prompt is not in it.
 */
export function stepFiles(messages: unknown[], messageID: string): string[] | null {
  const at = messages.findIndex((m) => (m as { id?: unknown } | null)?.id === messageID);
  if (at < 0) return null;
  const out = new Set<string>();
  for (const m of messages.slice(at + 1)) {
    const r = m as { type?: unknown; snapshot?: { files?: unknown } } | null;
    if (r?.type !== "assistant" || !Array.isArray(r.snapshot?.files)) continue;
    for (const f of r.snapshot.files) if (typeof f === "string" && f) out.add(f.replace(/\\/g, "/"));
  }
  return [...out];
}

/**
 * Builds the rewind preview from the transcript items after the prompt, the files its steps
 * changed (`steps`, see stepFiles) and the session diff from it on (`diff`, for each file's
 * status, and for what changed outside the steps). Tool rows: `category` "shell" with ids
 * `tool:shell-msg:` / `tool:shell-live:` are the user's `!` commands; other shell rows are
 * the agent's.
 */
export function rewindPreview(
  tools: Array<{ id: string; category: string; files: string[] }>,
  steps: string[] | null,
  diff: Array<{ path: string; status: "added" | "deleted" | "modified" }> | null,
): RewindPreview {
  const status = new Map((diff ?? []).map((d) => [norm(d.path), d.status]));
  const files =
    steps?.map((p) => ({ path: p, status: status.get(norm(p)) ?? ("modified" as const) })) ?? null;
  const reverted = new Set((steps ?? []).map(norm));
  const kept = steps && diff ? diff.map((d) => d.path).filter((p) => !reverted.has(norm(p))) : [];
  let agentShell = 0;
  let userShell = 0;
  const edited = new Set<string>();
  for (const t of tools) {
    if (t.category === "shell") {
      if (/^tool:shell-(msg|live):/.test(t.id)) userShell++;
      else agentShell++;
    }
    for (const f of t.files) edited.add(norm(f));
  }
  // Edit tools may report absolute paths; the diff's are relative to the folder.
  const covered = (p: string) => [...edited].some((e) => e === norm(p) || e.endsWith("/" + norm(p)));
  const shellFiles =
    files && agentShell + userShell > 0 ? files.map((f) => f.path).filter((p) => !covered(p)) : [];
  return { files, agentShell, userShell, shellFiles, kept };
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
