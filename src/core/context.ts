// Turns explicit, user-chosen context attachments into an OpenCode prompt.
//
// - Whole files are sent as OpenCode file attachments (file:// URIs); OpenCode
//   reads and inlines them itself, exactly like an @file mention in its TUI.
// - Selections are sent inline as a fenced snippet with path + line range, so
//   only the selected lines are transmitted, never the whole file.
// - Problems (VS Code diagnostics) are sent inline too, see ./problems.ts.

import { pathToFileURL } from "node:url";
import type { ContextAttachment } from "../shared/model";
import type { AttachmentChip } from "../shared/protocol";
import { formatProblems, problemsChip } from "./problems";

export const MAX_SELECTION_CHARS = 60_000;

/** Where a mention's token sits in the prompt text (UTF-16 offsets, end exclusive). */
export interface MentionSpan {
  start: number;
  end: number;
  text: string;
}

export interface PromptPayload {
  text: string;
  files: Array<{ uri: string; name: string; mention?: MentionSpan }>;
  agents?: Array<{ name: string; mention: MentionSpan }>;
  skills?: Array<{ id: string; mention: MentionSpan }>;
}

/**
 * A mention checked by the host: a file or folder resolved inside the open folder, a
 * subagent or a skill that OpenCode lists. `text` is the token as typed (`@src/a.ts`).
 */
export type ResolvedMention =
  | { kind: "file" | "folder"; absPath: string; relPath: string; text: string }
  | { kind: "agent"; name: string; text: string }
  | { kind: "skill"; id: string; text: string };

/**
 * Finds each mention's token in `text`, in order, as a whole word: the character
 * before it is the start or whitespace, and the one after it is not part of a path.
 * A token the user deleted after picking it is not found and is dropped.
 */
export function locateMentions<M extends { text: string }>(
  text: string,
  mentions: readonly M[],
): Array<M & { span: MentionSpan }> {
  const taken: Array<[number, number]> = [];
  const out: Array<M & { span: MentionSpan }> = [];
  for (const m of mentions) {
    if (!m.text.startsWith("@") || m.text.length < 2) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(m.text, from);
      if (at < 0) break;
      const end = at + m.text.length;
      const before = at === 0 || /\s|[([{"'`]/.test(text[at - 1]);
      const after = end === text.length || !/[\w./\\-]/.test(text[end]);
      const free = !taken.some(([s, e]) => at < e && end > s);
      if (before && after && free) {
        taken.push([at, end]);
        out.push({ ...m, span: { start: at, end, text: m.text } });
        break;
      }
      from = at + 1;
    }
  }
  return out;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export function chipFor(a: ContextAttachment): AttachmentChip {
  if (a.kind === "problems") return { id: a.id, ...problemsChip(a), kind: "problems" };
  if (a.kind === "file") return { id: a.id, label: basename(a.relPath), detail: a.relPath };
  if (a.kind === "image")
    return a.thumb
      ? { id: a.id, label: a.name, detail: a.detail, kind: "image", thumb: a.thumb }
      : { id: a.id, label: a.name, detail: a.detail, kind: "image" };
  const range = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`;
  return { id: a.id, label: `${basename(a.relPath)}:${range}`, detail: `${a.relPath} lines ${range}` };
}

/** Picks a backtick fence longer than any backtick run inside `text`. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function formatSelection(a: Extract<ContextAttachment, { kind: "selection" }>): string {
  const fence = fenceFor(a.text);
  const range = a.startLine === a.endLine ? `line ${a.startLine}` : `lines ${a.startLine}-${a.endLine}`;
  const lang = /^[\w+-]+$/.test(a.languageId) ? a.languageId : "";
  const body = a.text.endsWith("\n") ? a.text : a.text + "\n";
  return `Selected code from \`${a.relPath}\` (${range}):\n${fence}${lang}\n${body}${fence}`;
}

/** A large paste held as a chip in the message box; `token` marks its place in the text. */
export interface PastedText {
  token: string;
  text: string;
}

/**
 * Puts each paste's text where its token is (the first free occurrence), exactly as
 * pasted. Mention spans found in the text with the tokens are moved to match. A token
 * the user deleted is not found and its paste is dropped, as with mentions.
 */
export function expandPastes<M extends { span: MentionSpan }>(
  text: string,
  pastes: readonly PastedText[],
  found: readonly M[] = [],
): { text: string; mentions: M[] } {
  const taken: Array<[number, number]> = found.map((m) => [m.span.start, m.span.end]);
  const at: Array<{ start: number; end: number; text: string }> = [];
  for (const p of pastes) {
    if (!p.token) continue;
    for (let from = 0; ;) {
      const i = text.indexOf(p.token, from);
      if (i < 0) break;
      const end = i + p.token.length;
      if (!taken.some(([s, e]) => i < e && end > s)) {
        taken.push([i, end]);
        at.push({ start: i, end, text: p.text });
        break;
      }
      from = i + 1;
    }
  }
  if (!at.length) return { text, mentions: [...found] };
  at.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const r of at) {
    out += text.slice(last, r.start) + r.text;
    last = r.end;
  }
  out += text.slice(last);
  // Text before a mention grew or shrank by each paste in front of it.
  const shift = (pos: number) =>
    at.reduce((d, r) => (r.end <= pos ? d + r.text.length - (r.end - r.start) : d), 0);
  const mentions = found.map((m) => {
    const d = shift(m.span.start);
    return { ...m, span: { ...m.span, start: m.span.start + d, end: m.span.end + d } };
  });
  return { text: out, mentions };
}

/**
 * Builds OpenCode's prompt input. Files, folders and images become file attachments
 * (OpenCode reads `file://` URIs itself and takes `data:` images inline); selections
 * are added to the text; `@` mentions keep where their token sits in the text, as
 * OpenCode's own terminal UI sends them. Pastes are put in after the typed text is
 * trimmed and its mentions are found, so their text is sent exactly as pasted.
 */
export function buildPrompt(
  text: string,
  attachments: readonly ContextAttachment[],
  mentions: readonly ResolvedMention[] = [],
  pastes: readonly PastedText[] = [],
): PromptPayload {
  const files: PromptPayload["files"] = [];
  const seen = new Set<string>();
  const snippets: string[] = [];
  const expanded = expandPastes(text.trim(), pastes, locateMentions(text.trim(), mentions));
  const typed = expanded.text;
  const found = expanded.mentions;
  for (const m of found) {
    if (m.kind !== "file" && m.kind !== "folder") continue;
    seen.add(m.absPath);
    files.push({ uri: pathToFileURL(m.absPath).href, name: m.relPath, mention: m.span });
  }
  for (const a of attachments) {
    if (a.kind === "file") {
      if (seen.has(a.absPath)) continue;
      seen.add(a.absPath);
      files.push({ uri: pathToFileURL(a.absPath).href, name: a.relPath });
    } else if (a.kind === "image") {
      if (seen.has(a.uri)) continue;
      seen.add(a.uri);
      files.push({ uri: a.uri, name: a.name });
    } else if (a.kind === "problems") {
      snippets.push(formatProblems(a));
    } else {
      snippets.push(formatSelection(a));
    }
  }
  const parts = [typed, ...snippets].filter((p) => p.length > 0);
  const payload: PromptPayload = { text: parts.join("\n\n"), files };
  const agents = found.flatMap((m) => (m.kind === "agent" ? [{ name: m.name, mention: m.span }] : []));
  const skills = found.flatMap((m) => (m.kind === "skill" ? [{ id: m.id, mention: m.span }] : []));
  if (agents.length) payload.agents = agents;
  if (skills.length) payload.skills = skills;
  return payload;
}

/** Image types OpenCode recognizes, with the largest image Sidecar attaches. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The decoded size of a base64 `data:` URI, or null when it is not one. */
export function dataUriBytes(uri: string): number | null {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!m) return null;
  const b64 = m[2];
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Validates a selection before it is attached. Returns an error message or undefined. */
export function validateSelection(text: string): string | undefined {
  if (text.trim().length === 0) return "The selection is empty.";
  if (text.length > MAX_SELECTION_CHARS) {
    return `The selection is too large (${text.length.toLocaleString()} characters). Attach the file instead or select fewer lines.`;
  }
  return undefined;
}
