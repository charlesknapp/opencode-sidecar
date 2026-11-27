// Live tests of approval modes and permission rules against the real local OpenCode
// service. No model is called: OpenCode evaluates a permission without running a tool
// (`POST /api/session/{id}/permission`, which also opens a request when the answer is
// "ask"), so each mode is checked by what OpenCode decides. Everything happens in a new
// temporary folder (its own OpenCode project): the sessions and saved rules made here are
// deleted afterwards, and no config file is written. Skips without a service.
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { HttpOpenCodeClient, OpenCodeHttpError, type Endpoint } from "../../src/opencode/client";
import { forgetLocations } from "./locations";
import { discoverServer } from "../../src/opencode/service";
import { SessionController } from "../../src/core/sessionController";
import {
  classifyRules,
  presetRules,
  type ApprovalMode,
  type PermissionRule,
  type RuleEffect,
} from "../../src/shared/approval";
import type { SessionSummary, UiEvent } from "../../src/shared/model";
import { MemoryStore } from "../mockClient";

let client: HttpOpenCodeClient | undefined;
let endpoint: Endpoint | undefined;
let skipReason = "";
let dir = "";
let project: string | null = null;
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
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-perm-")));
  // A folder OpenCode has not loaded yet briefly lists no agents.
  for (let i = 0; i < 20 && !(await client.agentRules(dir)).build; i++)
    await new Promise((r) => setTimeout(r, 500));
  project = await client.projectId(dir);
});

after(async () => {
  // The saved rules live in this temporary folder's project; none may outlive the test.
  if (client && project)
    for (const r of await client.listSavedPermissions(project).catch(() => []))
      await client.removeSavedPermission(r.id).catch(() => undefined);
  for (const id of created) await client?.deleteSession(id).catch(() => undefined);
  await forgetLocations(endpoint, [dir]);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

async function newSession(c: HttpOpenCodeClient, permissions?: PermissionRule[]): Promise<SessionSummary> {
  const s = await c.createSession({
    directory: dir,
    agent: "build",
    ...(permissions ? { permissions } : {}),
  });
  created.add(s.id);
  return s;
}

/**
 * What OpenCode decides for a request in a session, as a tool would ask it. An "ask" opens
 * a request; `keep` leaves it open (for the reply tests), otherwise it is rejected.
 */
async function decide(
  sessionID: string,
  action: string,
  resource: string,
  options: { save?: string[]; keep?: boolean } = {},
): Promise<{ id: string; effect: RuleEffect }> {
  const res = await fetch(new URL(`/api/session/${sessionID}/permission`, endpoint!.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(endpoint!.authorization ? { authorization: endpoint!.authorization } : {}),
    },
    body: JSON.stringify({
      action,
      resources: [resource],
      agent: "build",
      ...(options.save ? { save: options.save } : {}),
    }),
  });
  assert.equal(res.status, 200, `evaluate ${action} ${resource}`);
  const d = ((await res.json()) as { data: { id: string; effect: RuleEffect } }).data;
  if (d.effect === "ask" && !options.keep) await client!.replyPermission(sessionID, d.id, "reject");
  return d;
}

describe("live OpenCode service: approval modes and rules", () => {
  it("reads every agent's rules, with Build and Plan as OpenCode defines them", async (t) => {
    const c = live(t);
    if (!c) return;
    const rules = await c.agentRules(dir);
    assert.ok(rules.build?.length, "build has rules");
    assert.ok(
      rules.plan?.some((r) => r.action === "edit" && r.resource === "*" && r.effect === "deny"),
      "plan denies edits",
    );
    for (const list of Object.values(rules))
      for (const r of list) assert.ok(["allow", "ask", "deny"].includes(r.effect));
  });

  it("applies each mode at session scope, reads it back and changes what OpenCode decides", async (t) => {
    const c = live(t);
    if (!c) return;
    const build = (await c.agentRules(dir)).build ?? null;
    const s = await newSession(c);
    assert.equal(s.permissions, undefined, "a new session has no rules of its own");
    // What each mode must make OpenCode decide (edits in the folder, a command, a destructive one).
    const expect: Record<ApprovalMode, Array<[string, string, RuleEffect]>> = {
      ask: [
        ["edit", "src/a.ts", "ask"],
        ["shell", "npm test", "ask"],
        ["webfetch", "https://example.com/", "ask"],
      ],
      balanced: [
        ["edit", "src/a.ts", "allow"],
        ["shell", "npm test", "ask"],
        ["external_directory", path.join(os.tmpdir(), "*"), "ask"],
      ],
      auto: [
        ["edit", "src/a.ts", "allow"],
        ["shell", "npm test -- --grep live", "allow"],
        ["shell", "rm -rf build", "deny"],
        ["shell", "git push origin main --force", "deny"],
        ["shell", "Remove-Item -Recurse -Force C:\\tmp\\x", "deny"],
      ],
    };
    for (const mode of ["ask", "balanced", "auto"] as const) {
      const rules = presetRules(mode, build);
      await c.setSessionPermissions(s.id, rules);
      const back: PermissionRule[] = (await c.getSession(s.id)).permissions ?? [];
      assert.deepEqual(back, rules, `${mode} stored as sent`);
      assert.equal(classifyRules(back, [build]).mode, mode);
      for (const [action, resource, effect] of expect[mode])
        assert.equal((await decide(s.id, action, resource)).effect, effect, `${mode}: ${action} ${resource}`);
    }
    // Secrets keep asking in every mode (Build's own exception).
    assert.equal((await decide(s.id, "read", path.join(dir, ".env"))).effect, "ask");
    // An empty list clears them: OpenCode's defaults again.
    await c.setSessionPermissions(s.id, []);
    assert.deepEqual((await c.getSession(s.id)).permissions, []);
    assert.equal((await decide(s.id, "shell", "rm -rf build")).effect, "allow", "Build alone allows it");
    assert.equal((await c.listPermissions(s.id)).length, 0, "every request opened here was answered");
  });

  it("creates a session in a mode, and its new subagents inherit it", async (t) => {
    const c = live(t);
    if (!c) return;
    const rules = presetRules("ask", (await c.agentRules(dir)).build ?? null);
    const s = await newSession(c, rules);
    assert.deepEqual(s.permissions, rules);
    // Sidecar never creates subagents; OpenCode's own create with a parent shows the inheritance.
    const raw = await fetch(new URL("/api/session", endpoint!.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint!.authorization ? { authorization: endpoint!.authorization } : {}),
      },
      body: JSON.stringify({ parentID: s.id }),
    });
    const sub = ((await raw.json()) as { data: { id: string; permissions?: PermissionRule[] } }).data;
    created.add(sub.id);
    assert.deepEqual(sub.permissions, rules);
  });

  it("reports rule changes on the event stream as session.permissions", async (t) => {
    const c = live(t);
    if (!c) return;
    const s = await newSession(c);
    const rules: PermissionRule[] = [{ action: "shell", resource: "npm test *", effect: "allow" }];
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents: () => undefined, onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: "", agent: "build" }),
    );
    let opened!: () => void;
    const ready = new Promise<void>((r) => (opened = r));
    const seen: UiEvent[] = [];
    const sub = c.subscribe({
      onOpen: () => opened(),
      onClose: () => undefined,
      onEvent: (raw) => {
        ctl.handleRawEvent(raw);
        const d = (raw as { type?: string; data?: { sessionID?: string } }).data;
        if ((raw as { type?: string }).type === "session.permissions" && d?.sessionID === s.id)
          seen.push({ type: "session.permissions", rules });
      },
    });
    try {
      await ctl.setDirectory(dir);
      assert.ok(await ctl.openSession(s.id));
      await ready;
      // Another client (here a raw request) changes the rules: Sidecar's view follows.
      await c.setSessionPermissions(s.id, rules);
      for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(seen.length, 1, "session.permissions arrived");
      assert.deepEqual(ctl.approvalView().rules, rules);
      assert.equal(ctl.approvalView().mode, "custom");
      // Sidecar's own switch is read back from OpenCode.
      await ctl.setApprovalMode("balanced", "session");
      assert.equal(ctl.approvalView().mode, "balanced");
      assert.deepEqual(ctl.approvalView().rules, rules, "the user's rule is kept after the mode's");
      const back = (await c.getSession(s.id)).permissions ?? [];
      assert.deepEqual(back.slice(-1), rules);
    } finally {
      sub.dispose();
      ctl.dispose();
    }
  });

  it("saves, edits and deletes a folder rule, and refuses a duplicate", async (t) => {
    const c = live(t);
    if (!c) return;
    assert.ok(project, "the folder has a project");
    const s = await newSession(c, [{ action: "shell", resource: "*", effect: "ask" }]);
    // OpenCode saves a rule when a request carrying `save` patterns is answered "always".
    const first = await decide(s.id, "shell", "npm test -- --grep live", {
      save: ["npm test -- --grep live"],
      keep: true,
    });
    assert.equal(first.effect, "ask");
    const pending = await c.listPermissions(s.id);
    assert.deepEqual(
      pending.map((p) => [p.id, p.canAlways, p.patterns]),
      [[first.id, true, ["npm test -- --grep live"]]],
    );
    await c.replyPermission(s.id, first.id, "always");
    const saved = await c.listSavedPermissions(project!);
    const rule = saved.find((r) => r.resource === "npm test -- --grep live");
    assert.ok(rule, "saved");
    assert.equal(rule.action, "shell");
    // Edited to a wider pattern: near-identical commands stop asking.
    const edited = await c.updateSavedPermission(rule.id, { resource: "npm test *" });
    assert.deepEqual([edited.id, edited.action, edited.resource], [rule.id, "shell", "npm test *"]);
    assert.equal(
      (await c.listSavedPermissions(project!)).find((r) => r.id === rule.id)?.resource,
      "npm test *",
    );
    assert.equal((await decide(s.id, "shell", "npm test -- --grep other")).effect, "allow");
    assert.equal((await decide(s.id, "shell", "npm run lint")).effect, "ask");
    // A second rule cannot become the same as the first.
    const second = await decide(s.id, "shell", "npm run lint", { save: ["npm run lint"], keep: true });
    await c.replyPermission(s.id, second.id, "always");
    const other = (await c.listSavedPermissions(project!)).find((r) => r.resource === "npm run lint");
    assert.ok(other);
    await assert.rejects(
      c.updateSavedPermission(other.id, { resource: "npm test *" }),
      (e: unknown) => e instanceof OpenCodeHttpError && e.status === 409,
    );
    // Deleting makes OpenCode ask again.
    await c.removeSavedPermission(rule.id);
    await c.removeSavedPermission(other.id);
    assert.equal((await c.listSavedPermissions(project!)).length, 0);
    assert.equal((await decide(s.id, "shell", "npm test -- --grep other")).effect, "ask");
  });

  it("always allows commands like this one, for the session or the folder (the dock's action)", async (t) => {
    const c = live(t);
    if (!c) return;
    const s = await newSession(c, [{ action: "shell", resource: "*", effect: "ask" }]);
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents: () => undefined, onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: "", agent: "build" }),
    );
    try {
      await ctl.setDirectory(dir);
      // This session: an allow rule, and the request allowed once.
      const one = await decide(s.id, "shell", "npm test -- --grep a", { keep: true });
      assert.ok(await ctl.openSession(s.id));
      await ctl.allowLike(one.id, ["npm test *"], "session");
      assert.deepEqual((await c.getSession(s.id)).permissions?.at(-1), {
        action: "shell",
        resource: "npm test *",
        effect: "allow",
      });
      assert.equal((await c.listPermissions(s.id)).length, 0, "answered");
      assert.equal((await decide(s.id, "shell", "npm test -- --grep b")).effect, "allow");
      // This folder: OpenCode's saved pattern becomes the one typed.
      const two = await decide(s.id, "shell", "cargo test --release", {
        save: ["cargo test --release"],
        keep: true,
      });
      assert.ok(await ctl.openSession(s.id));
      await ctl.allowLike(two.id, ["cargo test *"], "folder");
      const saved = await c.listSavedPermissions(project!);
      assert.deepEqual(
        saved.map((r) => [r.action, r.resource]),
        [["shell", "cargo test *"]],
      );
      const other = await newSession(c, [{ action: "shell", resource: "*", effect: "ask" }]);
      assert.equal(
        (await decide(other.id, "shell", "cargo test")).effect,
        "allow",
        "any session in the folder",
      );
      for (const r of saved) await c.removeSavedPermission(r.id);
    } finally {
      ctl.dispose();
    }
  });
});
