import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCommitPrompt,
  cleanCommitMessage,
  diffForPrompt,
  MAX_DIFF_CHARS,
  MAX_FILE_CHARS,
  splitGitDiff,
  styleExamples,
  trimContext,
} from "../src/core/commitMessage";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " export { a, b };",
  "diff --git a/package-lock.json b/package-lock.json",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  '-  "version": "1.0.0"',
  '+  "version": "1.0.1"',
  "",
].join("\r\n");

describe("commit message: diff", () => {
  it("splits git diff output by file, CRLF or not", () => {
    const s = splitGitDiff(DIFF);
    assert.deepEqual(
      s.map((x) => x.path),
      ["src/a.ts", "package-lock.json"],
    );
    assert.ok(!s[0].patch.includes("\r"));
    assert.ok(s[0].patch.startsWith("diff --git a/src/a.ts"));
    assert.deepEqual(splitGitDiff(""), []);
    assert.deepEqual(splitGitDiff("\n\n"), []);
  });

  it("reads quoted paths (spaces)", () => {
    const s = splitGitDiff('diff --git "a/my file.ts" "b/my file.ts"\n--- a\n+++ b\n');
    assert.equal(s[0].path, "my file.ts");
  });

  it("keeps three unchanged lines around changes in a whole-file patch", () => {
    const body = Array.from({ length: 20 }, (_, i) => ` line ${i + 1}`);
    body[10] = "-old";
    body.splice(11, 0, "+new");
    const patch = ["--- a/x", "+++ b/x", "@@ -1,20 +1,20 @@", ...body].join("\n");
    const out = trimContext(patch).split("\n");
    assert.deepEqual(out, [
      "--- a/x",
      "+++ b/x",
      "@@ -1,20 +1,20 @@",
      " …",
      " line 8",
      " line 9",
      " line 10",
      "-old",
      "+new",
      " line 12",
      " line 13",
      " line 14",
      " …",
    ]);
  });

  it("leaves lockfile diffs out, cuts a large file and lists files past the limit by name", () => {
    const big = "+" + "x".repeat(80) + "\n";
    const sections = [
      { path: "src/a.ts", patch: "--- a\n+++ b\n" + big.repeat(100) },
      { path: "yarn.lock", patch: "+lots" },
      ...Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, patch: big.repeat(30) })),
    ];
    const { text, truncated } = diffForPrompt(sections);
    assert.ok(truncated);
    assert.ok(text.length <= MAX_DIFF_CHARS + 500, `${text.length}`);
    assert.match(text, /\(yarn\.lock: lockfile changed, diff left out\)/);
    assert.ok(!text.includes("+lots"));
    assert.match(text, /… \(\d+ more lines of src\/a\.ts left out\)/);
    assert.match(text, /\(Also changed, diff left out: f\d\.ts/);
    const first = text.split("\n\n")[0];
    assert.ok(first.length <= MAX_FILE_CHARS + 80);
  });

  it("always shows the first file, even one over the limit, cut to its share", () => {
    const { text } = diffForPrompt([{ path: "a", patch: "+x\n".repeat(5000) }], 100);
    assert.ok(text.startsWith("+x"));
  });

  it("leaves a small diff as it is", () => {
    const sections = splitGitDiff(DIFF).slice(0, 1);
    assert.deepEqual(diffForPrompt(sections), { text: sections[0].patch, truncated: false });
  });
});

describe("commit message: prompt", () => {
  it("shows recent subjects as style examples, without merges or reverts", () => {
    assert.deepEqual(
      styleExamples([
        "Providers: a Providers panel\n\n- body line",
        "Merge branch 'x'",
        'Revert "Usage: y"',
        "",
        "Usage: costs by model",
      ]),
      ["Providers: a Providers panel", "Usage: costs by model"],
    );
    assert.equal(styleExamples(Array.from({ length: 30 }, (_, i) => `c${i}`)).length, 10);
  });

  it("asks for the message only, with the style and the staged diff", () => {
    const p = buildCommitPrompt({
      sections: splitGitDiff(DIFF),
      recent: ["Sessions: a strip of open sessions", "Composer: large pastes become chips"],
      source: "staged",
    });
    assert.match(p, /^Write a git commit message for the changes below\./);
    assert.match(p, /Reply with the commit message only/);
    assert.match(p, /recent commit subjects:\n- Sessions: a strip of open sessions\n- Composer: large/);
    assert.match(p, /\nStaged changes:\ndiff --git a\/src\/a\.ts/);
    assert.match(p, /\+const b = 3;/);
  });

  it("names the agent's changes and leaves out the style section without history", () => {
    const p = buildCommitPrompt({ sections: [{ path: "a", patch: "+x" }], recent: [], source: "agent" });
    assert.ok(!p.includes("recent commit subjects"));
    assert.match(p, /Changes made by the agent \(not yet staged\):\n\+x$/);
  });
});

describe("commit message: reply", () => {
  it("removes fences, labels, quotes and reasoning", () => {
    assert.equal(cleanCommitMessage("```\nFix: a bug\n\n- detail\n```"), "Fix: a bug\n\n- detail");
    assert.equal(cleanCommitMessage("```text\nFix: a bug\n```\n"), "Fix: a bug");
    assert.equal(cleanCommitMessage("Commit message: Fix: a bug"), "Fix: a bug");
    assert.equal(cleanCommitMessage("**Commit message:**\nFix: a bug"), "Fix: a bug");
    assert.equal(cleanCommitMessage('"Fix: a bug"'), "Fix: a bug");
    assert.equal(cleanCommitMessage("<think>hmm</think>\nFix: a bug"), "Fix: a bug");
    assert.equal(cleanCommitMessage("Fix: a bug  \r\n\r\n\r\n\r\n- one  "), "Fix: a bug\n\n- one");
    assert.equal(cleanCommitMessage("   "), "");
  });
});
