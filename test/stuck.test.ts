import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPoll, signature, StuckDetector, type StuckChange } from "../src/core/stuck";
import type { UiEvent } from "../src/shared/model";

const S = "ses_1";
let seq = 0;

/** One tool call as OpenCode's events give it: started, its input, then its result. */
function call(name: string, input: Record<string, unknown>, output = "ok", failed = false): UiEvent[] {
  const toolId = `call_${++seq}`;
  return [
    { type: "tool.started", toolId, name },
    { type: "tool.input", toolId, name: null, input },
    failed
      ? { type: "tool.failed", toolId, error: output, output: null, metadata: null }
      : { type: "tool.completed", toolId, output, metadata: null },
  ];
}

function run(calls: UiEvent[][], repeats = 3): { d: StuckDetector; changes: StuckChange[] } {
  const d = new StuckDetector(() => ({ repeats, stallMs: 180_000 }));
  const changes: StuckChange[] = [
    ...d.observe(
      S,
      [{ type: "session.busy" }, { type: "user.message", id: "m", text: "go", attachments: [] }],
      0,
    ),
  ];
  for (const c of calls) changes.push(...d.observe(S, c, 1));
  return { d, changes };
}

const read = (path: string, out = "content") => call("read", { filePath: path }, out);

describe("stuck detection: repeated calls", () => {
  it("flags the same read with the same result three times in a row, and counts on", () => {
    const { d, changes } = run([read("/w/a.ts"), read("/w/a.ts"), read("/w/a.ts"), read("/w/a.ts")]);
    assert.equal(changes.length, 2, "found at the third call, then grown");
    assert.deepEqual(changes[0].finding, {
      kind: "repeat",
      call: { tool: "read", arg: "/w/a.ts", path: true },
      count: 3,
    });
    const f = d.finding(S);
    assert.equal(f?.kind === "repeat" && f.count, 4);
  });

  it("does not flag reading different files, or the same file twice", () => {
    assert.deepEqual(run([read("/w/a.ts"), read("/w/b.ts"), read("/w/c.ts"), read("/w/d.ts")]).changes, []);
    assert.deepEqual(run([read("/w/a.ts"), read("/w/a.ts"), read("/w/b.ts")]).changes, []);
  });

  it("does not flag a file read again after it changed (another result)", () => {
    const { changes } = run([
      read("/w/a.ts", "let a;"),
      read("/w/a.ts", "let a, b;"),
      read("/w/a.ts", "let a, b, c;"),
    ]);
    assert.deepEqual(changes, []);
  });

  it("treats spacing, key order, slashes, drive-letter case and a description as the same call", () => {
    assert.equal(
      signature("Read", { filePath: "C:\\w\\a.ts", description: "first look" }),
      signature("read", { filePath: "c:/w/a.ts" }),
    );
    assert.equal(
      signature("shell", { command: "npm   test", cwd: "/w/" }),
      signature("shell", { cwd: "/w", command: " npm test " }),
    );
    assert.notEqual(
      signature("read", { filePath: "/w/a.ts", offset: 1 }),
      signature("read", { filePath: "/w/a.ts" }),
    );
    const { changes } = run([
      call("read", { filePath: "C:\\w\\a.ts" }),
      call("read", { filePath: "c:/w/a.ts", description: "again" }),
      call("read", { filePath: "C:/w/a.ts" }),
    ]);
    assert.equal(changes[0]?.finding?.kind, "repeat");
  });

  it("flags the same failing test run whose timings differ", () => {
    const test = (ms: number) =>
      call("shell", { command: "npm test" }, `1 failing\n  at a.test.ts:12\nDone in ${ms}ms`);
    const { changes } = run([test(812), test(799), test(845)]);
    assert.deepEqual(changes[0]?.finding, {
      kind: "repeat",
      call: { tool: "shell", arg: "npm test", path: false },
      count: 3,
    });
  });

  it("flags an edit that keeps failing the same way", () => {
    const edit = () =>
      call("edit", { filePath: "/w/a.ts", oldString: "x", newString: "y" }, "oldString not found", true);
    assert.equal(run([edit(), edit(), edit()]).changes[0]?.finding?.kind, "repeat");
  });

  it("does not flag polling a background job or waiting", () => {
    const status = () => call("shell", { command: "sleep 30 && cat build.log | tail -5" }, "building…");
    assert.deepEqual(run([status(), status(), status(), status(), status()]).changes, []);
    const job = () => call("shell_status", { id: "sh_1" }, "running");
    assert.deepEqual(run([job(), job(), job(), job()]).changes, []);
    const ps = () => call("shell", { command: "Get-Job | Receive-Job" }, "");
    assert.deepEqual(run([ps(), ps(), ps()]).changes, []);
    assert.ok(isPoll("bash_output", null));
    assert.ok(!isPoll("read", { filePath: "/w/status.ts" }));
    assert.ok(!isPoll("shell", { command: "npm test" }));
  });

  it("does not flag the same call when something else happens between", () => {
    const { changes } = run([
      read("/w/a.ts"),
      call("edit", { filePath: "/w/a.ts", oldString: "1", newString: "2" }),
      read("/w/a.ts"),
      call("shell", { command: "npm test" }),
      read("/w/a.ts"),
    ]);
    assert.deepEqual(changes, []);
  });

  it("starts over when the user sends a message or a steer reaches the agent", () => {
    const d = new StuckDetector(() => ({ repeats: 3, stallMs: 0 }));
    d.observe(S, [...read("/w/a.ts"), ...read("/w/a.ts")], 0);
    d.observe(S, [{ type: "inbox.delivered", id: "steer_1" }], 1);
    assert.deepEqual(d.observe(S, read("/w/a.ts"), 2), []);
    const found = d.observe(S, [...read("/w/a.ts"), ...read("/w/a.ts")], 3);
    assert.equal(found[0]?.finding?.kind, "repeat");
    const over = d.observe(S, [{ type: "user.message", id: "m2", text: "stop that", attachments: [] }], 4);
    assert.deepEqual(over, [{ sessionID: S, finding: null }]);
  });

  it("clears once the agent does something else", () => {
    const { changes } = run([read("/w/a.ts"), read("/w/a.ts"), read("/w/a.ts"), read("/w/b.ts")]);
    assert.equal(changes.length, 2);
    assert.equal(changes[1].finding, null);
  });

  it("keeps a dismissed loop quiet while it grows, and speaks again for a new one", () => {
    const d = new StuckDetector(() => ({ repeats: 3, stallMs: 0 }));
    d.observe(S, [...read("/w/a.ts"), ...read("/w/a.ts"), ...read("/w/a.ts")], 0);
    d.dismiss(S);
    assert.equal(d.finding(S), null);
    assert.deepEqual(d.observe(S, [...read("/w/a.ts"), ...read("/w/a.ts")], 1), []);
    assert.deepEqual(
      d.observe(S, read("/w/b.ts"), 2),
      [],
      "the loop broke: nothing showed, nothing to clear",
    );
    const again = d.observe(S, [...read("/w/b.ts"), ...read("/w/b.ts")], 3);
    assert.equal(again[0]?.finding?.kind === "repeat" && again[0].finding.call.arg, "/w/b.ts");
  });

  it("is off below two repeats", () => {
    assert.deepEqual(run([read("/w/a.ts"), read("/w/a.ts"), read("/w/a.ts")], 0).changes, []);
  });
});

describe("stuck detection: two calls taking turns", () => {
  it("flags A B A B A B with the same results", () => {
    const a = () => read("/w/a.ts");
    const b = () => call("grep", { pattern: "TODO" }, "a.ts:3");
    const { changes } = run([a(), b(), a(), b(), a(), b()]);
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].finding, {
      kind: "alternate",
      call: { tool: "read", arg: "/w/a.ts", path: true },
      other: { tool: "grep", arg: "TODO", path: false },
      count: 3,
    });
  });

  it("does not flag an edit-and-test cycle that makes progress", () => {
    let n = 0;
    const edit = () => call("edit", { filePath: "/w/a.ts", oldString: `${n}`, newString: `${++n}` });
    const test = () => call("shell", { command: "npm test" }, `${5 - n} failing`);
    // The counts only change numbers, so the edits (different input) keep it apart.
    assert.deepEqual(run([edit(), test(), edit(), test(), edit(), test()]).changes, []);
  });

  it("does not flag two turns, or a poll taking turns with a read", () => {
    const a = () => read("/w/a.ts");
    const b = () => read("/w/b.ts");
    assert.deepEqual(run([a(), b(), a(), b()]).changes, []);
    const wait = () => call("shell", { command: "sleep 10" }, "");
    assert.deepEqual(run([a(), wait(), a(), wait(), a(), wait()]).changes, []);
  });
});

describe("stuck detection: no progress", () => {
  const settings = () => ({ repeats: 3, stallMs: 180_000 });

  it("flags a busy run that sends nothing for the stall time, once, and clears on the next event", () => {
    const d = new StuckDetector(settings);
    d.observe(S, [{ type: "session.busy" }], 0);
    assert.deepEqual(d.stalls(179_999), []);
    assert.deepEqual(d.stalls(180_000), [{ sessionID: S, finding: { kind: "stall", idleMs: 180_000 } }]);
    assert.deepEqual(d.stalls(400_000), [], "reported once");
    assert.deepEqual(d.observe(S, [{ type: "assistant.delta", partId: "p", delta: "x" }], 400_001), [
      { sessionID: S, finding: null },
    ]);
  });

  it("never flags an idle session, a running shell command, or a request waiting for the user", () => {
    const idle = new StuckDetector(settings);
    idle.observe(S, [{ type: "session.busy" }, { type: "session.idle", outcome: "succeeded" }], 0);
    assert.deepEqual(idle.stalls(1e9), []);

    const shell = new StuckDetector(settings);
    shell.observe(S, [{ type: "session.busy" }, { type: "tool.started", toolId: "t", name: "shell" }], 0);
    assert.deepEqual(shell.stalls(1e9), [], "a build can take minutes without output");
    shell.observe(S, [{ type: "tool.completed", toolId: "t", output: "done", metadata: null }], 10);
    assert.equal(shell.stalls(1e9).length, 1);

    const perm = new StuckDetector(settings);
    perm.observe(
      S,
      [
        { type: "session.busy" },
        {
          type: "permission.requested",
          request: { id: "per_1", sessionID: S, action: "edit", resources: [], save: [], metadata: null },
          sensitive: [],
        } as unknown as UiEvent,
      ],
      0,
    );
    assert.deepEqual(perm.stalls(1e9), []);
    perm.observe(S, [{ type: "permission.resolved", requestId: "per_1", decision: "once" }], 5);
    assert.equal(perm.stalls(1e9).length, 1);

    const elsewhere = new StuckDetector(settings);
    elsewhere.observe(S, [{ type: "session.busy" }], 0);
    assert.deepEqual(
      elsewhere.stalls(1e9, () => true),
      [],
      "a subagent's request is waiting",
    );
  });

  it("counts a subagent's activity as progress, and is off at 0", () => {
    const d = new StuckDetector(settings);
    d.observe(S, [{ type: "session.busy" }], 0);
    d.touch(S, 170_000);
    assert.deepEqual(d.stalls(200_000), []);
    const off = new StuckDetector(() => ({ repeats: 3, stallMs: 0 }));
    off.observe(S, [{ type: "session.busy" }], 0);
    assert.deepEqual(off.stalls(1e9), []);
  });

  it("stays quiet after a dismiss until something happens", () => {
    const d = new StuckDetector(settings);
    d.observe(S, [{ type: "session.busy" }], 0);
    assert.equal(d.stalls(200_000).length, 1);
    d.dismiss(S);
    assert.deepEqual(d.stalls(900_000), []);
    d.observe(S, [{ type: "reasoning.delta", partId: "r", delta: "hm" }], 900_001);
    assert.equal(d.stalls(900_001 + 180_000).length, 1);
  });
});
