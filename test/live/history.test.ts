// Live tests for long sessions against the real OpenCode service, in a temporary folder: a
// session of 450 (or, with OCS_LIVE_LONG=1, 1,200) stored messages, built without the model writing anything (synthetic
// messages held with `resume: false`, then delivered together by one run, which fails at
// once at the free limit), opened through the controller with its newest messages, then
// earlier ones. The load times are printed. Skips without a registered service.
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { HISTORY_LIMIT, SessionController } from "../../src/core/sessionController";
import { HttpOpenCodeClient, type Endpoint } from "../../src/opencode/client";
import { discoverServer } from "../../src/opencode/service";
import { MemoryStore } from "../mockClient";

/**
 * 450 by default (more than one load); `OCS_LIVE_LONG=1` builds 1,200, whose delivery in one
 * run keeps OpenCode's store busy for a moment, which slows the live tests running beside it.
 */
const MESSAGES = process.env.OCS_LIVE_LONG === "1" ? 1200 : 450;

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
    skipReason = `no live OpenCode service (${outcome.reason}: ${outcome.detail})`;
    return;
  }
  endpoint = outcome.endpoint;
  client = new HttpOpenCodeClient(endpoint);
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-history-")));
});

after(async () => {
  for (const id of created) await client?.deleteSession(id).catch(() => undefined);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A request the client deliberately has no method for (synthetic messages). */
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

/** A session with `n` stored subagent reports and shell results, and the run that delivered them. */
async function bigSession(c: HttpOpenCodeClient, n: number): Promise<string> {
  const s = await c.createSession({ directory: dir });
  created.add(s.id);
  const report = (i: number) =>
    `## Report ${i}\n\n- \`src/a${i}.ts\`\n\n\`\`\`ts\nexport const f${i} = () => ${i};\n\`\`\`\n` +
    "Text. ".repeat(60);
  for (let i = 0; i < n; i += 20)
    await Promise.all(
      Array.from({ length: Math.min(20, n - i) }, (_, k) =>
        raw("POST", `/api/session/${s.id}/synthetic`, {
          text:
            (i + k) % 2
              ? `<background-result kind="shell" state="completed" command="npm test">\nok ${i + k}\n</background-result>`
              : report(i + k),
          description: (i + k) % 2 ? "npm test" : `Look ${i + k}`,
          metadata:
            (i + k) % 2
              ? { source: "shell", state: "completed" }
              : { source: "subagent", agent: "explore", state: "completed" },
          resume: false,
        }),
      ),
    );
  // One run delivers them all (and fails at once at the free limit, or answers briefly).
  await raw("POST", `/api/session/${s.id}/synthetic`, { text: "Reply with the word ok.", resume: true });
  for (let i = 0; i < 120; i++) {
    const inbox = await c.listInbox(s.id);
    if (!inbox.length && !(await c.activeSessions()).has(s.id)) break;
    await pause(1000);
  }
  return s.id;
}

describe("live: long sessions", () => {
  it(
    `opens a session of ${MESSAGES}+ messages with its newest ones, then earlier ones`,
    { timeout: 300_000 },
    async (t) => {
      const c = live(t);
      if (!c) return;
      const id = await bigSession(c, MESSAGES);
      let t0 = Date.now();
      const all = await c.listMessages(id, 5000);
      const allMs = Date.now() - t0;
      assert.ok(all.length >= MESSAGES, `${all.length} messages stored`);
      const newest = await c.listHistory(id, HISTORY_LIMIT);
      assert.equal(newest.messages.length, HISTORY_LIMIT);
      assert.equal(newest.more, true);
      assert.deepEqual(newest.messages, all.slice(-HISTORY_LIMIT), "the newest ones, oldest first");
      assert.equal((await c.listHistory(id, all.length)).more, false, "all of them: none before");

      const controller = new SessionController(
        c,
        new MemoryStore(),
        { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
        { info() {}, warn() {}, error() {} },
        () => ({ model: "", agent: "" }),
      );
      try {
        await controller.setDirectory(dir);
        t0 = Date.now();
        assert.equal(await controller.openSession(id), true);
        const openMs = Date.now() - t0;
        const first = controller.transcript.items.length;
        assert.ok(first >= HISTORY_LIMIT - 5, `${first} entries`);
        assert.equal(controller.historyView().more, true);
        t0 = Date.now();
        await controller.loadEarlier();
        const earlierMs = Date.now() - t0;
        assert.ok(
          controller.transcript.items.length > first + Math.min(HISTORY_LIMIT, all.length - first) - 10,
        );
        t0 = Date.now();
        while (controller.historyView().more) await controller.loadEarlier();
        const restMs = Date.now() - t0;
        assert.equal(controller.historyView().more, false, "everything is loaded");
        assert.ok(controller.transcript.items.some((i) => i.kind === "handback"));
        assert.ok(!controller.transcript.items.some((i) => i.kind === "unreadable"));
        t.diagnostic(
          `${all.length} messages: all in ${allMs} ms; open (newest ${HISTORY_LIMIT}) ${openMs} ms; ` +
            `earlier ${earlierMs} ms; the rest ${restMs} ms`,
        );
        assert.ok(openMs < 5000, `opened in ${openMs} ms`);
      } finally {
        controller.dispose();
      }
    },
  );
});
