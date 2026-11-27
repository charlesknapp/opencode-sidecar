// Live tests: HttpOpenCodeClient against the real local OpenCode service, found the way the
// extension finds it (discoverServer). They skip when no service is registered or it does not
// answer, so CI stays green. Every session they create lives in a fresh temporary folder and
// is deleted afterwards. Only the prompt tests call a model (OCS_LIVE_MODEL, by default a free
// one; see liveModel.ts), with a tiny prompt.
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
  sameDirectory,
  type Endpoint,
  type EventSubscription,
} from "../../src/opencode/client";
import { EventNormalizer, historyToEvents, type NormalizedEnvelope } from "../../src/opencode/events";
import { discoverServer } from "../../src/opencode/service";
import { forgetLocations } from "./locations";
import { buildPrompt } from "../../src/core/context";
import type { TaskNotice } from "../../src/core/currentTask";
import { ASIDES_KEY, SessionController } from "../../src/core/sessionController";
import { contextBreakdown } from "../../src/core/usage";
import { Transcript } from "../../src/shared/transcript";
import type { SessionSummary, UiEvent } from "../../src/shared/model";
import { MemoryStore } from "../mockClient";

import { LIVE_MODEL, LIVE_MODEL_FREE, LIVE_MODEL_KEY, NOT_OFFERED } from "./liveModel";

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
  await forgetLocations(endpoint, [dir]);
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
    const m = models.find((x) => x.key === LIVE_MODEL_KEY) ?? models[0];
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
    // The event can arrive before the create call returns, so every created session is kept.
    const createdEvents = new Map<string, NormalizedEnvelope>();
    const { opened, sub } = collect(
      c,
      (env) => {
        if (env.sessionsChanged && env.created !== null && env.sessionID)
          createdEvents.set(env.sessionID, env);
        return false;
      },
      20_000,
    );
    try {
      await opened;
      const id = (await newSession(c)).id;
      for (let i = 0; i < 150 && !createdEvents.has(id); i++) await new Promise((r) => setTimeout(r, 100));
      const ev = createdEvents.get(id);
      assert.ok(ev, "session.created arrived");
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

  it("stores a prompt with a large paste exactly as built (stopped before any reply)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    const s = await c.createSession({ directory: dir, agent: "plan", model: LIVE_MODEL });
    created.add(s.id);
    const paste = Array.from({ length: 40 }, (_, i) => `\tat frame ${i} ✓ ünï 🚀  `).join("\n") + "\n";
    const payload = buildPrompt(
      "  Reply OK. [Pasted text #1]  ",
      [],
      [],
      [{ token: "[Pasted text #1]", text: paste }],
    );
    assert.equal(payload.text, `Reply OK. ${paste}`);
    await c.prompt(s.id, payload);
    // OpenCode stores the prompt when it delivers it, a moment after accepting it; an
    // interrupt before that drops it, so the stop waits for it (as Sidecar's Stop does).
    let stored: Array<{ type?: string; text?: string }> = [];
    for (let i = 0; i < 50 && !stored.some((m) => m.type === "user"); i++) {
      stored = (await c.listMessages(s.id, 10)) as typeof stored;
      if (!stored.some((m) => m.type === "user")) await new Promise((r) => setTimeout(r, 100));
    }
    await c.interrupt(s.id).catch(() => false);
    assert.equal(stored.find((m) => m.type === "user")?.text, payload.text);
  });

  it("keeps a prompt stopped right after it was sent (Stop waits for OpenCode to deliver it)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: LIVE_MODEL_KEY, agent: "plan" }),
    );
    let opened!: () => void;
    const ready = new Promise<void>((r) => (opened = r));
    const sub = c.subscribe({ onEvent: (r) => ctl.handleRawEvent(r), onOpen: () => opened(), onClose() {} });
    try {
      await ready;
      await ctl.setDirectory(dir);
      // Without the wait, an interrupt this soon dropped the prompt nearly every time.
      await ctl.send("Reply with the single word OK. Do not use any tools.", []);
      const id = ctl.current?.id;
      assert.ok(id);
      created.add(id);
      await ctl.stop();
      const deadline = Date.now() + 20_000;
      while (ctl.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.equal(await c.firstUserText(id), "Reply with the single word OK. Do not use any tools.");
    } finally {
      sub.dispose();
      ctl.dispose();
    }
  });

  it("asks aside in a fork the History never lists, then deletes it (one model call)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    // The main session has some history (a shell command, no model call) and the Build agent.
    const main = await c.createSession({ directory: dir, agent: "build", model: LIVE_MODEL });
    created.add(main.id);
    await c.runShell(main.id, "echo sidecar-aside");
    for (let i = 0; i < 60 && !(await c.listMessages(main.id, 5)).length; i++)
      await new Promise((r) => setTimeout(r, 250));
    const store = new MemoryStore();
    const mainEvents: UiEvent[] = [];
    const ctl = new SessionController(
      c,
      store,
      { onEvents: (e) => mainEvents.push(...e), onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: LIVE_MODEL_KEY, agent: "build" }),
    );
    const sub = c.subscribe({ onEvent: (r) => ctl.handleRawEvent(r), onOpen() {}, onClose() {} });
    try {
      await ctl.setDirectory(dir);
      assert.ok(await ctl.openSession(main.id));
      const before = ctl.transcript.items.length;
      mainEvents.length = 0;
      await ctl.askAside("Reply with the single word OK.");
      const fork = (store.get<string[]>(ASIDES_KEY) ?? [])[0];
      assert.ok(fork && fork !== main.id, "the side thread is tracked for cleanup");
      created.add(fork);
      const copy = await c.getSession(fork);
      assert.equal(copy.forked, true);
      assert.equal(copy.agent, "plan", "the side thread cannot edit files");
      assert.equal(copy.modelKey, LIVE_MODEL_KEY);
      // OpenCode lists the fork; Sidecar's History does not.
      assert.ok((await c.listSessions(dir, 50)).some((x) => x.id === fork));
      await ctl.refreshSessions();
      assert.ok(!ctl.displaySessions().some((x) => x.id === fork));
      assert.ok(ctl.displaySessions().some((x) => x.id === main.id));

      const deadline = Date.now() + 120_000;
      while (ctl.asideView()?.status !== "idle" && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 250));
      const turn = ctl.asideView()?.turns[0];
      assert.ok(turn?.done, "the side question finished");
      // Nothing of the side thread reached the main conversation or its history.
      assert.equal(ctl.transcript.items.length, before);
      assert.deepEqual(mainEvents, []);
      assert.equal((await c.listMessages(main.id, 10)).length, 1);
      if (turn.error && /limit/i.test(turn.error)) {
        const stored = (await c.listMessages(fork, 10)) as Array<{ error?: { type?: string } }>;
        assert.ok(
          stored.some((m) => m.error?.type === "provider.free-limit"),
          turn.error,
        );
        t.diagnostic("the free model usage limit is reached for today: the answer was not checked");
      } else assert.match(turn.answer, /ok/i, turn.error ?? "");

      await ctl.closeAside();
      assert.equal(store.get(ASIDES_KEY), undefined);
      await assert.rejects(c.getSession(fork), (e) => e instanceof OpenCodeHttpError && e.status === 404);
      assert.equal((await c.listMessages(main.id, 10)).length, 1, "the main session is as it was");
    } finally {
      sub.dispose();
      ctl.dispose();
    }
  });

  it("reads the account of a folder OpenCode has not loaded yet as it is once loaded", async (t) => {
    const c = live(t);
    if (!c) return;
    // A cold folder lists no integrations at first, which read as signed out.
    const fresh = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-cold-")));
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: LIVE_MODEL_KEY, agent: "build" }),
    );
    try {
      await ctl.setDirectory(fresh);
      assert.deepEqual(ctl.account, await c.accountStatus(fresh));
    } finally {
      ctl.dispose();
      await forgetLocations(endpoint, [fresh]);
      fs.rmSync(fresh, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("reads usage limits, today's usage and a session's context as the usage menu shows them", async (t) => {
    const c = live(t);
    if (!c) return;
    // Limits: OpenCode Go and Console budgets of a signed-in OpenCode workspace, else null.
    const rawLimits = await raw(
      "GET",
      `/api/experimental/usage/limits?location[directory]=${encodeURIComponent(opencodeDirectory(dir))}`,
    );
    assert.ok("data" in rawLimits, JSON.stringify(rawLimits).slice(0, 200));
    const quota = await c.usageLimits(dir);
    if (rawLimits.data === null) assert.equal(quota, null, "not signed in: nothing to show");
    else {
      assert.ok(quota && Array.isArray(quota.meters));
      for (const m of quota.meters) {
        assert.ok(m.percent >= 0 && m.percent <= 100, JSON.stringify(m));
        assert.ok(m.resetsAt === null || m.resetsAt > 0);
      }
    }

    // Today's usage in the folder's project, and over all time (OpenCode's own totals).
    // The live tests beside this one add steps and delete sessions: compare a moment when
    // OpenCode's totals did not change between the two reads.
    type Totals = { steps: number; cost: number; sessions: number };
    const totals = async () =>
      (await raw("GET", "/api/experimental/session/stats?from=0&tools=none")).data as Totals;
    let all = await c.usageStats({ from: 0 });
    let rawAll = await totals();
    for (let i = 0; i < 20 && (all.steps !== rawAll.steps || all.sessions !== rawAll.sessions); i++) {
      await new Promise((r) => setTimeout(r, 250));
      all = await c.usageStats({ from: 0 });
      rawAll = await totals();
    }
    assert.equal(all.steps, rawAll.steps);
    assert.equal(all.sessions, rawAll.sessions);
    assert.ok(Math.abs(all.cost - rawAll.cost) < 1e-9);
    assert.ok(all.models.every((m) => /^[^/]+\/.+/.test(m.modelKey) && m.steps >= 0 && m.cost >= 0));
    assert.equal(new Set(all.models.map((m) => m.modelKey)).size, all.models.length, "variants merged");
    const project = await c.projectId(dir);
    const today = await c.usageStats({ from: new Date().setHours(0, 0, 0, 0), projectID: project });
    assert.ok(today.steps <= all.steps && today.sessions >= 0);

    // The context: the messages a model call is built from, here one shell command.
    const s = await newSession(c);
    assert.deepEqual(await c.sessionContext(s.id), [], "a new session's context is empty");
    await c.runShell(s.id, "echo sidecar-context");
    let context: unknown[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      context = await c.sessionContext(s.id);
      const m = context[0] as { status?: string } | undefined;
      if (m && m.status !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal((context[0] as { type?: string }).type, "shell", JSON.stringify(context).slice(0, 300));
    const parts = contextBreakdown(context, 5000, 100_000);
    assert.ok(
      parts.parts.some((p) => p.key === "tools" && p.tokens > 0),
      JSON.stringify(parts),
    );
    const rest = parts.parts.find((p) => p.key === "rest");
    assert.ok(rest && rest.tokens < 5000, "the rest is what the messages do not explain");
    await assert.rejects(c.sessionContext("ses_doesnotexist0000000000000"), OpenCodeHttpError);
  });

  it("reports a step's model, agent, cost and stream time for the turn footer (one model call)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    const s = await c.createSession({ directory: dir, agent: "plan", model: LIVE_MODEL });
    created.add(s.id);
    const { opened, finished, sub } = collect(
      c,
      (env) => env.sessionID === s.id && env.events.some((e) => e.type === "session.idle"),
      120_000,
    );
    let seen: NormalizedEnvelope[];
    try {
      await opened;
      await c.prompt(s.id, { text: "Reply with the single word OK. Do not use any tools.", files: [] });
      seen = await finished;
    } finally {
      sub.dispose();
    }
    const events = seen.filter((e) => e.sessionID === s.id).flatMap((e) => e.events);
    const idle = events.find((e) => e.type === "session.idle");
    if (idle?.type === "session.idle" && idle.outcome === "failed") {
      const stored = (await c.listMessages(s.id, 10)) as Array<{ error?: { type?: string } }>;
      if (stored.some((m) => m.error?.type === "provider.free-limit"))
        return t.skip("the free model usage limit is reached for today");
    }
    assert.ok(events.some((e) => e.type === "step.started" && e.modelKey === LIVE_MODEL_KEY));
    const step = events.find((e) => e.type === "usage.step");
    assert.ok(step?.type === "usage.step", JSON.stringify(events).slice(0, 400));
    assert.equal(step.modelKey, LIVE_MODEL_KEY);
    assert.equal(step.agent, "plan");
    if (LIVE_MODEL_FREE) assert.equal(step.cost, 0, "a free model reports a cost of 0");
    else assert.ok((step.cost ?? 0) > 0, `a paid model reports what the step cost: ${step.cost}`);
    assert.ok(step.tokens.output > 0);
    // Stored history carries the same, so a reopened session shows the same footer.
    const replayed = historyToEvents(await c.listMessages(s.id, 50)).find((e) => e.type === "usage.step");
    assert.ok(replayed?.type === "usage.step");
    assert.deepEqual(
      [replayed.modelKey, replayed.agent, replayed.cost, replayed.streamMs],
      [step.modelKey, step.agent, step.cost, step.streamMs],
    );
    const tr = new Transcript();
    for (const e of historyToEvents(await c.listMessages(s.id, 50))) tr.apply(e);
    const meta = tr.items.find((i) => i.kind === "turn-meta");
    assert.ok(meta?.kind === "turn-meta" && meta.models[0] === LIVE_MODEL_KEY);
    const ctx = await c.sessionContext(s.id);
    assert.ok(ctx.some((m) => (m as { type?: string }).type === "assistant"));
  });

  it("prompts a free model and replays the reply (one model call)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    const s = await c.createSession({ directory: dir, agent: "plan", model: LIVE_MODEL });
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
      // The stream carries every session's events, also those of the live tests beside this one.
      const idle = seen
        .filter((e) => e.sessionID === s.id)
        .flatMap((e) => e.events)
        .find((e) => e.type === "session.idle");
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
    assert.equal(after.modelKey, LIVE_MODEL_KEY);
    assert.equal(after.outcome, "succeeded");
  });

  /**
   * A controller with session `open` open and `other` working in the background, fed by
   * the real event stream. Returns the background session's own envelopes too.
   */
  async function watching(c: HttpOpenCodeClient) {
    const open = await c.createSession({ directory: dir, agent: "build", model: LIVE_MODEL });
    created.add(open.id);
    const other = await c.createSession({ directory: dir, agent: "build", model: LIVE_MODEL });
    created.add(other.id);
    const notices: TaskNotice[] = [];
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {}, onTaskNotice: (n) => notices.push(n) },
      { info() {}, warn() {}, error() {} },
      () => ({ model: LIVE_MODEL_KEY, agent: "build" }),
    );
    const normalizer = new EventNormalizer();
    const envelopes: NormalizedEnvelope[] = [];
    let opened!: () => void;
    const ready = new Promise<void>((r) => (opened = r));
    const sub = c.subscribe({
      onEvent: (r) => {
        ctl.handleRawEvent(r);
        const env = normalizer.normalize(r);
        if (env?.sessionID === other.id) envelopes.push(env);
      },
      onOpen: () => opened(),
      onClose() {},
    });
    await ready;
    await ctl.setDirectory(dir);
    assert.ok(await ctl.openSession(open.id));
    const until = async (done: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      return done();
    };
    const dispose = () => {
      sub.dispose();
      ctl.dispose();
    };
    return { open, other, ctl, notices, envelopes, until, dispose };
  }

  it("follows a session that is not open on the strip and notifies its end (one model call)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    const w = await watching(c);
    try {
      // A `!command` makes no run: OpenCode answers once it is done and sends no execution events.
      await c.runShell(w.other.id, "echo sidecar-strip");
      assert.ok(!w.envelopes.some((e) => e.events.some((ev) => ev.type === "session.busy")));
      // A prompt runs it; with the free limit reached it fails at once, which is reported too.
      await c.prompt(w.other.id, { text: "Reply with the single word OK. Do not use any tools.", files: [] });
      const idle = () =>
        w.envelopes.flatMap((e) => e.events).find((ev) => ev.type === "session.idle") as
          Extract<UiEvent, { type: "session.idle" }> | undefined;
      assert.ok(await w.until(() => !!idle(), 120_000), "the background run ended");
      // Execution events carry the session's id but no location: the folder comes from the session list.
      const busy = w.envelopes.find((e) => e.events.some((ev) => ev.type === "session.busy"));
      assert.ok(busy, "session.execution.started arrived for the session that is not open");
      const end = w.envelopes.find((e) => e.events.some((ev) => ev.type === "session.idle"))!;
      for (const env of [busy, end])
        assert.ok(env.directory === null || sameDirectory(env.directory, dir), String(env.directory));
      const outcome = idle()!.outcome;
      assert.ok(outcome === "succeeded" || outcome === "failed", outcome);
      assert.ok(await w.until(() => w.notices.length > 0, 5000), "a notice for the background session");
      assert.deepEqual(
        w.notices.map((n) => [n.kind, n.sessionID]),
        [[outcome === "succeeded" ? "completed" : "failed", w.other.id]],
      );
      const tab = w.ctl.stripView().find((x) => x.id === w.other.id);
      assert.equal(tab?.status, outcome === "succeeded" ? "done" : "failed");
      assert.equal(w.ctl.stripView().find((x) => x.current)?.id, w.open.id);
      if (outcome === "failed")
        t.diagnostic("the free model usage limit is reached for today: the run failed");
      // Opening it counts as seen.
      assert.ok(await w.ctl.openSession(w.other.id));
      assert.equal(w.ctl.stripView().find((x) => x.id === w.other.id)?.status, "idle");
    } finally {
      w.dispose();
    }
  });

  it("shows a background session's permission request on the strip (one model call)", async (t) => {
    const c = live(t);
    if (!c) return;
    const models = await c.listModels(dir);
    if (!models.some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    // A file outside the folder. OpenCode's Build agent allows reading it, so the session's
    // own rules make reading it ask.
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-out-")));
    fs.writeFileSync(path.join(outside, "secret-live.txt"), "x\n");
    const w = await watching(c);
    try {
      await c.setSessionPermissions(w.other.id, [
        { action: "read", resource: "*secret-live.txt", effect: "ask" },
        { action: "external_directory", resource: path.join(outside, "*"), effect: "ask" },
      ]);
      await c.prompt(w.other.id, {
        text: `Use the read tool to read ${path.join(outside, "secret-live.txt")} and reply with its contents.`,
        files: [],
      });
      const asked = () => w.envelopes.find((e) => e.events.some((ev) => ev.type === "permission.requested"));
      const ended = () => w.envelopes.some((e) => e.events.some((ev) => ev.type === "session.idle"));
      await w.until(() => !!asked() || ended(), 120_000);
      if (!asked()) {
        const stored = (await c.listMessages(w.other.id, 10)) as Array<{ error?: { type?: string } }>;
        if (stored.some((m) => m.error?.type === "provider.free-limit"))
          return t.skip("the free model usage limit is reached for today");
        assert.fail(`the model did not use a tool that asks: ${JSON.stringify(stored).slice(0, 600)}`);
      }
      const env = asked()!;
      assert.equal(env.sessionID, w.other.id);
      assert.ok(env.directory === null || sameDirectory(env.directory, dir), String(env.directory));
      const ev = env.events.find((e) => e.type === "permission.requested")!;
      const request = ev.type === "permission.requested" ? ev.request : null;
      assert.ok(request);
      assert.ok(await w.until(() => w.notices.length > 0, 5000));
      assert.deepEqual(
        w.notices.map((n) => [n.kind, n.sessionID]),
        [["needs-input", w.other.id]],
      );
      assert.equal(w.ctl.stripView().find((x) => x.id === w.other.id)?.status, "waiting");
      assert.equal(w.ctl.backgroundWaitingCount(), 1);
      // OpenCode lists it too (what Sidecar reads for a session found waiting).
      assert.ok((await c.listPermissions(w.other.id)).some((p) => p.id === request.id));
      await c.replyPermission(w.other.id, request.id, "reject", "Do not read it.");
      assert.ok(await w.until(() => w.ctl.backgroundWaitingCount() === 0, 10_000), "the reply clears it");
      await c.interrupt(w.other.id).catch(() => false);
    } finally {
      w.dispose();
      await forgetLocations(endpoint, [outside]);
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

// Sidecar has no voice input (docs/OPENCODE_INTEGRATION.md, "Voice input"): OpenCode's voice
// is realtime speech models that need a paid provider's key on the server. This keeps the
// write-up honest. A session is only asked for where OpenCode says it cannot start one.
describe("live: OpenCode's voice (not used by Sidecar)", () => {
  it("lists realtime voice models, and refuses a session without a provider key", async (t) => {
    if (!live(t)) return;
    const res = await fetch(new URL("/api/experimental/voice/models", endpoint!.url), {
      headers: endpoint!.authorization ? { authorization: endpoint!.authorization } : {},
    });
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as {
      data: {
        models: Array<{ model: string; provider: string; transports: string[]; available: boolean }>;
        default?: string | null;
      };
    };
    assert.ok(Array.isArray(data.models));
    for (const m of data.models) {
      assert.equal(typeof m.model, "string");
      assert.ok(
        m.transports.every((x) => x === "webrtc" || x === "websocket"),
        m.model,
      );
    }
    const unavailable = data.models.find((m) => !m.available && m.transports.includes("websocket"));
    t.diagnostic(
      `${data.models.length} voice models (${[...new Set(data.models.map((m) => m.provider))].join(", ")}), ` +
        `${data.models.filter((m) => m.available).length} available here`,
    );
    if (!unavailable) return;
    const session = await fetch(new URL("/api/experimental/voice/session", endpoint!.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint!.authorization ? { authorization: endpoint!.authorization } : {}),
      },
      body: JSON.stringify({ model: unavailable.model, transport: { type: "websocket" } }),
    });
    assert.equal(session.status, 503);
    const err = (await session.json()) as { _tag?: string; message?: string; service?: string };
    assert.equal(err._tag, "ServiceUnavailableError");
    assert.match(err.message ?? "", /API key/);
  });
});
