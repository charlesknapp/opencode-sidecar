import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubagentTracker } from "../src/core/subagents";
import { addCost, contextBreakdown, CostLedger, costBreakdown, rollupCosts } from "../src/core/usage";
import { parseUsageLimits, parseUsageStats } from "../src/opencode/client";
import type { SubagentView, TokenUsage } from "../src/shared/model";
import { formatRate, stepRate, ThroughputMeter } from "../src/shared/throughput";
import { Transcript } from "../src/shared/transcript";

const tok = (output: number, reasoning = 0): TokenUsage => ({
  input: 100,
  output,
  reasoning,
  cacheRead: 0,
  cacheWrite: 0,
});

function sub(id: string, parentID: string, depth: number, cost: number | null): SubagentView {
  return {
    sessionID: id,
    parentID,
    depth,
    agent: "explore",
    title: id,
    status: "completed",
    activity: null,
    tools: 1,
    files: 0,
    started: 1,
    ended: 2,
    cost,
    error: null,
  };
}

describe("cost aggregation", () => {
  it("adds unknown costs as unknown, and a free model's 0 as a real 0", () => {
    assert.equal(addCost(null, null), null);
    assert.equal(addCost(null, 0), 0);
    assert.equal(addCost(0.01, null), 0.01);
    assert.ok(Math.abs((addCost(0.1, 0.2) ?? 0) - 0.3) < 1e-12);
  });

  it("adds steps up by model and by agent", () => {
    const l = new CostLedger();
    l.add({ modelKey: "a/x", agent: "build", cost: 0.01, tokens: tok(10, 5) });
    l.add({ modelKey: "a/x", agent: "plan", cost: 0.02, tokens: tok(20) });
    l.add({ modelKey: "b/free", agent: "build", cost: 0, tokens: tok(7) });
    l.add({ modelKey: "c/unknown", agent: "build", cost: null, tokens: tok(3) });
    assert.deepEqual(l.byModel().get("a/x"), { steps: 2, tokens: 35, cost: 0.03 });
    assert.deepEqual(l.byModel().get("b/free"), { steps: 1, tokens: 7, cost: 0 });
    assert.deepEqual(l.byModel().get("c/unknown"), { steps: 1, tokens: 3, cost: null });
    assert.equal(l.byAgent().get("build")?.steps, 3);
    assert.ok(Math.abs((l.cost ?? 0) - 0.03) < 1e-12);
    l.reset();
    assert.equal(l.empty, true);
    assert.equal(l.cost, null);
  });

  it("rolls subagent costs up into the subagents that started them", () => {
    const views = [
      sub("s1", "root", 1, 0.1),
      sub("s1a", "s1", 2, 0.02),
      sub("s1a1", "s1a", 3, 0.003),
      sub("s1b", "s1", 2, null),
      sub("s2", "root", 1, 0.5),
    ];
    const totals = rollupCosts(views);
    assert.ok(Math.abs((totals.get("s1") ?? 0) - 0.123) < 1e-12, "own + children + grandchildren");
    assert.ok(Math.abs((totals.get("s1a") ?? 0) - 0.023) < 1e-12);
    assert.equal(totals.has("s1a1"), false, "a leaf has no separate total");
    assert.equal(totals.has("s2"), false);
    // Unknown costs throughout stay unknown.
    const unknown = rollupCosts([sub("p", "root", 1, null), sub("c", "p", 2, null)]);
    assert.equal(unknown.get("p"), null);
  });

  it("builds the tables: models across the tree, agents with subagents nested, the session's extra cost", () => {
    const own = new CostLedger();
    own.add({ modelKey: "a/x", agent: "build", cost: 0.04, tokens: tok(40) });
    own.add({ modelKey: "a/x", agent: "build", cost: 0.04, tokens: tok(40) });
    const childLedger = new CostLedger();
    childLedger.add({ modelKey: "b/y", agent: "explore", cost: 0.01, tokens: tok(9) });
    const grand = sub("g", "c", 2, 0.005);
    const child = sub("c", "root", 1, 0.01);
    const restored = sub("r", "root", 1, 0.2);
    const b = costBreakdown(own, 0.1, [
      { view: child, ledger: childLedger, modelKey: "b/y" },
      { view: grand, ledger: new CostLedger(), modelKey: "a/x" },
      { view: restored, ledger: new CostLedger(), modelKey: "c/z" },
    ]);
    assert.ok(b);
    // a/x: 0.08 own + the restored grandchild's 0.005 under the model its record names.
    assert.deepEqual(
      b.byModel.map((r) => [r.key, r.steps, Number(r.cost?.toFixed(3))]),
      [
        ["c/z", null, 0.2],
        ["a/x", 2, 0.085],
        ["b/y", 1, 0.01],
      ],
    );
    assert.deepEqual(
      b.byAgent.map((r) => [r.key, r.depth ?? 0, r.cost, r.total]),
      [
        ["build", 0, 0.08, undefined],
        ["c", 1, 0.01, 0.015],
        ["g", 2, 0.005, undefined],
        ["r", 1, 0.2, undefined],
      ],
    );
    assert.ok(Math.abs((b.other ?? 0) - 0.02) < 1e-9, "titles and compaction: session cost no step explains");
    assert.ok(Math.abs((b.total ?? 0) - 0.315) < 1e-9, "session + every subagent once");
  });

  it("free and unreported costs: 0 stays 0, nothing reported stays null", () => {
    const free = new CostLedger();
    free.add({ modelKey: "opencode/big-pickle", agent: "build", cost: 0, tokens: tok(5) });
    const b = costBreakdown(free, 0, []);
    assert.equal(b?.byModel[0].cost, 0);
    assert.equal(b?.total, 0);
    assert.equal(b?.other, null);
    const none = new CostLedger();
    none.add({ modelKey: "local/llama", agent: "build", tokens: tok(5) });
    const n = costBreakdown(none, null, []);
    assert.equal(n?.byModel[0].cost, null);
    assert.equal(n?.session, null);
    assert.equal(n?.total, null);
    assert.equal(costBreakdown(new CostLedger(), null, []), null, "an empty session has no tables");
  });
});

describe("context breakdown", () => {
  const messages = [
    { type: "user", text: "x".repeat(400), files: [{ mime: "text/plain", data: btoa("y".repeat(800)) }] },
    { type: "user", text: "", files: [{ mime: "image/png", data: "AAAA" }] },
    { type: "system", text: "z".repeat(40) },
    {
      type: "assistant",
      content: [
        { type: "reasoning", text: "r".repeat(200) },
        { type: "text", text: "t".repeat(200) },
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "a.ts" },
            content: [{ type: "text", text: "c".repeat(396) }],
          },
        },
      ],
    },
    { type: "compaction", status: "completed", summary: "s".repeat(80) },
    { type: "idle" },
  ];

  it("estimates the parts it can see and leaves the rest as one figure", () => {
    const b = contextBreakdown(messages, 2000, 100_000);
    const parts = Object.fromEntries(b.parts.map((p) => [p.key, p.tokens]));
    assert.equal(parts.prompts, 100);
    assert.equal(parts.files, 200, "800 bytes of text at about 4 a token");
    assert.equal(parts.instructions, 10);
    assert.equal(parts.replies, 100);
    assert.equal(parts.tools, Math.round((4 + JSON.stringify({ path: "a.ts" }).length + 396) / 4));
    assert.equal(parts.summary, 20);
    const seen = b.parts.filter((p) => p.key !== "rest").reduce((n, p) => n + p.tokens, 0);
    assert.equal(parts.rest, 2000 - seen);
    assert.equal(b.images, 1);
    assert.equal(b.messages, 6);
  });

  it("shows no remainder without a total, nor a negative one", () => {
    assert.equal(
      contextBreakdown(messages, null, null).parts.some((p) => p.key === "rest"),
      false,
    );
    assert.equal(
      contextBreakdown(messages, 50, 100).parts.some((p) => p.key === "rest"),
      false,
    );
    assert.deepEqual(contextBreakdown([], 3000, null).parts, [{ key: "rest", tokens: 3000 }]);
    assert.deepEqual(contextBreakdown(["junk", null, 3], null, null).parts, []);
  });
});

describe("throughput", () => {
  it("rates a finished step from its stream time", () => {
    assert.equal(stepRate(tok(80, 20), 2000), 50);
    assert.equal(stepRate(tok(80), undefined), null);
    assert.equal(stepRate(tok(0), 1000), null);
    assert.equal(stepRate(tok(5), 0), null);
    assert.equal(formatRate(38.4), "38 tok/s");
    assert.equal(formatRate(1530), "1.5k tok/s");
  });

  it("estimates a streaming reply from its text, and goes quiet between replies", () => {
    const m = new ThroughputMeter(2000);
    assert.equal(m.rate(0), null);
    m.add("a".repeat(40), 1000);
    assert.equal(m.rate(1000), null, "nothing to measure from one chunk");
    m.add("a".repeat(360), 2000);
    // 360 characters (about 90 tokens) arrived in the 1 s after the first chunk.
    assert.equal(m.rate(2000), 90);
    assert.equal(m.rate(4500), null, "no text for 2 s: a tool runs");
    m.add("b".repeat(400), 5000);
    m.add("b".repeat(400), 7000);
    assert.equal(m.rate(7000), 50, "a new measurement after the pause");
    m.reset();
    assert.equal(m.rate(7000), null);
    m.add("", 8000);
    assert.equal(m.rate(8000), null);
  });

  it("puts a footer under each turn: models, steps, tokens, speed and cost", () => {
    const t = new Transcript();
    t.apply({ type: "user.message", id: "u1", text: "go", attachments: [] });
    t.apply({ type: "usage.step", tokens: tok(80, 20), modelKey: "a/x", cost: 0.01, streamMs: 2000 });
    t.apply({ type: "usage.step", tokens: tok(50), modelKey: "b/y", cost: null });
    t.apply({ type: "usage.step", tokens: tok(30), modelKey: "a/x", cost: 0.02, streamMs: 1000 });
    t.apply({ type: "session.idle", outcome: "succeeded" });
    const meta = t.items.find((i) => i.kind === "turn-meta");
    assert.ok(meta?.kind === "turn-meta");
    assert.deepEqual(meta.models, ["a/x", "b/y"]);
    assert.equal(meta.steps, 3);
    assert.equal(meta.tokens, 180);
    assert.equal(meta.rate, 130 / 3, "only timed steps count toward the speed");
    assert.ok(Math.abs((meta.cost ?? 0) - 0.03) < 1e-12);
    // A subagent's report wakes the session in the same turn: the one footer grows.
    t.apply({ type: "usage.step", tokens: tok(20), modelKey: "c/z", cost: 0.01 });
    t.apply({ type: "session.idle", outcome: "succeeded" });
    const metas = t.items.filter((i) => i.kind === "turn-meta");
    assert.equal(metas.length, 1);
    assert.ok(metas[0].kind === "turn-meta" && metas[0].steps === 4);
    assert.deepEqual(meta.models, ["a/x", "b/y"], "the earlier item was not changed in place");
    // A turn with no steps (a !command) has no footer; a new turn starts from zero.
    t.apply({ type: "user.message", id: "u2", text: "again", attachments: [] });
    t.apply({ type: "session.idle", outcome: "succeeded" });
    assert.equal(t.items.filter((i) => i.kind === "turn-meta").length, 1);
    t.apply({ type: "user.message", id: "u3", text: "free", attachments: [] });
    t.apply({ type: "usage.step", tokens: tok(10), modelKey: "opencode/big-pickle", cost: 0 });
    t.apply({ type: "session.idle", outcome: "interrupted" });
    const free = t.items.filter((i) => i.kind === "turn-meta").pop();
    assert.ok(free?.kind === "turn-meta");
    assert.equal(free.cost, 0);
    assert.equal(free.rate, null);
  });
});

describe("usage limits", () => {
  it("is null when OpenCode is not signed in to an OpenCode workspace", () => {
    assert.equal(parseUsageLimits(null), null);
    assert.equal(parseUsageLimits(undefined), null);
    assert.equal(parseUsageLimits("nope"), null);
  });

  it("reads the OpenCode Go windows and Console budgets", () => {
    const q = parseUsageLimits({
      workspace: { id: "wrk_1", name: "Acme", usageURL: "https://opencode.ai/x" },
      go: {
        rolling: { percent: 85.4, limited: false, resetsAt: 1_800_000_000_000 },
        weekly: { percent: 30, limited: false, resetsAt: 1_800_100_000_000 },
        monthly: { percent: 100, limited: true, resetsAt: 1_800_200_000_000 },
      },
      budgets: [
        {
          id: "b1",
          limit: 10,
          spent: 3.2,
          scope: "combined",
          per: "set",
          coverage: "all",
          models: [],
          vendors: [],
          picked: false,
          shared: true,
          resetsAt: 1_800_300_000_000,
        },
        {
          id: "b2",
          limit: 5,
          spent: 6,
          scope: "each",
          per: "model",
          coverage: "models",
          models: [{ providerID: "opencode", modelID: "k", name: "Kimi" }],
          vendors: [],
          picked: true,
          shared: false,
          resetsAt: 1_800_400_000_000,
        },
      ],
    });
    assert.ok(q);
    assert.equal(q.workspace, "Acme");
    assert.deepEqual(
      q.meters.map((m) => [m.id, m.label, Math.round(m.percent), m.used, m.limited]),
      [
        ["go:rolling", "Go · rolling", 85, null, false],
        ["go:weekly", "Go · weekly", 30, null, false],
        ["go:monthly", "Go · monthly", 100, null, true],
        ["budget:b1", "Budget · all models", 32, "$3.20 / $10.00", false],
        ["budget:b2", "Budget · Kimi (you)", 100, "$6.00 / $5.00", true],
      ],
    );
    assert.equal(q.meters[0].resetsAt, 1_800_000_000_000);
  });

  it("a workspace without Go, a budget without a limit, and odd values", () => {
    const q = parseUsageLimits({
      workspace: { id: "wrk_2", usageURL: "u" },
      budgets: [
        { id: "zero", limit: 0, spent: 1 },
        { id: "weird", limit: "10", spent: 1 },
      ],
      go: { rolling: { percent: 140, limited: false }, weekly: {}, monthly: null },
    });
    assert.ok(q);
    assert.equal(q.workspace, null);
    assert.deepEqual(
      q.meters.map((m) => [m.id, m.percent, m.resetsAt]),
      [["go:rolling", 100, null]],
    );
    assert.deepEqual(parseUsageLimits({ workspace: { id: "w", usageURL: "u" }, budgets: [] })?.meters, []);
  });

  it("reads today's usage stats, variants of a model merged", () => {
    const s = parseUsageStats({
      sessions: 3,
      steps: 12,
      cost: 0.42,
      tokens: { input: 900, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
      models: [
        { model: { providerID: "opencode", id: "h", variant: "default" }, steps: 3, cost: 0.1 },
        { model: { providerID: "opencode", id: "h", variant: "none" }, steps: 1, cost: 0.02 },
        { model: { providerID: "opencode", id: "k" }, steps: 8, cost: 0.3 },
        { model: null, steps: 1, cost: 1 },
      ],
    });
    assert.equal(s.tokens, 120);
    assert.deepEqual(
      s.models.map((m) => [m.modelKey, m.steps, Number(m.cost.toFixed(2))]),
      [
        ["opencode/h", 4, 0.12],
        ["opencode/k", 8, 0.3],
      ],
    );
    assert.deepEqual(parseUsageStats(null), { sessions: 0, steps: 0, cost: 0, tokens: 0, models: [] });
  });
});

describe("subagent cost rollup on the rows", () => {
  it("gives a subagent with subagents its total, and counts their steps by model", () => {
    const t = new SubagentTracker(() => 1);
    t.created("s1", "root", "root", { title: "Parent", agent: "general" });
    t.created("s2", "s1", "root", { title: "Child", agent: "explore" });
    t.apply("s1", [{ type: "usage.session", cost: 0.02, tokens: tok(1) }]);
    t.apply("s2", [
      { type: "usage.step", tokens: tok(9), modelKey: "a/mini", cost: 0.03 },
      { type: "usage.session", cost: 0.03, tokens: tok(9) },
    ]);
    const [parent, child] = t.views();
    assert.ok(Math.abs((parent.totalCost ?? 0) - 0.05) < 1e-12);
    assert.equal("totalCost" in child, false, "a leaf shows its own cost only");
    const costs = t.costs();
    assert.deepEqual(costs[1].ledger.byModel().get("a/mini"), { steps: 1, tokens: 9, cost: 0.03 });
    assert.equal(costs[1].modelKey, "a/mini");
  });
});
