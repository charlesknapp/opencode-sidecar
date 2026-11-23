import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskNotice } from "../src/core/currentTask";
import { SessionController } from "../src/core/sessionController";
import type { TranscriptItem, UiEvent } from "../src/shared/model";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const silentLog = { info() {}, warn() {}, error() {} };
const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });

function setup() {
  const client = new MockClient();
  let now = 10_000;
  const notices: TaskNotice[] = [];
  const viewer: { transcripts: Array<[string, TranscriptItem[]]>; events: Array<[string, UiEvent[]]> } = {
    transcripts: [],
    events: [],
  };
  let stateChanges = 0;
  const c = new SessionController(
    client,
    new MemoryStore(),
    {
      onEvents() {},
      onTranscriptReset() {},
      onStateChanged: () => stateChanges++,
      onTaskNotice: (n) => notices.push(n),
      onSubagentTranscript: (id, items) => viewer.transcripts.push([id, items.map((i) => ({ ...i }))]),
      onSubagentEvents: (id, events) => viewer.events.push([id, events]),
    },
    silentLog,
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1, now: () => now },
  );
  return {
    client,
    c,
    notices,
    viewer,
    stateChanges: () => stateChanges,
    advance: (ms: number) => (now += ms),
  };
}

/** A running task whose agent launched an `explore` subagent in session `ses_sub`. */
async function withSubagent() {
  const env = setup();
  await env.c.setDirectory(DIR);
  await env.c.send("find the token callers", []);
  const { c } = env;
  c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_1" }));
  c.handleRawEvent(raw("session.tool.input.started", { sessionID: "ses_1", id: "call_1", name: "subagent" }));
  c.handleRawEvent(
    raw("session.tool.called", {
      sessionID: "ses_1",
      id: "call_1",
      input: { agent: "explore", description: "Find token callers", prompt: "…" },
    }),
  );
  c.handleRawEvent(
    raw("session.created", {
      sessionID: "ses_sub",
      parentID: "ses_1",
      title: "Find token callers",
      agent: "explore",
    }),
  );
  // OpenCode 2.3 completes the subagent tool as soon as the subagent is launched.
  c.handleRawEvent(
    raw("session.tool.success", {
      sessionID: "ses_1",
      id: "call_1",
      content: [{ type: "text", text: "Started subagent" }],
      metadata: { sessionID: "ses_sub" },
    }),
  );
  c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_sub" }));
  return env;
}

const permission = (id: string, sessionID: string) =>
  raw("permission.asked", { id, sessionID, action: "bash", resources: ["npm test"] });

describe("session controller: subagent progress", () => {
  it("links the subagent tool call to the subagent's session", async () => {
    const { c } = await withSubagent();
    const tool = c.transcript.get("tool:call_1");
    assert.ok(tool?.kind === "tool" && tool.category === "agent");
    assert.equal(tool.detail.subagent, "ses_sub");
  });

  it("tracks what the subagent is doing and pushes state only when it visibly changes", async () => {
    const { c, stateChanges, advance } = await withSubagent();
    const before = stateChanges();
    c.handleRawEvent(raw("session.tool.input.started", { sessionID: "ses_sub", id: "t1", name: "grep" }));
    c.handleRawEvent(
      raw("session.tool.called", { sessionID: "ses_sub", id: "t1", input: { pattern: "refreshToken(" } }),
    );
    let v = c.subagentViews()[0];
    assert.deepEqual(
      [v.sessionID, v.agent, v.title, v.status, v.tools],
      ["ses_sub", "explore", "Find token callers", "running", 1],
    );
    assert.equal(v.activity?.kind === "tool" && v.activity.title, "Searched refreshToken(");
    assert.ok(stateChanges() > before);
    const afterTool = stateChanges();
    for (let i = 0; i < 3; i++)
      c.handleRawEvent(
        raw("session.text.delta", { sessionID: "ses_sub", assistantMessageID: "m", ordinal: 0, delta: "x" }),
      );
    assert.equal(stateChanges(), afterTool + 1, "one push when it starts writing, none per token");
    advance(41_000);
    c.handleRawEvent(raw("session.execution.succeeded", { sessionID: "ses_sub" }));
    v = c.subagentViews()[0];
    assert.equal(v.status, "completed");
    assert.equal(v.ended! - v.started!, 41_000);
  });

  it("keeps the task running while subagents work after the parent's turn ends", async () => {
    const { c, notices } = await withSubagent();
    c.handleRawEvent(raw("session.execution.succeeded", { sessionID: "ses_1" }));
    assert.equal(c.busy, false);
    let task = c.taskView();
    assert.deepEqual([task?.label, task?.status], ["current", "running"]);
    assert.equal(notices.filter((n) => n.kind === "completed").length, 0, "not reported as done yet");

    c.handleRawEvent(permission("per_1", "ses_sub"));
    assert.equal(c.taskView()?.status, "waiting");
    assert.equal(c.subagentViews()[0].status, "waiting");
    c.handleRawEvent(raw("permission.replied", { sessionID: "ses_sub", requestID: "per_1", reply: "once" }));

    c.handleRawEvent(raw("session.execution.succeeded", { sessionID: "ses_sub" }));
    task = c.taskView();
    assert.deepEqual([task?.label, task?.status], ["last", "completed"]);
    assert.equal(
      notices.filter((n) => n.kind === "completed").length,
      1,
      "reported once the subagent is done",
    );
  });

  it("stops one subagent without stopping the task", async () => {
    const { c, client } = await withSubagent();
    await c.stopSubagent("ses_sub");
    await c.stopSubagent("ses_not_ours");
    assert.deepEqual(
      client.callsTo("interrupt").map((call) => call.args[0]),
      ["ses_sub"],
    );
  });

  it("forgets subagents when a new session starts", async () => {
    const { c } = await withSubagent();
    await c.openSubagent("ses_sub");
    await c.newSession();
    assert.deepEqual(c.subagentViews(), []);
    assert.equal(c.viewingSubagent(), null);
  });
});

describe("session controller: subagent conversation (drill-in)", () => {
  it("opens a subagent: its history, the requests it waits on, then its live events", async () => {
    const { c, client, viewer } = await withSubagent();
    client.messagesBySession.set("ses_sub", [
      { id: "u_sub", type: "user", text: "Find every caller of refreshToken" },
      {
        id: "a_sub",
        type: "assistant",
        content: [{ type: "text", text: "Searching now." }],
      },
    ]);
    c.handleRawEvent(permission("per_sub", "ses_sub"));
    assert.equal(await c.openSubagent("ses_sub"), true);
    assert.deepEqual(c.viewingSubagent(), { id: "ses_sub", loading: false });
    assert.deepEqual(viewer.transcripts[0], ["ses_sub", []], "empty while loading");
    const [id, items] = viewer.transcripts[1];
    assert.equal(id, "ses_sub");
    assert.deepEqual(
      items.map((i) => i.id),
      ["user:u_sub", "text:a_sub:0", "perm:per_sub"],
    );
    assert.equal(client.callsTo("listMessages").at(-1)?.args[0], "ses_sub");

    c.handleRawEvent(
      raw("session.text.delta", {
        sessionID: "ses_sub",
        assistantMessageID: "m2",
        ordinal: 0,
        delta: "Found 4.",
      }),
    );
    const before = Date.now();
    const [sessionID, forwarded] = viewer.events.at(-1)!;
    assert.equal(sessionID, "ses_sub");
    const { time, ...ev } = forwarded[0] as Extract<UiEvent, { type: "assistant.delta" }>;
    assert.deepEqual(ev, { type: "assistant.delta", partId: "m2:0", delta: "Found 4." });
    // Live events get their arrival time, so the subagent view can show timestamps.
    assert.ok(typeof time === "number" && time <= before && before - time < 5000);
    assert.ok(c.subagentItems().some((i) => i.kind === "assistant" && i.text === "Found 4."));
    // The parent conversation never receives the subagent's own text.
    assert.ok(!c.transcript.items.some((i) => i.kind === "assistant" && i.text === "Found 4."));
  });

  it("forwards only the open subagent's events, and nothing after it is closed", async () => {
    const { c, viewer } = await withSubagent();
    c.handleRawEvent(raw("session.created", { sessionID: "ses_other", parentID: "ses_1" }));
    await c.openSubagent("ses_sub");
    const delta = (sessionID: string) =>
      raw("session.text.delta", { sessionID, assistantMessageID: "m", ordinal: 0, delta: "x" });
    c.handleRawEvent(delta("ses_other"));
    assert.equal(viewer.events.length, 0);
    c.closeSubagent();
    assert.equal(c.viewingSubagent(), null);
    c.handleRawEvent(delta("ses_sub"));
    assert.equal(viewer.events.length, 0);
  });

  it("opens only subagents of the open session", async () => {
    const { c } = await withSubagent();
    assert.equal(await c.openSubagent("ses_unrelated"), false);
    assert.equal(c.viewingSubagent(), null);
  });

  it("closes the view and reports it when the history cannot be loaded", async () => {
    const { c, client } = await withSubagent();
    client.listMessages = async () => {
      throw new TypeError("fetch failed");
    };
    assert.equal(await c.openSubagent("ses_sub"), false);
    assert.equal(c.viewingSubagent(), null);
    assert.ok(c.transcript.items.some((i) => i.kind === "notice" && i.level === "error"));
  });

  it("restores subagent cards when a session is reopened", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.sessions = [
      {
        id: "ses_old",
        title: "Old",
        created: 1,
        updated: 2,
        agent: "build",
        modelKey: null,
        outcome: null,
        variant: null,
        cost: 0,
      },
      {
        id: "ses_done",
        title: "Explore",
        created: 5,
        updated: 50,
        agent: "explore",
        modelKey: null,
        outcome: "succeeded",
        variant: null,
        cost: 0.01,
      },
    ];
    client.children.set("ses_old", ["ses_done"]);
    await c.openSession("ses_old");
    const [v] = c.subagentViews();
    assert.deepEqual(
      [v.sessionID, v.status, v.agent, v.started, v.ended, v.tools],
      ["ses_done", "completed", "explore", 5, 50, null],
    );
  });
});
