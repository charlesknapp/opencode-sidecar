import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SUBAGENTS, SubagentTracker } from "../src/core/subagents";
import type { SessionSummary, UiEvent } from "../src/shared/model";

const ROOT = "ses_root";

function tracker(start = 1000) {
  let now = start;
  const t = new SubagentTracker(() => now);
  return { t, tick: (ms: number) => (now += ms) };
}

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: "Explore the repo",
  created: 100,
  updated: 900,
  agent: "explore",
  modelKey: null,
  variant: null,
  outcome: null,
  cost: 0.02,
  ...over,
});

describe("subagent tracker", () => {
  it("follows subagents of the open session and their own subagents, not other sessions", () => {
    const { t } = tracker();
    assert.equal(t.created("ses_a", ROOT, ROOT, { title: "Find callers", agent: "explore" }), true);
    assert.equal(t.created("ses_b", "ses_a", ROOT, null), true);
    assert.equal(t.created("ses_x", "ses_other", ROOT, null), false);
    assert.equal(t.created("ses_a", ROOT, ROOT, null), false, "announced once");
    const views = t.views();
    assert.deepEqual(
      views.map((v) => [v.sessionID, v.parentID, v.depth, v.agent, v.title, v.status]),
      [
        ["ses_a", ROOT, 1, "explore", "Find callers", "running"],
        ["ses_b", "ses_a", 2, null, "", "running"],
      ],
    );
    assert.equal(t.inTree(ROOT, ROOT), true);
    assert.equal(t.inTree("ses_b", ROOT), true);
    assert.equal(t.inTree("ses_x", ROOT), false);
  });

  it("summarizes live progress: activity, tool and file counts, cost and timing", () => {
    const { t, tick } = tracker(1000);
    t.created("ses_a", ROOT, ROOT, { title: "Find callers", agent: "explore" });
    assert.equal(t.apply("ses_a", [{ type: "session.busy" }]), false, "already running");
    t.apply("ses_a", [{ type: "reasoning.delta", partId: "p", delta: "hm" }]);
    assert.deepEqual(t.view("ses_a")?.activity, { kind: "thinking" });
    t.apply("ses_a", [
      { type: "tool.started", toolId: "t1", name: "grep" },
      { type: "tool.input", toolId: "t1", name: null, input: { pattern: "refreshToken(" } },
    ]);
    assert.deepEqual(t.view("ses_a")?.activity, {
      kind: "tool",
      title: "Searched refreshToken(",
      category: "search",
    });
    t.apply("ses_a", [
      { type: "tool.completed", toolId: "t1", output: "x", metadata: null },
      { type: "tool.started", toolId: "t2", name: "read" },
      { type: "files.changed", files: ["a.ts", "b.ts"] },
      { type: "files.changed", files: ["a.ts"] },
      {
        type: "usage.session",
        cost: 0.04,
        tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    tick(41_000);
    t.apply("ses_a", [{ type: "session.idle", outcome: "succeeded", sessionID: "ses_a" }]);
    const v = t.view("ses_a")!;
    assert.equal(v.status, "completed");
    assert.equal(v.tools, 2);
    assert.equal(v.files, 2);
    assert.equal(v.cost, 0.04);
    assert.equal(v.started, 1000);
    assert.equal(v.ended, 42_000);
    assert.equal(v.activity, null);
  });

  it("reports only visible changes, so streamed tokens do not cause a state push each", () => {
    const { t } = tracker();
    t.created("ses_a", ROOT, ROOT, null);
    const delta: UiEvent = { type: "assistant.delta", partId: "p", delta: "a" };
    assert.equal(t.apply("ses_a", [delta]), true, "now writing");
    assert.equal(t.apply("ses_a", [delta]), false);
    assert.equal(t.apply("ses_unknown", [delta]), false);
  });

  it("is waiting while a permission or question is open, and running again once answered", () => {
    const { t } = tracker();
    t.created("ses_a", ROOT, ROOT, null);
    const request = {
      id: "per_1",
      sessionID: "ses_a",
      action: "bash",
      resources: ["npm test"],
      canAlways: false,
      message: null,
      toolId: null,
    };
    t.apply("ses_a", [{ type: "permission.requested", request, sensitive: [] }]);
    t.apply("ses_a", [
      {
        type: "form.requested",
        form: { id: "f1", sessionID: "ses_a", title: "Q", fields: [], toolId: null },
      },
    ]);
    assert.equal(t.view("ses_a")?.status, "waiting");
    t.apply("ses_a", [{ type: "permission.resolved", requestId: "per_1", decision: "once" }]);
    assert.equal(t.view("ses_a")?.status, "waiting", "the question is still open");
    t.apply("ses_a", [{ type: "form.resolved", formId: "f1", status: "answered", answer: {} }]);
    assert.equal(t.view("ses_a")?.status, "running");
  });

  it("maps failures and stops, and resumes when a finished subagent is continued", () => {
    const { t } = tracker();
    t.created("ses_a", ROOT, ROOT, null);
    t.apply("ses_a", [
      { type: "session.error", message: "Rate limited", error: null, modelKey: null },
      { type: "session.idle", outcome: "failed" },
    ]);
    assert.equal(t.view("ses_a")?.status, "failed");
    assert.equal(t.view("ses_a")?.error, "Rate limited");
    t.apply("ses_a", [{ type: "session.busy" }]);
    assert.equal(t.view("ses_a")?.status, "running");
    assert.equal(t.view("ses_a")?.ended, null);
    assert.equal(t.view("ses_a")?.error, null);
    t.apply("ses_a", [{ type: "session.idle", outcome: "interrupted" }]);
    assert.equal(t.view("ses_a")?.status, "stopped");
  });

  it("restores subagents of a reopened session from OpenCode's records", () => {
    const { t } = tracker();
    t.restore(
      [
        { summary: summary("ses_a"), parentID: ROOT },
        {
          summary: summary("ses_b", { outcome: "failed", title: "Run tests", agent: "general" }),
          parentID: "ses_a",
        },
        { summary: summary("ses_c"), parentID: ROOT },
      ],
      new Set(["ses_c"]),
    );
    const [a, b, c] = t.views();
    assert.deepEqual([a.status, a.depth, a.started, a.ended, a.cost], ["completed", 1, 100, 900, 0.02]);
    assert.deepEqual([b.status, b.depth, b.agent], ["failed", 2, "general"]);
    assert.deepEqual([c.status, c.ended], ["running", null]);
    // Counts seen before the reopen are unknown, and stay unknown rather than undercounting.
    assert.equal(c.tools, null);
    t.apply("ses_c", [{ type: "tool.started", toolId: "t9", name: "read" }]);
    assert.equal(t.view("ses_c")?.tools, null);
    assert.equal(t.view("ses_c")?.activity?.kind, "tool");
  });

  it("is bounded and can be reset", () => {
    const { t } = tracker();
    for (let i = 0; i < MAX_SUBAGENTS + 5; i++) t.created(`ses_${i}`, ROOT, ROOT, null);
    assert.equal(t.size, MAX_SUBAGENTS);
    t.reset();
    assert.equal(t.size, 0);
    assert.equal(t.has("ses_1"), false);
  });
});
