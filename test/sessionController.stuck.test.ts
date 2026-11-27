import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionController } from "../src/core/sessionController";
import type { StuckSettings } from "../src/core/stuck";
import type { UiEvent } from "../src/shared/model";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const silentLog = { info() {}, warn() {}, error() {} };
const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });

async function setup(stuck?: StuckSettings | null) {
  const client = new MockClient();
  let now = 10_000;
  const emitted: UiEvent[] = [];
  const c = new SessionController(
    client,
    new MemoryStore(),
    { onEvents: (e) => emitted.push(...e), onTranscriptReset() {}, onStateChanged() {} },
    silentLog,
    () => ({ model: "", agent: "", ...(stuck !== undefined ? { stuck } : {}) }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1, stuckCheckMs: 1e9, now: () => now },
  );
  await c.setDirectory(DIR);
  await c.send("fix the bug", []);
  c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_1" }));
  let n = 0;
  /** One tool call in `sessionID`, as OpenCode's events send it. */
  const tool = (name: string, input: Record<string, unknown>, text = "same", sessionID = "ses_1") => {
    const id = `call_${++n}`;
    c.handleRawEvent(raw("session.tool.input.started", { sessionID, id, name }));
    c.handleRawEvent(raw("session.tool.called", { sessionID, id, input }));
    c.handleRawEvent(raw("session.tool.success", { sessionID, id, content: [{ type: "text", text }] }));
  };
  return { c, client, emitted, tool, advance: (ms: number) => (now += ms) };
}

const cards = (c: SessionController) => c.transcript.items.filter((i) => i.kind === "stuck");

describe("session controller: the agent seems stuck", () => {
  it("shows a card after the same read three times, relative to the folder, and updates it", async () => {
    const { c, tool } = await setup();
    tool("read", { filePath: `${DIR}/src/a.ts` });
    tool("read", { filePath: `${DIR}/src/a.ts` });
    assert.equal(cards(c).length, 0);
    tool("read", { filePath: `${DIR}/src/a.ts` });
    const [card] = cards(c);
    assert.deepEqual(card?.kind === "stuck" && card.stuck, {
      reason: "repeat",
      calls: ["read src/a.ts"],
      count: 3,
      minutes: 0,
    });
    assert.equal(card?.kind === "stuck" && card.sessionID, "ses_1");
    tool("read", { filePath: `${DIR}/src/a.ts` });
    assert.equal(cards(c).length, 1, "the same card grows");
    const grown = cards(c)[0];
    assert.equal(grown.kind === "stuck" && grown.stuck.count, 4);
    // The agent moves on: the card goes.
    tool("read", { filePath: `${DIR}/src/b.ts` }, "other");
    const over = cards(c)[0];
    assert.equal(over.kind === "stuck" && over.resolved, "moved-on");
  });

  it("Dismiss hides it for good; Stop interrupts the run and never stops by itself", async () => {
    const { c, client, tool } = await setup();
    for (let i = 0; i < 3; i++) tool("shell", { command: "npm test" }, "1 failing");
    assert.equal(client.callsTo("interrupt").length, 0, "never stops by itself");
    await c.stuckAction("ses_1", "dismiss");
    assert.equal(cards(c)[0].kind === "stuck" && cards(c)[0].resolved, "dismissed");
    for (let i = 0; i < 3; i++) tool("shell", { command: "npm test" }, "1 failing");
    assert.equal(cards(c).length, 1, "a dismissed loop does not come back as it grows");
    tool("read", { filePath: `${DIR}/a.ts` });
    for (let i = 0; i < 3; i++) tool("read", { filePath: `${DIR}/b.ts` });
    assert.equal(cards(c).length, 2, "a new loop gets a new card");
    await c.stuckAction("ses_1", "stop");
    assert.equal(cards(c)[1].kind === "stuck" && cards(c)[1].resolved, "stopped");
    assert.deepEqual(client.callsTo("interrupt")[0].args, ["ses_1"]);
  });

  it("shows a card for a run that sends nothing for minutes, but not while a command runs", async () => {
    const { c, advance } = await setup({ repeats: 3, stallMs: 180_000 });
    c.handleRawEvent(raw("session.tool.input.started", { sessionID: "ses_1", id: "sh", name: "shell" }));
    advance(600_000);
    c.checkStalls();
    assert.equal(cards(c).length, 0, "a long build is not a stall");
    c.handleRawEvent(raw("session.tool.success", { sessionID: "ses_1", id: "sh", content: [] }));
    advance(179_000);
    c.checkStalls();
    assert.equal(cards(c).length, 0);
    advance(1_000);
    c.checkStalls();
    const [card] = cards(c);
    assert.deepEqual(card?.kind === "stuck" && card.stuck, {
      reason: "stall",
      calls: [],
      count: 0,
      minutes: 3,
    });
    c.handleRawEvent(raw("session.text.delta", { sessionID: "ses_1", partID: "p1", delta: "Still here" }));
    assert.equal(cards(c)[0].kind === "stuck" && cards(c)[0].resolved, "moved-on");
  });

  it("does not count waiting for the user's answer as a stall", async () => {
    const { c, advance } = await setup({ repeats: 3, stallMs: 60_000 });
    c.handleRawEvent(
      raw("permission.asked", { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["a.ts"] }),
    );
    advance(3_600_000);
    c.checkStalls();
    assert.equal(cards(c).length, 0);
  });

  it("puts a subagent's loop on its row, and Dismiss clears it", async () => {
    const { c, tool, client } = await setup();
    c.handleRawEvent(
      raw("session.created", { sessionID: "ses_sub", parentID: "ses_1", title: "Look", agent: "explore" }),
    );
    c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_sub" }));
    for (let i = 0; i < 3; i++) tool("glob", { pattern: "**/*.ts" }, "a.ts", "ses_sub");
    const sub = () => c.subagentViews().find((v) => v.sessionID === "ses_sub");
    assert.deepEqual(sub()?.stuck, { reason: "repeat", calls: ["glob **/*.ts"], count: 3, minutes: 0 });
    assert.equal(cards(c).length, 0, "not in the open session's timeline");
    await c.stuckAction("ses_sub", "dismiss");
    assert.equal(sub()?.stuck, undefined);
    await c.stuckAction("ses_sub", "stop");
    assert.deepEqual(client.callsTo("interrupt").at(-1)?.args, ["ses_sub"]);
  });

  it("is off with the setting off", async () => {
    const { c, tool, advance } = await setup(null);
    for (let i = 0; i < 5; i++) tool("read", { filePath: `${DIR}/a.ts` });
    advance(3_600_000);
    c.checkStalls();
    assert.equal(cards(c).length, 0);
  });
});
