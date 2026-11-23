import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTool, diffLines, fileDiffsFromMetadata, MAX_DIFF_LINES } from "../src/shared/tools";
import { MAX_TOOL_OUTPUT, stampTime, Transcript } from "../src/shared/transcript";

describe("transcript reducer", () => {
  it("accumulates streaming deltas and finalizes on completion", () => {
    const t = new Transcript();
    t.apply({ type: "assistant.delta", partId: "m:0", delta: "Hel" });
    t.apply({ type: "assistant.delta", partId: "m:0", delta: "lo" });
    assert.deepEqual(t.get("text:m:0"), {
      kind: "assistant",
      id: "text:m:0",
      text: "Hello",
      streaming: true,
    });
    t.apply({ type: "assistant.completed", partId: "m:0", text: "Hello!" });
    assert.deepEqual(t.get("text:m:0"), {
      kind: "assistant",
      id: "text:m:0",
      text: "Hello!",
      streaming: false,
    });
  });

  it("tracks shell tool state: waiting → running → passed/failed", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "s1", name: "shell" });
    let item = t.get("tool:s1");
    assert.ok(item?.kind === "tool" && item.status === "pending");
    t.apply({ type: "tool.input", toolId: "s1", name: null, input: { command: "npm test" } });
    t.apply({ type: "tool.shell", toolId: "s1", cwd: "/repo", command: "npm test" });
    item = t.get("tool:s1");
    assert.ok(
      item?.kind === "tool" &&
        item.status === "running" &&
        item.detail.cwd === "/repo" &&
        item.title === "npm test",
    );
    t.apply({ type: "tool.completed", toolId: "s1", output: "1 failing", metadata: { exit: 1 } });
    item = t.get("tool:s1");
    assert.ok(item?.kind === "tool" && item.status === "failed" && item.detail.exitCode === 1);
  });

  it("caps large tool output", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "r", name: "read" });
    t.apply({
      type: "tool.completed",
      toolId: "r",
      output: "x".repeat(MAX_TOOL_OUTPUT + 10),
      metadata: null,
    });
    const item = t.get("tool:r");
    assert.ok(
      item?.kind === "tool" && item.detail.output?.length === MAX_TOOL_OUTPUT && item.detail.outputTruncated,
    );
  });

  it("summarizes edited files at the end of a turn", () => {
    const t = new Transcript();
    t.apply({ type: "user.message", id: "u1", text: "edit", attachments: [] });
    t.apply({ type: "tool.started", toolId: "e1", name: "edit" });
    t.apply({
      type: "tool.completed",
      toolId: "e1",
      output: "ok",
      metadata: { files: [{ file: "a.ts", additions: 3, deletions: 1, status: "modified", patch: "…" }] },
    });
    t.apply({ type: "tool.started", toolId: "e2", name: "write" });
    t.apply({
      type: "tool.completed",
      toolId: "e2",
      output: "ok",
      metadata: {
        files: [
          { file: "a.ts", additions: 2, deletions: 0, status: "modified" },
          { file: "b.ts", additions: 5, deletions: 0, status: "added" },
        ],
      },
    });
    const changed = t.apply({ type: "session.idle", outcome: "succeeded" });
    const summary = t.items.find((i) => i.kind === "turn-summary");
    assert.ok(summary && changed.includes(summary.id));
    assert.deepEqual(summary?.kind === "turn-summary" && summary.files, [
      { path: "a.ts", additions: 5, deletions: 1, status: "modified" },
      { path: "b.ts", additions: 5, deletions: 0, status: "added" },
    ]);
  });

  it("expires pending permissions and marks running tools when the session goes idle", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "s", name: "shell" });
    t.apply({ type: "tool.input", toolId: "s", name: null, input: { command: "sleep 60" } });
    t.apply({
      type: "permission.requested",
      request: {
        id: "p",
        sessionID: "x",
        action: "read",
        resources: ["a"],
        canAlways: false,
        message: null,
        toolId: null,
      },
      sensitive: [],
    });
    t.apply({ type: "session.idle", outcome: "interrupted" });
    const tool = t.get("tool:s");
    const perm = t.get("perm:p");
    assert.ok(tool?.kind === "tool" && tool.status === "failed" && tool.detail.error === "Interrupted");
    assert.ok(perm?.kind === "permission" && perm.status === "expired");
    assert.ok(t.items.some((i) => i.kind === "notice" && i.text === "Stopped."));
  });

  it("keeps a subagent's pending requests when only the parent session goes idle", () => {
    const t = new Transcript();
    const request = (id: string, sessionID: string) => ({
      type: "permission.requested" as const,
      request: {
        id,
        sessionID,
        action: "bash",
        resources: ["ls"],
        canAlways: false,
        message: null,
        toolId: null,
      },
      sensitive: [],
    });
    t.apply(request("p_parent", "ses_parent"));
    t.apply(request("p_sub", "ses_sub"));
    t.apply({
      type: "form.requested",
      form: { id: "f_sub", sessionID: "ses_sub", title: "Q", fields: [], toolId: null },
    });
    t.apply({ type: "session.idle", outcome: "succeeded", sessionID: "ses_parent" });
    assert.equal((t.get("perm:p_parent") as { status: string }).status, "expired");
    assert.equal((t.get("perm:p_sub") as { status: string }).status, "pending");
    assert.equal((t.get("form:f_sub") as { status: string }).status, "pending");
  });

  it("does not reopen a resolved permission, but reopens one that failed to send", () => {
    const t = new Transcript();
    const request = {
      id: "p",
      sessionID: "x",
      action: "read",
      resources: ["a"],
      canAlways: true,
      message: null,
      toolId: null,
    };
    t.apply({ type: "permission.requested", request, sensitive: [] });
    t.apply({ type: "permission.sending", requestId: "p" });
    t.apply({ type: "permission.requested", request, sensitive: [] });
    assert.equal((t.get("perm:p") as { status: string }).status, "pending");
    t.apply({ type: "permission.resolved", requestId: "p", decision: "always" });
    assert.deepEqual(t.apply({ type: "permission.requested", request, sensitive: [] }), []);
    assert.equal((t.get("perm:p") as { status: string }).status, "always");
  });

  it("does not duplicate a user message echoed twice", () => {
    const t = new Transcript();
    t.apply({ type: "user.message", id: "u", text: "x", attachments: [] });
    assert.deepEqual(t.apply({ type: "user.message", id: "u", text: "x", attachments: [] }), []);
    assert.equal(t.items.length, 1);
  });
});

describe("tool descriptions", () => {
  it("builds compact titles without dumping edit payloads", () => {
    assert.equal(describeTool("read", { path: "app/Http/Checkout.php" }).title, "Read Checkout.php");
    assert.equal(describeTool("grep", { pattern: "TODO" }).title, "Searched TODO");
    const edit = describeTool("edit", { path: "a.ts", oldString: "secret old", newString: "new" });
    assert.equal(edit.title, "Edited a.ts");
    assert.ok(!edit.facts.some(([k]) => k === "oldString" || k === "newString"));
    const sh = describeTool("shell", { command: "git status\ngit diff" });
    assert.equal(sh.category, "shell");
    assert.equal(sh.command, "git status\ngit diff");
    assert.equal(sh.title, "git status …");
  });
});

describe("subagent tool calls", () => {
  it("records the subagent's session from the result metadata", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "c", name: "subagent" });
    t.apply({
      type: "tool.input",
      toolId: "c",
      name: null,
      input: { agent: "explore", description: "Find callers", prompt: "…" },
    });
    const pending = t.get("tool:c");
    assert.ok(pending?.kind === "tool" && pending.category === "agent" && pending.detail.subagent === null);
    t.apply({ type: "tool.completed", toolId: "c", output: "started", metadata: { sessionID: "ses_sub" } });
    const done = t.get("tool:c");
    assert.ok(done?.kind === "tool" && done.detail.subagent === "ses_sub");
  });

  it("uses the session being continued, and ignores session IDs on other tools", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "c", name: "subagent" });
    t.apply({
      type: "tool.input",
      toolId: "c",
      name: null,
      input: { sessionID: "ses_prev", prompt: "go on" },
    });
    assert.equal((t.get("tool:c") as { detail: { subagent: string } }).detail.subagent, "ses_prev");
    t.apply({ type: "tool.started", toolId: "r", name: "read" });
    t.apply({ type: "tool.completed", toolId: "r", output: "x", metadata: { sessionID: "ses_x" } });
    assert.equal((t.get("tool:r") as { detail: { subagent: string | null } }).detail.subagent, null);
  });

  it("keeps when a prompt was sent and when text started, for timestamps", () => {
    const t = new Transcript();
    t.apply({ type: "user.message", id: "u", text: "hi", attachments: [], time: 1_000 });
    assert.equal((t.get("user:u") as { time?: number }).time, 1_000);
    t.apply({ type: "assistant.delta", partId: "m:0", delta: "He", time: 2_000 });
    t.apply({ type: "assistant.delta", partId: "m:0", delta: "llo", time: 2_500 });
    t.apply({ type: "assistant.completed", partId: "m:0", text: "Hello", time: 3_000 });
    assert.deepEqual(t.get("text:m:0"), {
      kind: "assistant",
      id: "text:m:0",
      text: "Hello",
      streaming: false,
      time: 2_000,
    });
  });

  it("measures thinking from the first delta to completion", () => {
    const t = new Transcript();
    t.apply({ type: "reasoning.delta", partId: "m:0", delta: "hm", time: 10_000 });
    t.apply({ type: "reasoning.delta", partId: "m:0", delta: "m", time: 11_000 });
    assert.deepEqual(t.get("think:m:0"), {
      kind: "reasoning",
      id: "think:m:0",
      text: "hmm",
      streaming: true,
      started: 10_000,
    });
    t.apply({ type: "reasoning.completed", partId: "m:0", text: "hmm", time: 13_400 });
    const item = t.get("think:m:0") as { started?: number; ended?: number };
    assert.deepEqual([item.started, item.ended], [10_000, 13_400]);
  });

  it("stamps live events once and leaves stored times alone", () => {
    const ev = stampTime({ type: "assistant.delta", partId: "m:0", delta: "x" }, 42);
    assert.equal((ev as { time?: number }).time, 42);
    assert.equal((stampTime(ev, 99) as { time?: number }).time, 42, "an existing time wins");
    const tool = { type: "tool.started", toolId: "t", name: "read" } as const;
    assert.equal(stampTime(tool, 42), tool, "untimed event types are unchanged");
  });
});

describe("tool rows: inputs, patches and written content", () => {
  const PATCH = [
    "Index: src/a.ts",
    "===================================================================",
    "--- src/a.ts",
    "+++ src/a.ts",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old",
    "+new",
    "@@ -40,2 +40,3 @@",
    " tail",
    "+added",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  it("keeps only hunk lines, with a gap between hunks", () => {
    assert.deepEqual(diffLines(PATCH), {
      lines: [
        { t: "ctx", text: "keep" },
        { t: "del", text: "old" },
        { t: "add", text: "new" },
        { t: "gap", text: "" },
        { t: "ctx", text: "tail" },
        { t: "add", text: "added" },
      ],
      more: 0,
    });
  });

  it("caps long patches and counts what it left out", () => {
    const big = ["@@ -1,0 +1,100 @@", ...Array.from({ length: 100 }, (_, i) => `+line ${i}`)].join("\r\n");
    const d = diffLines(big);
    assert.equal(d.lines.length, MAX_DIFF_LINES);
    assert.equal(d.more, 100 - MAX_DIFF_LINES);
    assert.equal(d.lines[0].text, "line 0", "CRLF is stripped");
  });

  it("does not read a second file's headers as changed lines", () => {
    const two = PATCH + "Index: b.ts\n=====\n--- b.ts\n+++ b.ts\n@@ -1 +1 @@\n-x\n+y\n";
    const texts = diffLines(two).lines.map((l) => `${l.t}:${l.text}`);
    assert.ok(!texts.some((t) => t.includes("b.ts")), texts.join(" | "));
  });

  it("reads per-file patches from edit metadata", () => {
    const diffs = fileDiffsFromMetadata({
      files: [
        { file: "src/a.ts", patch: PATCH, additions: 2, deletions: 1, status: "modified" },
        { file: "src/no-patch.ts", additions: 1 },
      ],
    });
    assert.deepEqual(
      diffs.map((d) => [d.path, d.lines.length]),
      [["src/a.ts", 6]],
    );
  });

  it("describes what a call works on: path, pattern, description, written content", () => {
    const read = describeTool("read", { path: "/w/src/a.ts" });
    assert.equal(read.path, "/w/src/a.ts");
    const grep = describeTool("grep", { pattern: "signOut(", path: "/w/src" });
    assert.deepEqual([grep.pattern, grep.path], ["signOut(", "/w/src"]);
    assert.equal(
      describeTool("bash", { command: "ls", description: "List files" }).description,
      "List files",
    );
    assert.equal(
      describeTool("task", { description: "Map callers", prompt: "x" }).description,
      null,
      "a subagent's description is its title",
    );
    const write = describeTool("write", { path: "/w/b.ts", content: "a\nb\nc\n" });
    assert.deepEqual(write.written, { lines: ["a", "b", "c"], total: 3 });
    assert.equal(describeTool("edit", { path: "/w/b.ts", oldString: "a", newString: "b" }).written, null);
  });

  it("carries inputs and diffs into the tool item", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "e", name: "edit" });
    t.apply({
      type: "tool.input",
      toolId: "e",
      name: "edit",
      input: { path: "/w/src/a.ts", oldString: "old" },
    });
    t.apply({
      type: "tool.completed",
      toolId: "e",
      output: "Edit applied",
      metadata: { files: [{ file: "src/a.ts", patch: PATCH, additions: 2, deletions: 1 }] },
    });
    const item = t.get("tool:e");
    assert.ok(item?.kind === "tool");
    assert.equal(item.detail.path, "/w/src/a.ts");
    assert.equal(item.detail.diffs?.[0].path, "src/a.ts");
    assert.equal(item.detail.diffs?.[0].lines.length, 6);
    assert.equal(item.detail.files[0].additions, 2);
  });
});

describe("subagent rows and reports", () => {
  it("keeps a subagent's whole prompt, not the clipped fact", () => {
    const prompt = "x".repeat(1000);
    const d = describeTool("task", { description: "Map callers", prompt });
    assert.equal(d.prompt, prompt);
    assert.ok(d.facts.find(([k]) => k === "prompt")![1].length < 1000, "facts stay short");
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "a", name: "task" });
    t.apply({ type: "tool.input", toolId: "a", name: "task", input: { description: "Map callers", prompt } });
    assert.equal((t.get("tool:a") as { detail: { prompt?: string } }).detail.prompt, prompt);
  });

  it("adds a hand-back item for a subagent report", () => {
    const t = new Transcript();
    t.apply({
      type: "subagent.report",
      id: "msg_s",
      childID: "ses_c",
      agent: "General",
      state: "completed",
      description: "Run git",
      text: "git 2.53",
      time: 5,
    });
    assert.deepEqual(t.get("handback:msg_s"), {
      kind: "handback",
      id: "handback:msg_s",
      childID: "ses_c",
      agent: "General",
      state: "completed",
      description: "Run git",
      report: "git 2.53",
      time: 5,
    });
    assert.equal(
      (
        stampTime(
          {
            type: "subagent.report",
            id: "x",
            childID: null,
            agent: null,
            state: null,
            description: null,
            text: "",
          },
          9,
        ) as {
          time?: number;
        }
      ).time,
      9,
      "live reports get their arrival time",
    );
  });
});
