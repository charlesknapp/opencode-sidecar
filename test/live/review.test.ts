// Live tests: the agent's changes as the Keep / Undo review reads them, from the real
// OpenCode service, in a temporary Git repository. OpenCode records a snapshot at each
// agent step, so two prompts with file changes made between them give the session a
// diff without the model having to edit anything (each prompt is tiny and uses the plan
// agent; at the free daily limit the step still records its snapshots). They skip
// without a registered service, and delete the session and the folder afterwards.
//
//   npm run test:live

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { reconstructSides } from "../../src/core/patch";
import {
  fileHunks,
  keptPatch,
  placeHunks,
  rewindPreview,
  stepFiles,
  toLines,
  undoEdit,
} from "../../src/core/review";
import { HttpOpenCodeClient } from "../../src/opencode/client";
import { discoverServer } from "../../src/opencode/service";

const FREE_MODEL = { providerID: "opencode", id: "big-pickle" };

let client: HttpOpenCodeClient | undefined;
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
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    skipReason = "git is not installed";
    return;
  }
  client = new HttpOpenCodeClient(outcome.endpoint);
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-review-")));
});

after(async () => {
  for (const id of created) await client?.deleteSession(id).catch(() => undefined);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const crlf = (ls: string[]) => ls.join("\r\n") + "\r\n";
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

describe("live: the agent's changes for the review", () => {
  it("rebuilds the baseline and snapshot from /diff, matches Git, undoes one hunk and stages the kept ones", async (t) => {
    const c = live(t);
    if (!c) return;
    // The repository first: OpenCode takes snapshots only in a folder that was a Git
    // repository when it first loaded it.
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("config", "user.email", "sidecar@example.invalid");
    git("config", "user.name", "Sidecar live test");
    fs.writeFileSync(path.join(dir, "a.txt"), crlf(lines(40)));
    fs.writeFileSync(path.join(dir, "gone.txt"), "bye\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "bee\n");
    git("add", ".");
    git("commit", "-qm", "init");
    let models = await c.listModels(dir);
    for (let i = 0; i < 20 && models.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      models = await c.listModels(dir);
    }
    if (!models.some((m) => m.key === `${FREE_MODEL.providerID}/${FREE_MODEL.id}`))
      return t.skip(`${FREE_MODEL.providerID}/${FREE_MODEL.id} is not offered`);

    // A change the user made before the session: part of the baseline, not the agent's.
    const baseline = ["LINE 1", ...lines(40).slice(1)];
    fs.writeFileSync(path.join(dir, "a.txt"), crlf(baseline));

    const s = await c.createSession({ directory: dir, agent: "plan", model: FREE_MODEL });
    created.add(s.id);
    let idles = 0;
    const turn = async () => {
      const sent = await c.prompt(s.id, {
        text: "Reply with the single word OK. Do not use any tools.",
        files: [],
      });
      idles++;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const m = (await c.listMessages(s.id, 50)) as Array<{ type?: string }>;
        if (m.filter((x) => x.type === "idle").length >= idles) return sent.id;
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error("the turn did not end");
    };
    const m1 = await turn();
    // Changes between the two turns: three hunks in a CRLF file, a new file and a deleted one.
    const agent = [...baseline];
    agent[4] = "agent 5";
    agent.splice(10, 0, "inserted");
    agent[35] = "agent 35";
    fs.writeFileSync(path.join(dir, "a.txt"), crlf(agent));
    fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n");
    fs.rmSync(path.join(dir, "gone.txt"));
    // A command run with `!` (no agent step): `echo … > file` works in bash, zsh and PowerShell.
    await c.runShell(s.id, "echo shell-edit > b.txt");
    for (let i = 0; i < 40 && read("b.txt") === "bee\n"; i++) await new Promise((r) => setTimeout(r, 250));
    assert.notEqual(read("b.txt"), "bee\n", "the shell command ran");
    const m2 = await turn();

    const diff = await c.sessionDiff(s.id, { from: m1, to: m2, full: true });
    const byFile = new Map(diff.map((d) => [d.file, d]));
    assert.deepEqual([...byFile.keys()].sort(), ["a.txt", "b.txt", "gone.txt", "new.txt"]);
    assert.equal(byFile.get("new.txt")?.status, "added");
    assert.equal(byFile.get("gone.txt")?.status, "deleted");
    assert.equal(byFile.get("a.txt")?.status, "modified");

    // Full-file patches (a context longer than the file) rebuild both sides exactly, CRLF kept.
    const a = byFile.get("a.txt")!;
    const sides = reconstructSides(a.patch, "modified");
    assert.ok(sides, `a.txt patch did not rebuild:\n${a.patch.slice(0, 400)}`);
    assert.equal(sides.before, crlf(baseline), "the baseline keeps the user's earlier change");
    assert.equal(sides.after, read("a.txt"));
    assert.deepEqual(reconstructSides(byFile.get("gone.txt")!.patch, "deleted"), {
      before: git("show", "HEAD:gone.txt"),
      after: "",
    });
    assert.deepEqual(reconstructSides(byFile.get("new.txt")!.patch, "added"), {
      before: "",
      after: "fresh\n",
    });

    const r = fileHunks(sides, a.patch);
    assert.equal(r.kind, "hunks");
    if (r.kind !== "hunks") return;
    assert.deepEqual(
      r.hunks.map((h) => [h.oldLines, h.newLines]),
      [
        [["line 5\n"], ["agent 5\n"]],
        [[], ["inserted\n"]],
        [["line 35\n"], ["agent 35\n"]],
      ],
    );

    // The user edits the top of the file; Undo of the middle hunk still lands exactly.
    const edited = ["// header", ...agent];
    const current = crlf(edited);
    const p = placeHunks(r.after, toLines(current), [r.hunks[1]])[0];
    assert.equal(p.kind, "ok");
    if (p.kind !== "ok") return;
    const u = undoEdit(current, p, r.hunks[1]);
    const undone = current.slice(0, u.start) + u.text + current.slice(u.end);
    assert.equal(undone, crlf(edited.filter((l) => l !== "inserted")));

    // Stage kept: hunks 1 and 3 only, onto the index (HEAD, without the user's LINE 1).
    const k = keptPatch({
      rel: "a.txt",
      status: "modified",
      index: git("cat-file", "blob", ":a.txt"),
      file: r,
      kept: new Set([r.hunks[0].id, r.hunks[2].id]),
      newFileEol: "\n",
    });
    assert.deepEqual([k.staged, k.skipped], [2, 0]);
    execFileSync("git", ["apply", "--cached", "--whitespace=nowarn", "-"], { cwd: dir, input: k.patch });
    const want = lines(40);
    want[4] = "agent 5";
    want[34] = "agent 35";
    assert.equal(git("cat-file", "blob", ":a.txt"), crlf(want));
    const cached = git("diff", "--cached", "--", "a.txt");
    assert.match(cached, /^-line 5\r?$/m);
    assert.match(cached, /^\+agent 35\r?$/m);
    assert.doesNotMatch(cached, /inserted|LINE 1/);

    // What a rewind with code to the first prompt reverts: only what the agent's steps
    // changed. These edits were made between the steps, so OpenCode reverts none of them.
    const steps = stepFiles(await c.listMessages(s.id, 200), m1);
    assert.deepEqual(steps, []);
    const preview = rewindPreview(
      [{ id: "tool:shell-msg:x", category: "shell", files: [] }],
      steps,
      diff.map((d) => ({ path: d.file, status: d.status })),
    );
    assert.deepEqual(preview.files, []);
    assert.deepEqual([...preview.kept].sort(), ["a.txt", "b.txt", "gone.txt", "new.txt"]);
    const before = { a: read("a.txt"), b: read("b.txt") };
    await c.revert(s.id, m1, true);
    assert.deepEqual(
      { a: read("a.txt"), b: read("b.txt") },
      before,
      "rewind with code left them, as the preview said",
    );
    assert.ok(fs.existsSync(path.join(dir, "new.txt")));
  });
});
