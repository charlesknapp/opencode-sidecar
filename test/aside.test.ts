// Ask aside (`/btw`): a side question asked in a fork of the open session, shown only in
// the aside card, while the main session keeps its context, run, queue and requests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASIDE_PREFIX, ASIDES_KEY, SessionController } from "../src/core/sessionController";
import { OpenCodeHttpError, type PromptInput } from "../src/opencode/client";
import type { AsideView, SessionSummary, UiEvent } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const silentLog = { info() {}, warn() {}, error() {} };
const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });
const tick = () => new Promise((r) => setTimeout(r, 5));

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: "Main",
  created: 1,
  updated: 2,
  agent: "build",
  modelKey: "opencode-go/kimi",
  outcome: null,
  variant: null,
  cost: 0,
  ...extra,
});

function setup(store = new MemoryStore()) {
  const client = new MockClient();
  const emitted: UiEvent[] = [];
  const asides: Array<AsideView | null> = [];
  const c = new SessionController(
    client,
    store,
    {
      onEvents: (e) => emitted.push(...e),
      onTranscriptReset() {},
      onStateChanged() {},
      onAsideChanged: (a) => asides.push(a),
    },
    silentLog,
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  return { client, store, c, emitted, asides };
}

/** A controller with the main session `ses_main` open (two prompts in its history). */
async function opened(store?: MemoryStore) {
  const s = setup(store);
  await s.c.setDirectory(DIR);
  s.client.sessions = [session("ses_main")];
  s.client.messages = [
    { id: "u1", type: "user", text: "first", time: { created: 1 } },
    { id: "u2", type: "user", text: "second", time: { created: 2 } },
  ];
  await s.c.openSession("ses_main");
  await s.c.selectModel("opencode-go/kimi");
  s.client.calls = [];
  return s;
}

/** Asks a question and returns the fork's id. */
async function ask(s: Awaited<ReturnType<typeof opened>>, q = "What does auth.ts export?") {
  await s.c.askAside(q);
  const fork = s.client.callsTo("prompt").at(-1)?.args[0] as string;
  assert.ok(fork && fork !== "ses_main");
  return fork;
}

describe("ask aside", () => {
  it("forks the whole session, switches the copy to Plan and asks there", async () => {
    const s = await opened();
    const fork = await ask(s);
    assert.deepEqual(s.client.callsTo("forkSession")[0].args, ["ses_main"], "no `before`: the whole session");
    assert.deepEqual(s.client.callsTo("switchAgent")[0].args, [fork, "plan"]);
    const input = s.client.callsTo("prompt")[0].args[1] as PromptInput;
    assert.equal(input.text, `${ASIDE_PREFIX}What does auth.ts export?`);
    assert.equal(input.delivery, undefined);
    assert.equal(s.client.callsTo("prompt").length, 1, "nothing goes to the main session");
    assert.equal(s.c.current?.id, "ses_main");
    assert.deepEqual(s.store.get(ASIDES_KEY), [fork]);
    assert.deepEqual(s.c.asideView(), {
      status: "running",
      turns: [{ question: "What does auth.ts export?", answer: "", error: null, done: false }],
      error: null,
      activity: null,
    });
  });

  it("uses the model picked in the main session when the copy has another", async () => {
    const s = await opened();
    await s.c.selectModel("vast/qwen");
    s.client.calls = [];
    const fork = await ask(s);
    assert.deepEqual(s.client.callsTo("switchModel").at(-1)?.args, [
      fork,
      { providerID: "vast", id: "qwen" },
    ]);
  });

  it("starts a new Plan session when there is nothing to copy yet", async () => {
    const s = setup();
    await s.c.setDirectory(DIR);
    await s.c.askAside("hi?");
    assert.equal(s.client.callsTo("forkSession").length, 0, "OpenCode cannot fork an empty session");
    const created = s.client.callsTo("createSession")[0].args[0] as { agent?: string; directory: string };
    assert.equal(created.agent, "plan");
    assert.equal(created.directory, DIR);
    assert.equal(s.c.current, null, "the main conversation is still new");
  });

  it("starts a new session when OpenCode finds the open one empty", async () => {
    const s = await opened();
    s.client.forkError = new OpenCodeHttpError(
      400,
      "InvalidRequestError",
      "Cannot fork empty session: ses_main",
    );
    await s.c.askAside("hi?");
    assert.equal(s.client.callsTo("forkSession").length, 1);
    assert.equal(s.client.callsTo("createSession").length, 1);
    assert.equal(s.c.asideView()?.error, null);
    assert.equal(s.c.asideView()?.status, "running");
  });

  it("streams the copy's answer to the card only, never into the main timeline", async () => {
    const s = await opened();
    const fork = await ask(s);
    const before = s.c.transcript.items.length;
    s.emitted.length = 0;
    s.c.handleRawEvent(raw("session.execution.started", { sessionID: fork }));
    s.c.handleRawEvent(raw("session.tool.input.started", { sessionID: fork, id: "t1", name: "read" }));
    assert.equal(s.c.asideView()?.activity, "Using read…");
    for (const delta of ["It exports ", "`login`."])
      s.c.handleRawEvent(
        raw("session.text.delta", { sessionID: fork, assistantMessageID: "m1", ordinal: 0, delta }),
      );
    assert.equal(s.c.asideView()?.turns[0].answer, "It exports `login`.");
    assert.equal(s.c.asideView()?.activity, null);
    s.c.handleRawEvent(
      raw("session.text.ended", {
        sessionID: fork,
        assistantMessageID: "m1",
        ordinal: 0,
        text: "It exports `login`.",
      }),
    );
    s.c.handleRawEvent(raw("session.execution.succeeded", { sessionID: fork }));
    const view = s.c.asideView()!;
    assert.equal(view.status, "idle");
    assert.equal(view.turns[0].done, true);
    assert.deepEqual(s.emitted, [], "no event reached the main conversation");
    assert.equal(s.c.transcript.items.length, before);
    assert.ok(s.asides.at(-1)?.turns[0].done);
  });

  it("leaves the main session's run, steering, queue and requests alone", async () => {
    const s = await opened();
    s.c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_main" }));
    assert.equal(s.c.busy, true);
    const fork = await ask(s);
    // The main session keeps steering and queueing while the side thread runs.
    assert.equal(await s.c.send("steer this", [], "steer"), true);
    assert.equal((s.client.callsTo("prompt").at(-1)?.args[1] as PromptInput).delivery, "steer");
    assert.equal(s.client.callsTo("prompt").at(-1)?.args[0], "ses_main");
    s.c.handleRawEvent(
      raw("permission.asked", { id: "per_main", sessionID: "ses_main", action: "bash", resources: ["ls"] }),
    );
    // The side thread ending does not end the main run, nor touch its request.
    s.c.handleRawEvent(raw("session.execution.succeeded", { sessionID: fork }));
    assert.equal(s.c.busy, true);
    const perm = s.c.transcript.get("perm:per_main");
    assert.ok(perm?.kind === "permission" && perm.status === "pending");
    assert.equal(s.c.pendingRequestCount(), 1);
    // A late model or agent event from the copy changes nothing in the main session.
    s.c.handleRawEvent(raw("session.agent.selected", { sessionID: fork, agent: "plan" }));
    assert.equal(s.c.selectedAgent, "build");
  });

  it("rejects the copy's permission requests and cancels its questions, so it never waits", async () => {
    const s = await opened();
    const fork = await ask(s);
    s.c.handleRawEvent(
      raw("permission.asked", { id: "per_a", sessionID: fork, action: "edit", resources: ["a.ts"] }),
    );
    s.c.handleRawEvent(
      raw("form.created", {
        form: { id: "frm_a", sessionID: fork, title: "Which?", fields: [{ key: "q0", type: "string" }] },
      }),
    );
    await tick();
    const reply = s.client.callsTo("replyPermission")[0].args;
    assert.deepEqual(reply.slice(0, 3), [fork, "per_a", "reject"]);
    assert.match(String(reply[3]), /side question/);
    assert.deepEqual(s.client.callsTo("cancelForm")[0].args, [fork, "frm_a"]);
    assert.equal(s.c.transcript.get("perm:per_a"), undefined);
    assert.equal(s.c.pendingRequestCount(), 0);
  });

  it("keeps the copy out of History while it is open", async () => {
    const s = await opened();
    const fork = await ask(s);
    await s.c.refreshSessions();
    assert.ok(
      s.client.sessions.some((x) => x.id === fork),
      "OpenCode lists the fork",
    );
    assert.deepEqual(
      s.c.displaySessions().map((x) => x.id),
      ["ses_main"],
    );
  });

  it("follows up in the same copy, and not while it is still answering", async () => {
    const s = await opened();
    const fork = await ask(s);
    await s.c.askAside("too soon");
    assert.equal(s.client.callsTo("prompt").length, 1, "ignored while answering");
    s.c.handleRawEvent(raw("session.execution.succeeded", { sessionID: fork }));
    await s.c.askAside("And logout?");
    assert.equal(s.client.callsTo("forkSession").length, 1);
    assert.deepEqual(s.client.callsTo("prompt").at(-1)?.args, [
      fork,
      { text: `${ASIDE_PREFIX}And logout?`, files: [] },
    ]);
    const view = s.c.asideView()!;
    assert.deepEqual(
      view.turns.map((t) => t.question),
      ["What does auth.ts export?", "And logout?"],
    );
    s.c.handleRawEvent(
      raw("session.text.delta", {
        sessionID: fork,
        assistantMessageID: "m2",
        ordinal: 0,
        delta: "Also `logout`.",
      }),
    );
    assert.equal(s.c.asideView()?.turns[0].answer, "", "each answer is its own");
    assert.equal(s.c.asideView()?.turns[1].answer, "Also `logout`.");
  });

  it("closes by stopping and deleting the copy", async () => {
    const s = await opened();
    const fork = await ask(s);
    await s.c.closeAside();
    assert.deepEqual(s.client.callsTo("interrupt")[0].args, [fork]);
    assert.deepEqual(s.client.callsTo("deleteSession")[0].args, [fork]);
    assert.equal(s.store.get(ASIDES_KEY), undefined);
    assert.equal(s.c.asideView(), null);
    assert.equal(s.asides.at(-1), null);
    // Late events from the deleted copy go nowhere.
    s.emitted.length = 0;
    s.c.handleRawEvent(
      raw("session.text.delta", { sessionID: fork, assistantMessageID: "m", ordinal: 0, delta: "x" }),
    );
    assert.deepEqual(s.emitted, []);
  });

  it("does not interrupt a copy that has finished, and deletes a copy made after it was closed", async () => {
    const s = await opened();
    const fork = await ask(s);
    s.c.handleRawEvent(raw("session.execution.succeeded", { sessionID: fork }));
    await s.c.closeAside();
    assert.equal(s.client.callsTo("interrupt").length, 0);

    let open!: () => void;
    s.client.forkGate = new Promise((r) => (open = r));
    const asking = s.c.askAside("slow?");
    await tick();
    await s.c.closeAside();
    open();
    await asking;
    const late = s.client.callsTo("forkSession").length;
    assert.equal(late, 2);
    const ids = s.client.callsTo("deleteSession").map((x) => x.args[0]);
    assert.equal(ids.length, 2, "the late copy is deleted too");
    assert.equal(s.client.callsTo("prompt").length, 1, "and never asked");
    assert.equal(s.store.get(ASIDES_KEY), undefined);
  });

  it("keeps a copy it could not delete for the next start, which deletes it", async () => {
    const store = new MemoryStore();
    const s = await opened(store);
    const fork = await ask(s);
    s.client.deleteError = new Error("offline");
    await s.c.closeAside();
    assert.deepEqual(store.get(ASIDES_KEY), [fork]);

    // Next start: still hidden from History, and deleted.
    const next = setup(store);
    next.client.sessions = [session("ses_main"), session(fork, { forked: true })];
    await next.c.setDirectory(DIR);
    assert.deepEqual(
      next.c.displaySessions().map((x) => x.id),
      ["ses_main"],
    );
    await next.c.cleanupAsides();
    assert.deepEqual(next.client.callsTo("deleteSession")[0].args, [fork]);
    assert.equal(store.get(ASIDES_KEY), undefined);
    // One OpenCode already lost counts as deleted.
    store.data.set(ASIDES_KEY, ["ses_gone"]);
    next.client.deleteError = new OpenCodeHttpError(404, "NotFound", "Session not found");
    await next.c.cleanupAsides();
    assert.equal(store.get(ASIDES_KEY), undefined);
  });

  it("shows why the copy could not be made, and tries again on the next question", async () => {
    const s = await opened();
    s.client.forkError = new OpenCodeHttpError(500, "Error", "boom");
    await s.c.askAside("q1");
    const view = s.c.asideView()!;
    assert.equal(view.status, "idle");
    assert.match(view.error ?? "", /^Could not start the side thread: boom/);
    s.client.forkError = null;
    await s.c.askAside("q2");
    assert.equal(s.client.callsTo("forkSession").length, 2);
    assert.equal(s.c.asideView()?.error, null);
  });

  it("shows the model's error in the card, such as a used-up free limit", async () => {
    const s = await opened();
    const fork = await ask(s);
    s.c.handleRawEvent(
      raw("session.execution.failed", {
        sessionID: fork,
        error: { type: "provider.free-limit", message: "Free usage limit reached for today", status: 429 },
      }),
    );
    const turn = s.c.asideView()!.turns[0];
    assert.equal(turn.done, true);
    assert.match(turn.error ?? "", /limit/i);
    assert.deepEqual(
      s.emitted.filter((e) => e.type === "error" || e.type === "notice"),
      [],
    );
    s.client.promptError = new OpenCodeHttpError(429, "provider.free-limit", "limit");
    await s.c.askAside("again?");
    assert.match(s.c.asideView()!.turns[1].error ?? "", /Could not ask the side question/);
  });

  it("sends the answer to the main session: queued while it works, plain when idle", async () => {
    const s = await opened();
    const fork = await ask(s, "Which test covers login?");
    assert.equal(await s.c.asideToMain(), false, "nothing answered yet");
    s.c.handleRawEvent(
      raw("session.text.ended", {
        sessionID: fork,
        assistantMessageID: "m1",
        ordinal: 0,
        text: "auth.test.ts",
      }),
    );
    s.c.handleRawEvent(raw("session.execution.succeeded", { sessionID: fork }));
    s.c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_main" }));
    assert.equal(await s.c.asideToMain(), true);
    const [id, input] = s.client.callsTo("prompt").at(-1)!.args as [string, PromptInput];
    assert.equal(id, "ses_main");
    assert.equal(input.delivery, "queue");
    assert.match(input.text, /Which test covers login\?/);
    assert.match(input.text, /auth\.test\.ts/);
    assert.equal(s.c.asideView()?.turns[0].sent, true);
    s.c.handleRawEvent(raw("session.execution.succeeded", { sessionID: "ses_main" }));
    await s.c.asideToMain();
    assert.equal((s.client.callsTo("prompt").at(-1)!.args[1] as PromptInput).delivery, undefined);
  });

  it("closes with the folder", async () => {
    const s = await opened();
    const fork = await ask(s);
    await s.c.setDirectory("/work/other");
    await tick();
    assert.equal(s.c.asideView(), null);
    assert.deepEqual(s.client.callsTo("deleteSession")[0].args, [fork]);
  });

  it("validates the aside messages from the view", () => {
    assert.ok(parseWebviewMessage({ type: "askAside", text: "why?" }));
    assert.equal(parseWebviewMessage({ type: "askAside", text: "  " }), undefined);
    assert.equal(parseWebviewMessage({ type: "askAside", text: "x", extra: 1 }), undefined);
    assert.ok(parseWebviewMessage({ type: "closeAside" }));
    assert.ok(parseWebviewMessage({ type: "asideToMain" }));
    assert.equal(parseWebviewMessage({ type: "asideToMain", text: "x" }), undefined);
  });
});
