// Features built on OpenCode's session API: `@` mentions, images, fork, archive and a
// rewind staged in another client. Request shapes follow OpenCode's OpenAPI document
// (GET /openapi.json); fork, archive, revert clear, skills and file search were also
// checked against a live OpenCode 2 service.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { buildPrompt, dataUriBytes, locateMentions, type ResolvedMention } from "../src/core/context";
import { SessionController } from "../src/core/sessionController";
import { HttpOpenCodeClient, toModelOption, toSessionSummary } from "../src/opencode/client";
import type { SessionSummary, UiEvent } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const silentLog = { info() {}, warn() {}, error() {} };

function setup() {
  const client = new MockClient();
  const emitted: UiEvent[] = [];
  const c = new SessionController(
    client,
    new MemoryStore(),
    { onEvents: (e) => emitted.push(...e), onTranscriptReset() {}, onStateChanged() {} },
    silentLog,
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  return { client, c, emitted };
}

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: "Old",
  created: 1,
  updated: 2,
  agent: "build",
  modelKey: null,
  outcome: null,
  variant: null,
  cost: 0,
  ...extra,
});

async function opened() {
  const s = setup();
  await s.c.setDirectory(DIR);
  s.client.sessions = [session("ses_old")];
  s.client.messages = [
    { id: "u1", type: "user", text: "first", time: { created: 1 } },
    { id: "u2", type: "user", text: "second prompt", time: { created: 2 } },
  ];
  await s.c.openSession("ses_old");
  return s;
}

describe("@ mentions in the prompt", () => {
  const file = (rel: string): ResolvedMention => ({
    kind: "file",
    absPath: `/repo/${rel}`,
    relPath: rel,
    text: `@${rel}`,
  });

  it("finds each token as a whole word, in order, and skips deleted ones", () => {
    const text = "see @src/a.ts and @src/a.ts.bak, ask @explore";
    const found = locateMentions(text, [{ text: "@src/a.ts" }, { text: "@explore" }, { text: "@gone" }]);
    assert.deepEqual(
      found.map((m) => [m.text, m.span.start, m.span.end]),
      [
        ["@src/a.ts", 4, 13],
        ["@explore", 37, 45],
      ],
    );
  });

  it("sends files and folders as attachments with their mention, agents and skills by name", () => {
    const p = buildPrompt(
      "  Compare @src/a.ts with @docs/ using @explore and @review  ",
      [],
      [
        file("src/a.ts"),
        { kind: "folder", absPath: "/repo/docs", relPath: "docs", text: "@docs/" },
        { kind: "agent", name: "explore", text: "@explore" },
        { kind: "skill", id: "review", text: "@review" },
      ],
    );
    assert.equal(p.text, "Compare @src/a.ts with @docs/ using @explore and @review");
    assert.deepEqual(p.files, [
      {
        uri: pathToFileURL("/repo/src/a.ts").href,
        name: "src/a.ts",
        mention: { start: 8, end: 17, text: "@src/a.ts" },
      },
      {
        uri: pathToFileURL("/repo/docs").href,
        name: "docs",
        mention: { start: 23, end: 29, text: "@docs/" },
      },
    ]);
    assert.deepEqual(p.agents, [{ name: "explore", mention: { start: 36, end: 44, text: "@explore" } }]);
    assert.deepEqual(p.skills, [{ id: "review", mention: { start: 49, end: 56, text: "@review" } }]);
  });

  it("does not attach a file twice when it is both mentioned and attached", () => {
    const p = buildPrompt(
      "fix @src/a.ts",
      [{ kind: "file", id: "1", relPath: "src/a.ts", absPath: "/repo/src/a.ts" }],
      [file("src/a.ts")],
    );
    assert.equal(p.files.length, 1);
    assert.ok(p.files[0].mention);
    assert.equal(p.agents, undefined);
  });
});

describe("images", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("are sent as file attachments with their data: or file:// URI", () => {
    const p = buildPrompt("what is this?", [
      { kind: "image", id: "i1", name: "shot.png", uri: png, detail: "8 B" },
      { kind: "image", id: "i2", name: "b.png", uri: "file:///tmp/b.png", detail: "1 KB" },
    ]);
    assert.deepEqual(p.files, [
      { uri: png, name: "shot.png" },
      { uri: "file:///tmp/b.png", name: "b.png" },
    ]);
  });

  it("measures a data: URI's decoded size", () => {
    assert.equal(dataUriBytes("data:image/png;base64,AAAA"), 3);
    assert.equal(dataUriBytes("data:image/png;base64,AAA="), 2);
    assert.equal(dataUriBytes("file:///a.png"), null);
  });

  it("the view may send only small base64 PNG, JPEG, GIF or WebP images", () => {
    const ok = { type: "attachImage", name: "a.png", dataUrl: png, thumb: png, width: 10, height: 10 };
    assert.ok(parseWebviewMessage(ok));
    assert.equal(parseWebviewMessage({ ...ok, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }), undefined);
    assert.equal(parseWebviewMessage({ ...ok, dataUrl: "file:///etc/passwd" }), undefined);
    assert.equal(parseWebviewMessage({ ...ok, width: -1 }), undefined);
    assert.equal(
      parseWebviewMessage({ ...ok, dataUrl: `data:image/png;base64,${"A".repeat(7_000_000)}` }),
      undefined,
    );
  });

  it("marks models that take image input", () => {
    const base = { id: "m", providerID: "p", name: "M", limit: { context: 1 } };
    assert.equal(
      toModelOption({ ...base, capabilities: { input: ["text", "image"] } }, new Map())?.images,
      true,
    );
    assert.equal(toModelOption({ ...base, capabilities: { input: ["text"] } }, new Map())?.images, undefined);
  });
});

describe("mention and session messages from the view", () => {
  it("accepts mentions only in their exact shape", () => {
    const m = { kind: "file", value: "src/a.ts", text: "@src/a.ts" };
    assert.ok(parseWebviewMessage({ type: "send", text: "x @src/a.ts", mentions: [m] }));
    assert.equal(
      parseWebviewMessage({ type: "send", text: "x", mentions: [{ ...m, kind: "url" }] }),
      undefined,
    );
    assert.equal(
      parseWebviewMessage({ type: "send", text: "x", mentions: [{ ...m, text: "src" }] }),
      undefined,
    );
    assert.equal(parseWebviewMessage({ type: "send", text: "x", mentions: [{ ...m, extra: 1 }] }), undefined);
    assert.ok(parseWebviewMessage({ type: "findMentions", query: "src", requestId: "m1" }));
  });

  it("accepts fork, archive and staged-rewind messages", () => {
    assert.ok(parseWebviewMessage({ type: "forkSession" }));
    assert.ok(parseWebviewMessage({ type: "forkSession", messageID: "msg_1" }));
    assert.ok(parseWebviewMessage({ type: "archiveSession", id: "ses_1", archived: true }));
    assert.equal(parseWebviewMessage({ type: "archiveSession", id: "ses_1", archived: "yes" }), undefined);
    assert.ok(parseWebviewMessage({ type: "resolveRevert", action: "restore" }));
    assert.equal(parseWebviewMessage({ type: "resolveRevert", action: "delete" }), undefined);
    assert.ok(parseWebviewMessage({ type: "loadArchived" }));
  });
});

describe("HTTP client: session features", () => {
  function fake(responses: Record<string, unknown>) {
    const calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const body = responses[`${method} ${url.pathname}`];
      return body === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body));
    }) as typeof fetch;
    return { client: new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn), calls };
  }

  it("forks, archives and resolves a staged rewind with OpenCode's requests", async () => {
    const { client, calls } = fake({
      "POST /api/session/ses_1/fork": { data: { id: "ses_2", fork: { sessionID: "ses_1" }, time: {} } },
    });
    const forked = await client.forkSession("ses_1", "msg_9");
    assert.equal(forked.id, "ses_2");
    assert.equal(forked.forked, true);
    await client.forkSession("ses_1");
    await client.setArchived("ses_1", true);
    await client.resolveRevert("ses_1", "clear");
    await client.resolveRevert("ses_1", "commit");
    assert.deepEqual(
      calls.map((c) => [c.method, c.path, c.body]),
      [
        ["POST", "/api/session/ses_1/fork", { before: "msg_9" }],
        ["POST", "/api/session/ses_1/fork", {}],
        ["PATCH", "/api/session/ses_1", { archived: true }],
        ["DELETE", "/api/session/ses_1/revert", undefined],
        ["POST", "/api/session/ses_1/revert/commit", undefined],
      ],
    );
  });

  it("lists active or archived sessions, since OpenCode includes archived ones unless asked", async () => {
    const { client, calls } = fake({ "GET /api/session": { data: [] } });
    await client.listSessions("/r", 30);
    await client.listSessions("/r", 30, true);
    assert.equal(calls[0].query.get("archived"), "false");
    assert.equal(calls[1].query.get("archived"), "true");
  });

  it("reads fork, archive and staged-rewind state from a session", () => {
    const s = toSessionSummary({
      id: "ses_1",
      time: { created: 1, updated: 2, archived: 3 },
      fork: { sessionID: "ses_0", boundary: { type: "before", messageID: "msg_1" } },
      revert: { messageID: "msg_5", files: [{ file: "a.ts" }, { file: "b.ts" }] },
    });
    assert.equal(s.forked, true);
    assert.equal(s.archived, true);
    assert.deepEqual(s.revert, { messageID: "msg_5", files: 2 });
    assert.equal(toSessionSummary({ id: "ses_2", time: {} }).revert, undefined);
  });

  it("finds files with OpenCode's search and lists subagents and skills", async () => {
    const { client, calls } = fake({
      "GET /api/fs/find": {
        data: [
          { path: "src\\", type: "directory" },
          { path: "src/alpha.ts", type: "file" },
        ],
      },
      "GET /api/agent": {
        data: [
          { id: "build", name: "Build", mode: "primary" },
          { id: "explore", name: "Explore", mode: "subagent", description: "Reads code. Fast." },
          { id: "title", name: "Title", mode: "primary", hidden: true },
          { id: "general", name: "General", mode: "all" },
        ],
      },
      "GET /api/skill": {
        data: [
          { id: "review", name: "Review", description: "Reviews. More.", path: "/x", content: "secret" },
        ],
      },
    });
    assert.deepEqual(await client.findFiles("/r", "src", 30), [
      { path: "src", type: "directory" },
      { path: "src/alpha.ts", type: "file" },
    ]);
    assert.equal(calls[0].query.get("query"), "src");
    assert.equal(calls[0].query.get("limit"), "30");
    assert.deepEqual(
      (await client.listSubagents("/r")).map((a) => a.id),
      ["explore", "general"],
    );
    assert.deepEqual(await client.listSkills("/r"), [
      { id: "review", name: "Review", description: "Reviews." },
    ]);
  });

  it("sends agent and skill mentions with the prompt", async () => {
    const { client, calls } = fake({ "POST /api/session/ses_1/prompt": { data: { id: "msg_1" } } });
    await client.prompt("ses_1", {
      text: "@explore",
      files: [],
      agents: [{ name: "explore", mention: { start: 0, end: 8, text: "@explore" } }],
    });
    assert.deepEqual(calls[0].body, {
      text: "@explore",
      agents: [{ name: "explore", mention: { start: 0, end: 8, text: "@explore" } }],
    });
  });
});

describe("session controller: mentions, fork, archive and staged rewinds", () => {
  it("loads subagents and skills with the catalog and sends mentions with the prompt", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    assert.deepEqual(
      c.mentionAgents.map((a) => a.id),
      ["explore", "general"],
    );
    assert.deepEqual(
      c.skills.map((k) => k.id),
      ["review"],
    );
    await c.send("ask @explore", [], undefined, [{ kind: "agent", name: "explore", text: "@explore" }]);
    const input = client.callsTo("prompt")[0].args[1] as { agents?: unknown[] };
    assert.equal(input.agents?.length, 1);
  });

  it("forks before a prompt, opens the copy and returns the prompt's text", async () => {
    const { c, client } = await opened();
    assert.equal(await c.fork("u2"), "second prompt");
    assert.deepEqual(client.callsTo("forkSession")[0].args, ["ses_old", "u2"]);
    assert.notEqual(c.current?.id, "ses_old");
    assert.equal(c.current?.forked, true);
  });

  it("forks the whole conversation, and refuses an unknown prompt", async () => {
    const { c, client } = await opened();
    assert.equal(await c.fork("nope"), null);
    assert.equal(await c.fork(), "");
    assert.deepEqual(client.callsTo("forkSession")[0].args, ["ses_old"]);
  });

  it("archives the open session (starting a new one) and restores it from the archived list", async () => {
    const { c, client } = await opened();
    await c.setArchived("ses_old", true);
    assert.deepEqual(client.callsTo("setArchived")[0].args, ["ses_old", true]);
    assert.equal(c.current, null, "a new session starts");
    assert.ok(!c.sessions.some((s) => s.id === "ses_old"));
    await c.loadArchived();
    assert.deepEqual(
      c.archivedSessions?.map((s) => s.id),
      ["ses_old"],
    );
    await c.setArchived("ses_old", false);
    assert.deepEqual(c.archivedSessions, []);
    assert.ok(c.sessions.some((s) => s.id === "ses_old"));
  });

  it("shows a rewind staged elsewhere, and restores or applies it", async () => {
    const { c, client } = await opened();
    client.sessions[0].revert = { messageID: "u2", files: 1 };
    await c.openSession("ses_old");
    assert.deepEqual(c.stagedRevert(), { messageID: "u2", files: 1 });
    await c.resolveRevert("restore");
    assert.deepEqual(client.callsTo("resolveRevert")[0].args, ["ses_old", "clear"]);
    assert.equal(c.stagedRevert(), null);

    client.sessions[0].revert = { messageID: "u2", files: 0 };
    await c.openSession("ses_old");
    await c.resolveRevert("apply");
    assert.deepEqual(client.callsTo("resolveRevert")[1].args, ["ses_old", "commit"]);
  });
});
