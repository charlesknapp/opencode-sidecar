// Live tests: HttpOpenCodeClient against the real local OpenCode service, found the way the
// extension finds it (discoverServer). They skip when no service is registered or it does not
// answer, so CI stays green. Every session they create lives in a fresh temporary folder and
// is deleted afterwards. Only the prompt test calls a model (a free one, with a tiny prompt).
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import {
  HttpOpenCodeClient,
  OpenCodeHttpError,
  opencodeDirectory,
  type Endpoint,
  type EventSubscription,
} from "../../src/opencode/client";
import { EventNormalizer, historyToEvents, type NormalizedEnvelope } from "../../src/opencode/events";
import { discoverServer } from "../../src/opencode/service";
import type { SessionSummary } from "../../src/shared/model";

/** Free model used by the one test that needs a reply. */
const FREE_MODEL = { providerID: "opencode", id: "big-pickle" };

let client: HttpOpenCodeClient | undefined;
let endpoint: Endpoint | undefined;
let skipReason = "";
let dir = "";
const created = new Set<string>();

before(async () => {
  const outcome = await discoverServer(
    { serverUrl: "", allowRemote: false },
    { readFile: (f) => fs.promises.readFile(f, "utf8").catch(() => undefined), fetch, env: process.env },
  );
  if (!outcome.ok) {
    // `detail` names the URL at most, never the password.
    skipReason = `no live OpenCode service (${outcome.reason}: ${outcome.detail})`;
    return;
  }
  endpoint = outcome.endpoint;
  client = new HttpOpenCodeClient(endpoint);
  // A real folder (no 8.3 short names), as VS Code would report it.
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-")));
  fs.writeFileSync(path.join(dir, "hello-live.txt"), "hello\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "main-live.ts"), "export {};\n");
  // A folder OpenCode has not loaded yet briefly lists no models (the controller retries too).
  for (let i = 0; i < 20 && (await client.listModels(dir)).length === 0; i++)
    await new Promise((r) => setTimeout(r, 500));
});

after(async () => {
  for (const id of created) await client?.deleteSession(id).catch(() => undefined);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** The client, or skips the test when there is no live service. */
function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

async function newSession(c: HttpOpenCodeClient, directory = dir): Promise<SessionSummary> {
  const s = await c.createSession({ directory });
  created.add(s.id);
  return s;
}

/** A raw request with the discovered credentials (for what the client deliberately cannot do). */
async function raw(method: string, p: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(p, endpoint!.url), {
    method,
    headers: {
      "content-type": "application/json",
      ...(endpoint!.authorization ? { authorization: endpoint!.authorization } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(res.ok, `${method} ${p}: HTTP ${res.status}`);
  return (res.status === 204 ? {} : await res.json()) as Record<string, unknown>;
}

/** Collects normalized events until `done` matches one, or times out. */
function collect(
  c: HttpOpenCodeClient,
  done: (env: NormalizedEnvelope, raw: Record<string, unknown>) => boolean,
  timeoutMs: number,
): { opened: Promise<void>; finished: Promise<NormalizedEnvelope[]>; sub: EventSubscription } {
  const normalizer = new EventNormalizer();
  const seen: NormalizedEnvelope[] = [];
  let open!: () => void;
  let finish!: (v: NormalizedEnvelope[]) => void;
  let fail!: (e: Error) => void;
  const opened = new Promise<void>((r) => (open = r));
  const finished = new Promise<NormalizedEnvelope[]>((res, rej) => {
    finish = res;
    fail = rej;
  });
  const timer = setTimeout(() => fail(new Error("timed out waiting for the event")), timeoutMs);
  const sub = c.subscribe({
    onOpen: () => open(),
    onClose: () => undefined,
    onEvent: (r) => {
      const env = normalizer.normalize(r);
      if (!env) return;
      seen.push(env);
      if (done(env, r as Record<string, unknown>)) {
        clearTimeout(timer);
        finish(seen);
      }
    },
  });
  void finished.catch(() => undefined).finally(() => clearTimeout(timer));
  return { opened, finished, sub };
}

describe("live OpenCode service", () => {
  it("info reports the version and pid", async (t) => {
    const c = live(t);
    if (!c) return;
    const info = await c.info();
    assert.match(info.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof info.pid, "number");
  });

  it("lists models with the fields the model menu needs, and a default", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    assert.ok(models.length > 0, "no models");
    for (const m of models) {
      assert.equal(m.key, `${m.providerID}/${m.id}`);
      assert.ok(m.name && m.providerName, m.key);
      assert.ok(Array.isArray(m.variants) && !m.variants.includes("default"), m.key);
      assert.ok(m.contextLimit === null || m.contextLimit > 0, m.key);
    }
    // Sorted by provider name, then model name, as the menu groups them.
    const order = models.map((m) => [m.providerName, m.name]);
    const sorted = [...order].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    assert.deepEqual(order, sorted);
    const def = await c.defaultModel(dir);
    assert.ok(def === null || /^[^/]+\/.+/.test(def), String(def));
  });

  it("lists primary agents and subagents separately", async (t) => {
    const c = live(t);
    if (!c) return;
    const agents = await c.listAgents(dir);
    const subagents = await c.listSubagents(dir);
    assert.ok(
      agents.some((a) => a.id === "build"),
      agents.map((a) => a.id).join(),
    );
    for (const a of [...agents, ...subagents]) {
      assert.ok(a.id && a.name);
      assert.ok(a.description === undefined || (a.description.length > 0 && a.description.length <= 160));
    }
    const primary = new Set(agents.map((a) => a.id));
    assert.ok(!subagents.some((a) => primary.has(a.id) && a.id === "build"));
  });

  it("lists skills and slash commands", async (t) => {
    const c = live(t);
    if (!c) return;
    for (const k of await c.listSkills(dir)) assert.ok(k.id && k.name);
    const commands = await c.listCommands(dir);
    for (const cmd of commands) {
      assert.ok(cmd.name && !cmd.name.startsWith("/"), cmd.name);
      assert.ok(cmd.description === null || typeof cmd.description === "string");
    }
  });

  it("finds files and folders with forward-slash relative paths", async (t) => {
    const c = live(t);
    if (!c) return;
    const files = await c.findFiles(dir, "main-live", 10);
    assert.deepEqual(
      files.find((f) => f.path.endsWith("main-live.ts")),
      { path: "src/main-live.ts", type: "file" },
      JSON.stringify(files),
    );
    const folders = await c.findFiles(dir, "src", 10);
    assert.ok(
      folders.some((f) => f.path === "src" && f.type === "directory"),
      JSON.stringify(folders),
    );
    for (const f of [...files, ...folders])
      assert.ok(!f.path.includes("\\") && !f.path.endsWith("/"), f.path);
  });

  it("reads the account status without labels", async (t) => {
    const c = live(t);
    if (!c) return;
    const status = await c.accountStatus(dir);
    assert.deepEqual(Object.keys(status).sort(), ["opencode", "otherProviders"]);
    assert.ok(["connected", "needs-auth", "none"].includes(status.opencode));
    assert.equal(typeof status.otherProviders, "boolean");
  });

  it("lists MCP servers, the project and its saved permissions", async (t) => {
    const c = live(t);
    if (!c) return;
    for (const m of await c.listMcpServers(dir)) {
      assert.ok(m.name);
      assert.ok(["connected", "pending", "disabled", "failed", "needs_auth"].includes(m.status));
    }
    const project = await c.projectId(dir);
    assert.ok(project, "no project for the folder");
    for (const p of await c.listSavedPermissions(project)) {
      assert.ok(p.id && typeof p.action === "string" && typeof p.resource === "string");
      assert.equal(typeof p.created, "number");
    }
  });

  it("creates, reads, renames, archives and deletes a session", async (t) => {
    const c = live(t);
    if (!c) return;
    const s = await newSession(c);
    assert.match(s.id, /^ses_/);
    assert.ok(s.created > 0 && s.updated >= s.created);
    assert.equal(s.outcome, null);
    assert.ok(!s.archived && !s.forked);

    await c.renameSession(s.id, "Sidecar live test");
    assert.equal((await c.getSession(s.id)).title, "Sidecar live test");
    let listed = await c.listSessions(dir, 20);
    assert.ok(listed.some((x) => x.id === s.id && x.title === "Sidecar live test"));

    await c.setArchived(s.id, true);
    assert.equal((await c.getSession(s.id)).archived, true);
    listed = await c.listSessions(dir, 20);
    assert.ok(!listed.some((x) => x.id === s.id), "archived session still in the active list");
    assert.ok((await c.listSessions(dir, 20, true)).some((x) => x.id === s.id && x.archived));
    await c.setArchived(s.id, false);
    assert.ok((await c.listSessions(dir, 20)).some((x) => x.id === s.id));

    await c.deleteSession(s.id);
    created.delete(s.id);
    await assert.rejects(c.getSession(s.id), (e) => e instanceof OpenCodeHttpError && e.status === 404);
    assert.ok(!(await c.listSessions(dir, 20)).some((x) => x.id === s.id));
  });

  it("switches a session's agent and model without a prompt", async (t) => {
    const c = live(t);
    if (!c) return;
    const s = await newSession(c);
    await c.switchAgent(s.id, "plan");
    assert.equal((await c.getSession(s.id)).agent, "plan");
    const models = await c.listModels(dir);
    const m = models.find((x) => x.key === "opencode/big-pickle") ?? models[0];
    await c.switchModel(s.id, { providerID: m.providerID, id: m.id });
    assert.equal((await c.getSession(s.id)).modelKey, m.key);
  });

  it("an idle session has no messages, inbox, permissions, forms, changes or children", async (t) => {
    const c = live(t);
    if (!c) return;
    const s = await newSession(c);
    assert.deepEqual(await c.listMessages(s.id, 50), []);
    assert.deepEqual(await c.listInbox(s.id), []);
    assert.deepEqual(await c.listPermissions(s.id), []);
    assert.deepEqual(await c.listForms(s.id), []);
    assert.deepEqual(await c.sessionDiff(s.id), []);
    assert.deepEqual(await c.listChildSessions(s.id), []);
    assert.equal(await c.firstUserText(s.id), null);
    assert.ok(!(await c.activeSessions()).has(s.id));
    assert.equal(await c.interrupt(s.id), false);
  });

  it("runs a shell command, replays it, forks the session and rewinds it", async (t) => {
    const c = live(t);
    if (!c) return;
    const s = await newSession(c);
    // `echo` works in every shell OpenCode may use (bash, zsh, PowerShell).
    await c.runShell(s.id, "echo sidecar-live");
    let messages: unknown[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      messages = await c.listMessages(s.id, 50);
      const m = messages[0] as { status?: string } | undefined;
      if (m && m.status !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(messages.length, 1, JSON.stringify(messages).slice(0, 300));
    const shell = messages[0] as { id: string; type: string; command: string };
    assert.equal(shell.type, "shell");
    assert.equal(shell.command, "echo sidecar-live");
    assert.ok(historyToEvents(messages).length > 0, "history replay ignored the shell message");

    const fork = await c.forkSession(s.id);
    created.add(fork.id);
    assert.notEqual(fork.id, s.id);
    assert.equal(fork.forked, true);
    // The fork holds a copy of the history, under new message ids.
    const copied = (await c.listMessages(fork.id, 50)) as Array<{ id: string; command?: string }>;
    assert.equal(copied.length, 1);
    assert.equal(copied[0].command, shell.command);
    assert.ok((await c.listSessions(dir, 50)).some((x) => x.id === fork.id && x.forked));

    await c.revert(fork.id, copied[0].id, false);
    assert.equal((await c.listMessages(fork.id, 50)).length, 0, "rewind kept the message");
    assert.equal((await c.listMessages(s.id, 50)).length, 1, "rewinding the fork changed the original");
  });

  it("lists a session whatever the drive letter's case (Windows)", async (t) => {
    const c = live(t);
    if (!c) return;
    if (process.platform !== "win32" || !/^[A-Za-z]:/.test(dir)) return t.skip("Windows drive paths only");
    const canonical = opencodeDirectory(dir);
    const lower = canonical[0].toLowerCase() + canonical.slice(1);
    assert.match(canonical, /^[A-Z]:\\/);

    // VS Code reports `c:\…`; the client records the folder as OpenCode's CLI does (`C:\…`).
    const s = await newSession(c, lower);
    const stored = (await raw("GET", `/api/session/${s.id}`)).data as { location?: { directory?: string } };
    assert.equal(stored.location?.directory, canonical);
    assert.ok((await c.listSessions(lower, 50)).some((x) => x.id === s.id));
    assert.ok((await c.listSessions(canonical, 50)).some((x) => x.id === s.id));

    // A session an older Sidecar recorded under `c:\…` still shows, once.
    const legacy = (await raw("POST", "/api/session", { location: { directory: lower } })).data as {
      id: string;
    };
    created.add(legacy.id);
    for (const form of [lower, canonical]) {
      const ids: string[] = (await c.listSessions(form, 50)).map((x) => x.id);
      assert.ok(
        ids.includes(legacy.id),
        `legacy session missing when listing ${form === lower ? "c:" : "C:"}`,
      );
      assert.equal(new Set(ids).size, ids.length, "a session is listed twice");
    }
  });

  it("receives session.created for a new session on the event stream", async (t) => {
    const c = live(t);
    if (!c) return;
    let id = "";
    const { opened, finished, sub } = collect(
      c,
      (env) => env.sessionID === id && env.sessionsChanged && env.created !== null,
      15_000,
    );
    try {
      await opened;
      id = (await newSession(c)).id;
      const seen = await finished;
      const ev = seen.find((e) => e.sessionID === id && e.created)!;
      assert.equal(ev.parentID, null);
      assert.equal(ev.directory === null || opencodeDirectory(ev.directory) === opencodeDirectory(dir), true);
    } finally {
      sub.dispose();
    }
  });

  it("rejects unknown sessions with OpenCode's error", async (t) => {
    const c = live(t);
    if (!c) return;
    await assert.rejects(
      c.getSession("ses_sidecarlivetestmissing"),
      (e) => e instanceof OpenCodeHttpError && e.status >= 400 && e.status < 500 && !!e.message,
    );
  });

  it("prompts a free model and replays the reply (one model call)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === `${FREE_MODEL.providerID}/${FREE_MODEL.id}`))
      return t.skip(`${FREE_MODEL.providerID}/${FREE_MODEL.id} is not offered`);
    const s = await c.createSession({ directory: dir, agent: "plan", model: FREE_MODEL });
    created.add(s.id);
    const text = "Reply with the single word OK. Do not use any tools.";
    const { opened, finished, sub } = collect(
      c,
      (env) => env.sessionID === s.id && env.events.some((e) => e.type === "session.idle"),
      120_000,
    );
    try {
      await opened;
      const sent = await c.prompt(s.id, { text, files: [] });
      assert.match(sent.id, /^msg_/);
      const seen = await finished;
      const idle = seen.flatMap((e) => e.events).find((e) => e.type === "session.idle");
      if (idle?.type === "session.idle" && idle.outcome === "failed") {
        // The account's daily allowance of free model use is not the client's fault.
        const stored = (await c.listMessages(s.id, 10)) as Array<{ error?: { type?: string } }>;
        if (stored.some((m) => m.error?.type === "provider.free-limit"))
          return t.skip("the free model usage limit is reached for today");
      }
      assert.equal(idle?.type === "session.idle" && idle.outcome, "succeeded");
    } finally {
      sub.dispose();
    }
    assert.equal(await c.firstUserText(s.id), text);
    const replay = historyToEvents(await c.listMessages(s.id, 50));
    const user = replay.find((e) => e.type === "user.message");
    assert.equal(user?.type === "user.message" && user.text, text);
    assert.ok(
      replay.some((e) => e.type === "assistant.completed" && /ok/i.test(e.text)),
      JSON.stringify(replay).slice(0, 400),
    );
    const after = await c.getSession(s.id);
    assert.equal(after.modelKey, "opencode/big-pickle");
    assert.equal(after.outcome, "succeeded");
  });
});
