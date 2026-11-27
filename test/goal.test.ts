import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionController } from "../src/core/sessionController";
import { HttpOpenCodeClient, OpenCodeHttpError } from "../src/opencode/client";
import { EventNormalizer, parseGoal } from "../src/opencode/events";
import type { GoalState, SessionSummary } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const GOAL: GoalState = {
  id: "338c03e5",
  objective: "make the tests pass",
  status: "active",
  reason: null,
  rounds: 0,
  maxRounds: 50,
};
/** OpenCode's Goal.State as its plugin sends it (with fields Sidecar does not keep). */
const RAW = {
  id: "338c03e5",
  objective: "make the tests pass",
  status: "active",
  rounds: 0,
  maxRounds: 50,
  boot: "ada8276a",
  updatedAt: 1795758713143,
};

const session = (id: string): SessionSummary => ({
  id,
  title: id,
  created: 1,
  updated: 1,
  agent: "build",
  modelKey: null,
  variant: null,
  outcome: null,
  cost: null,
});

function setup() {
  const client = new MockClient();
  client.sessions = [session("ses_g")];
  client.commands.push({
    name: "goal",
    description: "keep working until an objective is met [pause|resume|clear]",
  });
  let states = 0;
  const c = new SessionController(
    client,
    new MemoryStore(),
    { onEvents() {}, onTranscriptReset() {}, onStateChanged: () => states++ },
    { info() {}, warn() {}, error() {} },
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1, goalRetryMs: 1 },
  );
  return { client, c, states: () => states };
}

/** Waits for the goal read after opening a session. */
async function settled(ok: () => boolean) {
  for (let i = 0; i < 40 && !ok(); i++) await tick();
}

describe("goals: OpenCode's goal plugin", () => {
  it("reads Goal.State and nothing that is not one", () => {
    assert.deepEqual(parseGoal(RAW), GOAL);
    assert.deepEqual(parseGoal({ ...RAW, status: "paused", reason: "Paused by the user", rounds: 3 }), {
      ...GOAL,
      status: "paused",
      reason: "Paused by the user",
      rounds: 3,
    });
    assert.equal(parseGoal({ ...RAW, status: "done" }), null);
    assert.equal(parseGoal({ ...RAW, objective: "" }), null);
    assert.equal(parseGoal(null), null);
    assert.equal(parseGoal({ ...RAW, maxRounds: 0 })?.maxRounds, null);
  });

  it("normalizes the plugin's event for the session it names, null once cleared", () => {
    const n = new EventNormalizer();
    const ev = (goal: unknown) =>
      n.normalize({
        id: "e",
        created: 1,
        type: "rpc.opencode.goal.changed",
        location: { directory: DIR },
        data: { sessionID: "ses_g", goal },
      });
    const set = ev(RAW);
    assert.equal(set?.sessionID, "ses_g");
    assert.deepEqual(set?.events, [{ type: "goal.changed", goal: GOAL }]);
    assert.deepEqual(ev(null)?.events, [{ type: "goal.changed", goal: null }]);
  });

  it("asks the plugin's RPC with the session, in the folder", async () => {
    const calls: Array<{ url: URL; body: unknown }> = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (calls.length === 3)
        return new Response(
          JSON.stringify({
            _tag: "RpcError",
            type: "rpc.unavailable",
            message: "RPC is unavailable: opencode.goal",
          }),
          { status: 400 },
        );
      return new Response(JSON.stringify({ output: calls.length === 1 ? RAW : null }));
    }) as typeof fetch;
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn);
    assert.deepEqual(await c.getGoal("c:\\repo", "ses_g"), GOAL);
    assert.equal(await c.getGoal("c:\\repo", "ses_none"), null);
    await assert.rejects(c.getGoal("c:\\repo", "ses_g"), (e: unknown) => {
      assert.ok(e instanceof OpenCodeHttpError);
      assert.equal(e.tag, "RpcError");
      return true;
    });
    assert.equal(calls[0].url.pathname, "/api/rpc/opencode.goal/get");
    assert.equal(calls[0].url.searchParams.get("location[directory]"), "C:\\repo");
    assert.deepEqual(calls[0].body, { input: { sessionID: "ses_g" } });
  });

  it("accepts the header's actions and nothing else", () => {
    for (const action of ["pause", "resume", "clear"])
      assert.deepEqual(parseWebviewMessage({ type: "goalAction", action }), { type: "goalAction", action });
    assert.equal(parseWebviewMessage({ type: "goalAction", action: "set" }), undefined);
    assert.equal(parseWebviewMessage({ type: "goalAction", action: "clear", objective: "x" }), undefined);
  });
});

describe("session controller: the goal header", () => {
  it("reads the open session's goal and follows the plugin's events, from any client", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.goals.set("ses_g", GOAL);
    await c.openSession("ses_g");
    await settled(() => !!c.goalView());
    assert.deepEqual(c.goalView(), {
      objective: "make the tests pass",
      status: "active",
      reason: null,
      rounds: 0,
      maxRounds: 50,
    });
    const event = (sessionID: string, goal: unknown) =>
      c.handleRawEvent({ id: "e", created: 1, type: "rpc.opencode.goal.changed", data: { sessionID, goal } });
    event("ses_g", { ...RAW, status: "active", rounds: 2 });
    assert.equal(c.goalView()?.rounds, 2);
    event("ses_other", { ...RAW, status: "complete" });
    assert.equal(c.goalView()?.status, "active", "another session's goal is not this one's");
    event("ses_g", { ...RAW, status: "complete", reason: "All tests pass", rounds: 2 });
    assert.deepEqual([c.goalView()?.status, c.goalView()?.reason], ["complete", "All tests pass"]);
    event("ses_g", null);
    assert.equal(c.goalView(), null);
  });

  it("has no goal for a session without one, or after switching away", async () => {
    const { c, client } = setup();
    client.sessions.push(session("ses_plain"));
    await c.setDirectory(DIR);
    client.goals.set("ses_g", GOAL);
    await c.openSession("ses_g");
    await settled(() => !!c.goalView());
    await c.openSession("ses_plain");
    await settled(() => client.callsTo("getGoal").length >= 2);
    await tick(10);
    assert.equal(c.goalView(), null);
    c.newSession();
    assert.equal(c.goalView(), null);
  });

  it("tries the plugin again while it loads, and falls back to the history's goal notices", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.goals.set("ses_g", GOAL);
    client.goalFailures = 1;
    await c.openSession("ses_g");
    await settled(() => !!c.goalView());
    assert.equal(c.goalView()?.status, "active", "the second try got it");
    assert.equal(client.callsTo("getGoal").length, 2);

    const started =
      "A goal is now active for this session. Work toward it across turns until it is met.\n\n<untrusted_objective>\nship the docs\n</untrusted_objective>\n";
    const round =
      "Continue working toward the active goal.\n\n<untrusted_objective>\nship the docs\n</untrusted_objective>\n\nThe index is missing.";
    client.messages = [
      { id: "msg_s", type: "synthetic", text: started, metadata: { source: "goal", goalID: "g" } },
      { id: "msg_r1", type: "synthetic", text: round, metadata: { source: "goal", goalID: "g" } },
      { id: "msg_r2", type: "synthetic", text: round, metadata: { source: "goal", goalID: "g" } },
    ];
    client.goalFailures = 2;
    await c.openSession("ses_g");
    await settled(() => c.goalView()?.objective === "ship the docs");
    assert.deepEqual(c.goalView(), {
      objective: "ship the docs",
      status: null,
      reason: null,
      rounds: 2,
      maxRounds: null,
    });
  });

  it("pauses, resumes and ends the goal with OpenCode's /goal command, then reads it back", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.goals.set("ses_g", GOAL);
    await c.openSession("ses_g");
    await settled(() => !!c.goalView());
    client.goals.set("ses_g", { ...GOAL, status: "paused", reason: "Paused by the user" });
    await c.goalCommand("pause");
    await settled(() => c.goalView()?.status === "paused");
    await c.goalCommand("resume");
    client.goals.set("ses_g", null);
    await c.goalCommand("clear");
    await settled(() => c.goalView() === null);
    assert.deepEqual(
      client.callsTo("runCommand").map((x) => x.args),
      [
        ["ses_g", "goal", "pause"],
        ["ses_g", "goal", "resume"],
        ["ses_g", "goal", "clear"],
      ],
    );
    assert.equal(c.goalView(), null);
  });
});
