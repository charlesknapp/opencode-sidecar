// Renders screenshots from the real webview bundle (dist/webview.js) with generic
// demo data and VS Code "Dark Modern" colors.
// Math.random is pinned to 0 and animations are stopped, so every run gives the same images
// (the Working line always reads "Riding along…").
//   npm run build && node scripts/screenshots.mjs          README set -> docs/marketplace/screenshots
//   node scripts/screenshots.mjs --all --out=<folder>       every scene, for review
//   node scripts/screenshots.mjs 8-timeline --out=<folder>  chosen scenes
//   ... --scroll-up=<px>                                     scrolled up from the end, to review the box over the chat
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let out = path.join(root, "docs", "marketplace", "screenshots");
const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));
const DARK = {
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-sideBar-background": "#181818",
  "--vscode-font-family": "-apple-system, 'Segoe UI', sans-serif",
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": "Menlo, Consolas, monospace",
  "--vscode-widget-border": "#313131",
  "--vscode-input-background": "#313131",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-button-background": "#0078d4",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#026ec1",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-dropdown-background": "#313131",
  "--vscode-dropdown-foreground": "#cccccc",
  "--vscode-dropdown-border": "#3c3c3c",
  "--vscode-badge-background": "#616161",
  "--vscode-badge-foreground": "#f8f8f8",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-textCodeBlock-background": "#2b2b2b",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-errorForeground": "#f85149",
  "--vscode-inputValidation-warningBackground": "#352a05",
  "--vscode-inputValidation-warningBorder": "#b89500",
  "--vscode-inputValidation-errorBackground": "#5a1d1d",
  "--vscode-inputValidation-errorBorder": "#be1100",
  "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
  "--vscode-gitDecoration-deletedResourceForeground": "#c74e39",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-list-inactiveSelectionBackground": "#37373d",
  "--vscode-editorWidget-background": "#202020",
  "--vscode-testing-iconPassed": "#73c991",
  "--vscode-progressBar-background": "#0078d4",
  "--vscode-toolbar-hoverBackground": "#5a5d5e50",
  "--vscode-terminal-background": "#181818",
  "--vscode-editor-background": "#1f1f1f",
  "--vscode-diffEditor-insertedLineBackground": "#9bb95533",
  "--vscode-diffEditor-removedLineBackground": "#ff000033",
  "--vscode-diffEditor-insertedTextBackground": "#9ccc2c33",
  "--vscode-diffEditor-removedTextBackground": "#ff000033",
  // Syntax colors (Dark Modern's values for the variables media/main.css uses).
  "--vscode-debugTokenExpression-boolean": "#4e94ce",
  "--vscode-debugTokenExpression-string": "#ce9178",
  "--vscode-debugTokenExpression-number": "#b5cea8",
  "--vscode-charts-yellow": "#cca700",
  "--vscode-terminal-ansiCyan": "#11a8cd",
  "--vscode-symbolIcon-variableForeground": "#75beff",
};
const css = Object.entries(DARK)
  .map(([k, v]) => `${k}:${v}`)
  .join(";");
const D = (o = {}) => ({
  facts: [],
  command: null,
  cwd: null,
  output: null,
  outputTruncated: false,
  exitCode: null,
  files: [],
  error: null,
  subagent: null,
  ...o,
});
const models = [
  {
    key: "opencode-go/kimi-k2.7-code",
    providerID: "opencode-go",
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    providerName: "OpenCode Go",
    contextLimit: 262144,
    variants: [],
  },
  {
    key: "opencode-go/qwen3.7-plus",
    providerID: "opencode-go",
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    providerName: "OpenCode Go",
    contextLimit: 262144,
    variants: ["none", "high", "max"],
  },
];
const base = (o = {}) => ({
  connection: { kind: "connected", version: "2.x", url: "http://127.0.0.1" },
  workspace: {
    active: { name: "acme-shop", path: "/projects/acme-shop" },
    folders: [{ name: "acme-shop", path: "/projects/acme-shop" }],
    branch: "feature/checkout-totals",
    detachedAt: null,
    repoKind: "local",
    repoRoot: "/projects/acme-shop",
    mainWorktree: null,
    uncommitted: 3,
  },
  models,
  agents: [
    {
      id: "build",
      name: "Build",
      description: "The default agent. Executes tools based on configured permissions.",
    },
    {
      id: "plan",
      name: "Plan",
      description: "Read-only agent for exploring the codebase and planning work.",
    },
  ],
  selectedModel: "opencode-go/qwen3.7-plus",
  selectedAgent: "build",
  selectedVariant: "high",
  sessions: [],
  currentSession: { id: "s", title: "Fix checkout total rounding" },
  busy: false,
  stopping: false,
  attachments: [],
  agentChanges: { status: "none" },
  workspaceChanges: { count: 3 },
  usage: {
    contextTokens: 42100,
    contextLimit: 262144,
    cost: 0.08,
    cacheHit: 0.82,
    lastStepAt: Date.now() - 2 * 60_000,
  },
  steps: 14,
  budget: {
    level: "medium",
    limits: { maxCost: 0.3, maxSteps: 50 },
    taskCost: 0.03,
    taskSteps: 5,
    active: false,
    state: "ok",
    allowance: 1,
  },
  budgetPresets: {
    small: { maxCost: 0.1, maxSteps: 20 },
    medium: { maxCost: 0.3, maxSteps: 50 },
    large: { maxCost: 1, maxSteps: 120 },
    custom: { maxCost: 0.5, maxSteps: 80 },
  },
  pending: [],
  locale: "en",
  showPlacementHint: false,
  subagents: [],
  viewingSubagent: null,
  prefs: { stickyPrompt: true, cacheWarmMinutes: 5, activity: "detailed" },
  commands: [
    { name: "changelog", description: "Draft release notes from the commits" },
    { name: "test-plan", description: "Write a test plan for the open file" },
    { name: "triage", description: "Sort the open issues by area" },
  ],
  bookmarks: [],
  mentionAgents: [
    { id: "explore", name: "Explore", description: "Fast agent specialized for exploring codebases." },
    { id: "general", name: "General", description: "Researches questions and runs multi-step tasks." },
  ],
  skills: [],
  revert: null,
  archivedSessions: null,
  onboarding: {
    stage: "ready",
    checklist: { installed: "done", connected: "done", account: "done", models: "done" },
    hint: null,
    signIn: "idle",
  },
  task: {
    id: "t",
    label: "current",
    summary: "Fix checkout total rounding and add a regression test",
    status: "running",
    steer: null,
    next: null,
    chars: 120,
    lines: 3,
  },
  ...o,
});
const report =
  "## Checkout totals\n\nThe rounding error comes from summing **rounded** line totals.\n\n| Step | Change |\n|:--|:--|\n| 1 | Sum raw prices |\n| 2 | Round once at the end |\n\n```ts\nconst total = round(lines.reduce((s, l) => s + l.price * l.qty, 0));\n```";
const scenes = {
  "1-chat": {
    state: base({ attachments: [{ id: "a", label: "cart.ts:40-58", detail: "src/cart.ts lines 40-58" }] }),
    items: [
      {
        kind: "user",
        id: "u1",
        text: "Why is the checkout total sometimes off by a cent?",
        attachments: ["cart.ts:40-58"],
      },
      {
        kind: "tool",
        id: "t1",
        name: "read",
        title: "Read cart.ts",
        category: "read",
        status: "completed",
        detail: D(),
      },
      {
        kind: "tool",
        id: "t2",
        name: "shell",
        title: "npm test -- cart",
        category: "shell",
        status: "completed",
        detail: D({ command: "npm test -- cart", exitCode: 0 }),
      },
      { kind: "assistant", id: "a1", text: report, streaming: false },
    ],
  },
  "2-budget": {
    state: base({
      budget: {
        level: "small",
        limits: { maxCost: 0.1, maxSteps: 20 },
        taskCost: 0.06,
        taskSteps: 20,
        active: false,
        state: "exceeded",
        allowance: 1,
      },
      steps: 20,
      task: {
        id: "t2",
        label: "last",
        summary: "Refactor every module to the new logger",
        status: "budget-stopped",
        steer: null,
        next: null,
        chars: 40,
        lines: 1,
      },
    }),
    items: [
      { kind: "user", id: "u1", text: "Refactor every module to the new logger.", attachments: [] },
      {
        kind: "tool",
        id: "t1",
        name: "edit",
        title: "Edited logger.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "src/logger.ts", additions: 18, deletions: 6, status: "modified" }] }),
      },
      {
        kind: "budget",
        id: "b1",
        state: "warning",
        text: "Task budget is nearly exhausted.",
        resolved: null,
      },
      {
        kind: "tool",
        id: "t2",
        name: "edit",
        title: "Edited orders.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "src/orders.ts", additions: 9, deletions: 4, status: "modified" }] }),
      },
      { kind: "notice", id: "n1", level: "info", text: "Stopped." },
      {
        kind: "budget",
        id: "b2",
        state: "stopped",
        text: "Task budget reached. The agent was stopped.",
        resolved: null,
      },
    ],
  },
  "3-agent-changes": {
    state: base({
      agentChanges: {
        status: "ok",
        files: [
          { path: "src/cart.ts", additions: 6, deletions: 3, status: "modified" },
          { path: "test/cart.test.ts", additions: 24, deletions: 0, status: "added" },
        ],
      },
    }),
    items: [
      { kind: "user", id: "u1", text: "Fix the rounding and add a regression test.", attachments: [] },
      {
        kind: "tool",
        id: "t1",
        name: "edit",
        title: "Edited cart.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "src/cart.ts", additions: 6, deletions: 3, status: "modified" }] }),
      },
      {
        kind: "tool",
        id: "t2",
        name: "write",
        title: "Edited cart.test.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "test/cart.test.ts", additions: 24, deletions: 0, status: "added" }] }),
      },
      {
        kind: "tool",
        id: "t3",
        name: "shell",
        title: "npm test -- cart",
        category: "shell",
        status: "completed",
        detail: D({ command: "npm test -- cart", exitCode: 0 }),
      },
      {
        kind: "turn-summary",
        id: "s1",
        files: [
          { path: "src/cart.ts", additions: 6, deletions: 3, status: "modified" },
          { path: "test/cart.test.ts", additions: 24, deletions: 0, status: "added" },
        ],
      },
      {
        kind: "assistant",
        id: "a1",
        text: "Done. Totals are now rounded once, and `cart.test.ts` covers the case.",
        streaming: false,
      },
    ],
    open: true,
  },
  "4-question-steer": {
    state: base({
      busy: true,
      budget: {
        level: "medium",
        limits: { maxCost: 0.3, maxSteps: 50 },
        taskCost: 0.02,
        taskSteps: 4,
        active: true,
        state: "ok",
        allowance: 1,
      },
      pending: [
        { id: "q", text: "After that, run only the cart tests.", attachments: [], delivery: "queue" },
      ],
      task: {
        id: "t4",
        label: "current",
        summary: "Add a currency formatter for the receipt",
        status: "waiting",
        steer: "Keep the existing receipt layout.",
        next: { summary: "After that, run only the cart tests.", more: 0 },
        chars: 41,
        lines: 1,
      },
    }),
    items: [
      { kind: "user", id: "u1", text: "Add a currency formatter for the receipt.", attachments: [] },
      {
        kind: "form",
        id: "form:f1",
        status: "pending",
        answer: null,
        form: {
          id: "f1",
          sessionID: "s",
          title: "Questions",
          toolId: null,
          fields: [
            {
              key: "q0",
              type: "string",
              title: "Currency display",
              description: "How should prices appear on the receipt?",
              options: [
                { value: "symbol", label: "Symbol ($12.50)" },
                { value: "code", label: "ISO code (USD 12.50)" },
              ],
              custom: true,
            },
          ],
        },
      },
    ],
  },
};
// First run: OpenCode is connected but has no account and no models yet.
scenes["5-onboarding"] = {
  state: base({
    models: [],
    selectedModel: null,
    selectedVariant: null,
    currentSession: null,
    usage: null,
    steps: 0,
    task: null,
    workspace: { ...base().workspace, branch: "main", uncommitted: 0 },
    workspaceChanges: null,
    budget: { ...base().budget, taskCost: null, taskSteps: 0 },
    onboarding: {
      stage: "sign-in",
      checklist: { installed: "done", connected: "done", account: "todo", models: "todo" },
      hint: null,
      signIn: "idle",
    },
  }),
  items: [],
};
// Subagents: live cards in the chat, the task bar list, and a request raised by a subagent.
const now = Date.now();
const sub = (o) => ({
  parentID: "s",
  depth: 1,
  agent: "explore",
  status: "running",
  activity: null,
  tools: 0,
  files: 0,
  started: now - 41_000,
  ended: null,
  cost: 0.02,
  error: null,
  ...o,
});
const subagents = [
  sub({
    sessionID: "sub-1",
    title: "Find every caller of refreshToken",
    activity: { kind: "tool", title: "Searched refreshToken(", category: "search" },
    tools: 12,
  }),
  sub({
    sessionID: "sub-2",
    agent: "general",
    title: "Update the session tests",
    status: "waiting",
    tools: 7,
    files: 2,
    started: now - 95_000,
    cost: 0.04,
  }),
  sub({
    sessionID: "sub-3",
    title: "Map the token storage",
    status: "completed",
    tools: 9,
    started: now - 160_000,
    ended: now - 72_000,
    cost: 0.01,
  }),
];
const subagentTool = (id, agent, description, session, prompt) => ({
  kind: "tool",
  id,
  name: "subagent",
  title: `Subagent: ${description}`,
  category: "agent",
  status: "completed",
  detail: D({
    facts: [
      ["agent", agent],
      ["description", description],
    ],
    subagent: session,
    prompt,
  }),
});
const refactorTask = {
  id: "t",
  label: "current",
  summary: "Refactor token refresh into the auth service",
  status: "waiting",
  steer: null,
  next: null,
  chars: 64,
  lines: 1,
};
scenes["6-subagents"] = {
  state: base({
    busy: true,
    currentSession: { id: "s", title: "Token refresh refactor" },
    task: refactorTask,
    subagents,
  }),
  items: [
    { kind: "user", id: "u1", text: "Refactor token refresh into the auth service", attachments: [] },
    {
      kind: "assistant",
      id: "a1",
      text: "I'll split this up: one subagent maps the callers, one maps storage, one updates the tests.",
      streaming: false,
    },
    subagentTool(
      "t1",
      "explore",
      "Find every caller of refreshToken",
      "sub-1",
      "Find every caller of refreshToken() in src/ and note, for each, how it handles a failed refresh: retry count, sign-out, and the error shown to the user.",
    ),
    subagentTool(
      "t2",
      "general",
      "Update the session tests",
      "sub-2",
      "Add a test to test/session.test.ts that sends two requests with an expired token and expects exactly one refresh and no sign-out. Run the session tests.",
    ),
    subagentTool(
      "t3",
      "explore",
      "Map the token storage",
      "sub-3",
      "Map where access and refresh tokens are stored on each platform and which modules read them.",
    ),
    {
      kind: "handback",
      id: "handback:h3",
      childID: "sub-3",
      agent: "explore",
      state: "completed",
      description: "Map the token storage",
      report:
        "Tokens live in localStorage on the web build and in the OS keychain on desktop (`token-store.ts`); only `session.ts` and `api-client.ts` read them.",
    },
    {
      kind: "permission",
      id: "perm:p1",
      request: {
        id: "p1",
        sessionID: "sub-2",
        action: "bash",
        resources: ["npm test -- session"],
        canAlways: true,
        patterns: ["npm test *"],
        message: null,
        toolId: null,
      },
      sensitive: [],
      status: "pending",
    },
  ],
};
// Drill-in: one subagent's own conversation, live, with a way back to the chat.
scenes["7-subagent-view"] = {
  state: base({
    busy: true,
    currentSession: { id: "s", title: "Token refresh refactor" },
    task: { ...refactorTask, status: "running" },
    subagents: [subagents[0], subagents[2]],
    viewingSubagent: { id: "sub-1", loading: false },
  }),
  items: [],
  subItems: [
    {
      kind: "user",
      id: "u",
      text: "Find every caller of refreshToken and note how each one handles a failed refresh.",
      attachments: [],
    },
    {
      kind: "tool",
      id: "g1",
      name: "grep",
      title: "Searched refreshToken(",
      category: "search",
      status: "completed",
      detail: D(),
    },
    {
      kind: "tool",
      id: "r1",
      name: "read",
      title: "Read session.ts",
      category: "read",
      status: "completed",
      detail: D(),
    },
    {
      kind: "tool",
      id: "r2",
      name: "read",
      title: "Read api-client.ts",
      category: "read",
      status: "completed",
      detail: D(),
    },
    {
      kind: "assistant",
      id: "a",
      text: "Found **4 callers** so far:\n\n1. `session.ts:42` retries once, then signs out\n2. `api-client.ts:118` retries on 401 without a limit\n3. `ws.ts:77`",
      streaming: true,
    },
  ],
};
// Timeline: two turns on one day with thought rows, tools, text blocks with times,
// and a date divider. Fixed local times keep the renders stable.
const at = (h, m, s = 0) => new Date(2026, 10, 23, h, m, s).getTime();
const timelineItems = [
  {
    kind: "user",
    id: "user:u1",
    text: "Users say they get signed out at random, usually after lunch. Can you find out why?",
    attachments: [],
    time: at(11, 52),
  },
  {
    kind: "reasoning",
    id: "think:r1",
    text: "Check the token lifetimes and the refresh path.",
    streaming: false,
    started: at(11, 52, 2),
    ended: at(11, 52, 11),
  },
  {
    kind: "tool",
    id: "tool:g1",
    name: "grep",
    title: "Searched signOut(",
    category: "search",
    status: "completed",
    detail: D({ pattern: "signOut(", path: "/projects/acme-shop/src", output: "src/auth/session.ts:48" }),
  },
  {
    kind: "tool",
    id: "tool:r1",
    name: "read",
    title: "Read session.ts",
    category: "read",
    status: "completed",
    detail: D({ path: "/projects/acme-shop/src/auth/session.ts" }),
  },
  {
    kind: "assistant",
    id: "text:a1",
    text: "The access token lives for **45 minutes** and the refresh token rotates on every use. A tab left open over lunch comes back with an expired access token.\n\nThe sign-out comes from a race: two requests fail with 401 at once, both call `refreshToken()`, and the second refresh is rejected.",
    streaming: false,
    time: at(11, 53),
  },
  {
    kind: "user",
    id: "user:u2",
    text: "Yes, check the other callers. And tell me which tests cover this.",
    attachments: [],
    time: at(12, 4),
  },
  {
    kind: "reasoning",
    id: "think:r2",
    text: "List callers, then run the session tests.",
    streaming: false,
    started: at(12, 4, 3),
    ended: at(12, 4, 6),
  },
  {
    kind: "tool",
    id: "tool:s1",
    name: "shell",
    title: "npm test -- session",
    category: "shell",
    status: "completed",
    detail: D({
      command: "npm test -- session",
      exitCode: 0,
      output:
        "  session\n    ✓ refreshes an expired token (41 ms)\n    ✓ signs out when the refresh token is revoked\n  11 passing (1.2 s)",
    }),
  },
  {
    kind: "assistant",
    id: "text:a2",
    text: "All **11 tests** in `test/session.test.ts` pass, but none sends two requests at once, so the race is not covered.",
    streaming: false,
    time: at(12, 5),
  },
  { kind: "reasoning", id: "think:r3", text: "", streaming: true, started: at(12, 5, 10) },
  {
    kind: "tool",
    id: "tool:g2",
    name: "grep",
    title: "Searched refreshToken(",
    category: "search",
    status: "running",
    detail: D({ pattern: "refreshToken(", path: "/projects/acme-shop/src" }),
  },
];
for (const [suffix, width] of [
  ["", 400],
  ["-300", 300],
  ["-520", 520],
]) {
  const state = base({ busy: true, task: null, currentSession: { id: "s", title: "Random sign-outs" } });
  scenes[`8-timeline${suffix}`] = { state, items: timelineItems, width };
  scenes[`8-timeline${suffix}-top`] = { state, items: timelineItems, width, scroll: "top" };
}

// Tool rows: shell IN/OUT, read link, inline edit diff, write preview, search, failure.
const toolItems = [
  {
    kind: "user",
    id: "user:t",
    text: "Make concurrent 401s share one refresh, and add a test for the race.",
    attachments: [],
    time: at(12, 21),
  },
  {
    kind: "tool",
    id: "tool:read",
    name: "read",
    title: "Read service.ts",
    category: "read",
    status: "completed",
    detail: D({ path: "/projects/acme-shop/src/auth/service.ts" }),
  },
  {
    kind: "tool",
    id: "tool:edit",
    name: "edit",
    title: "Edited service.ts",
    category: "edit",
    status: "completed",
    detail: D({
      path: "/projects/acme-shop/src/auth/service.ts",
      files: [{ path: "src/auth/service.ts", additions: 3, deletions: 1, status: "modified" }],
      diffs: [
        {
          path: "src/auth/service.ts",
          more: 0,
          lines: [
            { t: "ctx", text: 'import { refreshToken } from "./token";' },
            { t: "ctx", text: "" },
            { t: "del", text: "export const refresh = () => refreshToken();" },
            { t: "add", text: "let inflight: Promise<boolean> | null = null;" },
            { t: "add", text: "export const refresh = () =>" },
            { t: "add", text: "  (inflight ??= refreshToken().finally(() => (inflight = null)));" },
            { t: "ctx", text: "" },
            { t: "ctx", text: "export async function signOut(reason: string) {" },
          ],
        },
      ],
    }),
  },
  {
    kind: "tool",
    id: "tool:write",
    name: "write",
    title: "Edited race.test.ts",
    category: "edit",
    status: "completed",
    detail: D({
      path: "/projects/acme-shop/test/auth/race.test.ts",
      written: {
        total: 14,
        lines: [
          'import { test } from "node:test";',
          'import { refresh } from "../../src/auth/service";',
          "",
          'test("two 401s trigger one refresh", async () => {',
        ],
      },
    }),
  },
  {
    kind: "tool",
    id: "tool:sh",
    name: "shell",
    title: "npm test -- race",
    category: "shell",
    status: "failed",
    detail: D({
      command: "npm test -- race",
      exitCode: 1,
      output:
        "  race\n    ✕ two 401s trigger one refresh (12 ms)\n      Expected 1 refresh, got 2\n  0 passing, 1 failing\n\n  at Object.<anonymous> (test/auth/race.test.ts:9:5)",
    }),
  },
  {
    kind: "tool",
    id: "tool:grep",
    name: "grep",
    title: "Searched refresh(",
    category: "search",
    status: "completed",
    detail: D({
      pattern: "refresh(",
      path: "/projects/acme-shop/src",
      output: "src/api-client.ts:118\nsrc/ws.ts:77",
    }),
  },
  {
    kind: "tool",
    id: "tool:sh2",
    name: "shell",
    title: "npm test -- session",
    category: "shell",
    status: "running",
    detail: D({ command: "npm test -- session" }),
  },
];
for (const [suffix, width] of [
  ["", 400],
  ["-300", 300],
  ["-520", 520],
]) {
  const state = base({ busy: true, task: null, currentSession: { id: "s", title: "Shared token refresh" } });
  scenes[`9-tools${suffix}`] = { state, items: toolItems, width, scroll: "top" };
  scenes[`9-tools${suffix}-end`] = { state, items: toolItems, width };
}

// Docks at the narrowest width.
scenes["6-subagents-300"] = { ...scenes["6-subagents"], width: 300 };
scenes["4-question-steer-300"] = { ...scenes["4-question-steer"], width: 300 };

// Step 7: a finished turn with Copy/Bookmark, the commands, usage and bookmarks menus.
const doneItems = timelineItems
  .filter((i) => i.id !== "think:r3" && i.id !== "tool:g2")
  .map((i) => (i.kind === "tool" ? { ...i, status: "completed" } : i));
const doneState = base({ task: null, currentSession: { id: "s", title: "Random sign-outs" } });
scenes["10-final-answer"] = { state: doneState, items: doneItems };
scenes["11-commands"] = { state: doneState, items: doneItems, click: '[data-testid="commands-button"]' };
scenes["12-usage"] = { state: doneState, items: doneItems, click: '[data-testid="cache-pill"]' };
scenes["13-bookmarks"] = {
  state: base({
    task: null,
    currentSession: { id: "s", title: "Random sign-outs" },
    bookmarks: [
      {
        id: "b1",
        sessionID: "s",
        sessionTitle: "Random sign-outs",
        itemId: "text:a2",
        excerpt:
          "All 11 tests in test/session.test.ts pass, but none sends two requests at once, so the race is not covered.",
        created: Date.now() - 20 * 60_000,
      },
      {
        id: "b2",
        sessionID: "s2",
        sessionTitle: "Fix checkout total rounding",
        itemId: "text:x",
        excerpt: "The rounding error comes from summing rounded line totals. Round once at the end.",
        created: Date.now() - 26 * 3600_000,
      },
    ],
  }),
  items: doneItems,
  click: '[data-testid="bookmarks-button"]',
};

// Step 8: activity: grouped folds runs of tool calls into one line.
scenes["14-grouped"] = {
  state: base({
    task: null,
    currentSession: { id: "s", title: "Shared token refresh" },
    prefs: { stickyPrompt: true, cacheWarmMinutes: 5, activity: "grouped" },
  }),
  items: [
    ...toolItems.filter((i) => i.id !== "tool:sh2"),
    {
      kind: "assistant",
      id: "text:g",
      text: "The race test fails as expected: two refreshes. Fixing the shared promise next.",
      streaming: false,
    },
  ],
  click: '[data-testid="activity-group"] summary',
  scroll: "top",
};

// Menus from the message box, and the chat scrolling under it.
scenes["15-mode-menu"] = { state: doneState, items: doneItems, click: '[data-testid="mode-button"]' };
scenes["16-model-menu"] = { state: doneState, items: doneItems, click: '[data-testid="model-pill"]' };
scenes["17-plus-menu"] = { state: doneState, items: doneItems, click: '[data-testid="add-context"]' };

// `@` in the message box: files, folders and subagents, with an image already attached.
scenes["18-mention"] = {
  state: {
    ...doneState,
    attachments: [{ id: "i1", label: "sign-out.png", detail: "1280×720 · 184 KB", kind: "image" }],
  },
  items: doneItems,
  type: "Add a test for the race in @",
  mention: [
    { kind: "folder", value: "src/auth", label: "auth/", detail: "src/" },
    { kind: "file", value: "src/auth/session.ts", label: "session.ts", detail: "src/auth/" },
    { kind: "file", value: "src/auth/refresh.ts", label: "refresh.ts", detail: "src/auth/" },
    { kind: "file", value: "test/session.test.ts", label: "session.test.ts", detail: "test/" },
    { kind: "file", value: "package.json", label: "package.json" },
    {
      kind: "agent",
      value: "explore",
      label: "explore",
      detail: "Fast agent specialized for exploring codebases.",
    },
    {
      kind: "agent",
      value: "general",
      label: "general",
      detail: "Researches questions and runs multi-step tasks.",
    },
  ],
};

// Optional scene filter and output folder:
//   node scripts/screenshots.mjs 8-timeline --out=some/folder
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith("--out="));
const scrollUp = Number(args.find((a) => a.startsWith("--scroll-up="))?.slice("--scroll-up=".length) ?? 0);
if (outArg) out = path.resolve(outArg.slice("--out=".length));
fs.mkdirSync(out, { recursive: true });
const only = args.filter((a) => !a.startsWith("--"));
// The README's screenshots: scene -> file name in docs/marketplace/screenshots.
const README = {
  "10-final-answer": "timeline",
  "9-tools": "tools",
  "6-subagents": "subagents",
  "7-subagent-view": "subagent-view",
  "4-question-steer": "question",
  "11-commands": "commands",
  "12-usage": "usage",
  "13-bookmarks": "bookmarks",
  "18-mention": "mentions",
  "5-onboarding": "onboarding",
  "2-budget": "budget",
  "3-agent-changes": "agent-changes",
};
const readmeRun = !only.length && !args.includes("--all") && !outArg;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-shots-"));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const chosen = Object.entries(scenes).filter(([n]) =>
  only.length ? only.includes(n) : !readmeRun || n in README,
);
for (const [name, scene] of chosen) {
  const html = path.join(dir, `${name}.html`);
  fs.writeFileSync(
    html,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${path.join(root, "media", "main.css")}"><style>:root{${css}} body{background:#181818} *,*::before,*::after{animation:none !important;caret-color:transparent !important}</style></head><body><div id="app"></div><script>Math.random=()=>0;window.acquireVsCodeApi=()=>({postMessage(m){if(m.type==="findMentions")setTimeout(()=>window.postMessage({type:"mentionResults",requestId:m.requestId,items:window.__mention||[]},"*"),0)},getState(){},setState(){}});</script><script src="file://${path.join(root, "dist", "webview.js")}"></script></body></html>`,
  );
  const page = await browser.newPage();
  await page.setViewport({ width: scene.width ?? 400, height: 860, deviceScaleFactor: 2 });
  await page.goto("file://" + html);
  await page.evaluate((s) => {
    window.postMessage({ type: "state", state: s.state }, "*");
    window.postMessage({ type: "transcript", items: s.items }, "*");
    if (s.subItems && s.state.viewingSubagent)
      window.postMessage(
        { type: "subagentTranscript", sessionID: s.state.viewingSubagent.id, items: s.subItems },
        "*",
      );
  }, scene);
  await new Promise((r) => setTimeout(r, 400));
  if (scene.open) await page.click('[data-testid="agent-changes-toggle"]').catch(() => {});
  if (scene.click) await page.click(scene.click).catch(() => {});
  if (scene.type) {
    await page.evaluate((m) => (window.__mention = m), scene.mention ?? []);
    await page.click("textarea");
    await page.keyboard.type(scene.type);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (scene.scroll === "top") await page.$eval(".conversation", (c) => (c.scrollTop = 0));
  if (scrollUp)
    await page.$eval(
      ".conversation",
      (c, px) => (c.scrollTop = c.scrollHeight - c.clientHeight - px),
      scrollUp,
    );
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(out, `${readmeRun ? README[name] : name}.png`) });
  await page.close();
}
await browser.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("screenshots written to", out);
