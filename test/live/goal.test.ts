// Live tests for the goal header against the real OpenCode service, in a temporary folder:
// OpenCode's goal plugin's RPC (`POST /api/rpc/opencode.goal/get`) and its
// `rpc.opencode.goal.changed` events, driven through the controller with OpenCode's own
// `/goal` command. The goal's first turn is stopped with Stop as soon as it runs (so at most one
// tiny model call runs, and at the free limit none answers), which stops the goal; then it is ended.
// The goal notices OpenCode stores are read back as Sidecar's goal rows. They skip without
// a registered service or the model (OCS_LIVE_MODEL, see liveModel.ts).
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { SessionController } from "../../src/core/sessionController";
import { HttpOpenCodeClient, OpenCodeHttpError, type Endpoint } from "../../src/opencode/client";
import { forgetLocations } from "./locations";
import { discoverServer } from "../../src/opencode/service";
import type { UiEvent } from "../../src/shared/model";
import { MemoryStore } from "../mockClient";

import { LIVE_MODEL, LIVE_MODEL_KEY, NOT_OFFERED } from "./liveModel";

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
  client = new HttpOpenCodeClient(outcome.endpoint);
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-goal-")));
  for (let i = 0; i < 20 && (await client.listModels(dir)).length === 0; i++)
    await new Promise((r) => setTimeout(r, 500));
});

after(async () => {
  for (const id of created) await client?.deleteSession(id).catch(() => undefined);
  await forgetLocations(endpoint, [dir]);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; !ok();) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await pause(200);
  }
}

describe("live: goals", () => {
  it("reads a goal from OpenCode's goal plugin, follows its events, stops and ends it", async (t) => {
    const c = live(t);
    if (!c) return;
    if (!(await c.listModels(dir)).some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);
    const s = await c.createSession({ directory: dir, agent: "plan", model: LIVE_MODEL });
    created.add(s.id);
    // The plugin's RPC can be briefly unavailable while the folder loads.
    let none: unknown = "unread";
    for (let i = 0; i < 10 && none === "unread"; i++)
      none = await c.getGoal(dir, s.id).catch(async (e: unknown) => {
        assert.ok(e instanceof OpenCodeHttpError && e.tag === "RpcError", String(e));
        await pause(500);
        return "unread";
      });
    assert.equal(none, null, "a new session has no goal");

    const events: UiEvent[] = [];
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents: (e) => events.push(...e), onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: LIVE_MODEL_KEY, agent: "plan" }),
    );
    let opened!: () => void;
    const open = new Promise<void>((r) => (opened = r));
    const sub = c.subscribe({ onOpen: () => opened(), onClose() {}, onEvent: (r) => ctl.handleRawEvent(r) });
    try {
      await open;
      await ctl.setDirectory(dir);
      assert.ok(
        ctl.commands.some((x) => x.name === "goal"),
        "OpenCode offers /goal",
      );
      assert.ok(await ctl.openSession(s.id));
      await pause(300);
      assert.equal(ctl.goalView(), null);

      // Nothing to pause yet: OpenCode refuses, and says so.
      await ctl.goalCommand("pause");
      assert.ok(
        events.some(
          (e) => e.type === "notice" && e.level === "error" && /No active goal to pause/.test(e.text),
        ),
      );

      await ctl.runCommand("goal", "Reply with the single word OK");
      await until("the goal event", () => !!ctl.goalView());
      const set = ctl.goalView()!;
      assert.equal(set.objective, "Reply with the single word OK");
      assert.ok(set.status === "active" || set.status === "paused", String(set.status));
      assert.equal(set.maxRounds, 50);
      // Stopped as the Stop button does, as soon as the run shows: Stop waits for OpenCode to
      // deliver the goal's kickoff, which an interrupt before that drops (it is then never stored).
      await until("the goal's run", () => ctl.busy || ctl.goalView()?.status !== "active");
      await ctl.stop();
      // Interrupted (or failed at the free limit), the goal stops with OpenCode's reason.
      await until("the goal to stop", () => ctl.goalView()?.status !== "active");
      const stopped = ctl.goalView()!;
      assert.equal(stopped.status, "paused");
      assert.ok(stopped.reason, "OpenCode says why it stopped");
      assert.deepEqual(await c.getGoal(dir, s.id).then((g) => [g?.status, g?.reason]), [
        "paused",
        stopped.reason,
      ]);

      // OpenCode stored the goal's start as a notice: reopened, it is a "set" goal row.
      assert.ok(await ctl.openSession(s.id));
      const rows = ctl.transcript.items.filter((i) => i.kind === "background" && i.source === "goal");
      assert.ok(
        rows.some(
          (r) => r.kind === "background" && r.state === "set" && r.text === "Reply with the single word OK",
        ),
        JSON.stringify(rows),
      );
      await until("the goal read again", () => ctl.goalView()?.status === "paused");

      await ctl.goalCommand("clear");
      await until("the goal to end", () => ctl.goalView() === null);
      assert.equal(await c.getGoal(dir, s.id), null);
    } finally {
      sub.dispose();
      ctl.dispose();
      await c.interrupt(s.id).catch(() => false);
    }
  });
});
