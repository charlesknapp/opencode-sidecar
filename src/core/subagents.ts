// Progress of the subagents started by the open session. OpenCode runs each subagent in
// a child session (`session.created` with `parentID`); subagents can start their own. The
// tracker keeps one compact view per subagent session, built from that session's events,
// for the subagent cards and the Current Task bar. Their full conversations are loaded
// only when the user opens one.

import type { SessionSummary, SubagentActivity, SubagentView, UiEvent } from "../shared/model";
import { describeTool } from "../shared/tools";

/** Upper bound on subagent sessions followed for one open session (including nested ones). */
export const MAX_SUBAGENTS = 200;

interface Entry {
  view: SubagentView;
  tools: Set<string>;
  files: Set<string>;
  /** Pending permission requests and questions raised by this subagent. */
  waiting: Set<string>;
  /** Tool calls that are running, so the activity can fall back to the previous one. */
  toolNames: Map<string, string>;
}

export class SubagentTracker {
  private entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Forgets all subagents (another session was opened, or a new one started). */
  reset(): void {
    this.entries.clear();
  }

  has(sessionID: string): boolean {
    return this.entries.has(sessionID);
  }

  get size(): number {
    return this.entries.size;
  }

  /** True for the open session (`root`) and its subagents. */
  inTree(sessionID: string, root: string): boolean {
    return sessionID === root || this.entries.has(sessionID);
  }

  /**
   * Records a session announced by `session.created`. Returns true when it is a new
   * subagent of the open session (`root`) or of one of its subagents.
   */
  created(
    sessionID: string,
    parentID: string,
    root: string,
    info: { title: string | null; agent: string | null } | null,
  ): boolean {
    if (this.entries.has(sessionID) || !this.inTree(parentID, root) || this.entries.size >= MAX_SUBAGENTS)
      return false;
    const parent = this.entries.get(parentID);
    this.entries.set(
      sessionID,
      newEntry({
        sessionID,
        parentID,
        depth: parent ? parent.view.depth + 1 : 1,
        agent: info?.agent ?? null,
        title: info?.title ?? "",
        status: "running",
        activity: null,
        tools: 0,
        files: 0,
        started: this.now(),
        ended: null,
        cost: null,
        error: null,
      }),
    );
    return true;
  }

  /**
   * Restores subagents of a reopened session. Live counts (tools, files) are unknown for
   * them; status, timing and cost come from OpenCode's session records.
   */
  restore(children: ReadonlyArray<{ summary: SessionSummary; parentID: string }>, active: Set<string>): void {
    for (const { summary, parentID } of children) {
      if (this.entries.has(summary.id) || this.entries.size >= MAX_SUBAGENTS) continue;
      const parent = this.entries.get(parentID);
      const running = active.has(summary.id);
      this.entries.set(
        summary.id,
        newEntry({
          sessionID: summary.id,
          parentID,
          depth: parent ? parent.view.depth + 1 : 1,
          agent: summary.agent,
          title: summary.title,
          status: running
            ? "running"
            : summary.outcome === "failed"
              ? "failed"
              : summary.outcome === "interrupted"
                ? "stopped"
                : "completed",
          activity: null,
          tools: null,
          files: null,
          started: summary.created || null,
          ended: running ? null : summary.updated || null,
          cost: summary.cost,
          error: null,
        }),
      );
    }
  }

  /** Applies a subagent session's events. Returns true when its view changed. */
  apply(sessionID: string, events: readonly UiEvent[]): boolean {
    const e = this.entries.get(sessionID);
    if (!e) return false;
    const before = JSON.stringify(e.view);
    for (const ev of events) this.applyOne(e, ev);
    e.view.status = statusOf(e);
    return JSON.stringify(e.view) !== before;
  }

  private applyOne(e: Entry, ev: UiEvent): void {
    const v = e.view;
    switch (ev.type) {
      case "session.busy":
        if (v.ended !== null) {
          // A finished subagent was continued.
          v.ended = null;
          v.error = null;
        }
        v.status = "running";
        break;
      case "session.idle":
        v.status = ev.outcome === "succeeded" ? "completed" : ev.outcome === "failed" ? "failed" : "stopped";
        v.ended = this.now();
        v.activity = null;
        e.toolNames.clear();
        e.waiting.clear();
        break;
      case "session.error":
        v.error = ev.message;
        break;
      case "session.renamed":
        if (ev.title) v.title = ev.title;
        break;
      case "tool.started":
        e.tools.add(ev.toolId);
        // Counts stay unknown (null) for a subagent restored mid-run: a partial count would mislead.
        if (v.tools !== null) v.tools = e.tools.size;
        e.toolNames.set(ev.toolId, ev.name);
        v.activity = toolActivity(ev.name, null);
        break;
      case "tool.input": {
        const name = ev.name ?? e.toolNames.get(ev.toolId) ?? "tool";
        e.toolNames.set(ev.toolId, name);
        v.activity = toolActivity(name, ev.input);
        break;
      }
      case "tool.completed":
      case "tool.failed":
        e.toolNames.delete(ev.toolId);
        break;
      case "assistant.delta":
        if (v.activity?.kind !== "writing") v.activity = { kind: "writing" };
        break;
      case "reasoning.delta":
        if (v.activity?.kind !== "thinking") v.activity = { kind: "thinking" };
        break;
      case "files.changed":
        for (const f of ev.files) e.files.add(f);
        if (v.files !== null) v.files = e.files.size;
        break;
      case "usage.session":
        v.cost = ev.cost;
        break;
      case "permission.requested":
        e.waiting.add(`perm:${ev.request.id}`);
        break;
      case "permission.resolved":
        e.waiting.delete(`perm:${ev.requestId}`);
        break;
      case "form.requested":
        e.waiting.add(`form:${ev.form.id}`);
        break;
      case "form.resolved":
        if (ev.status !== "pending") e.waiting.delete(`form:${ev.formId}`);
        break;
      default:
        break;
    }
  }

  /** Subagents in the order they were started (parents before their own subagents). */
  views(): SubagentView[] {
    return [...this.entries.values()].map((e) => ({
      ...e.view,
      activity: e.view.activity && { ...e.view.activity },
    }));
  }

  view(sessionID: string): SubagentView | null {
    const e = this.entries.get(sessionID);
    return e ? { ...e.view } : null;
  }
}

function newEntry(view: SubagentView): Entry {
  return { view, tools: new Set(), files: new Set(), waiting: new Set(), toolNames: new Map() };
}

function toolActivity(name: string, input: Record<string, unknown> | null): SubagentActivity {
  const d = describeTool(name, input);
  return { kind: "tool", title: d.title, category: d.category };
}

function statusOf(e: Entry): SubagentView["status"] {
  const s = e.view.status;
  if (s === "running" || s === "waiting") return e.waiting.size > 0 ? "waiting" : "running";
  return s;
}
