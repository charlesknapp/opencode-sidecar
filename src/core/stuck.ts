// Notices when an agent seems stuck: the same tool call (same tool, same input, same
// result) several times in a row, two calls taking turns, or a run that sends nothing
// for minutes. It only ever suggests: the controller shows a card, the user decides.
// Calls whose input waits or polls (sleep, a job's status) are left out, since repeating
// them is how a background job is followed; so is a run that waits on a long shell
// command or on the user.

import type { UiEvent } from "../shared/model";
import { categorize, describeTool } from "../shared/tools";

export interface StuckSettings {
  /** Identical calls in a row that count as a loop (and pairs for two taking turns); below 2 turns it off. */
  repeats: number;
  /** A busy run with no event for this long counts as stalled; 0 turns it off. */
  stallMs: number;
}

export const DEFAULT_STUCK: StuckSettings = { repeats: 3, stallMs: 3 * 60_000 };

/** A call as the card names it: the tool and its main argument (a path, command, pattern or URL). */
export interface CallLabel {
  tool: string;
  arg: string | null;
  /** `arg` is a path (the controller shows it relative to the folder). */
  path: boolean;
}

export type StuckFinding =
  | { kind: "repeat"; call: CallLabel; count: number }
  | { kind: "alternate"; call: CallLabel; other: CallLabel; count: number }
  | { kind: "stall"; idleMs: number };

/** A session's finding changed: a new or grown one, or `null` once it is over. */
export interface StuckChange {
  sessionID: string;
  finding: StuckFinding | null;
}

interface Call {
  /** Tool, normalized input and result: equal keys are the same call with the same outcome. */
  key: string;
  label: CallLabel;
  poll: boolean;
}

interface Track {
  busy: boolean;
  last: number;
  running: Map<string, { name: string; input: Record<string, unknown> | null }>;
  calls: Call[];
  waiting: Set<string>;
  finding: StuckFinding | null;
  /** The finding the user dismissed; it stays quiet until the pattern breaks. */
  muted: string | null;
}

/** Calls kept per session: enough for the longest pattern looked for. */
const KEEP = 24;

export class StuckDetector {
  private tracks = new Map<string, Track>();

  constructor(private readonly settings: () => StuckSettings = () => DEFAULT_STUCK) {}

  reset(): void {
    this.tracks.clear();
  }

  forget(sessionID: string): void {
    this.tracks.delete(sessionID);
  }

  finding(sessionID: string): StuckFinding | null {
    return this.tracks.get(sessionID)?.finding ?? null;
  }

  /** Activity somewhere else that counts as progress here (a subagent working for its parent). */
  touch(sessionID: string, now: number): void {
    const t = this.tracks.get(sessionID);
    if (t) t.last = now;
  }

  /** Applies a session's live events; returns its finding when it changed. */
  observe(sessionID: string, events: readonly UiEvent[], now: number): StuckChange[] {
    if (!events.length) return [];
    const t = this.track(sessionID, now);
    const before = t.finding;
    t.last = now;
    // Anything at all is progress for the stall check.
    if (t.finding?.kind === "stall") t.finding = null;
    if (t.muted === "stall") t.muted = null;
    for (const ev of events) this.apply(t, ev);
    return before === t.finding ? [] : [{ sessionID, finding: t.finding }];
  }

  /** Busy sessions with no event for the stall time (and not waiting on a shell or the user). */
  stalls(now: number, waitingElsewhere: (sessionID: string) => boolean = () => false): StuckChange[] {
    const { stallMs } = this.settings();
    if (!(stallMs > 0)) return [];
    const out: StuckChange[] = [];
    for (const [sessionID, t] of this.tracks) {
      if (!t.busy || t.finding || t.muted === "stall" || t.waiting.size > 0) continue;
      if (now - t.last < stallMs) continue;
      // A build or a test run can take minutes without output: only the user knows.
      if ([...t.running.values()].some((c) => categorize(c.name) === "shell")) continue;
      if (waitingElsewhere(sessionID)) continue;
      t.finding = { kind: "stall", idleMs: now - t.last };
      out.push({ sessionID, finding: t.finding });
    }
    return out;
  }

  /** The user dismissed the session's finding: quiet until the agent does something else. */
  dismiss(sessionID: string): void {
    const t = this.tracks.get(sessionID);
    if (!t?.finding) return;
    t.muted = identity(t.finding);
    t.finding = null;
  }

  private track(sessionID: string, now: number): Track {
    let t = this.tracks.get(sessionID);
    if (!t) {
      t = {
        busy: false,
        last: now,
        running: new Map(),
        calls: [],
        waiting: new Set(),
        finding: null,
        muted: null,
      };
      this.tracks.set(sessionID, t);
    }
    return t;
  }

  private apply(t: Track, ev: UiEvent): void {
    switch (ev.type) {
      case "session.busy":
        t.busy = true;
        break;
      case "session.idle":
        t.busy = false;
        t.running.clear();
        t.waiting.clear();
        t.finding = null;
        break;
      case "user.message":
      case "inbox.delivered":
        // The user said something (a prompt, or a steer reaching the agent): whatever went round before is a new start.
        t.calls = [];
        t.finding = null;
        t.muted = null;
        break;
      case "tool.started":
        t.running.set(ev.toolId, { name: ev.name, input: null });
        break;
      case "tool.input": {
        const prev = t.running.get(ev.toolId);
        t.running.set(ev.toolId, { name: ev.name ?? prev?.name ?? "tool", input: ev.input });
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        const call = t.running.get(ev.toolId);
        t.running.delete(ev.toolId);
        if (!call) break;
        const result = ev.type === "tool.failed" ? `!${ev.error}\n${ev.output ?? ""}` : (ev.output ?? "");
        const exit = typeof ev.metadata?.exit === "number" ? ev.metadata.exit : null;
        t.calls.push({
          key: `${signature(call.name, call.input)}\u0000${exit ?? ""}\u0000${hash(normalizeOutput(result))}`,
          label: label(call.name, call.input),
          poll: isPoll(call.name, call.input),
        });
        if (t.calls.length > KEEP) t.calls.splice(0, t.calls.length - KEEP);
        this.evaluate(t);
        break;
      }
      case "permission.requested":
        t.waiting.add(`perm:${ev.request.id}`);
        break;
      case "permission.resolved":
        t.waiting.delete(`perm:${ev.requestId}`);
        break;
      case "form.requested":
        t.waiting.add(`form:${ev.form.id}`);
        break;
      case "form.resolved":
        if (ev.status !== "pending") t.waiting.delete(`form:${ev.formId}`);
        break;
      default:
        break;
    }
  }

  private evaluate(t: Track): void {
    const found = detect(t.calls, this.settings().repeats);
    if (!found) {
      t.muted = null;
      if (t.finding && t.finding.kind !== "stall") t.finding = null;
      return;
    }
    const id = identity(found);
    if (t.muted === id) return;
    t.muted = null;
    t.finding = found;
  }
}

/** The loop at the end of `calls`, if any. */
export function detect(calls: readonly Call[], repeats: number): StuckFinding | null {
  if (repeats < 2 || !calls.length) return null;
  const n = calls.length;
  const last = calls[n - 1];
  let same = 1;
  while (same < n && calls[n - 1 - same].key === last.key) same++;
  if (same >= repeats) return last.poll ? null : { kind: "repeat", call: last.label, count: same };
  // Two calls taking turns: A B A B A B.
  if (n < 2 * repeats) return null;
  const other = calls[n - 2];
  if (other.key === last.key || last.poll || other.poll) return null;
  let run = 2;
  while (run < n && calls[n - 1 - run].key === calls[n - 1 - run + 2].key) run++;
  if (run < 2 * repeats) return null;
  return { kind: "alternate", call: other.label, other: last.label, count: Math.floor(run / 2) };
}

/** Which loop a finding is, without its count (a dismissed loop stays dismissed as it grows). */
function identity(f: StuckFinding): string {
  if (f.kind === "stall") return "stall";
  const name = (c: CallLabel) => `${c.tool} ${c.arg ?? ""}`;
  return f.kind === "repeat"
    ? `r:${name(f.call)}`
    : `a:${[name(f.call), name(f.other)].sort().join("\u0000")}`;
}

/** Keys that describe a call rather than change it. */
const VOLATILE = new Set(["description", "explanation", "reason", "timeout", "title"]);
const PATH_KEY = /^(path|filePath|file_path|file|target|directory|dir|cwd|workdir)$/;

/** Tool name and input in a stable form: key order, spacing, slashes and drive-letter case do not matter. */
export function signature(name: string, input: Record<string, unknown> | null): string {
  return `${name.toLowerCase()} ${JSON.stringify(normalize(input ?? {}, ""))}`;
}

function normalize(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    const s = value.trim().replace(/\s+/g, " ");
    return PATH_KEY.test(key)
      ? s
          .replace(/\\/g, "/")
          .replace(/^([a-z]):/i, (_, d: string) => `${d.toLowerCase()}:`)
          .replace(/\/+$/, "")
      : s;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = normalize((value as Record<string, unknown>)[k], k);
    }
    return out;
  }
  return value;
}

/** Output with numbers and spacing evened out, so timings and counters do not make a loop look new. */
function normalizeOutput(s: string): string {
  return s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** FNV-1a, so a long output is kept as a few characters. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}:${s.length}`;
}

const POLL_TOOL = /(status|output|poll|wait|await|job|monitor|sleep|logs?)(\b|_|$)/i;
const POLL_COMMAND =
  /\b(sleep|start-sleep|wait|wait-job|wait-process|timeout|watch|tail|jobs|get-job|receive-job|status|ps|get-process)\b/i;

/** Calls that wait or check on something running: repeating them is how a job is followed. */
export function isPoll(name: string, input: Record<string, unknown> | null): boolean {
  if (POLL_TOOL.test(name)) return true;
  const d = describeTool(name, input);
  return d.category === "shell" && !!d.command && POLL_COMMAND.test(d.command);
}

function label(name: string, input: Record<string, unknown> | null): CallLabel {
  const d = describeTool(name, input);
  const firstLine = (s: string) => s.split("\n")[0].trim();
  if (d.command) return { tool: name, arg: clip(firstLine(d.command)), path: false };
  if (d.path) return { tool: name, arg: d.path, path: true };
  if (d.pattern) return { tool: name, arg: clip(d.pattern), path: false };
  const url = typeof input?.url === "string" ? input.url : null;
  if (url) return { tool: name, arg: clip(url), path: false };
  return { tool: name, arg: null, path: false };
}

function clip(s: string, max = 60): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
