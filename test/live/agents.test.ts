// Live tests for custom agents: the agent files Sidecar writes, read by the real OpenCode
// service. Each test works in its own temporary folder (its `.opencode/agents`), never in
// OpenCode's global config folder, and deletes what it wrote. No model is called. They
// skip without a registered service.
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import {
  draftFromFile,
  legacyRules,
  newAgentFile,
  newAgentFileWithRules,
  parseAgentFile,
  updateAgentFile,
} from "../../src/core/agentFile";
import {
  agentFilePath,
  deriveAgentRows,
  globalConfigDir,
  isInside,
  projectConfigDir,
  scanAgentFiles,
  type AgentDetail,
} from "../../src/core/agents";
import { importComments, modeToAgent, parseModesFile } from "../../src/core/roomodes";
import { SessionController } from "../../src/core/sessionController";
import { HttpOpenCodeClient, type Endpoint } from "../../src/opencode/client";
import { forgetLocations } from "./locations";
import { discoverServer } from "../../src/opencode/service";
import type { AgentDraft, ModelOption } from "../../src/shared/model";
import { MemoryStore } from "../mockClient";

let client: HttpOpenCodeClient | undefined;
let endpoint: Endpoint | undefined;
let skipReason = "";
let models: ModelOption[] = [];
const dirs: string[] = [];

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
});

after(async () => {
  await forgetLocations(endpoint, dirs);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

/** A new temporary folder, with its models loaded (a cold location briefly lists none). */
async function folder(c: HttpOpenCodeClient): Promise<string> {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-agents-")));
  dirs.push(d);
  for (let i = 0; i < 20 && (models = await c.listModels(d)).length === 0; i++)
    await new Promise((r) => setTimeout(r, 500));
  return d;
}

/** Waits for OpenCode's agent list to satisfy `ok` (it watches the config folders, slower under load). */
async function until(
  c: HttpOpenCodeClient,
  dir: string,
  ok: (list: AgentDetail[]) => boolean,
  timeoutMs = 30_000,
): Promise<AgentDetail[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const list = await c.listAgentDetails(dir);
    if (ok(list)) return list;
    if (Date.now() > end)
      assert.fail(`OpenCode's agent list did not change in time: ${list.map((a) => a.id).join(", ")}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * An agent file with no rules of its own, for what OpenCode gives every custom agent
 * (built-in ones differ: Build also allows the question tool).
 */
async function baseline(c: HttpOpenCodeClient, dir: string): Promise<AgentDetail> {
  write(agentFilePath(projectConfigDir(dir), "sidecar-plain"), "---\nmode: subagent\n---\nPlain.\n");
  return (await until(c, dir, (l) => l.some((a) => a.id === "sidecar-plain"))).find(
    (a) => a.id === "sidecar-plain",
  )!;
}

/** The rules an agent file added, without OpenCode's defaults before and after them. */
function ownRules(agent: AgentDetail, plain: AgentDetail): AgentDetail["permissions"] {
  const base = plain.permissions;
  // The defaults end with the browser rules (if any), which OpenCode puts after the file's own.
  const browser = base.findIndex((r) => r.action === "browser");
  const tail = browser < 0 ? base.length : browser;
  const head = base.slice(0, tail);
  const rest = agent.permissions.slice(head.length);
  return rest.slice(0, rest.length - (base.length - tail));
}

describe("custom agents (live)", () => {
  it("reports its config folders: the global one outside the folder, then the folder's own", async (t) => {
    const c = live(t);
    if (!c) return;
    // The folder's .opencode is listed when it is there as OpenCode loads the folder (one
    // made later is not, though its agents are picked up: Sidecar scans it anyway).
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-agents-")));
    dirs.push(dir);
    write(path.join(dir, ".opencode", "agents", "x.md"), "---\nmode: subagent\n---\nX\n");
    const sources = await c.configSources(dir);
    const global = globalConfigDir(sources, dir);
    assert.ok(global && !isInside(global, dir), JSON.stringify(sources.directories));
    if (process.platform === "win32") assert.equal(global, path.join(os.homedir(), ".config", "opencode"));
    assert.ok(
      sources.directories.some((d) => isInside(d, dir) && isInside(projectConfigDir(dir), d)),
      `the folder's .opencode is listed: ${JSON.stringify(sources.directories)}`,
    );
    assert.deepEqual(sources.documentAgents, {});
  });

  it("lists an agent file Sidecar wrote with its fields, then an edit, then not after a delete", async (t) => {
    const c = live(t);
    if (!c) return;
    const dir = await folder(c);
    const plain = await baseline(c, dir);
    const model = models.find((m) => m.key === "opencode/big-pickle") ?? models[0];
    const d: AgentDraft = {
      name: "sidecar-live",
      description: 'Live test agent: "quoted" #1',
      mode: "subagent",
      model: model?.key ?? null,
      variant: model?.variants[0] ?? null,
      temperature: 0.2,
      permissions: { edit: "deny", shell: "ask", webfetch: "deny" },
      prompt: "You are a live test.\n\nReply briefly.",
      scope: "project",
    };
    const file = agentFilePath(projectConfigDir(dir), d.name);
    write(file, newAgentFile(d));
    let a = (await until(c, dir, (l) => l.some((x) => x.id === d.name))).find((x) => x.id === d.name)!;
    assert.equal(a.description, d.description);
    assert.equal(a.mode, "subagent");
    assert.equal(a.system, "You are a live test.\n\nReply briefly.");
    assert.equal(a.temperature, 0.2);
    if (model) assert.equal(a.model, `${model.key}${d.variant ? `#${d.variant}` : ""}`);
    assert.deepEqual(ownRules(a, plain), [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ]);

    // The panel's row for it, from the same files and list.
    const sources = await c.configSources(dir);
    const files = await scanAgentFiles(sources.directories, dir);
    const row = deriveAgentRows({
      details: await c.listAgentDetails(dir),
      files,
      documentAgents: {},
      folder: dir,
    }).find((r) => r.id === d.name);
    assert.equal(row?.source, "project");
    assert.equal(row?.file, ".opencode/agents/sidecar-live.md");
    assert.deepEqual(row?.draft, d);

    // An edit that keeps a comment and an unknown key the form does not know.
    const text = fs.readFileSync(file, "utf8").replace("---\n", "---\n# kept\nsidecar_note: kept\n");
    const edited = updateAgentFile(text, {
      ...d,
      description: "Edited",
      mode: "all",
      permissions: { edit: "ask" },
      temperature: null,
    });
    assert.ok(edited.includes("# kept\nsidecar_note: kept\n"));
    fs.writeFileSync(file, edited);
    a = (await until(c, dir, (l) => l.some((x) => x.id === d.name && x.description === "Edited"))).find(
      (x) => x.id === d.name,
    )!;
    assert.equal(a.mode, "all");
    assert.equal(a.temperature, null);
    assert.deepEqual(ownRules(a, plain), [{ action: "edit", resource: "*", effect: "ask" }]);

    fs.rmSync(file);
    await until(c, dir, (l) => !l.some((x) => x.id === d.name));
  });

  it("converts an OpenCode 1 file to the rules OpenCode itself made of it", async (t) => {
    const c = live(t);
    if (!c) return;
    const dir = await folder(c);
    const plain = await baseline(c, dir);
    const v1 = [
      "---",
      "description: Old style",
      "tools:",
      "  write: false",
      "  task: false",
      "permission:",
      "  bash:",
      '    "git *": allow',
      '    "*": ask',
      "  webfetch: deny",
      "temperature: 0.4",
      "---",
      "Old.",
      "",
    ].join("\n");
    const file = path.join(dir, ".opencode", "agent", "old.md");
    write(file, v1);
    const before1 = (await until(c, dir, (l) => l.some((x) => x.id === "old"))).find((x) => x.id === "old")!;
    assert.deepEqual(ownRules(before1, plain), legacyRules(parseAgentFile(v1).data));
    assert.equal(before1.temperature, 0.4);
    // Changing a switch writes OpenCode 2's keys; OpenCode then decides the same plus the change.
    const d = draftFromFile(v1, "old", "project").draft;
    fs.writeFileSync(file, updateAgentFile(v1, { ...d, permissions: { ...d.permissions, read: "deny" } }));
    const after1 = (
      await until(c, dir, (l) =>
        l.some(
          (x) =>
            x.id === "old" &&
            x.permissions.some((r) => r.action === "read" && r.effect === "deny" && r.resource === "*"),
        ),
      )
    ).find((x) => x.id === "old")!;
    assert.equal(after1.temperature, 0.4);
    assert.deepEqual(ownRules(after1, plain), [
      { action: "read", resource: "*", effect: "deny" },
      ...legacyRules(parseAgentFile(v1).data),
    ]);
  });

  it("imports a .roomodes file as agents OpenCode lists with the mapped fields", async (t) => {
    const c = live(t);
    if (!c) return;
    const dir = await folder(c);
    const plain = await baseline(c, dir);
    const modes = parseModesFile(
      [
        "customModes:",
        "  - slug: live-docs",
        "    name: 📝 Docs",
        "    roleDefinition: You write docs.",
        "    whenToUse: Writing documentation",
        "    groups:",
        "      - read",
        "      - - edit",
        "        - fileRegex: \\.(md|mdx)$",
        "      - browser",
        "  - slug: live-orchestrator",
        "    name: Orchestrator",
        "    roleDefinition: You coordinate work with new_task.",
        "    groups: []",
      ].join("\n"),
    );
    for (const m of modes) {
      const a = modeToAgent(m, { models, others: modes.filter((x) => x !== m).map((x) => x.slug) });
      write(
        agentFilePath(projectConfigDir(dir), a.name),
        newAgentFileWithRules(a.draft, a.rules, importComments(m, ".roomodes", a.notes)),
      );
    }
    const list = await until(
      c,
      dir,
      (l) => l.some((x) => x.id === "live-docs") && l.some((x) => x.id === "live-orchestrator"),
    );
    const docs = list.find((x) => x.id === "live-docs")!;
    assert.equal(docs.mode, "all");
    assert.equal(docs.description, "Writing documentation");
    assert.equal(docs.system, "You write docs.");
    assert.deepEqual(ownRules(docs, plain), [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "edit", resource: "*.md", effect: "allow" },
      { action: "edit", resource: "*.mdx", effect: "allow" },
    ]);
    const orch = list.find((x) => x.id === "live-orchestrator")!;
    assert.equal(orch.mode, "primary");
    assert.ok(orch.permissions.some((r) => r.action === "subagent" && r.effect === "allow"));
    assert.match(orch.system, /subagent tool: live-docs\.$/);
    // The primary agent is offered for sessions; the `all` one also as a subagent.
    assert.ok((await c.listAgents(dir)).some((a) => a.id === "live-orchestrator"));
    assert.ok((await c.listSubagents(dir)).some((a) => a.id === "live-docs"));
  });

  it("applies agents/build.md on top of the built-in Build agent, and brings it back once deleted", async (t) => {
    const c = live(t);
    if (!c) return;
    const dir = await folder(c);
    const builtIn = (await c.listAgentDetails(dir)).find((a) => a.id === "build");
    assert.ok(builtIn, "OpenCode has a built-in build agent");
    assert.equal(
      deriveAgentRows({ details: [builtIn], files: new Map(), documentAgents: {}, folder: dir })[0].source,
      "built-in",
    );
    // What the form writes for an override: description, mode, prompt and one switch.
    const d: AgentDraft = {
      ...emptyDraft(),
      name: "build",
      description: "Overridden build",
      permissions: { shell: "deny" },
      prompt: "You are the overridden build agent.",
    };
    const file = agentFilePath(projectConfigDir(dir), "build");
    write(file, newAgentFile(d));
    const over = (
      await until(c, dir, (l) => l.some((a) => a.id === "build" && a.description === d.description))
    ).filter((a) => a.id === "build");
    assert.equal(over.length, 1, "still one build agent");
    // Merged, not replaced: the file's fields win, the rest (and every built-in rule) stays.
    assert.equal(over[0].name, builtIn.name);
    assert.equal(over[0].mode, "primary");
    assert.equal(over[0].system, d.prompt);
    // OpenCode's browser rules stay last. Once the folder has agent files it adds them to
    // the agents, built-in ones too, where it listed none before (seen with OpenCode 2.4.2).
    const isBrowser = (r: AgentDetail["permissions"][number]) =>
      r.action === "browser" || (r.action === "skill" && r.resource === "browser");
    const own = (rules: AgentDetail["permissions"]) => {
      let end = rules.length;
      while (end > 0 && isBrowser(rules[end - 1])) end--;
      return rules.slice(0, end);
    };
    assert.deepEqual(own(over[0].permissions), [
      ...own(builtIn.permissions),
      { action: "shell", resource: "*", effect: "deny" },
    ]);
    const tail = over[0].permissions.slice(own(over[0].permissions).length);
    for (const r of builtIn.permissions.slice(own(builtIn.permissions).length))
      assert.ok(
        tail.some((x) => JSON.stringify(x) === JSON.stringify(r)),
        `the browser rules last: ${JSON.stringify(r)}`,
      );
    assert.ok(over[0].permissions.some((r) => r.action === "question" && r.effect === "allow"));

    // The panel's row: the file's, marked as overriding the built-in, editable in the form.
    const sources = await c.configSources(dir);
    const row = deriveAgentRows({
      details: await c.listAgentDetails(dir),
      files: await scanAgentFiles([...sources.directories, projectConfigDir(dir)], dir),
      documentAgents: {},
      folder: dir,
    }).find((r) => r.id === "build");
    assert.equal(row?.source, "project");
    assert.equal(row?.overrides, true);
    assert.equal(row?.file, ".opencode/agents/build.md");
    assert.deepEqual(row?.draft, d);

    // An empty body leaves the agent with no prompt: explore's own is replaced too.
    const explore = (await c.listAgentDetails(dir)).find((a) => a.id === "explore")!;
    assert.ok(explore.system, "the built-in explore agent has a prompt");
    const exploreFile = agentFilePath(projectConfigDir(dir), "explore");
    write(exploreFile, "---\ndescription: Mine\n---\n");
    const mine = (
      await until(c, dir, (l) => l.some((a) => a.id === "explore" && a.description === "Mine"))
    ).find((a) => a.id === "explore")!;
    assert.equal(mine.system, "");
    assert.equal(mine.mode, "subagent", "the mode it does not set stays the built-in's");

    // Removing the overrides brings the built-in definitions back.
    fs.rmSync(file);
    fs.rmSync(exploreFile);
    const back = await until(
      c,
      dir,
      (l) =>
        l.some((a) => a.id === "build" && a.description === builtIn.description) &&
        l.some((a) => a.id === "explore" && a.system === explore.system),
    );
    const plainBuild = (a: AgentDetail | undefined) => a && { ...a, permissions: own(a.permissions) };
    assert.deepEqual(plainBuild(back.find((a) => a.id === "build")), plainBuild(builtIn));
    assert.deepEqual(
      back.find((a) => a.id === "explore"),
      explore,
    );
  });

  it("the controller waits for a saved agent and refreshes the agent picker", async (t) => {
    const c = live(t);
    if (!c) return;
    const dir = await folder(c);
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: "", agent: "" }),
      { debounceMs: 50, stopCheckMs: 15_000, modelRetryMs: 500, agentWaitMs: 15_000 },
    );
    try {
      await ctl.setDirectory(dir);
      const file = agentFilePath(projectConfigDir(dir), "live-picker");
      write(
        file,
        newAgentFile({ ...emptyDraft(), name: "live-picker", description: "Picker test", prompt: "P." }),
      );
      assert.equal(await ctl.awaitAgents((l) => l.some((a) => a.id === "live-picker")), true);
      assert.ok(
        ctl.agents?.some((a) => a.id === "live-picker"),
        "the agent picker lists it",
      );
      await ctl.selectAgent("live-picker");
      assert.equal(ctl.selectedAgent, "live-picker");
      fs.rmSync(file);
      assert.equal(await ctl.awaitAgents((l) => !l.some((a) => a.id === "live-picker")), true);
      assert.ok(!ctl.agents?.some((a) => a.id === "live-picker"));
    } finally {
      ctl.dispose();
    }
  });
});

function emptyDraft(): AgentDraft {
  return {
    name: "",
    description: "",
    mode: "primary",
    model: null,
    variant: null,
    temperature: null,
    permissions: {},
    prompt: "",
    scope: "project",
  };
}
