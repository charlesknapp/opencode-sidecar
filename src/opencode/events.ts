// Maps OpenCode v2 event envelopes and stored messages onto the internal UiEvent
// model. Raw transport objects never leave this module.

import { findSensitive } from "../core/sensitive";
import { parseForm } from "../core/forms";
import { parseRules } from "../shared/approval";
import type {
  FormAnswer,
  GoalState,
  PermissionRequest,
  RawError,
  TokenUsage,
  UiEvent,
} from "../shared/model";
import { splitUserText } from "../shared/userText";

type Rec = Record<string, unknown>;

export interface NormalizedEnvelope {
  /** Session the events belong to; null for global events. */
  sessionID: string | null;
  events: UiEvent[];
  /** True when the set of sessions changed (created/deleted/renamed). */
  sessionsChanged: boolean;
  /** Directory the event was scoped to, when OpenCode provided one. */
  directory: string | null;
  /** For `session.created`: the parent session, set when the new session is a subagent. */
  parentID: string | null;
  /** For `session.created`: the new session's title and agent, when OpenCode provided them. */
  created: { title: string | null; agent: string | null } | null;
}

const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function toTokenUsage(v: unknown): TokenUsage | null {
  const t = rec(v);
  if (!t) return null;
  const cache = rec(t.cache);
  return {
    input: n(t.input),
    output: n(t.output),
    reasoning: n(t.reasoning),
    cacheRead: n(cache?.read),
    cacheWrite: n(cache?.write),
  };
}

/** A cost in USD, or null when OpenCode did not report one (0 is a real cost: a free model's). */
function cost(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** How long the model streamed (first token to end of stream), when both were timed. */
function streamTime(first: number | undefined, end: number | undefined): { streamMs?: number } {
  return first !== undefined && end !== undefined && end > first ? { streamMs: end - first } : {};
}

export function modelKey(v: unknown): string | null {
  const m = rec(v);
  const provider = s(m?.providerID);
  const id = s(m?.id);
  return provider && id ? `${provider}/${id}` : null;
}

/** Concatenates text content blocks of a tool result. */
export function toolOutput(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const c of content) {
    const r = rec(c);
    if (r?.type === "text" && typeof r.text === "string") texts.push(r.text);
    else if (r?.type === "file") texts.push(`[file ${s(r.name) ?? s(r.uri) ?? ""}]`);
  }
  return texts.length ? texts.join("\n") : null;
}

function errorMessage(v: unknown, fallback: string): string {
  const e = rec(v);
  return s(e?.message) ?? fallback;
}

export function toRawError(v: unknown): RawError | null {
  const e = rec(v);
  if (!e) return null;
  return {
    type: s(e.type) ?? "unknown",
    message: s(e.message) ?? "",
    status: typeof e.status === "number" ? e.status : null,
    body: s(rec(e.response)?.body),
  };
}

function answerOf(v: unknown): FormAnswer | null {
  const r = rec(v);
  if (!r) return null;
  const out: FormAnswer = {};
  for (const [k, x] of Object.entries(r)) {
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = x;
    else if (Array.isArray(x)) out[k] = x.filter((y): y is string => typeof y === "string");
  }
  return out;
}

export function toPermissionRequest(v: unknown): PermissionRequest | null {
  const d = rec(v);
  const id = s(d?.id);
  const sessionID = s(d?.sessionID);
  if (!d || !id || !sessionID) return null;
  const resources = Array.isArray(d.resources)
    ? d.resources.filter((r): r is string => typeof r === "string")
    : [];
  const save = Array.isArray(d.save) ? d.save : [];
  const source = rec(d.source);
  return {
    id,
    sessionID,
    action: s(d.action) ?? "unknown",
    resources,
    canAlways: save.length > 0,
    patterns: save.filter((x): x is string => typeof x === "string"),
    message: s(d.message),
    toolId: s(source?.id),
  };
}

/**
 * A subagent's report to its parent: an OpenCode synthetic message whose metadata
 * says `source: "subagent"`. The text arrives wrapped as
 * `<subagent sessionID=… state=… description=…>report</subagent>`, or since OpenCode 2.4
 * `<background-result kind="subagent" …>report</background-result>`; the wrapper is
 * dropped. Other synthetic messages (e.g. shell notices) return null.
 */
export function subagentReport(id: string, raw: Record<string, unknown>, time?: number): UiEvent | null {
  const meta = rec(raw.metadata);
  if (meta?.source !== "subagent") return null;
  const text = s(raw.text) ?? "";
  const wrapped =
    /^\s*<subagent\b[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/subagent>\s*$/.exec(text) ??
    /^\s*<background-result\b[^\n]*>\r?\n([\s\S]*?)\r?\n?(?:<\/background-result>)?\s*$/.exec(text);
  return {
    type: "subagent.report",
    id,
    childID: s(meta.childID),
    agent: s(meta.agent),
    state: s(meta.state),
    description: s(raw.description),
    text: (wrapped ? wrapped[1] : text).trim(),
    ...(time !== undefined ? { time } : {}),
  };
}

/**
 * Anything else OpenCode posts into a session on its own: a goal's progress, a
 * background shell's result, a finished image or video job. A background shell's
 * text arrives wrapped as `<background-result kind=… state=… command=…>…</background-result>`;
 * the wrapper is dropped and its attributes fill in what the metadata leaves out.
 */
export function backgroundNotice(id: string, raw: Record<string, unknown>, time?: number): UiEvent | null {
  const meta = rec(raw.metadata);
  const source = s(meta?.source);
  if (!source || source === "subagent") return null;
  const text = s(raw.text) ?? "";
  // The opening tag ends its line; attribute values (a shell command) may contain ">".
  const wrapped = /^\s*<background-result\b([^\n]*)>\r?\n([\s\S]*?)\r?\n?(?:<\/background-result>)?\s*$/.exec(
    text,
  );
  const attrs: Record<string, string> = {};
  if (wrapped) for (const [, k, v] of wrapped[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[k] = v;
  const goal = source === "goal" ? goalNotice(text) : null;
  return {
    type: "background.notice",
    id,
    source,
    state: goal?.state ?? s(meta?.state) ?? attrs.state ?? null,
    text: goal?.text ?? (wrapped ? wrapped[2] : text).trim(),
    // The description is the command as typed; the wrapper's attribute breaks on quotes in it.
    command: source === "shell" ? (s(raw.description) ?? attrs.command ?? null) : null,
    path: s(meta?.path) ?? null,
    ...(time !== undefined ? { time } : {}),
  };
}

/** OpenCode's `Goal.State` (its goal plugin's RPC and events); null for none or anything else. */
export function parseGoal(v: unknown): GoalState | null {
  const g = rec(v);
  const id = s(g?.id);
  const objective = s(g?.objective);
  const status = g?.status;
  if (!g || !id || !objective || (status !== "active" && status !== "paused" && status !== "complete"))
    return null;
  return {
    id,
    objective,
    status,
    reason: s(g.reason) || null,
    rounds: n(g.rounds),
    maxRounds: typeof g.maxRounds === "number" && g.maxRounds > 0 ? g.maxRounds : null,
  };
}

/** Sentences of OpenCode's goal prompt that speak to the model, not to the user. */
const GOAL_INSTRUCTIONS = [
  /^A goal is now active for this session\b/,
  /^The objective below is user-provided data\b/,
  /^Start now\. Treat the objective as your directive\b/,
  /^When you end a turn, a reviewer checks\b/,
  /^If you are blocked and need something only the user can provide\b/,
];

/**
 * A goal notice for people: the objective (OpenCode wraps it in `<untrusted_objective>`
 * for the model) and any reason or next step, without the instructions to the model.
 * "set" when the notice starts the goal. Null when the text has no objective to show.
 */
function goalNotice(text: string): { state: string | null; text: string } | null {
  const objective = /<untrusted_objective>\s*([\s\S]*?)\s*<\/untrusted_objective>/.exec(text);
  if (!objective) return null;
  const rest = text
    .replace(objective[0], "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !GOAL_INSTRUCTIONS.some((re) => re.test(l)));
  return {
    state: /^\s*A goal is now active\b/.test(text) ? "set" : null,
    text: [objective[1].trim(), ...rest].join("\n"),
  };
}

function userMessageEvent(id: string, text: string, files: unknown): UiEvent {
  const split = splitUserText(text);
  const names: string[] = [];
  if (Array.isArray(files)) {
    for (const f of files) {
      const r = rec(f);
      const src = rec(r?.source);
      const name = s(r?.name) ?? s(r?.uri) ?? s(src?.uri);
      if (name) names.push(name.split(/[\\/]/).pop() ?? name);
    }
  }
  return {
    type: "user.message",
    id,
    text: split.text,
    attachments: [...names, ...split.snippets],
    raw: text,
  };
}

/**
 * Stateful normalizer: remembers which shell belongs to which tool call (so a
 * command row can show its working directory) and which model produced a step.
 */
export class EventNormalizer {
  private shells = new Map<string, { cwd: string | null; command: string | null }>();
  private shellTool = new Map<string, { sessionID: string; toolId: string }>();
  /** Per step: its model and agent, and when its first token and the end of its stream arrived. */
  private steps = new Map<
    string,
    { model: string | null; agent: string | null; firstToken?: number; streamed?: number }
  >();
  /** Last model used per session, so execution failures can name the model. */
  private sessionModel = new Map<string, string>();

  normalize(raw: unknown): NormalizedEnvelope | null {
    const env = rec(raw);
    const type = s(env?.type);
    if (!env || !type) return null;
    const data = rec(env.data) ?? {};
    const directory = s(rec(env.location)?.directory);
    const sessionID = s(data.sessionID) ?? s(rec(data.form)?.sessionID);
    const out = (
      events: UiEvent[],
      sessionsChanged = false,
      parentID: string | null = null,
    ): NormalizedEnvelope => ({
      sessionID,
      events,
      sessionsChanged,
      directory,
      parentID,
      created: null,
    });
    const idle = (outcome: "succeeded" | "failed" | "interrupted"): UiEvent =>
      sessionID ? { type: "session.idle", outcome, sessionID } : { type: "session.idle", outcome };
    const partId = () => `${s(data.assistantMessageID) ?? "?"}:${n(data.ordinal)}`;
    const toolId = s(data.id) ?? "?";

    switch (type) {
      case "session.created":
        return {
          ...out([], true, s(data.parentID)),
          created: { title: s(data.title), agent: s(data.agent) ?? s(rec(data.agent)?.id) },
        };
      case "session.deleted":
        return out([], true);
      case "session.renamed":
        return out([{ type: "session.renamed", title: s(data.title) ?? "" }], true);
      case "session.inbox.enqueued": {
        const item = rec(data.item);
        const payload = rec(item?.payload);
        // OpenCode 2.4 delivers subagent reports and background notices through the inbox.
        if (item?.type === "synthetic" && payload) {
          const id = s(data.inboxID) ?? "?";
          const report = subagentReport(id, payload) ?? backgroundNotice(id, payload);
          return out(report ? [report] : []);
        }
        if (item?.type !== "user" || !payload) return out([]);
        const msg = userMessageEvent(s(data.inboxID) ?? "?", s(payload.text) ?? "", payload.files);
        if (msg.type !== "user.message") return out([]);
        const delivery = item.delivery === "queue" ? "queue" : "steer";
        return out([
          {
            type: "inbox.enqueued",
            id: msg.id,
            text: msg.text,
            attachments: msg.attachments,
            delivery,
            raw: msg.raw,
          },
        ]);
      }
      case "session.inbox.delivered":
        return out([{ type: "inbox.delivered", id: s(data.inboxID) ?? "?" }]);
      case "session.inbox.cancelled":
        return out([{ type: "inbox.cancelled", id: s(data.inboxID) ?? "?" }]);
      case "session.inbox.delivery.changed":
        return out([
          {
            type: "inbox.delivery",
            id: s(data.inboxID) ?? "?",
            delivery: data.delivery === "queue" ? "queue" : "steer",
          },
        ]);
      case "form.created": {
        const form = parseForm(data.form);
        return form ? out([{ type: "form.requested", form }]) : null;
      }
      case "form.replied": {
        const id = s(data.id);
        return id
          ? out([{ type: "form.resolved", formId: id, status: "answered", answer: answerOf(data.answer) }])
          : null;
      }
      case "form.cancelled": {
        const id = s(data.id);
        return id ? out([{ type: "form.resolved", formId: id, status: "cancelled", answer: null }]) : null;
      }
      case "session.execution.started":
        return out([{ type: "session.busy" }]);
      case "session.execution.succeeded":
        return out([idle("succeeded")], true);
      case "session.execution.interrupted":
        return out([idle("interrupted")], true);
      case "session.execution.failed":
        return out(
          [
            {
              type: "session.error",
              message: errorMessage(data.error, "The session failed."),
              error: toRawError(data.error),
              modelKey: sessionID ? (this.sessionModel.get(sessionID) ?? null) : null,
            },
            idle("failed"),
          ],
          true,
        );
      case "session.synthetic": {
        const id =
          s(data.id) ?? s(data.messageID) ?? `${sessionID ?? "?"}:${s(rec(data.metadata)?.childID) ?? "?"}`;
        const report = subagentReport(id, data) ?? backgroundNotice(id, data);
        return out(report ? [report] : []);
      }
      case "session.text.delta":
        return out([{ type: "assistant.delta", partId: partId(), delta: s(data.delta) ?? "" }]);
      case "session.text.ended":
        return out([{ type: "assistant.completed", partId: partId(), text: s(data.text) ?? "" }]);
      case "session.reasoning.delta":
        return out([{ type: "reasoning.delta", partId: partId(), delta: s(data.delta) ?? "" }]);
      case "session.reasoning.ended":
        return out([{ type: "reasoning.completed", partId: partId(), text: s(data.text) ?? "" }]);
      case "session.tool.input.started":
        return out([{ type: "tool.started", toolId, name: s(data.name) ?? "tool" }]);
      case "session.tool.called":
        return out([{ type: "tool.input", toolId, name: null, input: rec(data.input) ?? {} }]);
      case "session.tool.progress": {
        const shellID = s(rec(data.metadata)?.shellID);
        if (!shellID || !sessionID) return out([]);
        this.shellTool.set(shellID, { sessionID, toolId });
        const info = this.shells.get(shellID);
        return out(info ? [{ type: "tool.shell", toolId, cwd: info.cwd, command: info.command }] : []);
      }
      case "shell.created": {
        const info = rec(data.info);
        const shellID = s(info?.id);
        if (!info || !shellID) return null;
        const entry = { cwd: s(info.cwd), command: s(info.command) };
        this.shells.set(shellID, entry);
        const link = this.shellTool.get(shellID);
        if (!link) return null;
        return {
          sessionID: link.sessionID,
          events: [{ type: "tool.shell", toolId: link.toolId, cwd: entry.cwd, command: entry.command }],
          sessionsChanged: false,
          directory,
          parentID: null,
          created: null,
        };
      }
      case "shell.deleted": {
        const id = s(data.id);
        if (id) {
          this.shells.delete(id);
          this.shellTool.delete(id);
        }
        return null;
      }
      case "session.tool.success":
        return out([
          { type: "tool.completed", toolId, output: toolOutput(data.content), metadata: rec(data.metadata) },
        ]);
      case "session.tool.failed":
        return out([
          {
            type: "tool.failed",
            toolId,
            error: errorMessage(data.error, "Tool failed"),
            output: toolOutput(data.content),
            metadata: rec(data.metadata),
          },
        ]);
      case "permission.asked": {
        const request = toPermissionRequest(data);
        if (!request) return null;
        return out([
          { type: "permission.requested", request, sensitive: describeSensitive(request.resources) },
        ]);
      }
      case "permission.replied": {
        const requestId = s(data.requestID);
        const reply = data.reply;
        if (!requestId || (reply !== "once" && reply !== "always" && reply !== "reject")) return null;
        return out([{ type: "permission.resolved", requestId, decision: reply }]);
      }
      case "session.step.started": {
        const id = s(data.assistantMessageID);
        const key = modelKey(data.model);
        const agent = s(data.agent);
        if (id) this.steps.set(id, { model: key, agent });
        if (sessionID && key) this.sessionModel.set(sessionID, key);
        return out([{ type: "step.started", modelKey: key, agent }]);
      }
      case "session.step.first-token":
      case "session.step.streamed": {
        // OpenCode stores these times as the message's `time.firstToken` and `time.streamed`.
        const step = this.steps.get(s(data.assistantMessageID) ?? "");
        const at = typeof env.created === "number" ? env.created : Date.now();
        if (step && type === "session.step.first-token") step.firstToken = at;
        else if (step) step.streamed = at;
        return out([]);
      }
      case "session.step.ended":
      case "session.step.failed": {
        const events: UiEvent[] = [];
        const files = Array.isArray(data.files)
          ? data.files.filter((f): f is string => typeof f === "string")
          : [];
        if (files.length) events.push({ type: "files.changed", files });
        const tokens = toTokenUsage(data.tokens);
        const msgId = s(data.assistantMessageID);
        const step = msgId ? this.steps.get(msgId) : undefined;
        if (tokens)
          events.push({
            type: "usage.step",
            tokens,
            modelKey: step?.model ?? null,
            cost: cost(data.cost),
            agent: step?.agent ?? null,
            ...streamTime(step?.firstToken, step?.streamed),
          });
        if (msgId) this.steps.delete(msgId);
        return out(events);
      }
      case "session.usage.updated": {
        const tokens = toTokenUsage(data.tokens);
        return out(tokens ? [{ type: "usage.session", cost: n(data.cost), tokens }] : []);
      }
      case "session.retry.scheduled":
        return out([
          {
            type: "session.retry",
            attempt: n(data.attempt),
            message: errorMessage(data.error, "Provider error"),
          },
        ]);
      case "session.shell.started": {
        // `!command` typed in the chat: shown like a shell tool call.
        const shell = rec(data.shell);
        const id = s(shell?.id);
        if (!id) return out([]);
        const toolId = `shell-live:${id}`;
        return out([
          { type: "tool.started", toolId, name: "shell" },
          { type: "tool.input", toolId, name: "shell", input: { command: s(shell?.command) ?? "" } },
          { type: "tool.shell", toolId, cwd: s(shell?.cwd), command: s(shell?.command) },
        ]);
      }
      case "session.shell.ended": {
        const shell = rec(data.shell);
        const id = s(shell?.id);
        if (!id) return out([]);
        const output = rec(data.output);
        const exit = shell?.exit;
        return out([
          {
            type: "tool.completed",
            toolId: `shell-live:${id}`,
            output: s(output?.output),
            metadata: {
              ...(typeof exit === "number" ? { exit } : {}),
              ...(output?.truncated === true ? { truncated: true } : {}),
            },
          },
        ]);
      }
      case "session.revert.staged":
      case "session.revert.committed":
      case "session.revert.cleared":
        // A rewind from any client (Sidecar, the TUI, another window) changes the history.
        return out([{ type: "session.reverted" }], true);
      case "session.agent.selected": {
        const agent = s(data.agent) ?? s(rec(data.agent)?.id);
        return out(agent ? [{ type: "session.selection", agent }] : []);
      }
      case "session.model.selected": {
        const key = modelKey(data.model);
        return out(
          key ? [{ type: "session.selection", modelKey: key, variant: s(rec(data.model)?.variant) }] : [],
        );
      }
      case "session.permissions":
        // The whole list, from Sidecar, the TUI or another client.
        return out([{ type: "session.permissions", rules: parseRules(data.permissions) }]);
      case "rpc.opencode.goal.changed":
        // The goal plugin's own event: the whole goal, or null once cleared.
        return out([{ type: "goal.changed", goal: parseGoal(data.goal) }]);
      case "session.compaction.ended":
        return out([{ type: "notice", level: "info", text: "Conversation context was compacted." }]);
      case "session.skill.activated":
        return out([
          {
            type: "notice",
            level: "info",
            text: `Skill activated: ${s(data.name) ?? s(data.id) ?? "skill"}`,
          },
        ]);
      case "session.archived":
      case "session.unarchived":
      case "session.forked":
      case "session.moved":
        return out([], true);
      case "session.compaction.started":
        return out([{ type: "notice", level: "info", text: "Compacting conversation context…" }]);
      case "session.compaction.failed":
        return out([
          {
            type: "notice",
            level: "error",
            text: `Context compaction failed: ${errorMessage(data.error, "unknown error")}`,
          },
        ]);
      default:
        return out([]);
    }
  }
}

export function describeSensitive(resources: readonly string[]): string[] {
  return findSensitive(resources).map((m) => `${m.value} — ${m.reason}`);
}

/** A positive epoch-ms timestamp from an OpenCode `time` record, if present. */
function time(raw: unknown, key: "created" | "completed" | "firstToken" | "streamed"): number | undefined {
  const v = rec(raw)?.[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Replays stored session messages (oldest first) as UiEvents so history and
 * live streaming share one rendering path.
 */
export function historyToEvents(messages: readonly unknown[]): UiEvent[] {
  const events: UiEvent[] = [];
  for (const raw of messages) {
    const m = rec(raw);
    if (!m) continue;
    const id = s(m.id) ?? "?";
    // OpenCode stores times in epoch milliseconds: messages have time.created, reasoning
    // parts time.created/completed.
    const created = time(m.time, "created");
    switch (m.type) {
      case "user": {
        const ev = userMessageEvent(id, s(m.text) ?? "", m.files);
        events.push(created !== undefined && ev.type === "user.message" ? { ...ev, time: created } : ev);
        break;
      }
      case "assistant": {
        const counters = { text: 0, reasoning: 0 };
        const content = Array.isArray(m.content) ? m.content : [];
        for (const partRaw of content) {
          const part = rec(partRaw);
          if (!part) continue;
          if (part.type === "text") {
            const at = time(part.time, "created") ?? created;
            events.push({
              type: "assistant.completed",
              partId: `${id}:${counters.text++}`,
              text: s(part.text) ?? "",
              ...(at !== undefined ? { time: at } : {}),
            });
          } else if (part.type === "reasoning") {
            const started = time(part.time, "created");
            const ended = time(part.time, "completed");
            events.push({
              type: "reasoning.completed",
              partId: `${id}:${counters.reasoning++}`,
              text: s(part.text) ?? "",
              ...(started !== undefined ? { started } : {}),
              ...(ended !== undefined ? { time: ended } : {}),
            });
          } else if (part.type === "tool") {
            const toolId = s(part.id) ?? "?";
            const state = rec(part.state) ?? {};
            events.push({ type: "tool.started", toolId, name: s(part.name) ?? "tool" });
            events.push({ type: "tool.input", toolId, name: s(part.name), input: rec(state.input) ?? {} });
            if (state.status === "completed") {
              events.push({
                type: "tool.completed",
                toolId,
                output: toolOutput(state.content),
                metadata: rec(state.metadata),
              });
            } else if (state.status === "error") {
              events.push({
                type: "tool.failed",
                toolId,
                error: errorMessage(state.error, "Tool failed"),
                output: toolOutput(state.content),
                metadata: rec(state.metadata),
              });
            }
          }
        }
        const tokens = toTokenUsage(m.tokens);
        const finished = time(m.time, "completed");
        if (tokens)
          events.push({
            type: "usage.step",
            tokens,
            modelKey: modelKey(m.model),
            cost: cost(m.cost),
            agent: s(m.agent),
            ...streamTime(time(m.time, "firstToken"), time(m.time, "streamed")),
            ...(finished !== undefined ? { time: finished } : {}),
          });
        if (rec(m.error) && m.finish === "error") {
          events.push({
            type: "session.error",
            message: errorMessage(m.error, "The step failed."),
            error: toRawError(m.error),
            modelKey: modelKey(m.model),
          });
        }
        break;
      }
      case "shell": {
        const toolId = `shell-msg:${id}`;
        events.push({ type: "tool.started", toolId, name: "shell" });
        events.push({ type: "tool.input", toolId, name: "shell", input: { command: s(m.command) ?? "" } });
        const output = s(rec(m.output)?.output);
        events.push({
          type: "tool.completed",
          toolId,
          output,
          metadata: typeof m.exit === "number" ? { exit: m.exit } : null,
        });
        break;
      }
      case "synthetic": {
        const report = subagentReport(id, m, created) ?? backgroundNotice(id, m, created);
        if (report) events.push(report);
        break;
      }
      case "compaction":
        events.push({ type: "notice", level: "info", text: "Conversation context was compacted." });
        break;
      case "idle": {
        const outcome = m.outcome === "failed" || m.outcome === "interrupted" ? m.outcome : "succeeded";
        events.push({ type: "session.idle", outcome });
        break;
      }
      default:
        break;
    }
  }
  return events;
}
