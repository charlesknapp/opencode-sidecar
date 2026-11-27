import type { FileChange, ToolDetail, TranscriptItem, UiEvent } from "./model";
import { stepRate } from "./throughput";
import {
  describeTool,
  fileChangesFromMetadata,
  fileDiffsFromMetadata,
  mergeFileChanges,
  subagentSessionOf,
} from "./tools";

/** Hard cap on tool output kept in memory / sent to the webview. */
export const MAX_TOOL_OUTPUT = 20_000;

/**
 * Mutable transcript state. The same reducer runs in the extension host (the
 * canonical copy, used to restore the webview) and in the webview.
 */
export class Transcript {
  items: TranscriptItem[] = [];
  private index = new Map<string, number>();
  private turnFiles = new Map<string, FileChange>();
  private toolInputs = new Map<string, Record<string, unknown>>();
  private turn = 0;
  /** The open turn's steps, for its footer line. */
  private turnSteps = newTurnSteps();

  reset(items: TranscriptItem[] = []): void {
    this.items = [];
    this.index.clear();
    this.turnFiles.clear();
    this.toolInputs.clear();
    this.turnSteps = newTurnSteps();
    for (const item of items) this.upsert(item);
  }

  get(id: string): TranscriptItem | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** Position of an item in `items`, or -1. */
  indexOf(id: string): number {
    return this.index.get(id) ?? -1;
  }

  /** Inserts or replaces an item; returns its id. */
  upsert(item: TranscriptItem): string {
    const i = this.index.get(item.id);
    if (i === undefined) {
      this.index.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[i] = item;
    }
    return item.id;
  }

  /** Applies a normalized event. Returns ids of items that were added or changed. */
  apply(ev: UiEvent): string[] {
    switch (ev.type) {
      case "user.message": {
        const id = `user:${ev.id}`;
        if (this.has(id)) return [];
        this.turn++;
        this.turnFiles.clear();
        this.turnSteps = newTurnSteps();
        return [
          this.upsert({
            kind: "user",
            id,
            text: ev.text,
            attachments: ev.attachments,
            ...defined({ time: ev.time }),
          }),
        ];
      }
      case "assistant.delta":
      case "assistant.completed": {
        const id = `text:${ev.partId}`;
        const prev = this.get(id);
        const before = prev?.kind === "assistant" ? prev : undefined;
        const done = ev.type === "assistant.completed";
        const text = done ? ev.text : (before?.text ?? "") + ev.delta;
        const time = before?.time ?? ev.time;
        return [this.upsert({ kind: "assistant", id, text, streaming: !done, ...defined({ time }) })];
      }
      case "reasoning.delta":
      case "reasoning.completed": {
        const id = `think:${ev.partId}`;
        const prev = this.get(id);
        const before = prev?.kind === "reasoning" ? prev : undefined;
        if (ev.type === "reasoning.completed") {
          if (ev.text.trim() === "" && !before) return [];
          const started = before?.started ?? ev.started;
          return [
            this.upsert({
              kind: "reasoning",
              id,
              text: ev.text,
              streaming: false,
              ...defined({ started, ended: ev.time }),
            }),
          ];
        }
        const text = (before?.text ?? "") + ev.delta;
        const started = before?.started ?? ev.time;
        return [this.upsert({ kind: "reasoning", id, text, streaming: true, ...defined({ started }) })];
      }
      case "subagent.report": {
        const item: TranscriptItem = {
          kind: "handback",
          id: `handback:${ev.id}`,
          childID: ev.childID,
          agent: ev.agent,
          state: ev.state,
          description: ev.description,
          report: ev.text,
        };
        if (ev.time !== undefined) item.time = ev.time;
        return [this.upsert(item)];
      }
      case "background.notice": {
        const item: TranscriptItem = {
          kind: "background",
          id: `background:${ev.id}`,
          source: ev.source,
          state: ev.state,
          text: ev.text,
          command: ev.command,
          path: ev.path,
        };
        if (ev.time !== undefined) item.time = ev.time;
        return [this.upsert(item)];
      }
      case "tool.started": {
        const id = `tool:${ev.toolId}`;
        if (this.has(id)) return [];
        const d = describeTool(ev.name, null);
        return [
          this.upsert({
            kind: "tool",
            id,
            name: ev.name,
            title: d.title,
            category: d.category,
            status: "pending",
            detail: emptyDetail(),
          }),
        ];
      }
      case "tool.input": {
        const id = `tool:${ev.toolId}`;
        const prev = this.get(id);
        const name = ev.name ?? (prev?.kind === "tool" ? prev.name : "tool");
        this.toolInputs.set(ev.toolId, ev.input);
        const d = describeTool(name, ev.input);
        const detail = prev?.kind === "tool" ? { ...prev.detail } : emptyDetail();
        detail.facts = d.facts;
        detail.command = d.command ?? detail.command;
        if (d.category === "agent") detail.subagent = subagentSessionOf(null, ev.input) ?? detail.subagent;
        if (d.path) detail.path = d.path;
        if (d.pattern) detail.pattern = d.pattern;
        if (d.description) detail.description = d.description;
        if (d.written) detail.written = d.written;
        if (d.prompt) detail.prompt = d.prompt;
        if (d.todos) detail.todos = d.todos;
        const status = prev?.kind === "tool" && prev.status !== "pending" ? prev.status : "running";
        return [
          this.upsert({ kind: "tool", id, name, title: d.title, category: d.category, status, detail }),
        ];
      }
      case "tool.shell": {
        const id = `tool:${ev.toolId}`;
        const prev = this.get(id);
        if (prev?.kind !== "tool") return [];
        const detail = {
          ...prev.detail,
          cwd: ev.cwd ?? prev.detail.cwd,
          command: prev.detail.command ?? ev.command,
        };
        return [this.upsert({ ...prev, detail })];
      }
      case "tool.completed":
      case "tool.failed": {
        const id = `tool:${ev.toolId}`;
        const prev = this.get(id);
        const base =
          prev?.kind === "tool"
            ? prev
            : {
                kind: "tool" as const,
                id,
                name: "tool",
                title: "Tool",
                category: "other" as const,
                status: "pending" as const,
                detail: emptyDetail(),
              };
        const detail: ToolDetail = { ...base.detail };
        if (ev.output !== null) {
          detail.output =
            ev.output.length > MAX_TOOL_OUTPUT ? ev.output.slice(0, MAX_TOOL_OUTPUT) : ev.output;
          detail.outputTruncated = ev.output.length > MAX_TOOL_OUTPUT || ev.metadata?.truncated === true;
        }
        if (typeof ev.metadata?.exit === "number") detail.exitCode = ev.metadata.exit;
        const files = fileChangesFromMetadata(ev.metadata);
        if (files.length) {
          detail.files = files;
          mergeFileChanges(this.turnFiles, files);
        }
        const diffs = fileDiffsFromMetadata(ev.metadata);
        if (diffs.length) detail.diffs = diffs;
        if (ev.type === "tool.failed") detail.error = ev.error;
        if (base.category === "media") {
          const path = typeof ev.metadata?.path === "string" ? ev.metadata.path : null;
          if (path) detail.path = path;
          detail.media = {
            kind: /video/i.test(base.name) || ev.metadata?.source === "generate_video" ? "video" : "image",
            state: typeof ev.metadata?.state === "string" ? ev.metadata.state : null,
          };
        }
        if (base.category === "agent")
          detail.subagent =
            subagentSessionOf(ev.metadata, this.toolInputs.get(ev.toolId) ?? null) ?? detail.subagent;
        const failed = ev.type === "tool.failed" || (detail.exitCode !== null && detail.exitCode !== 0);
        return [this.upsert({ ...base, status: failed ? "failed" : "completed", detail })];
      }
      case "permission.requested": {
        const id = `perm:${ev.request.id}`;
        const prev = this.get(id);
        if (prev?.kind === "permission" && prev.status !== "pending" && prev.status !== "sending") return [];
        return [
          this.upsert({
            kind: "permission",
            id,
            request: ev.request,
            sensitive: ev.sensitive,
            status: "pending",
          }),
        ];
      }
      case "permission.sending":
      case "permission.resolved": {
        const id = `perm:${ev.requestId}`;
        const prev = this.get(id);
        if (prev?.kind !== "permission") return [];
        const status = ev.type === "permission.sending" ? "sending" : ev.decision;
        const feedback = ev.type === "permission.resolved" ? ev.feedback : undefined;
        return [this.upsert({ ...prev, status, ...(feedback ? { feedback } : {}) })];
      }
      case "session.idle": {
        const changed: string[] = [];
        for (const item of this.items) {
          if ((item.kind === "assistant" || item.kind === "reasoning") && item.streaming) {
            changed.push(this.upsert({ ...item, streaming: false }));
          } else if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) {
            const status = ev.outcome === "succeeded" ? "completed" : "failed";
            const detail = {
              ...item.detail,
              error: item.detail.error ?? (ev.outcome === "interrupted" ? "Interrupted" : null),
            };
            changed.push(this.upsert({ ...item, status, detail }));
          } else if (
            item.kind === "permission" &&
            (item.status === "pending" || item.status === "sending") &&
            ownedBy(item.request.sessionID, ev.sessionID)
          ) {
            changed.push(this.upsert({ ...item, status: "expired" }));
          } else if (
            item.kind === "form" &&
            (item.status === "pending" || item.status === "sending") &&
            ownedBy(item.form.sessionID, ev.sessionID)
          ) {
            changed.push(this.upsert({ ...item, status: "expired" }));
          }
        }
        if (this.turnFiles.size) {
          const files = [...this.turnFiles.values()];
          changed.push(this.upsert({ kind: "turn-summary", id: `summary:${this.turn}`, files }));
          this.turnFiles.clear();
        }
        // The footer covers the whole turn: a subagent report that wakes the session adds its steps.
        const steps = this.turnSteps;
        if (steps.steps) {
          changed.push(
            this.upsert({
              kind: "turn-meta",
              id: `meta:${this.turn}`,
              models: [...steps.models],
              steps: steps.steps,
              tokens: steps.tokens,
              rate: steps.streamMs > 0 ? steps.timedTokens / (steps.streamMs / 1000) : null,
              cost: steps.cost,
            }),
          );
        }
        if (ev.outcome === "interrupted") {
          changed.push(
            this.upsert({ kind: "notice", id: `stopped:${this.turn}`, level: "info", text: "Stopped." }),
          );
        }
        return changed;
      }
      case "session.error":
        return [
          this.upsert({
            kind: "notice",
            id: `error:${this.turn}:${this.items.length}`,
            level: "error",
            text: ev.message,
          }),
        ];
      case "session.retry":
        return [
          this.upsert({
            kind: "notice",
            id: `retry:${this.turn}`,
            level: "info",
            text: `Retrying (attempt ${ev.attempt}): ${ev.message}`,
          }),
        ];
      case "error":
        return [
          this.upsert({
            kind: "error",
            id: ev.id,
            title: ev.title,
            detail: ev.detail,
            actions: ev.actions,
            ...(ev.provider ? { provider: ev.provider } : {}),
          }),
        ];
      case "form.requested": {
        const id = `form:${ev.form.id}`;
        const prev = this.get(id);
        if (prev?.kind === "form" && prev.status !== "pending" && prev.status !== "sending") return [];
        return [this.upsert({ kind: "form", id, form: ev.form, status: "pending", answer: null })];
      }
      case "form.sending":
      case "form.resolved": {
        const id = `form:${ev.formId}`;
        const prev = this.get(id);
        if (prev?.kind !== "form") return [];
        if (ev.type === "form.sending") return [this.upsert({ ...prev, status: "sending" })];
        if (prev.status === "answered" && ev.status !== "answered") return [];
        return [this.upsert({ ...prev, status: ev.status, answer: ev.answer ?? prev.answer })];
      }
      case "usage.step": {
        const t = this.turnSteps;
        t.steps++;
        t.tokens += ev.tokens.output + ev.tokens.reasoning;
        if (ev.modelKey && !t.models.includes(ev.modelKey)) t.models.push(ev.modelKey);
        if (ev.cost != null) t.cost = (t.cost ?? 0) + ev.cost;
        // Only steps OpenCode timed count toward the speed.
        if (stepRate(ev.tokens, ev.streamMs) !== null) {
          t.timedTokens += ev.tokens.output + ev.tokens.reasoning;
          t.streamMs += ev.streamMs!;
        }
        return [];
      }
      case "budget":
        return [this.upsert({ kind: "budget", id: ev.id, state: ev.state, text: ev.text, resolved: null })];
      case "budget.resolved": {
        const prev = this.get(ev.id);
        if (prev?.kind !== "budget") return [];
        return [this.upsert({ ...prev, resolved: ev.resolution })];
      }
      case "history.unreadable":
        return [
          this.upsert({ kind: "unreadable", id: `unreadable:${ev.id}`, messageID: ev.id, reason: ev.reason }),
        ];
      case "stuck": {
        const prev = this.get(ev.id);
        // A card the user dismissed or stopped stays that way when the loop grows.
        if (prev?.kind === "stuck" && prev.resolved && prev.resolved !== "moved-on") return [];
        return [
          this.upsert({ kind: "stuck", id: ev.id, sessionID: ev.sessionID, stuck: ev.stuck, resolved: null }),
        ];
      }
      case "stuck.resolved": {
        const prev = this.get(ev.id);
        if (prev?.kind !== "stuck" || prev.resolved === ev.resolution) return [];
        return [this.upsert({ ...prev, resolved: ev.resolution })];
      }
      case "notice":
        return [
          this.upsert({ kind: "notice", id: `notice:${this.items.length}`, level: ev.level, text: ev.text }),
        ];
      default:
        return [];
    }
  }
}

function newTurnSteps() {
  return {
    steps: 0,
    tokens: 0,
    timedTokens: 0,
    streamMs: 0,
    cost: null as number | null,
    models: [] as string[],
  };
}

/** Event types whose items show a time in the timeline. */
const TIMED = new Set<UiEvent["type"]>([
  "user.message",
  "assistant.delta",
  "assistant.completed",
  "reasoning.delta",
  "reasoning.completed",
  "subagent.report",
  "background.notice",
]);

/**
 * Gives a live event the time it arrived, unless it already has one. OpenCode's live
 * events carry no timestamp; stored history does (see `historyToEvents`). Stamping
 * in the host keeps the host's and the webview's transcripts identical.
 */
export function stampTime(ev: UiEvent, now: number): UiEvent {
  if (!TIMED.has(ev.type) || ("time" in ev && ev.time !== undefined)) return ev;
  return { ...ev, time: now } as UiEvent;
}

/** Copies only the keys whose value is defined, so optional fields stay absent rather than `undefined`. */
function defined<T extends Record<string, number | undefined>>(o: T): Partial<Record<keyof T, number>> {
  const out: Partial<Record<keyof T, number>> = {};
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** A request belongs to the idle session; without a session ID (replayed history) every request does. */
function ownedBy(requestSession: string, idleSession: string | undefined): boolean {
  return idleSession === undefined || requestSession === idleSession;
}

export function emptyDetail(): ToolDetail {
  return {
    facts: [],
    command: null,
    cwd: null,
    output: null,
    outputTruncated: false,
    exitCode: null,
    files: [],
    error: null,
    subagent: null,
  };
}
