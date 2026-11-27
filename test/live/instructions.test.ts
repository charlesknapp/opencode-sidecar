// Live tests for the Project instructions panel against the real OpenCode service: in a
// temporary Git repository (below a temporary folder with its own AGENTS.md), what
// Sidecar works out OpenCode reads is checked against OpenCode itself. OpenCode reports a
// hash of the instruction files it built a session from (`session.instructions.updated`,
// "core/instructions") when a prompt starts, even at the free limit, so changing a file
// Sidecar lists as read must change the hash, and changing one it lists as not read must
// not. Each prompt is interrupted once the hash arrives; every session is deleted. They
// skip without a registered service or the free model.
//
//   npm run test:live

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { globalConfigDir } from "../../src/core/agents";
import { appendBullet, instructionView, startAgentsFile } from "../../src/core/instructions";
import { HttpOpenCodeClient, type Endpoint, type EventSubscription } from "../../src/opencode/client";
import { forgetLocations } from "./locations";
import { discoverServer } from "../../src/opencode/service";

import { LIVE_MODEL, LIVE_MODEL_KEY, NOT_OFFERED } from "./liveModel";

let client: HttpOpenCodeClient | undefined;
let endpoint: Endpoint | undefined;
let skipReason = "";
let root = "";
let sub: EventSubscription | undefined;
const events: Array<{ type?: string; data?: { sessionID?: string; delta?: Record<string, string> } }> = [];

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
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-instr-")));
  let opened!: () => void;
  const open = new Promise<void>((r) => (opened = r));
  sub = client.subscribe({ onOpen: () => opened(), onClose() {}, onEvent: (r) => events.push(r as never) });
  await open;
});

after(async () => {
  sub?.dispose();
  await forgetLocations(endpoint, [root]);
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The instruction hash OpenCode builds a new session in `dir` from: "" when it reads no
 * file, null when it sent none (no event in time). OpenCode watches the files, so this
 * first waits for it to notice a change.
 */
async function instructionHash(c: HttpOpenCodeClient, dir: string): Promise<string | null> {
  await pause(2500);
  const s = await c.createSession({ directory: dir, agent: "plan", model: LIVE_MODEL });
  try {
    await c.prompt(s.id, { text: "Reply with the single word OK. Do not use any tools.", files: [] });
    for (let i = 0; i < 60; i++) {
      const e = events.find((x) => x.type === "session.instructions.updated" && x.data?.sessionID === s.id);
      if (e) return e.data?.delta?.["core/instructions"] ?? "";
      await pause(250);
    }
    return null;
  } finally {
    await c.interrupt(s.id).catch(() => false);
    await pause(300);
    await c.deleteSession(s.id).catch(() => undefined);
  }
}

describe("live: project instructions", () => {
  it("lists the files OpenCode reads for a folder, as OpenCode reads them", async (t) => {
    const c = live(t);
    if (!c) return;
    const repo = path.join(root, "repo");
    const ws = path.join(repo, "pkg");
    fs.mkdirSync(ws, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const write = (f: string, text: string) => fs.writeFileSync(path.join(root, f), text);
    write("AGENTS.md", "# Outer\n- outer rule\n");
    write("repo/AGENTS.md", "# Repo\n- repo rule\n");
    write("repo/CLAUDE.md", "# Claude\n- ignored while AGENTS.md is there\n");
    write("repo/extra.md", "Extra rule\n");
    write("repo/opencode.json", JSON.stringify({ instructions: ["extra.md"] }));
    // A folder OpenCode has not loaded yet briefly lists no models.
    for (let i = 0; i < 20 && (await c.listModels(ws)).length === 0; i++) await pause(500);
    if (!(await c.listModels(ws)).some((m) => m.key === LIVE_MODEL_KEY)) return t.skip(NOT_OFFERED);

    // What Sidecar works out, from OpenCode's config documents and project.
    const sources = await c.configSources(ws);
    assert.deepEqual(sources.instructions, [{ entry: "extra.md", from: path.join(repo, "opencode.json") }]);
    const projectDir = await c.projectDirectory(ws);
    assert.equal(projectDir, repo, "the Git root is the project");
    const view = () =>
      instructionView({
        folder: ws,
        projectDir,
        home: os.homedir(),
        configDir: globalConfigDir(sources, ws) ?? path.join(os.homedir(), ".config", "opencode"),
        instructions: sources.instructions ?? [],
        isFile: (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
      });
    const mine = () =>
      view()
        .rows.filter((r) => r.path.startsWith(root))
        .map((r) => `${r.kind} ${path.relative(root, r.path)} ${r.state}`);
    assert.deepEqual(mine(), [
      `project ${path.join("repo", "AGENTS.md")} loaded`,
      `project ${path.join("repo", "CLAUDE.md")} shadowed`,
      "project AGENTS.md loaded",
      `config ${path.join("repo", "extra.md")} loaded`,
    ]);
    assert.equal(view().projectFile, path.join(repo, "AGENTS.md"));

    // What OpenCode reads: each change to a file listed as read changes the hash.
    const first = await instructionHash(c, ws);
    if (first === null) return t.skip("OpenCode sent no instruction hash");
    assert.ok(first, "OpenCode reads instruction files here");
    write("repo/CLAUDE.md", "# Claude\n- changed, still ignored\n");
    assert.equal(await instructionHash(c, ws), first, "a CLAUDE.md beside AGENTS.md is not read");
    write("repo/extra.md", "Extra rule, changed\n");
    const second = await instructionHash(c, ws);
    assert.notEqual(second, first, "the config's instructions are read");
    write("AGENTS.md", "# Outer\n- changed\n");
    const third = await instructionHash(c, ws);
    assert.notEqual(third, second, "an AGENTS.md above the Git root (below home) is read");
    // "Remember this" adds a line OpenCode then reads.
    const agents = path.join(repo, "AGENTS.md");
    fs.writeFileSync(agents, appendBullet(fs.readFileSync(agents, "utf8"), "Run the tests before pushing"));
    assert.equal(fs.readFileSync(agents, "utf8"), "# Repo\n- repo rule\n- Run the tests before pushing\n");
    const fourth = await instructionHash(c, ws);
    assert.notEqual(fourth, third, "the remembered line is read");
    // Without AGENTS.md, the CLAUDE.md beside it is read instead.
    fs.rmSync(agents);
    assert.ok(mine().includes(`project ${path.join("repo", "CLAUDE.md")} loaded`));
    assert.equal(view().claudeFile, path.join(repo, "CLAUDE.md"), "a new AGENTS.md would hide it");
    const fifth = await instructionHash(c, ws);
    assert.notEqual(fifth, fourth);
    write("repo/CLAUDE.md", "# Claude\r\n- now read\r\n");
    const sixth = await instructionHash(c, ws);
    assert.notEqual(sixth, fifth, "now the CLAUDE.md is read");
    // "Remember this" with "Create AGENTS.md and copy CLAUDE.md into it": OpenCode reads the
    // new AGENTS.md (CLAUDE.md's rules and the line) and no longer the CLAUDE.md.
    const claude = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
    fs.writeFileSync(agents, appendBullet(startAgentsFile(claude), "Keep replies short"), { flag: "wx" });
    assert.equal(fs.readFileSync(agents, "utf8"), "# Claude\r\n- now read\r\n- Keep replies short\r\n");
    assert.ok(mine().includes(`project ${path.join("repo", "CLAUDE.md")} shadowed`));
    assert.equal(view().claudeFile, null);
    const seventh = await instructionHash(c, ws);
    assert.notEqual(seventh, sixth, "the new AGENTS.md is read");
    write("repo/CLAUDE.md", "# Claude\n- changed after the copy\n");
    assert.equal(await instructionHash(c, ws), seventh, "the CLAUDE.md is no longer read");
    fs.appendFileSync(agents, "- Another rule\r\n");
    assert.notEqual(await instructionHash(c, ws), seventh, "the copy in AGENTS.md is what is read");
  });

  it("offers /init for the folder", async (t) => {
    const c = live(t);
    if (!c) return;
    let names: string[] = [];
    for (let i = 0; i < 3 && !names.length; i++) {
      names = (await c.listCommands(root)).map((x) => x.name);
      if (!names.length) await pause(500);
    }
    assert.ok(names.includes("init"), names.join(", "));
  });
});
