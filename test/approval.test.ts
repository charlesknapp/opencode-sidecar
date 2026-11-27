// Approval modes: the rules each mode sets, how they read back, OpenCode's pattern match,
// "commands like this" patterns, and the controller's mode switching, rules editor and
// "always allow like this". The agent rules are the ones OpenCode 2.4 reports (live).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionController } from "../src/core/sessionController";
import { HttpOpenCodeClient, OpenCodeHttpError, toSessionSummary } from "../src/opencode/client";
import { EventNormalizer } from "../src/opencode/events";
import {
  classifyRules,
  DESTRUCTIVE_COMMANDS,
  evaluate,
  generalizeCommand,
  generalizePattern,
  globMatch,
  isRule,
  parseRules,
  presetRules,
  type PermissionRule,
} from "../src/shared/approval";
import type { UiEvent } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

/** GET /api/agent on OpenCode 2.4.2 (Windows): build and plan. */
const BUILD: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "question", resource: "*", effect: "allow" },
  { action: "browser", resource: "*", effect: "deny" },
  { action: "skill", resource: "browser", effect: "deny" },
];
const PLAN: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "question", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "edit", resource: "C:\\Users\\me\\.opencode\\plan\\*", effect: "allow" },
  { action: "browser", resource: "*", effect: "deny" },
];

/** What OpenCode decides: the agent's rules, then the session's. */
const decide = (agent: PermissionRule[], session: PermissionRule[], action: string, resource: string) =>
  evaluate([...agent, ...session], action, resource);

describe("approval modes: OpenCode's pattern match", () => {
  it("matches like OpenCode 2.4 (checked live)", () => {
    assert.equal(globMatch("npm test", "npm test *"), true, "a trailing ' *' also matches nothing");
    assert.equal(globMatch("npm test -- --grep foo", "npm test *"), true);
    assert.equal(globMatch("NPM TEST x", "npm test *"), true, "case-insensitive");
    assert.equal(globMatch("npm testing", "npm test *"), false);
    assert.equal(globMatch("npm  test x", "npm test *"), false);
    assert.equal(globMatch("git status -s", "git status*"), true);
    assert.equal(globMatch("C:\\repo\\src\\a.ts", "C:/repo/*"), true, "backslashes read as slashes");
    assert.equal(globMatch("src/a.ts", "C:/repo/*"), false);
    assert.equal(globMatch("npm run build:prod (x)", "npm run build:prod (x)"), true, "regex characters");
    assert.equal(globMatch("ab", "a?"), true);
    assert.equal(globMatch("line1\nline2", "line1*"), true, "a newline is any character");
  });

  it("evaluates the last matching rule, and asks when none matches", () => {
    const rules: PermissionRule[] = [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status*", effect: "allow" },
      { action: "shell", resource: "rm -rf *", effect: "deny" },
    ];
    assert.equal(evaluate(rules, "shell", "ls"), "ask");
    assert.equal(evaluate(rules, "shell", "git status -s"), "allow");
    assert.equal(evaluate(rules, "shell", "rm -rf /x"), "deny");
    assert.equal(evaluate(rules, "edit", "a.ts"), "ask");
    assert.equal(evaluate([], "edit", "a.ts"), "ask");
  });
});

describe("approval modes: preset → OpenCode rules", () => {
  it("Ask asks before edits, commands, outside files and the web, and keeps the agent's .env asks", () => {
    const rules = presetRules("ask", BUILD);
    assert.deepEqual(rules, [
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "websearch", resource: "*", effect: "ask" },
    ]);
    assert.equal(decide(BUILD, rules, "edit", "src/a.ts"), "ask");
    assert.equal(decide(BUILD, rules, "shell", "npm test"), "ask");
    assert.equal(decide(BUILD, rules, "webfetch", "https://example.com"), "ask");
    assert.equal(decide(BUILD, rules, "read", "src/a.ts"), "allow", "reads are not asked");
    assert.equal(decide(BUILD, rules, "read", "C:\\repo\\.env"), "ask");
    assert.equal(decide(BUILD, rules, "browser", "x"), "deny", "the agent's blocks stay");
  });

  it("Balanced lets edits in the folder run and asks for commands, outside files and the web", () => {
    const rules = presetRules("balanced", BUILD);
    // Build already allows reads, searches and edits: only the asks are added.
    assert.deepEqual(
      rules.map((r) => `${r.action} ${r.effect}`),
      ["shell ask", "external_directory ask", "webfetch ask", "websearch ask"],
    );
    assert.equal(decide(BUILD, rules, "edit", "src/a.ts"), "allow");
    assert.equal(decide(BUILD, rules, "grep", "TODO"), "allow");
    assert.equal(decide(BUILD, rules, "external_directory", "C:/elsewhere/*"), "ask");
    assert.equal(decide(BUILD, rules, "shell", "npm test"), "ask");
    assert.equal(decide(BUILD, rules, "read", "/w/.env.local"), "ask");
  });

  it("Auto allows everything but blocks destructive commands, Unix and Windows", () => {
    const rules = presetRules("auto", BUILD);
    assert.deepEqual(
      rules,
      DESTRUCTIVE_COMMANDS.map((c) => ({ action: "shell", resource: c, effect: "deny" })),
      "build allows the rest already",
    );
    for (const ok of [
      "npm test",
      "git push origin main",
      "git push origin feature-fix",
      "rm notes.txt",
      "ls -la",
    ])
      assert.equal(decide(BUILD, rules, "shell", ok), "allow", ok);
    for (const bad of [
      "rm -rf /",
      "rm -rf node_modules",
      "RM -RF build",
      "rm -fr dist",
      "git push --force",
      "git push --force-with-lease origin main",
      "git push origin main --force",
      "git push -f",
      "git push origin main -f",
      "git push -f origin main",
      "git reset --hard HEAD~3",
      "git clean -fdx",
      "Remove-Item -Recurse -Force C:\\repo\\build",
      "Remove-Item .\\dist -Recurse",
      "rmdir /s /q build",
      "rd /s build",
    ])
      assert.equal(decide(BUILD, rules, "shell", bad), "deny", bad);
    assert.equal(decide(BUILD, rules, "edit", "src/a.ts"), "allow");
    assert.equal(decide(BUILD, rules, "read", ".env"), "ask", "secrets still ask");
  });

  it("never lifts an agent's block: Plan keeps not editing in every mode", () => {
    for (const mode of ["ask", "balanced", "auto"] as const) {
      const rules = presetRules(mode, PLAN);
      assert.ok(!rules.some((r) => r.action === "edit"), mode);
      assert.equal(decide(PLAN, rules, "edit", "src/a.ts"), "deny", mode);
      assert.equal(decide(PLAN, rules, "edit", "C:\\Users\\me\\.opencode\\plan\\p.md"), "allow", mode);
    }
    // On Plan, Ask and Balanced are the same rules.
    assert.deepEqual(presetRules("ask", PLAN), presetRules("balanced", PLAN));
  });

  it("replaces only the agent's catch-all: its exceptions still apply", () => {
    const agent: PermissionRule[] = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "shell", resource: "git push*", effect: "deny" },
      { action: "shell", resource: "git status*", effect: "allow" },
    ];
    const balanced = presetRules("balanced", agent);
    assert.equal(decide(agent, balanced, "shell", "git push origin"), "deny", "a deny is repeated");
    assert.equal(decide(agent, balanced, "shell", "git status"), "allow", "an allow-list entry is kept");
    assert.equal(decide(agent, balanced, "shell", "npm test"), "ask");
    // An agent that asks for commands: Auto lets them run, but a deny stays.
    const asking: PermissionRule[] = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "curl *", effect: "deny" },
    ];
    const auto = presetRules("auto", asking);
    assert.equal(decide(asking, auto, "shell", "npm test"), "allow");
    assert.equal(decide(asking, auto, "shell", "curl x"), "deny");
    assert.equal(decide(asking, auto, "shell", "rm -rf x"), "deny");
  });

  it("sets every rule when the agent's rules are unknown, and no command blocks when commands are denied", () => {
    assert.equal(presetRules("ask", null).length, 5);
    assert.equal(presetRules("auto", null).length, 8 + DESTRUCTIVE_COMMANDS.length);
    const noShell: PermissionRule[] = [{ action: "shell", resource: "*", effect: "deny" }];
    assert.ok(!presetRules("auto", noShell).some((r) => r.action === "shell"));
  });
});

describe("approval modes: reading rules back", () => {
  it("finds the mode and the user's own rules after it", () => {
    const own: PermissionRule = { action: "shell", resource: "npm test *", effect: "allow" };
    for (const mode of ["ask", "balanced", "auto"] as const) {
      const c = classifyRules([...presetRules(mode, BUILD), own], [BUILD]);
      assert.equal(c.mode, mode);
      assert.deepEqual(c.custom, [own]);
      assert.deepEqual(c.modeRules, presetRules(mode, BUILD));
    }
    assert.deepEqual(classifyRules([], [BUILD]), { mode: "default", modeRules: [], custom: [] });
    assert.deepEqual(classifyRules([own], [BUILD]), { mode: "custom", modeRules: [], custom: [own] });
  });

  it("reads rules fitted to another agent, and breaks Plan's Ask/Balanced tie with the last pick", () => {
    // Picked on Build, now on Plan (before Sidecar refits them).
    assert.equal(classifyRules(presetRules("ask", BUILD), [PLAN, BUILD]).mode, "ask");
    const same = presetRules("ask", PLAN);
    assert.equal(classifyRules(same, [PLAN]).mode, "ask");
    assert.equal(classifyRules(same, [PLAN], "balanced").mode, "balanced");
    // Set by an older Sidecar or another client without the agent's rules.
    assert.equal(classifyRules(presetRules("auto", null), [BUILD]).mode, "auto");
  });

  it("parses OpenCode's rules and drops malformed ones", () => {
    assert.deepEqual(
      parseRules([
        { action: "shell", resource: "*", effect: "ask" },
        { action: "shell", resource: "*", effect: "maybe" },
        { action: 1, resource: "*", effect: "allow" },
        null,
      ]),
      [{ action: "shell", resource: "*", effect: "ask" }],
    );
    assert.deepEqual(parseRules(undefined), []);
    assert.equal(isRule({ action: "shell", resource: "npm *", effect: "deny" }), true);
    assert.equal(isRule({ action: "shell", resource: " ", effect: "deny" }), false);
    assert.equal(isRule({ action: "sh ell", resource: "x", effect: "deny" }), false);
    assert.equal(isRule({ action: "shell", resource: "x", effect: "deny", extra: 1 }), false);
  });
});

describe("approval modes: commands like this one", () => {
  it("keeps the program and its subcommands, then *", () => {
    const cases: Array<[string, string]> = [
      ["npm test -- --grep foo", "npm test *"],
      ["npm test", "npm test *"],
      ["npm run build:prod", "npm run build:prod *"],
      ["git status -s", "git status *"],
      ["git log --oneline -5", "git log *"],
      ["docker compose up -d", "docker compose up *"],
      ["npx vitest run src/a.test.ts", "npx vitest run *"],
      ["ls", "ls *"],
      ["  cargo   test  --release ", "cargo test *"],
      ["node scripts/build.js --watch", "node scripts/build.js *"],
      ["python -m pytest tests -k slow", "python -m pytest *"],
      ["npm test && rm -rf /", "npm test *"],
      ["cat a.txt | grep x", "cat *"],
      ["echo 'a; b' ; ls", "echo *"],
      ["make\nmake install", "make *"],
      ["", ""],
    ];
    for (const [cmd, want] of cases) assert.equal(generalizeCommand(cmd), want, JSON.stringify(cmd));
  });

  it("handles PowerShell and Windows commands", () => {
    const cases: Array<[string, string]> = [
      ["Get-ChildItem -Path src -Recurse", "Get-ChildItem *"],
      ["Get-Content .\\package.json", "Get-Content *"],
      [".\\scripts\\build.ps1 -Fast", ".\\scripts\\build.ps1 *"],
      ['& "C:\\Program Files\\nodejs\\npm.cmd" test', '& "C:\\Program Files\\nodejs\\npm.cmd" *'],
      ["npm.cmd run lint", "npm.cmd run lint *"],
      ["dotnet test --no-build", "dotnet test *"],
      ["pwsh -File .\\tools\\x.ps1", "pwsh -File .\\tools\\x.ps1 *"],
      ["python -m pytest", "python -m pytest *"],
      ["powershell .\\tools\\x.ps1 -Verbose", "powershell .\\tools\\x.ps1 *"],
      ["cmd /c dir", "cmd /c dir *"],
    ];
    for (const [cmd, want] of cases) assert.equal(generalizeCommand(cmd), want, JSON.stringify(cmd));
    // The pattern covers the command it came from, backslashes and all.
    for (const [cmd] of cases) assert.equal(globMatch(cmd, generalizeCommand(cmd)), true, cmd);
  });

  it("makes patterns for paths and web requests too", () => {
    assert.equal(generalizePattern("bash", "npm test -- x"), "npm test *");
    assert.equal(
      generalizePattern("webfetch", "https://docs.example.com/a/b?c=1"),
      "https://docs.example.com/*",
    );
    assert.equal(generalizePattern("edit", "src/core/a.ts"), "src/core/*");
    assert.equal(generalizePattern("edit", "C:\\repo\\src\\a.ts"), "C:\\repo\\src\\*");
    assert.equal(generalizePattern("external_directory", "C:/elsewhere/*"), "C:/elsewhere/*");
    assert.equal(generalizePattern("skill", "review"), "review");
  });
});

// ------------------------------------------------------------- controller

const DIR = "/work/repo";
const silentLog = { info() {}, warn() {}, error() {} };
const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const client = new MockClient();
  client.rules = { build: BUILD, plan: PLAN };
  const store = new MemoryStore();
  const emitted: UiEvent[] = [];
  const c = new SessionController(
    client,
    store,
    { onEvents: (e) => emitted.push(...e), onTranscriptReset() {}, onStateChanged() {} },
    silentLog,
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  return { client, store, c, emitted };
}

async function withSession() {
  const env = setup();
  await env.c.setDirectory(DIR);
  await env.c.send("hi", []);
  return env;
}

describe("approval modes: the session controller", () => {
  it("applies a mode to the open session and reads it back", async () => {
    const { c, client } = await withSession();
    assert.equal(c.approvalView().mode, "default");
    await c.setApprovalMode("balanced", "session");
    const set = client.callsTo("setSessionPermissions");
    assert.deepEqual(set[0].args, ["ses_1", presetRules("balanced", BUILD)]);
    const view = c.approvalView();
    assert.equal(view.mode, "balanced");
    assert.deepEqual(view.modeRules, presetRules("balanced", BUILD));
    assert.equal(view.session, true);
    assert.equal(view.folderMode, null, "the folder is left alone");
    assert.ok(view.actions.includes("shell") && view.actions.includes("question"), "OpenCode's actions too");
  });

  it("keeps the user's own rules when the mode changes, and Default clears only the mode's", async () => {
    const { c, client } = await withSession();
    await c.setApprovalMode("ask", "session");
    const own: PermissionRule = { action: "shell", resource: "npm test *", effect: "allow" };
    await c.setSessionRules([own]);
    assert.deepEqual(c.approvalView().rules, [own]);
    await c.setApprovalMode("auto", "session");
    assert.equal(c.approvalView().mode, "auto");
    assert.deepEqual(c.approvalView().rules, [own]);
    await c.setApprovalMode("default", "session");
    assert.deepEqual(client.sessions[0].permissions, [own]);
    assert.equal(c.approvalView().mode, "custom");
    await c.setSessionRules([]);
    assert.equal(c.approvalView().mode, "default");
  });

  it("starts the next session in a mode picked before it exists, or in the folder's", async () => {
    const { c, client, store } = setup();
    await c.setDirectory(DIR);
    await c.setApprovalMode("ask", "session");
    assert.equal(c.approvalView().mode, "ask");
    assert.equal(c.approvalView().session, false);
    await c.send("hi", []);
    assert.deepEqual(
      (client.callsTo("createSession")[0].args[0] as { permissions: unknown }).permissions,
      presetRules("ask", BUILD),
    );
    assert.equal(c.approvalView().mode, "ask");
    // The folder's mode: saved for the folder and used by every new session.
    await c.setApprovalMode("auto", "folder");
    assert.equal(store.get("opencodeSidecar.approval:/work/repo"), "auto");
    assert.equal(c.approvalView().mode, "auto", "the open session too");
    await c.newSession();
    assert.equal(c.approvalView().mode, "auto");
    await c.send("again", []);
    assert.deepEqual(
      (client.callsTo("createSession")[1].args[0] as { permissions: unknown }).permissions,
      presetRules("auto", BUILD),
    );
    assert.equal(c.approvalView().folderMode, "auto");
    await c.setApprovalMode("default", "folder");
    assert.equal(store.get("opencodeSidecar.approval:/work/repo"), undefined);
    await c.newSession();
    await c.send("plain", []);
    assert.equal(
      (client.callsTo("createSession")[2].args[0] as { permissions?: unknown }).permissions,
      undefined,
    );
  });

  it("follows rules changed in the TUI or another client", async () => {
    const { c } = await withSession();
    c.handleRawEvent(
      raw("session.permissions", { sessionID: "ses_1", permissions: presetRules("auto", BUILD) }),
    );
    assert.equal(c.approvalView().mode, "auto");
    c.handleRawEvent(
      raw("session.permissions", {
        sessionID: "ses_1",
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      }),
    );
    assert.equal(c.approvalView().mode, "custom");
    // Another session's rules are not the open one's.
    c.handleRawEvent(raw("session.permissions", { sessionID: "ses_other", permissions: [] }));
    assert.equal(c.approvalView().mode, "custom");
  });

  it("fits the mode to the agent on a switch, and back", async () => {
    const { c, client } = await withSession();
    await c.setApprovalMode("ask", "session");
    await c.selectAgent("plan");
    assert.deepEqual(client.sessions[0].permissions, presetRules("ask", PLAN), "no edit rule for Plan");
    assert.equal(c.approvalView().mode, "ask");
    await c.selectAgent("build");
    assert.deepEqual(client.sessions[0].permissions, presetRules("ask", BUILD));
    // Balanced on Plan looks like Ask; it comes back as Balanced on Build.
    await c.setApprovalMode("balanced", "session");
    await c.selectAgent("plan");
    assert.equal(c.approvalView().mode, "balanced");
    await c.selectAgent("build");
    assert.deepEqual(client.sessions[0].permissions, presetRules("balanced", BUILD));
    // An agent chosen in another client is followed the same way.
    c.handleRawEvent(raw("session.agent.selected", { sessionID: "ses_1", agent: "plan" }));
    await tick(10);
    assert.deepEqual(client.sessions[0].permissions, presetRules("balanced", PLAN));
  });

  it("says so when OpenCode refuses the rules, and keeps what it had", async () => {
    const { c, client, emitted } = await withSession();
    client.permissionsError = new OpenCodeHttpError(400, "InvalidRequestError", "Expected Permission.Effect");
    await c.setApprovalMode("auto", "session");
    assert.equal(c.approvalView().mode, "default");
    assert.equal(c.approvalView().busy, false);
    assert.ok(
      emitted.some((e) => e.type === "notice" && /Could not change the permission rules/.test(e.text)),
    );
  });
});

describe("approval modes: always allow like this", () => {
  async function asked(save: string[] = ["npm test *"]) {
    const env = await withSession();
    env.client.projects.set(DIR, "prj_1");
    env.c.handleRawEvent(
      raw("permission.asked", {
        id: "per_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["npm test -- --grep foo"],
        ...(save.length ? { save } : {}),
      }),
    );
    return env;
  }

  it("this session: adds an allow rule and allows the request once", async () => {
    const { c, client } = await asked();
    await c.allowLike("per_1", ["npm test *", " npm test * "], "session");
    assert.deepEqual(client.sessions[0].permissions, [
      { action: "shell", resource: "npm test *", effect: "allow" },
    ]);
    assert.deepEqual(client.callsTo("replyPermission")[0].args, ["ses_1", "per_1", "once"]);
    assert.deepEqual(c.approvalView().rules, [{ action: "shell", resource: "npm test *", effect: "allow" }]);
  });

  it("this session: a subagent's request gets the rule on its own session and the open one", async () => {
    const { c, client } = await withSession();
    client.sessions.push({ ...client.sessions[0], id: "ses_sub", permissions: [] });
    c.handleRawEvent(raw("session.created", { sessionID: "ses_sub", parentID: "ses_1" }));
    c.handleRawEvent(
      raw("permission.asked", {
        id: "per_s",
        sessionID: "ses_sub",
        action: "shell",
        resources: ["npm test"],
      }),
    );
    await c.allowLike("per_s", ["npm test *"], "session");
    assert.deepEqual(
      client.callsTo("setSessionPermissions").map((x) => x.args[0]),
      ["ses_sub", "ses_1"],
    );
    assert.deepEqual(client.callsTo("replyPermission")[0].args, ["ses_sub", "per_s", "once"]);
  });

  it("this folder: OpenCode saves its pattern, which becomes the one typed", async () => {
    const { c, client } = await asked(["npm test -- --grep foo"]);
    client.onAlways = () =>
      client.saved.push({
        id: "ps_new",
        projectID: "prj_1",
        action: "shell",
        resource: "npm test -- --grep foo",
        created: 5,
      });
    await c.allowLike("per_1", ["npm test *"], "folder");
    assert.deepEqual(client.callsTo("replyPermission")[0].args, ["ses_1", "per_1", "always"]);
    assert.deepEqual(client.callsTo("updateSavedPermission")[0].args, ["ps_new", { resource: "npm test *" }]);
    assert.equal(client.saved[0].resource, "npm test *");
  });

  it("this folder: a pattern the folder already allows removes the narrower copy", async () => {
    const { c, client } = await asked(["npm test -- --grep foo"]);
    client.saved.push({
      id: "ps_old",
      projectID: "prj_1",
      action: "shell",
      resource: "npm test *",
      created: 1,
    });
    client.onAlways = () =>
      client.saved.push({
        id: "ps_new",
        projectID: "prj_1",
        action: "shell",
        resource: "npm test -- --grep foo",
        created: 5,
      });
    await c.allowLike("per_1", ["npm test *"], "folder");
    assert.deepEqual(client.callsTo("removeSavedPermission")[0].args, ["ps_new"]);
    assert.deepEqual(
      client.saved.map((x) => x.id),
      ["ps_old"],
    );
  });

  it("this folder: only when OpenCode offers 'always'; answered requests are left alone", async () => {
    const { c, client } = await asked([]);
    await c.allowLike("per_1", ["npm test *"], "folder");
    assert.equal(client.callsTo("replyPermission").length, 0);
    await c.allowLike("per_1", ["  "], "session");
    assert.equal(client.callsTo("setSessionPermissions").length, 0);
    await c.allowLike("per_1", ["npm test *"], "session");
    await c.allowLike("per_1", ["npm test *"], "session");
    assert.equal(client.callsTo("replyPermission").length, 1, "once answered, not again");
  });

  it("keeps the sensitive-path warning on the request", async () => {
    const { c } = await withSession();
    c.handleRawEvent(
      raw("permission.asked", { id: "per_env", sessionID: "ses_1", action: "read", resources: [".env"] }),
    );
    const item = c.transcript.get("perm:per_env");
    assert.ok(item?.kind === "permission" && item.sensitive.length > 0);
  });
});

describe("approval modes: the HTTP client and the wire", () => {
  it("reads a session's rules, and leaves them out when OpenCode has none", () => {
    const base = { id: "ses_1", projectID: "p", cost: 0, tokens: {}, time: { created: 1, updated: 2 } };
    assert.equal(toSessionSummary(base).permissions, undefined);
    assert.deepEqual(
      toSessionSummary({ ...base, permissions: [{ action: "edit", resource: "*", effect: "ask" }] })
        .permissions,
      [{ action: "edit", resource: "*", effect: "ask" }],
    );
  });

  it("sends rules, saved-rule changes and agent rules in OpenCode's shapes", async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      seen.push({
        method: init?.method ?? "GET",
        path: u.pathname + u.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (u.pathname === "/api/agent")
        return new Response(JSON.stringify({ data: [{ id: "build", permissions: BUILD }, { id: "x" }] }), {
          status: 200,
        });
      if (u.pathname.startsWith("/api/permission/saved/"))
        return new Response(
          JSON.stringify({
            data: {
              id: "ps_1",
              projectID: "p",
              action: "shell",
              resource: "npm *",
              time: { created: 3, updated: 4 },
            },
          }),
          { status: 200 },
        );
      if (u.pathname === "/api/session")
        return new Response(
          JSON.stringify({ data: { id: "ses_9", time: { created: 1, updated: 1 }, permissions: [] } }),
          { status: 200 },
        );
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new HttpOpenCodeClient({ url: "http://127.0.0.1:1" }, fetchImpl);
    const rules: PermissionRule[] = [{ action: "shell", resource: "*", effect: "ask" }];
    await client.setSessionPermissions("ses_1", rules);
    assert.deepEqual(seen.at(-1), {
      method: "PATCH",
      path: "/api/session/ses_1",
      body: { permissions: rules },
    });
    await client.setSessionPermissions("ses_1", []);
    assert.deepEqual(seen.at(-1)?.body, { permissions: [] }, "an empty list clears them");
    assert.deepEqual(await client.updateSavedPermission("ps_1", { resource: "npm *" }), {
      id: "ps_1",
      action: "shell",
      resource: "npm *",
      created: 3,
    });
    assert.deepEqual(seen.at(-1), {
      method: "PATCH",
      path: "/api/permission/saved/ps_1",
      body: { resource: "npm *" },
    });
    assert.deepEqual(await client.agentRules("c:\\repo"), { build: BUILD, x: [] });
    assert.match(seen.at(-1)!.path, /location%5Bdirectory%5D=C%3A%5Crepo/);
    const s = await client.createSession({ directory: "/r", permissions: rules });
    assert.deepEqual((seen.at(-1)!.body as { permissions: unknown }).permissions, rules);
    assert.deepEqual(s.permissions, []);
    await client.createSession({ directory: "/r", permissions: [] });
    assert.equal((seen.at(-1)!.body as { permissions?: unknown }).permissions, undefined);
  });

  it("normalizes session.permissions", () => {
    const env = new EventNormalizer().normalize(
      raw("session.permissions", {
        sessionID: "ses_1",
        permissions: [{ action: "shell", resource: "*", effect: "deny" }],
      }),
    );
    assert.equal(env?.sessionID, "ses_1");
    assert.deepEqual(env?.events, [
      { type: "session.permissions", rules: [{ action: "shell", resource: "*", effect: "deny" }] },
    ]);
  });

  it("validates the webview's approval messages strictly", () => {
    const ok = [
      { type: "setApprovalMode", mode: "auto", scope: "folder", dontAskAgain: true },
      { type: "setApprovalMode", mode: "default", scope: "session" },
      { type: "setSessionRules", rules: [] },
      { type: "setSessionRules", rules: [{ action: "shell", resource: "npm test *", effect: "allow" }] },
      { type: "allowLike", requestId: "per_1", patterns: ["npm test *"], scope: "session" },
      { type: "updateSavedPermission", id: "ps_1", action: "shell", resource: "npm *" },
    ];
    for (const m of ok) assert.ok(parseWebviewMessage(m), JSON.stringify(m));
    const bad = [
      { type: "setApprovalMode", mode: "yolo", scope: "session" },
      { type: "setApprovalMode", mode: "ask", scope: "global" },
      { type: "setSessionRules", rules: [{ action: "shell", resource: "x", effect: "maybe" }] },
      { type: "setSessionRules", rules: "x" },
      {
        type: "setSessionRules",
        rules: Array.from({ length: 201 }, () => ({ action: "a", resource: "b", effect: "ask" })),
      },
      { type: "allowLike", requestId: "per_1", patterns: [], scope: "session" },
      { type: "allowLike", requestId: "per_1", patterns: [" "], scope: "session" },
      { type: "allowLike", requestId: "per_1", patterns: ["x"], scope: "global" },
      { type: "updateSavedPermission", id: "ps_1", action: "", resource: "npm *" },
      { type: "updateSavedPermission", id: "ps_1", action: "shell", resource: "npm *", effect: "deny" },
    ];
    for (const m of bad) assert.equal(parseWebviewMessage(m), undefined, JSON.stringify(m));
  });
});
