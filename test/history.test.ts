import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HISTORY_LIMIT, MAX_HISTORY, SessionController } from "../src/core/sessionController";
import { OpenCodeHttpError } from "../src/opencode/client";
import { historyToEvents, messageEvents } from "../src/opencode/events";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";

function setup() {
  const client = new MockClient();
  const warnings: string[] = [];
  const errors: string[] = [];
  const c = new SessionController(
    client,
    new MemoryStore(),
    { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
    { info() {}, warn: (m) => warnings.push(m), error: (m) => errors.push(m) },
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  return { client, c, warnings, errors };
}

const user = (i: number) => ({ id: `msg_u${i}`, type: "user", text: `prompt ${i}`, time: { created: i } });
const reply = (i: number) => ({
  id: `msg_a${i}`,
  type: "assistant",
  time: { created: i, completed: i + 1 },
  content: [{ type: "text", text: `answer ${i}` }],
});
const summary = (id: string) => ({
  id,
  title: id,
  created: 1,
  updated: 1,
  agent: null,
  modelKey: null,
  variant: null,
  outcome: null,
  cost: null,
});
/** A conversation of `turns` prompts and replies: 2 × turns messages. */
const conversation = (turns: number) => Array.from({ length: turns }, (_, i) => [user(i), reply(i)]).flat();

describe("history: messages that cannot be read", () => {
  it("turns a message that is not an object, has no type or breaks the replay into a placeholder", () => {
    const boom = {
      id: "msg_bad",
      type: "assistant",
      get content(): unknown {
        throw new Error("boom");
      },
    };
    const events = historyToEvents([user(1), 42, { id: "msg_x" }, boom, reply(1)]);
    assert.deepEqual(
      events.filter((e) => e.type === "history.unreadable"),
      [
        { type: "history.unreadable", id: "#1", reason: "It is not an object." },
        { type: "history.unreadable", id: "msg_x", reason: "It has no type." },
        { type: "history.unreadable", id: "msg_bad", reason: "boom" },
      ],
    );
    assert.equal(events[0].type, "user.message", "the rest still replays");
    assert.equal(events.at(-1)?.type, "assistant.completed");
    assert.deepEqual(
      messageEvents({ id: "m", type: "model-switched" }),
      [],
      "known types with nothing to show",
    );
  });

  it("opens the session with a placeholder row, logs it, and opens the message as raw JSON", async () => {
    const { client, c, warnings } = setup();
    await c.setDirectory(DIR);
    client.sessions = [summary("ses_old")];
    client.messages = [user(1), { id: "msg_broken", text: "no type" }, reply(1)];
    assert.equal(await c.openSession("ses_old"), true);
    const kinds = c.transcript.items.map((i) => i.kind);
    assert.deepEqual(kinds, ["user", "unreadable", "assistant"]);
    assert.match(
      warnings.join("\n"),
      /1 message\(s\) of ses_old could not be shown: msg_broken \(It has no type\.\)/,
    );
    const raw = c.rawJson("unreadable:msg_broken");
    assert.equal(raw?.title, "msg_broken.json");
    assert.deepEqual(JSON.parse(raw!.text), { id: "msg_broken", text: "no type" });
    assert.deepEqual(JSON.parse(c.rawJson("user:msg_u1")!.text).text, "prompt 1", "any entry opens as JSON");
    assert.equal(c.rawJson("nope"), null);
  });
});

describe("history: messages that do not load", () => {
  it("keeps the session open read-only with the reason, refuses to send, and Retry loads it", async () => {
    const { client, c, errors } = setup();
    await c.setDirectory(DIR);
    client.sessions = [summary("ses_1")];
    client.messages = conversation(2);
    const listMessages = client.listMessages.bind(client);
    client.listMessages = async () => {
      throw new OpenCodeHttpError(500, "UnknownError", "Unexpected token in JSON");
    };
    assert.equal(await c.openSession("ses_1"), true);
    assert.equal(c.current?.id, "ses_1", "the session is open");
    assert.equal(c.historyView().error, "Could not load the messages: Unexpected token in JSON");
    assert.match(errors.join("\n"), /Loading the messages of ses_1 failed/);
    assert.equal(await c.send("hello", []), false, "read-only");
    assert.equal(client.callsTo("prompt").length, 0);
    client.listMessages = listMessages;
    await c.retryHistory();
    assert.equal(c.historyView().error, null);
    assert.equal(c.transcript.items.filter((i) => i.kind === "user").length, 2);
    assert.equal(await c.send("hello", []), true);
  });
});

describe("history: long sessions", () => {
  it("loads the newest messages, then earlier ones on request, up to the cap, and keeps them on reload", async () => {
    const { client, c } = setup();
    await c.setDirectory(DIR);
    client.sessions = [summary("ses_1")];
    client.messages = conversation(1300); // 2,600 messages
    await c.openSession("ses_1");
    const prompts = () => c.transcript.items.filter((i) => i.kind === "user").length;
    assert.equal(prompts(), HISTORY_LIMIT / 2);
    assert.deepEqual(c.historyView(), { more: true, capped: false, loading: false, error: null });
    assert.equal(c.transcript.items[0].id, `user:msg_u${1300 - HISTORY_LIMIT / 2}`, "the newest ones");
    await c.loadEarlier();
    assert.equal(prompts(), HISTORY_LIMIT);
    // A reconnect or a rewind made elsewhere reloads the session: the earlier messages stay.
    await c.resync();
    assert.equal(prompts(), HISTORY_LIMIT);
    for (let i = 0; i < 10; i++) await c.loadEarlier();
    assert.equal(prompts(), MAX_HISTORY / 2, "never more than the cap");
    assert.deepEqual(c.historyView(), { more: false, capped: true, loading: false, error: null });
    // Another session starts from the newest ones again.
    client.sessions = [summary("ses_1"), summary("ses_2")];
    client.messages = conversation(3);
    await c.openSession("ses_2");
    assert.deepEqual(c.historyView(), { more: false, capped: false, loading: false, error: null });
  });
});
