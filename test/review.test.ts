import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { reconstructSides } from "../src/core/patch";
import {
  applyKept,
  countDecisions,
  diffLines,
  eolOf,
  fileHunks,
  fromLines,
  gitQuote,
  keptPatch,
  MAX_REVIEW_SESSIONS,
  placeHunks,
  pruneDecisions,
  putSession,
  readStore,
  rewindPreview,
  stepFiles,
  toLines,
  undoEdit,
  unifiedPatch,
  type Hunk,
} from "../src/core/review";

const lines = (n: number, f = (i: number) => `line ${i + 1}`) => Array.from({ length: n }, (_, i) => f(i));
const text = (ls: string[], eol = "\n") => ls.join(eol) + eol;

/** Hunks of a before/after pair, or fails. */
function hunksOf(before: string, after: string) {
  const r = fileHunks({ before, after }, "");
  assert.equal(r.kind, "hunks");
  if (r.kind !== "hunks") throw new Error("unreachable");
  return r;
}

/** Applies a hunk's undo to `current` the way the editor does. */
function undo(current: string, after: string[], h: Hunk): string {
  const p = placeHunks(after, toLines(current), [h])[0];
  assert.equal(p.kind, "ok", "hunk should place");
  if (p.kind !== "ok") return current;
  const e = undoEdit(current, p, h);
  return current.slice(0, e.start) + e.text + current.slice(e.end);
}

describe("review: lines and diff", () => {
  it("normalizes CRLF and keeps a missing final newline distinct", () => {
    assert.deepEqual(toLines("a\r\nb\nc"), ["a\n", "b\n", "c"]);
    assert.deepEqual(toLines(""), []);
    assert.equal(eolOf("a\r\nb\n"), "\r\n");
    assert.equal(eolOf("a"), "\n");
    assert.equal(fromLines(["a\n", "b"], "\r\n"), "a\r\nb");
    assert.notDeepEqual(toLines("a\n"), toLines("a"));
  });

  it("finds each changed block, insertions and removals included", () => {
    const a = ["a\n", "b\n", "c\n", "d\n", "e\n"];
    const b = ["a\n", "B\n", "c\n", "x\n", "d\n"];
    assert.deepEqual(diffLines(a, b), [
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
      { aStart: 3, aEnd: 3, bStart: 3, bEnd: 4 },
      { aStart: 4, aEnd: 5, bStart: 5, bEnd: 5 },
    ]);
    assert.deepEqual(diffLines(a, a), []);
    assert.deepEqual(diffLines([], ["x\n"]), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
  });

  it("gives up (null) past the edit distance limit instead of taking quadratic memory", () => {
    const a = lines(50).map((l) => l + "\n");
    const b = lines(50, (i) => `other ${i}`).map((l) => l + "\n");
    assert.equal(diffLines(a, b, 10), null);
    assert.ok(diffLines(a, b));
  });
});

describe("review: hunks", () => {
  it("splits an agent edit into hunks with stable content ids", () => {
    const before = text(lines(40));
    const l = lines(40);
    l[4] = "agent 5";
    l.splice(10, 0, "inserted");
    l[35] = "agent 35";
    const r = hunksOf(before, text(l));
    assert.deepEqual(
      r.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]),
      [
        [4, ["line 5\n"], 4, ["agent 5\n"]],
        [10, [], 10, ["inserted\n"]],
        [34, ["line 35\n"], 35, ["agent 35\n"]],
      ],
    );
    // Same changes elsewhere in the file: same ids.
    const moved = hunksOf("top\n" + before, "top\n" + text(l));
    assert.deepEqual(
      moved.hunks.map((h) => h.id),
      r.hunks.map((h) => h.id),
    );
  });

  it("numbers repeated identical changes", () => {
    const r = hunksOf("a\nx\nb\nx\n", "a\ny\nb\ny\n");
    assert.equal(r.hunks.length, 2);
    assert.notEqual(r.hunks[0].id, r.hunks[1].id);
    assert.match(r.hunks[1].id, /\.1$/);
  });

  it("reviews new and deleted files as one hunk", () => {
    const added = hunksOf("", "a\nb\n");
    assert.deepEqual(added.hunks.length, 1);
    assert.deepEqual(added.hunks[0].newLines, ["a\n", "b\n"]);
    const deleted = hunksOf("a\n", "");
    assert.deepEqual(deleted.hunks[0].oldLines, ["a\n"]);
  });

  it("reviews binary, incomplete and huge files as a whole", () => {
    const bin = fileHunks(null, "Binary files a/x.png and b/x.png differ");
    assert.equal(bin.kind, "file");
    assert.match(bin.kind === "file" ? bin.id : "", /^file:/);
    const huge = fileHunks({ before: "x".repeat(2_000_001), after: "" }, "");
    assert.deepEqual(huge.kind === "file" && huge.reason, "large");
    // More hunks than the cap: every other line changed.
    const many = fileHunks(
      { before: text(lines(700)), after: text(lines(700, (i) => (i % 2 ? `c${i}` : `line ${i + 1}`))) },
      "",
    );
    assert.equal(many.kind, "file");
  });

  it("treats CRLF and LF versions of the same change alike", () => {
    const lf = hunksOf("a\nb\nc\n", "a\nB\nc\n");
    const crlf = hunksOf("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
    assert.deepEqual(
      crlf.hunks.map((h) => h.id),
      lf.hunks.map((h) => h.id),
    );
  });
});

describe("review: placing hunks on an edited document and undoing one", () => {
  const before = text(lines(20));
  const agent = lines(20);
  agent[2] = "agent 3";
  agent[15] = "agent 16";
  const after = text(agent);

  it("undoes exactly one hunk and keeps the other", () => {
    const r = hunksOf(before, after);
    assert.equal(r.hunks.length, 2);
    const out = undo(after, r.after, r.hunks[0]);
    const want = [...agent];
    want[2] = "line 3";
    assert.equal(out, text(want));
  });

  it("follows the hunk when the user added and removed lines elsewhere", () => {
    const r = hunksOf(before, after);
    const user = [...agent];
    user.splice(8, 2); // removed two lines between the hunks
    user.unshift("// header", "// more"); // added two at the top
    const out = undo(text(user), r.after, r.hunks[1]);
    const want = [...user];
    want[want.indexOf("agent 16")] = "line 16";
    assert.equal(out, text(want));
  });

  it("marks a hunk the user edited since as changed, and places the others", () => {
    const r = hunksOf(before, after);
    const user = [...agent];
    user[2] = "agent 3, edited by me";
    const p = placeHunks(r.after, toLines(text(user)), r.hunks);
    assert.equal(p[0].kind, "changed");
    assert.deepEqual(p[1], { kind: "ok", start: 15, end: 16 });
    assert.equal(p[0].kind === "changed" && p[0].near, 2);
  });

  it("does not place a removal whose spot the user filled", () => {
    const r = hunksOf("a\nb\nc\n", "a\nc\n");
    assert.deepEqual(placeHunks(r.after, toLines("a\nc\n"), r.hunks), [{ kind: "ok", start: 1, end: 1 }]);
    assert.equal(placeHunks(r.after, toLines("a\nmine\nc\n"), r.hunks)[0].kind, "changed");
    // An edit right above or below the spot is fine.
    assert.deepEqual(placeHunks(r.after, toLines("A\nc\n"), r.hunks), [{ kind: "ok", start: 1, end: 1 }]);
    assert.equal(undo("A\nc\n", r.after, r.hunks[0]), "A\nb\nc\n");
  });

  it("undoes an insertion and a removal", () => {
    const ins = hunksOf("a\nc\n", "a\nb\nc\n");
    assert.equal(undo("a\nb\nc\n", ins.after, ins.hunks[0]), "a\nc\n");
    const del = hunksOf("a\nb\nc\n", "a\nc\n");
    assert.equal(undo("a\nc\n", del.after, del.hunks[0]), "a\nb\nc\n");
  });

  it("writes the document's CRLF line endings back", () => {
    const r = hunksOf("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
    assert.equal(undo("a\r\nB\r\nc\r\n", r.after, r.hunks[0]), "a\r\nb\r\nc\r\n");
    // The baseline was LF but the user's editor saved CRLF: still places, written as CRLF.
    const lf = hunksOf("a\nb\nc\n", "a\nB\nc\n");
    assert.equal(undo("a\r\nB\r\nc\r\n", lf.after, lf.hunks[0]), "a\r\nb\r\nc\r\n");
  });

  it("handles a change to the last line without a newline", () => {
    const r = hunksOf("a\nb", "a\nB");
    assert.equal(undo("a\nB", r.after, r.hunks[0]), "a\nb");
    const nl = hunksOf("a\nb", "a\nb\n");
    assert.equal(nl.hunks.length, 1, "adding the final newline is a change");
    assert.equal(undo("a\nb\n", nl.after, nl.hunks[0]), "a\nb");
  });

  it("an undone hunk places again once its lines are back (Ctrl+Z)", () => {
    const r = hunksOf(before, after);
    const undone = undo(after, r.after, r.hunks[0]);
    assert.equal(placeHunks(r.after, toLines(undone), [r.hunks[0]])[0].kind, "changed");
    assert.equal(placeHunks(r.after, toLines(after), [r.hunks[0]])[0].kind, "ok");
  });

  it("rebuilds the sides of OpenCode's full-file patch (CRLF, several changes) into the same hunks", () => {
    // GET /api/session/{id}/diff?context=10000000 on OpenCode 2.4.2, CRLF file.
    const patch =
      "diff --git a/a.txt b/a.txt\nindex 19ea662..47ec641 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,6 +1,7 @@\n" +
      " LINE 1\r\n-line 2\r\n+agent 2\r\n line 3\r\n+inserted\r\n line 4\r\n line 5\r\n-line 6\r\n+agent 6\r\n";
    const sides = reconstructSides(patch, "modified");
    assert.ok(sides);
    const r = hunksOf(sides.before, sides.after);
    assert.equal(r.hunks.length, 3);
    assert.equal(eolOf(sides.after), "\r\n");
  });
});

describe("review: decisions", () => {
  it("reads back only well-formed decisions", () => {
    const s = readStore({
      ses_1: { at: 5, files: { "a.ts": { h1: "kept", h2: "undone", h3: "maybe" }, "b.ts": "x" } },
      ses_2: null,
      ses_3: { files: {} },
    });
    assert.deepEqual(s, {
      ses_1: { at: 5, files: { "a.ts": { h1: "kept", h2: "undone" } } },
      ses_3: { at: 0, files: {} },
    });
    assert.deepEqual(readStore("junk"), {});
  });

  it("drops stale hunks and files, keeps the rest", () => {
    const files = {
      "a.ts": { h1: "kept" as const, h2: "undone" as const },
      "gone.ts": { h9: "kept" as const },
    };
    assert.deepEqual(pruneDecisions(files, { "a.ts": ["h1", "h3"] }), { "a.ts": { h1: "kept" } });
    assert.deepEqual(pruneDecisions(files, { "a.ts": ["h3"] }), {});
  });

  it("a new agent edit to a reviewed file adds only new undecided hunks", () => {
    const before = text(lines(30));
    const first = lines(30);
    first[3] = "agent 4";
    const r1 = hunksOf(before, text(first));
    const decisions = { [r1.hunks[0].id]: "kept" as const };
    const second = [...first];
    second[25] = "agent 26";
    const r2 = hunksOf(before, text(second));
    const pruned = pruneDecisions({ "f.ts": decisions }, { "f.ts": r2.hunks.map((h) => h.id) });
    assert.deepEqual(
      countDecisions(
        r2.hunks.map((h) => h.id),
        pruned["f.ts"],
      ),
      {
        undecided: 1,
        kept: 1,
        undone: 0,
        changed: 0,
        fileOnly: false,
      },
    );
  });

  it("keeps sessions apart and drops the least recently reviewed past the cap", () => {
    let store = putSession({}, "ses_a", { "a.ts": { h: "kept" } }, 1);
    store = putSession(store, "ses_b", { "a.ts": { h: "undone" } }, 2);
    assert.equal(store.ses_a.files["a.ts"].h, "kept");
    assert.equal(store.ses_b.files["a.ts"].h, "undone");
    // Survives a round trip through workspace state (JSON).
    assert.deepEqual(readStore(JSON.parse(JSON.stringify(store))), store);
    for (let i = 0; i < MAX_REVIEW_SESSIONS + 5; i++)
      store = putSession(store, `s${i}`, { f: { h: "kept" } }, 10 + i);
    assert.equal(Object.keys(store).length, MAX_REVIEW_SESSIONS);
    assert.equal(store.ses_a, undefined);
    assert.deepEqual(
      Object.keys(putSession(store, "s60", {}, 99)).includes("s60"),
      false,
      "empty sessions are removed",
    );
  });
});

describe("review: staging kept hunks", () => {
  const before = text(lines(20));
  const agent = lines(20);
  agent[2] = "agent 3";
  agent[15] = "agent 16";

  it("applies only the kept hunks to the staged version", () => {
    const r = hunksOf(before, text(agent));
    const res = applyKept(toLines(before), r, new Set([r.hunks[1].id]));
    const want = lines(20);
    want[15] = "agent 16";
    assert.equal(res.lines.join(""), text(want));
    assert.deepEqual([res.staged, res.already, res.skipped], [1, 0, 0]);
  });

  it("counts a hunk already staged, and skips one whose lines differ in the index", () => {
    const r = hunksOf(before, text(agent));
    const staged = [...lines(20)];
    staged[2] = "agent 3";
    staged[15] = "line 16, staged by me";
    const res = applyKept(toLines(text(staged)), r, new Set(r.hunks.map((h) => h.id)));
    assert.deepEqual([res.staged, res.already, res.skipped], [0, 1, 1]);
  });

  it("writes a patch Git applies, with CRLF, Windows separators and quoted paths", () => {
    const p = unifiedPatch("src\\dir\\a.txt", ["a\n", "b\n"], ["a\n", "B\n"], "\r\n");
    assert.equal(
      p,
      "diff --git a/src/dir/a.txt b/src/dir/a.txt\n--- a/src/dir/a.txt\n+++ b/src/dir/a.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n",
    );
    assert.equal(gitQuote("a/b c.txt"), "a/b c.txt");
    assert.equal(gitQuote('a/"q".txt'), '"a/\\"q\\".txt"');
    assert.equal(gitQuote("a/é.txt"), '"a/\\303\\251.txt"');
    assert.match(
      unifiedPatch("n.txt", null, ["x"], "\n"),
      /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/n.txt\n@@ -0,0 \+1,1 @@\n\+x\n\\ No newline at end of file\n$/,
    );
    assert.match(
      unifiedPatch("o.txt", ["x\n"], null, "\n", "100755"),
      /deleted file mode 100755\n--- a\/o.txt\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-x\n$/,
    );
    assert.equal(unifiedPatch("same.txt", ["a\n"], ["a\n"], "\n"), "");
  });

  it("merges nearby changes into one hunk and keeps far ones apart", () => {
    const a = lines(30).map((l) => l + "\n");
    const b = [...a];
    b[2] = "x\n";
    b[5] = "y\n";
    b[25] = "z\n";
    const p = unifiedPatch("f", a, b, "\n");
    assert.deepEqual(p.match(/^@@ .* @@$/gm), ["@@ -1,9 +1,9 @@", "@@ -23,7 +23,7 @@"]);
  });

  it("builds the kept-hunks patch for new, deleted and untracked files", () => {
    const added = hunksOf("", "x\ny\n");
    const all = new Set(added.hunks.map((h) => h.id));
    const n = keptPatch({
      rel: "n.txt",
      status: "added",
      index: null,
      file: added,
      kept: all,
      newFileEol: "\n",
    });
    assert.match(n.patch, /^diff --git a\/n.txt b\/n.txt\nnew file mode 100644\n/);
    const deleted = hunksOf("x\n", "");
    const d = keptPatch({
      rel: "o.txt",
      status: "deleted",
      index: "x\n",
      mode: "100644",
      file: deleted,
      kept: new Set(deleted.hunks.map((h) => h.id)),
      newFileEol: "\n",
    });
    assert.match(d.patch, /deleted file mode 100644/);
    const none = keptPatch({
      rel: "n.txt",
      status: "added",
      index: null,
      file: added,
      kept: new Set(),
      newFileEol: "\n",
    });
    assert.equal(none.patch, "");
  });

  it("stages against an LF index when the working file is CRLF (core.autocrlf)", () => {
    const r = hunksOf("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
    const k = keptPatch({
      rel: "a.txt",
      status: "modified",
      index: "a\nb\nc\n",
      file: r,
      kept: new Set([r.hunks[0].id]),
      newFileEol: "\n",
    });
    assert.ok(k.patch.includes("-b\n+B\n"), k.patch);
    assert.ok(!k.patch.includes("\r"));
  });

  it("git apply --cached takes the patch and stages only the kept hunk (CRLF file)", (t) => {
    let dir = "";
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
      t.skip("git is not installed");
      return;
    }
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-stage-"));
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init", "-q");
      git("config", "core.autocrlf", "false");
      fs.mkdirSync(path.join(dir, "sub dir"));
      const file = path.join("sub dir", "a b.txt");
      const base = text(lines(20), "\r\n");
      fs.writeFileSync(path.join(dir, file), base);
      git("add", ".");
      const crlf = lines(20);
      crlf[2] = "agent 3";
      crlf[15] = "agent 16";
      const r = hunksOf(base, text(crlf, "\r\n"));
      const k = keptPatch({
        rel: file,
        status: "modified",
        index: git("cat-file", "blob", ":sub dir/a b.txt"),
        file: r,
        kept: new Set([r.hunks[0].id]),
        newFileEol: "\r\n",
      });
      execFileSync("git", ["apply", "--cached", "--whitespace=nowarn", "-"], { cwd: dir, input: k.patch });
      const staged = git("cat-file", "blob", ":sub dir/a b.txt");
      const want = lines(20);
      want[2] = "agent 3";
      assert.equal(staged, text(want, "\r\n"));
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review: rewind preview", () => {
  it("counts the agent's and the user's shell commands and names files no edit tool reported", () => {
    const p = rewindPreview(
      [
        { id: "tool:t1", category: "edit", files: ["C:\\w\\app\\src\\a.ts"] },
        { id: "tool:t2", category: "shell", files: [] },
        { id: "tool:shell-msg:msg_1", category: "shell", files: [] },
        { id: "tool:shell-live:sh_1", category: "shell", files: [] },
      ],
      ["src/a.ts", "build/out.js"],
      [
        { path: "src/a.ts", status: "modified" },
        { path: "build/out.js", status: "added" },
        { path: "notes.md", status: "modified" },
      ],
    );
    assert.deepEqual(p, {
      files: [
        { path: "src/a.ts", status: "modified" },
        { path: "build/out.js", status: "added" },
      ],
      agentShell: 1,
      userShell: 2,
      shellFiles: ["build/out.js"],
      kept: ["notes.md"],
    });
  });

  it("reads the files each agent step changed after the prompt from the history", () => {
    const history = [
      { id: "msg_1", type: "user" },
      { id: "a1", type: "assistant", snapshot: { start: "x", end: "y", files: ["early.ts"] } },
      { id: "msg_2", type: "user" },
      { id: "a2", type: "assistant", snapshot: { start: "y", end: "z", files: ["src\\b.ts", "c.ts"] } },
      { id: "sh", type: "shell", command: "echo" },
      { id: "a3", type: "assistant", snapshot: { files: ["c.ts"] } },
      { id: "a4", type: "assistant" },
      null,
    ];
    assert.deepEqual(stepFiles(history, "msg_2"), ["src/b.ts", "c.ts"]);
    assert.deepEqual(stepFiles(history, "msg_1"), ["early.ts", "src/b.ts", "c.ts"]);
    assert.equal(stepFiles(history, "msg_9"), null);
  });

  it("names no shell files when no shell command ran, or when the diff is unknown", () => {
    assert.deepEqual(rewindPreview([], ["a"], [{ path: "a", status: "added" }]).shellFiles, []);
    assert.deepEqual(rewindPreview([{ id: "tool:x", category: "shell", files: [] }], null, null), {
      files: null,
      agentShell: 1,
      userShell: 0,
      shellFiles: [],
      kept: [],
    });
  });
});
