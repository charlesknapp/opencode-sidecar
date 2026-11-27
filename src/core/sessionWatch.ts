// The sessions watched beside the open one: the session strip (sessions opened lately in
// the folder, and any that work or wait) with each one's status, and the notices for
// sessions that finish, fail or start waiting while another one is open. Built from the
// global event stream, so it never needs a session's history. Free of VS Code APIs.

import { oneLine, permissionDetail } from "./currentTask";
import type { StripStatus, UiEvent } from "../shared/model";

/** Most sessions the strip keeps. */
export const STRIP_MAX = 6;

/** A strip entry as kept in workspace state (per folder). */
export interface StripEntry {
  id: string;
  /** Finished (`done`) or failed while another session was open, until it is opened. */
  unread?: "done" | "failed";
}

/** A background session's milestone, notified once. */
export interface BackgroundNotice {
  kind: "completed" | "failed" | "needs-input";
  sessionID: string;
  key: string;
  /** What OpenCode asks, for needs-input (redacted, one line). */
  detail?: string;
}

/** What the watch needs to know about the controller's state. */
export interface WatchContext {
  /** The open session, if any. */
  current: string | null;
  /** True for a root session of the open folder (never a side question). */
  known(id: string): boolean;
  /** True while OpenCode runs the session (its active list and the event stream). */
  running(id: string): boolean;
}

export class SessionWatch {
  private entries: StripEntry[] = [];
  /** Subagent session → the session that started it (from `session.created`). */
  private parents = new Map<string, string>();
  /** Requests (permission or question) waiting per root session, with the session that raised each. */
  private waiting = new Map<string, Map<string, string>>();
  /** How a root session's run ended, until its subagents are done too and it is reported. */
  private ended = new Map<string, "succeeded" | "failed">();
  /** Runs seen per root session, so each run is reported once. */
  private runs = new Map<string, number>();
  private notified = new Set<string>();

  /** Starts over for another folder, with its saved strip. */
  reset(saved: readonly StripEntry[] | undefined): void {
    this.entries = (saved ?? [])
      .filter((e) => e && typeof e.id === "string")
      .slice(0, STRIP_MAX)
      .map((e) =>
        e.unread === "done" || e.unread === "failed" ? { id: e.id, unread: e.unread } : { id: e.id },
      );
    this.waiting.clear();
    this.ended.clear();
  }

  /** The strip, most recent first, for saving. */
  saved(): StripEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  ids(): string[] {
    return this.entries.map((e) => e.id);
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  /** Records that `child` was started by `parent` (a subagent). */
  link(child: string, parent: string): void {
    if (child !== parent) this.parents.set(child, parent);
  }

  /** The root session above a subagent session (the session itself for a root). */
  rootOf(id: string): string {
    let at = id;
    // Bounded: a broken parent chain must not loop.
    for (let i = 0; i < 50; i++) {
      const p = this.parents.get(at);
      if (!p) break;
      at = p;
    }
    return at;
  }

  /** The user opened a session: it moves to the front and counts as seen. */
  opened(id: string, ctx: WatchContext): boolean {
    const before = JSON.stringify(this.entries);
    this.entries = [{ id }, ...this.entries.filter((e) => e.id !== id)];
    this.trim(ctx);
    return JSON.stringify(this.entries) !== before;
  }

  /** Adds a session that works or waits; one already there keeps its place. */
  show(id: string, ctx: WatchContext): boolean {
    if (this.has(id)) return false;
    this.entries.unshift({ id });
    this.trim(ctx);
    return true;
  }

  /** Takes a session off the strip (closed with ×, deleted or archived). */
  remove(id: string): boolean {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.waiting.delete(id);
    this.ended.delete(id);
    return this.entries.length !== n;
  }

  /** Drops the oldest entries over the cap, keeping the open, working and waiting ones while it can. */
  private trim(ctx: WatchContext): void {
    while (this.entries.length > STRIP_MAX) {
      const busy = (id: string) => id === ctx.current || ctx.running(id) || this.waitingCount(id) > 0;
      let drop = -1;
      for (let i = this.entries.length - 1; i >= 0 && drop < 0; i--) if (!busy(this.entries[i].id)) drop = i;
      if (drop < 0)
        for (let i = this.entries.length - 1; i >= 0 && drop < 0; i--)
          if (this.entries[i].id !== ctx.current) drop = i;
      this.entries.splice(drop < 0 ? this.entries.length - 1 : drop, 1);
    }
  }

  /** Requests the session (or its subagents) is waiting on. */
  waitingCount(root: string): number {
    return this.waiting.get(root)?.size ?? 0;
  }

  /** Requests waiting in sessions other than `current`. */
  backgroundWaiting(current: string | null): number {
    let n = 0;
    for (const [root, reqs] of this.waiting) if (root !== current) n += reqs.size;
    return n;
  }

  /**
   * Replaces what is known to wait in a session: from OpenCode's pending lists (a session
   * found working at start or after a reconnect) or from the conversation the user leaves.
   * Never notifies.
   */
  seedWaiting(root: string, requests: ReadonlyArray<{ id: string; sessionID: string }>): void {
    if (requests.length) this.waiting.set(root, new Map(requests.map((r) => [r.id, r.sessionID])));
    else this.waiting.delete(root);
  }

  /** A strip tab's status. The open session's comes from its conversation (see the controller). */
  status(id: string, ctx: WatchContext): StripStatus {
    if (this.waitingCount(id) > 0) return "waiting";
    if (ctx.running(id) || this.subagentsRunning(id, ctx)) return "running";
    return this.entries.find((e) => e.id === id)?.unread ?? "idle";
  }

  private subagentsRunning(root: string, ctx: WatchContext): boolean {
    for (const child of this.parents.keys())
      if (ctx.running(child) && this.rootOf(child) === root) return true;
    return false;
  }

  private markUnread(id: string, unread: "done" | "failed" | undefined): boolean {
    const e = this.entries.find((x) => x.id === id);
    if (!e || e.unread === unread) return false;
    if (unread) e.unread = unread;
    else delete e.unread;
    return true;
  }

  /**
   * Live events of one session (a root session or a subagent). Returns whether the strip
   * changed (`save` when the saved part did) and the notices for sessions that are not open.
   * Replayed history never comes here, so reopening or reconnecting notifies nothing.
   */
  apply(
    sessionID: string,
    events: readonly UiEvent[],
    ctx: WatchContext,
  ): { changed: boolean; save: boolean; notices: BackgroundNotice[] } {
    const root = this.rootOf(sessionID);
    const out = { changed: false, save: false, notices: [] as BackgroundNotice[] };
    if (!ctx.known(root)) return out;
    const background = root !== ctx.current;
    const saveIf = (b: boolean) => {
      if (b) out.changed = out.save = true;
    };
    for (const ev of events) {
      switch (ev.type) {
        case "session.busy":
          out.changed = true;
          if (sessionID !== root) break;
          this.runs.set(root, (this.runs.get(root) ?? 0) + 1);
          this.ended.delete(root);
          saveIf(this.show(root, ctx));
          saveIf(this.markUnread(root, undefined));
          break;
        case "permission.requested":
        case "form.requested": {
          const id = ev.type === "permission.requested" ? ev.request.id : ev.form.id;
          const reqs = this.waiting.get(root) ?? new Map<string, string>();
          if (reqs.has(id)) break;
          reqs.set(id, sessionID);
          this.waiting.set(root, reqs);
          out.changed = true;
          saveIf(this.show(root, ctx));
          if (!background) break;
          const detail =
            ev.type === "permission.requested"
              ? permissionDetail(ev.request.action, ev.request.resources)
              : oneLine(`a question: ${ev.form.fields.find((f) => f.title)?.title ?? ev.form.title}`);
          this.notice(out.notices, { kind: "needs-input", sessionID: root, key: `bg-input:${id}`, detail });
          break;
        }
        case "permission.resolved":
        case "form.resolved": {
          if (ev.type === "form.resolved" && ev.status === "pending") break;
          const id = ev.type === "permission.resolved" ? ev.requestId : ev.formId;
          const reqs = this.waiting.get(root);
          if (reqs?.delete(id)) {
            out.changed = true;
            if (!reqs.size) this.waiting.delete(root);
          }
          break;
        }
        case "session.idle": {
          // A session that stops has no request open any more (OpenCode drops them).
          const reqs = this.waiting.get(root);
          if (reqs) {
            for (const [id, from] of reqs) if (from === sessionID) reqs.delete(id);
            if (!reqs.size) this.waiting.delete(root);
          }
          out.changed = true;
          if (sessionID === root && ev.outcome !== "interrupted") this.ended.set(root, ev.outcome);
          else if (sessionID === root) this.ended.delete(root);
          break;
        }
        default:
          break;
      }
    }
    // A run is reported once it is over, subagents included; a failure at once.
    const end = this.ended.get(root);
    if (end && !ctx.running(root) && (end === "failed" || !this.subagentsRunning(root, ctx))) {
      this.ended.delete(root);
      if (background) {
        saveIf(this.markUnread(root, end === "failed" ? "failed" : "done"));
        const kind = end === "failed" ? "failed" : "completed";
        this.notice(out.notices, {
          kind,
          sessionID: root,
          key: `bg-${kind}:${root}:${this.runs.get(root) ?? 0}`,
        });
      }
    }
    return out;
  }

  /** The user is looking at the session: what it finished or failed is seen. */
  seen(id: string): boolean {
    return this.markUnread(id, undefined);
  }

  private notice(into: BackgroundNotice[], n: BackgroundNotice): void {
    if (this.notified.has(n.key)) return;
    this.notified.add(n.key);
    into.push(n);
  }
}
