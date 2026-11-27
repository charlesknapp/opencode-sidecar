// The session strip and background notices: sessions opened lately in the folder, and any
// that work or wait, each with a status built from the global event stream; a session that
// is not open is notified once when it finishes, fails or starts waiting.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideNotification, type TaskNotice } from "../src/core/currentTask";
import { ASIDES_KEY, SessionController } from "../src/core/sessionController";
import { SessionWatch, STRIP_MAX, type WatchContext } from "../src/core/sessionWatch";
import type { FormRequest, PermissionRequest, SessionSummary } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const STRIP_KEY = `opencodeSidecar.strip:${DIR}`;
const silentLog = { info() {}, warn() {}, error() {} };
const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });
const tick = () => new Promise((r) => setTimeout(r, 5));
const started = (sessionID: string) => raw("session.execution.started", { sessionID });
const succeeded = (sessionID: string) => raw("session.execution.succeeded", { sessionID });
const failed = (sessionID: string) =>
  raw("session.execution.failed", { sessionID, error: { type: "provider.free-limit", message: "limit" } });
const asked = (id: string, sessionID: string) =>
  raw("permission.asked", { id, sessionID, action: "bash", resources: ["npm test"] });

const session = (id: string, title = id): SessionSummary => ({
  id,
  title: `Session ${title}`,
  created: 1,
  updated: 2,
  agent: "build",
  modelKey: "opencode-go/kimi",
  outcome: null,
  variant: null,
  cost: 0,
});

/** A controller in DIR with sessions a, b and c listed and `a` open. */
async function setup(store = new MemoryStore()) {
  const client = new MockClient();
  client.sessions = [session("a"), session("b"), session("c")];
  const notices: TaskNotice[] = [];
  let states = 0;
  const c = new SessionController(
    client,
    store,
    {
      onEvents() {},
      onTranscriptReset() {},
      onStateChanged: () => states++,
      onTaskNotice: (n) => notices.push(n),
    },
    silentLog,
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  await c.setDirectory(DIR);
  await c.openSession("a");
  return { client, store, c, notices, states: () => states };
}

const tabs = (c: SessionController) => c.stripView().map((t) => `${t.id}:${t.status}${t.current ? "*" : ""}`);

describe("session strip", () => {
  it("lists the sessions you opened, most recent first, and saves them per folder", async () => {
    const s = await setup();
    await s.c.openSession("b");
    await s.c.openSession("c");
    await s.c.openSession("b");
    assert.deepEqual(tabs(s.c), ["b:idle*", "c:idle", "a:idle"]);
    assert.deepEqual(s.store.get(STRIP_KEY), [{ id: "b" }, { id: "c" }, { id: "a" }]);
    // Another controller (VS Code restarted) shows the same strip.
    const again = await setup(s.store);
    assert.deepEqual(
      again.c.stripView().map((t) => t.id),
      ["a", "b", "c"],
      "the remembered session opens first",
    );
    // Another folder has its own strip.
    await again.c.setDirectory("/work/other");
    assert.deepEqual(again.c.stripView(), []);
  });

  it("takes a session off with × (not the open one), and when it is deleted or archived", async () => {
    const s = await setup();
    await s.c.openSession("b");
    await s.c.openSession("c");
    s.c.closeStripTab("a");
    s.c.closeStripTab("c");
    assert.deepEqual(tabs(s.c), ["c:idle*", "b:idle"]);
    s.c.handleRawEvent(raw("session.deleted", { sessionID: "b" }));
    assert.deepEqual(tabs(s.c), ["c:idle*"]);
    await s.c.openSession("a");
    await s.c.setArchived("c", true);
    assert.deepEqual(tabs(s.c), ["a:idle*"]);
    assert.ok(parseWebviewMessage({ type: "closeStripTab", id: "a" }));
    assert.equal(parseWebviewMessage({ type: "closeStripTab" }), undefined);
    assert.equal(parseWebviewMessage({ type: "closeStripTab", id: "a", x: 1 }), undefined);
  });

  it("adds a session that starts working; it keeps its place after that", async () => {
    const s = await setup();
    s.c.handleRawEvent(started("b"));
    assert.deepEqual(tabs(s.c), ["b:running", "a:idle*"]);
    s.c.handleRawEvent(started("a"));
    assert.deepEqual(tabs(s.c), ["b:running", "a:running*"]);
  });

  it("derives each tab's status: working, waiting for you, finished or failed since you looked", async () => {
    const s = await setup();
    await s.c.openSession("b");
    await s.c.openSession("c");
    await s.c.openSession("a");
    s.c.handleRawEvent(started("b"));
    s.c.handleRawEvent(started("c"));
    s.c.handleRawEvent(asked("per_1", "c"));
    assert.deepEqual(tabs(s.c), ["a:idle*", "c:waiting", "b:running"]);
    s.c.handleRawEvent(raw("permission.replied", { sessionID: "c", requestID: "per_1", reply: "once" }));
    assert.deepEqual(tabs(s.c), ["a:idle*", "c:running", "b:running"]);
    s.c.handleRawEvent(succeeded("b"));
    s.c.handleRawEvent(failed("c"));
    assert.deepEqual(tabs(s.c), ["a:idle*", "c:failed", "b:done"]);
    assert.deepEqual(s.store.get(STRIP_KEY), [
      { id: "a" },
      { id: "c", unread: "failed" },
      { id: "b", unread: "done" },
    ]);
    // Opening it counts as seen.
    await s.c.openSession("b");
    assert.deepEqual(tabs(s.c), ["b:idle*", "a:idle", "c:failed"]);
    // A new run clears what was unread.
    s.c.handleRawEvent(started("c"));
    s.c.handleRawEvent(raw("session.execution.interrupted", { sessionID: "c" }));
    assert.deepEqual(tabs(s.c), ["b:idle*", "a:idle", "c:idle"]);
  });

  it("shows the open session's own state: working and waiting", async () => {
    const s = await setup();
    await s.c.openSession("b");
    await s.c.openSession("a");
    s.c.handleRawEvent(started("a"));
    assert.deepEqual(tabs(s.c), ["a:running*", "b:idle"]);
    s.c.handleRawEvent(asked("per_a", "a"));
    assert.deepEqual(tabs(s.c), ["a:waiting*", "b:idle"]);
    s.c.handleRawEvent(succeeded("a"));
    assert.deepEqual(tabs(s.c), ["a:idle*", "b:idle"], "never unread while you look at it");
  });

  it("keeps a request on the tab of the session you leave", async () => {
    const s = await setup();
    s.client.active = new Set(["a"]);
    s.client.permissions = [
      {
        id: "per_r",
        sessionID: "a",
        action: "edit",
        resources: ["x.ts"],
        canAlways: false,
      } as PermissionRequest,
    ];
    await s.c.openSession("a");
    assert.equal(s.c.pendingRequestCount(), 1);
    s.client.permissions = [];
    await s.c.openSession("b");
    assert.deepEqual(tabs(s.c), ["b:idle*", "a:waiting"]);
    assert.equal(s.c.backgroundWaitingCount(), 1);
    assert.equal(s.notices.length, 0, "a restored request is not notified");
  });

  it("keeps at most STRIP_MAX sessions, dropping the oldest quiet one first", async () => {
    const s = await setup();
    s.client.sessions = Array.from({ length: 9 }, (_, i) => session(`s${i}`));
    await s.c.refreshSessions();
    await s.c.openSession("s0");
    s.c.handleRawEvent(started("s1"));
    for (let i = 2; i < 8; i++) await s.c.openSession(`s${i}`);
    const ids = s.c.stripView().map((t) => t.id);
    assert.equal(ids.length, STRIP_MAX);
    assert.ok(ids.includes("s1"), "a working session stays");
    assert.ok(!ids.includes("s0") && !ids.includes("a"), "the oldest quiet ones go");
  });

  it("shows a session older than the list once OpenCode describes it, and drops a deleted one", async () => {
    const store = new MemoryStore();
    await store.update(STRIP_KEY, [{ id: "old" }, { id: "gone" }, { id: "a" }]);
    const s = await setup(store);
    s.client.sessions.push({ ...session("old"), archived: false });
    // `old` is not in the listed sessions (the mock lists every session; hide it).
    const listSessions = s.client.listSessions.bind(s.client);
    s.client.listSessions = async (d, l, archived) =>
      (await listSessions(d, l, archived)).filter((x) => x.id !== "old");
    await s.c.refreshSessions();
    assert.deepEqual(tabs(s.c), ["a:idle*"], "loading");
    await tick();
    assert.deepEqual(tabs(s.c), ["a:idle*", "old:idle"]);
    assert.deepEqual(
      (s.store.get(STRIP_KEY) as Array<{ id: string }>).map((e) => e.id),
      ["a", "old"],
    );
  });
});

describe("background notices", () => {
  it("notifies a session that is not open when it finishes, fails or waits, once each", async () => {
    const s = await setup();
    s.c.handleRawEvent(started("b"));
    s.c.handleRawEvent(asked("per_b", "b"));
    s.c.handleRawEvent(asked("per_b", "b"));
    s.c.handleRawEvent(succeeded("b"));
    s.c.handleRawEvent(succeeded("b"));
    s.c.handleRawEvent(started("c"));
    s.c.handleRawEvent(failed("c"));
    assert.deepEqual(
      s.notices.map((n) => [n.kind, n.sessionID, n.summary]),
      [
        ["needs-input", "b", "Session b"],
        ["completed", "b", "Session b"],
        ["failed", "c", "Session c"],
      ],
    );
    assert.match(s.notices[0].detail ?? "", /permission for bash: npm test/);
    // The next run is reported again.
    s.c.handleRawEvent(started("b"));
    s.c.handleRawEvent(succeeded("b"));
    assert.equal(s.notices.filter((n) => n.kind === "completed").length, 2);
  });

  it("names a question's first field", async () => {
    const s = await setup();
    s.c.handleRawEvent(started("b"));
    s.c.handleRawEvent(
      raw("form.created", {
        form: {
          id: "frm_1",
          sessionID: "b",
          title: "Questions",
          fields: [{ key: "q0", type: "string", title: "Which DB?" }],
        },
      }),
    );
    assert.deepEqual(
      s.notices.map((n) => [n.kind, n.detail]),
      [["needs-input", "a question: Which DB?"]],
    );
    assert.deepEqual(tabs(s.c), ["b:waiting", "a:idle*"]);
    s.c.handleRawEvent(raw("form.cancelled", { id: "frm_1", sessionID: "b" }));
    assert.deepEqual(tabs(s.c), ["b:running", "a:idle*"]);
  });

  it("leaves the open session to its own notices", async () => {
    const s = await setup();
    s.c.handleRawEvent(started("a"));
    s.c.handleRawEvent(asked("per_a", "a"));
    s.c.handleRawEvent(succeeded("a"));
    assert.ok(
      s.notices.every((n) => !n.sessionID),
      JSON.stringify(s.notices),
    );
  });

  it("reports a session that was open when its run started and finished after you left", async () => {
    const s = await setup();
    s.client.active = new Set(["a"]);
    s.c.handleRawEvent(started("a"));
    await s.c.openSession("b");
    s.client.active = new Set();
    s.c.handleRawEvent(succeeded("a"));
    assert.deepEqual(
      s.notices.map((n) => [n.kind, n.sessionID]),
      [["completed", "a"]],
    );
  });

  it("follows subagents for their parent: its requests, and completion once they are done", async () => {
    const s = await setup();
    s.c.handleRawEvent(started("b"));
    s.c.handleRawEvent(raw("session.created", { sessionID: "sub1", parentID: "b", title: "Explore" }));
    s.c.handleRawEvent(raw("session.created", { sessionID: "sub2", parentID: "sub1" }));
    s.c.handleRawEvent(started("sub1"));
    s.c.handleRawEvent(started("sub2"));
    s.c.handleRawEvent(asked("per_sub", "sub2"));
    assert.deepEqual(
      s.notices.map((n) => [n.kind, n.sessionID]),
      [["needs-input", "b"]],
      "a subagent's request is its parent's",
    );
    assert.deepEqual(tabs(s.c), ["b:waiting", "a:idle*"]);
    // The parent's turn ends while its subagents work: not finished yet.
    s.c.handleRawEvent(succeeded("b"));
    s.c.handleRawEvent(succeeded("sub2"));
    assert.deepEqual(tabs(s.c), ["b:running", "a:idle*"], "the ended subagent's request is gone");
    assert.equal(s.notices.length, 1);
    s.c.handleRawEvent(succeeded("sub1"));
    assert.deepEqual(
      s.notices.map((n) => [n.kind, n.sessionID]),
      [
        ["needs-input", "b"],
        ["completed", "b"],
      ],
    );
    assert.ok(!s.c.stripView().some((t) => t.id.startsWith("sub")), "subagents never get a tab");
  });

  it("never notifies side questions, other folders' sessions or unknown subagents", async () => {
    const store = new MemoryStore();
    await store.update(ASIDES_KEY, ["fork"]);
    const s = await setup(store);
    s.client.sessions.push(session("fork"));
    await s.c.refreshSessions();
    for (const id of ["fork", "elsewhere", "orphan"]) {
      s.c.handleRawEvent(started(id));
      s.c.handleRawEvent(asked(`per_${id}`, id));
      s.c.handleRawEvent(succeeded(id));
    }
    // A side question's subagent belongs to the side question.
    s.c.handleRawEvent(raw("session.created", { sessionID: "forksub", parentID: "fork" }));
    s.c.handleRawEvent(started("forksub"));
    s.c.handleRawEvent(asked("per_fs", "forksub"));
    assert.deepEqual(s.notices, []);
    assert.deepEqual(tabs(s.c), ["a:idle*"]);
    assert.equal(s.c.backgroundWaitingCount(), 0);
  });

  it("never replays: reopening, a reconnect and a session found working are silent", async () => {
    const s = await setup();
    s.client.active = new Set(["b"]);
    s.client.permissions = [
      {
        id: "per_old",
        sessionID: "b",
        action: "bash",
        resources: ["ls"],
        canAlways: false,
      } as PermissionRequest,
    ];
    s.client.children.set("b", ["bsub"]);
    s.client.forms = [
      { id: "frm_old", sessionID: "bsub", title: "Q", fields: [], toolId: null } as unknown as FormRequest,
    ];
    s.client.active.add("bsub");
    await s.c.resync();
    await s.c.refreshSessions();
    await tick();
    assert.deepEqual(tabs(s.c), ["b:waiting", "a:idle*"], "found working and waiting");
    assert.equal(s.c.backgroundWaitingCount(), 2);
    assert.deepEqual(s.notices, []);
    assert.equal(
      s.client.callsTo("listPermissions").filter((c) => c.args[0] === "b").length,
      1,
      "read once per run, not at every refresh",
    );
    // The subagent was linked: its answer clears the parent's tab.
    s.c.handleRawEvent(raw("form.replied", { id: "frm_old", sessionID: "bsub", answer: {} }));
    s.c.handleRawEvent(raw("permission.replied", { sessionID: "b", requestID: "per_old", reply: "once" }));
    assert.deepEqual(tabs(s.c), ["b:running", "a:idle*"]);
    // Reopening a session replays its history and requests without notices.
    await s.c.openSession("b");
    await s.c.openSession("a");
    assert.deepEqual(s.notices, []);
  });

  it("is shown while you watch the chat, and follows the notification settings", () => {
    const on = { taskComplete: true, needsInput: true, taskFailed: true, budgetStopped: true };
    const watching = { viewVisible: true, windowFocused: true };
    const n = (kind: TaskNotice["kind"], detail?: string): TaskNotice => ({
      kind,
      key: kind,
      summary: "Fix login",
      sessionTitle: "Fix login",
      sessionID: "b",
      ...(detail ? { detail } : {}),
    });
    assert.deepEqual(decideNotification(n("completed"), on, watching), {
      show: true,
      severity: "info",
      message: "✅ OpenCode finished in “Fix login”",
    });
    assert.equal(
      decideNotification(n("needs-input", "permission for bash"), on, watching).message,
      "❓ OpenCode is waiting for you in “Fix login”: permission for bash",
    );
    assert.equal(
      decideNotification(n("failed"), on, watching).message,
      "❌ OpenCode task failed in “Fix login”",
    );
    assert.equal(decideNotification(n("completed"), { ...on, taskComplete: false }, watching).show, false);
    assert.equal(decideNotification(n("needs-input"), { ...on, needsInput: false }, watching).show, false);
    assert.equal(decideNotification(n("failed"), { ...on, taskFailed: false }, watching).show, false);
    // The open session's notices are unchanged.
    assert.equal(decideNotification({ ...n("completed"), sessionID: undefined }, on, watching).show, false);
  });
});

describe("session watch", () => {
  const ctx = (over: Partial<WatchContext> = {}): WatchContext => ({
    current: null,
    known: () => true,
    running: () => false,
    ...over,
  });

  it("reads a saved strip defensively", () => {
    const w = new SessionWatch();
    w.reset([
      { id: "a", unread: "done" },
      { id: "b", unread: "nonsense" as "done" },
      null as unknown as { id: string },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `x${i}` })),
    ]);
    assert.equal(w.ids().length, STRIP_MAX);
    assert.deepEqual(w.saved().slice(0, 2), [{ id: "a", unread: "done" }, { id: "b" }]);
    w.reset(undefined);
    assert.deepEqual(w.ids(), []);
  });

  it("follows a parent chain to its root, even a broken one", () => {
    const w = new SessionWatch();
    w.link("c", "b");
    w.link("b", "a");
    assert.equal(w.rootOf("c"), "a");
    w.link("a", "c");
    assert.ok(["a", "b", "c"].includes(w.rootOf("c")), "a loop ends");
  });

  it("drops the oldest entry when every one is busy, never the open one", () => {
    const w = new SessionWatch();
    const c = ctx({ current: "s0", running: () => true });
    for (let i = 0; i <= STRIP_MAX; i++) w.opened(`s${i}`, c);
    assert.ok(!w.has("s1") || w.has("s0"));
    assert.ok(w.has("s0"), "the open session stays");
    assert.equal(w.ids().length, STRIP_MAX);
  });
});
