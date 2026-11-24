type Json = Record<string, unknown>

export const PROMPT =
  "Users get signed out at random after lunch. Find out why and fix it."

const detail = (extra: Json = {}): Json => ({
  facts: [],
  command: null,
  cwd: null,
  output: null,
  outputTruncated: false,
  exitCode: null,
  files: [],
  error: null,
  subagent: null,
  ...extra,
})

const models = [
  {
    key: "opencode-go/qwen3.7-plus",
    providerID: "opencode-go",
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    providerName: "OpenCode Go",
    contextLimit: 262144,
    variants: ["none", "high", "max"],
  },
]

export const hostState = ({ now, ...extra }: Json & { now: number }): Json => ({
  connection: { kind: "connected", version: "2.x", url: "http://127.0.0.1" },
  workspace: {
    active: { name: "acme-shop", path: "/projects/acme-shop" },
    folders: [{ name: "acme-shop", path: "/projects/acme-shop" }],
    branch: "fix/random-sign-outs",
    detachedAt: null,
    repoKind: "local",
    repoRoot: "/projects/acme-shop",
    mainWorktree: null,
    uncommitted: 0,
  },
  models,
  agents: [
    {
      id: "build",
      name: "Build",
      description:
        "The default agent. Executes tools based on configured permissions.",
    },
    {
      id: "plan",
      name: "Plan",
      description:
        "Read-only agent for exploring the codebase and planning work.",
    },
  ],
  selectedModel: "opencode-go/qwen3.7-plus",
  selectedAgent: "build",
  selectedVariant: "high",
  sessions: [],
  currentSession: { id: "s", title: "New session" },
  busy: false,
  stopping: false,
  attachments: [
    { id: "a", label: "session.ts", detail: "src/auth/session.ts" },
  ],
  agentChanges: { status: "none" },
  workspaceChanges: null,
  usage: null,
  steps: 0,
  budget: {
    level: "medium",
    limits: { maxCost: 0.3, maxSteps: 50 },
    taskCost: null,
    taskSteps: 0,
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
  prefs: {
    stickyPrompt: true,
    cacheWarmMinutes: 5,
    activity: "detailed",
    statusWords: true,
  },
  commands: [],
  bookmarks: [],
  mentionAgents: [],
  skills: [],
  revert: null,
  archivedSessions: null,
  onboarding: {
    stage: "ready",
    checklist: {
      installed: "done",
      connected: "done",
      account: "done",
      models: "done",
    },
    hint: null,
    signIn: "idle",
  },
  task: null,
  lastStepAt: now,
  ...extra,
})

export const runningTask = (status: "running" | "waiting"): Json => ({
  id: "t",
  label: "current",
  summary: "Find out why users get signed out at random",
  status,
  steer: null,
  next: null,
  chars: 70,
  lines: 1,
})

export const userItem = (text: string): Json => ({
  kind: "user",
  id: "u1",
  text,
  attachments: ["session.ts"],
})

export const thinking = (started: number): Json => ({
  kind: "reasoning",
  id: "r1",
  text: "",
  streaming: true,
  started,
})

export const thought = (started: number): Json => ({
  kind: "reasoning",
  id: "r1",
  text: "Check the token lifetimes and the refresh path.",
  streaming: false,
  started,
  ended: started + 9000,
})

export const grep: Json = {
  kind: "tool",
  id: "g1",
  name: "grep",
  title: "Searched refreshToken(",
  category: "search",
  status: "completed",
  detail: detail({
    pattern: "refreshToken(",
    path: "/projects/acme-shop/src",
    output: "src/auth/service.ts:3\nsrc/api-client.ts:118",
  }),
}

export const read: Json = {
  kind: "tool",
  id: "rd1",
  name: "read",
  title: "Read service.ts",
  category: "read",
  status: "completed",
  detail: detail({ path: "/projects/acme-shop/src/auth/service.ts" }),
}

export const testRunning: Json = {
  kind: "tool",
  id: "sh1",
  name: "shell",
  title: "npm test -- race",
  category: "shell",
  status: "running",
  detail: detail({ command: "npm test -- race" }),
}

export const testFailed: Json = {
  ...testRunning,
  status: "failed",
  detail: detail({
    command: "npm test -- race",
    exitCode: 1,
    output:
      "  race\n    ✕ two 401s trigger one refresh\n      Expected 1 refresh, got 2\n  0 passing, 1 failing",
  }),
}

export const edit: Json = {
  kind: "tool",
  id: "e1",
  name: "edit",
  title: "Edited service.ts",
  category: "edit",
  status: "completed",
  detail: detail({
    path: "/projects/acme-shop/src/auth/service.ts",
    files: [
      {
        path: "src/auth/service.ts",
        additions: 3,
        deletions: 1,
        status: "modified",
      },
    ],
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
          {
            t: "add",
            text: "  (inflight ??= refreshToken().finally(() => (inflight = null)));",
          },
          { t: "ctx", text: "" },
        ],
      },
    ],
  }),
}

export const plan: Json = {
  kind: "assistant",
  id: "a1",
  text: "Two requests that fail at once both call `refreshToken()`, and the second refresh is rejected, which signs the user out. I made them share one refresh. Now three subagents check the other callers, the tests and the mobile app.",
  streaming: false,
}

export type SubagentId = "sub-1" | "sub-2" | "sub-3"

const SUBAGENTS: readonly {
  id: SubagentId
  agent: string
  title: string
  prompt: string
  activity: string
}[] = [
  {
    id: "sub-1",
    agent: "explore",
    title: "Find every caller of refreshToken",
    prompt:
      "Find every caller of refreshToken() in src/ and note how each handles a failed refresh.",
    activity: "Searched refreshToken(",
  },
  {
    id: "sub-2",
    agent: "general",
    title: "Update the session tests",
    prompt:
      "Add a test that sends two requests with an expired token and expects exactly one refresh.",
    activity: "Edited session.test.ts",
  },
  {
    id: "sub-3",
    agent: "explore",
    title: "Check the mobile app's token storage",
    prompt: "Map where the mobile app stores tokens.",
    activity: "Read token-store.ts",
  },
]

export type SubagentStatus = "running" | "waiting" | "completed" | "stopped"

export const subagentTools: readonly Json[] = SUBAGENTS.map((s, index) => ({
  kind: "tool",
  id: `t${index + 1}`,
  name: "subagent",
  title: `Subagent: ${s.title}`,
  category: "agent",
  status: "completed",
  detail: detail({
    facts: [
      ["agent", s.agent],
      ["description", s.title],
    ],
    subagent: s.id,
    prompt: s.prompt,
  }),
}))

export const subagentRows = (
  statuses: Readonly<Record<SubagentId, SubagentStatus>>,
  started: number,
  now: number
): readonly Json[] =>
  SUBAGENTS.map((s, index) => {
    const status = statuses[s.id]
    const done = status === "completed" || status === "stopped"
    return {
      sessionID: s.id,
      parentID: "s",
      depth: 1,
      agent: s.agent,
      title: s.title,
      status,
      activity: done
        ? null
        : {
            kind: "tool",
            title: s.activity,
            category: index === 1 ? "edit" : "search",
          },
      tools: 4 + index * 3,
      files: index === 1 ? 1 : 0,
      started,
      ended: done ? now : null,
      cost: 0.01,
      error: null,
    }
  })

export const permission = (status: string): Json => ({
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
  status,
})

export const testsPass: Json = {
  kind: "tool",
  id: "sh2",
  name: "shell",
  title: "npm test",
  category: "shell",
  status: "completed",
  detail: detail({
    command: "npm test",
    exitCode: 0,
    output:
      "  12 passing (1.4 s)\n    ✓ two 401s trigger one refresh\n    ✓ refreshes an expired token",
  }),
}

export const summary: Json = {
  kind: "turn-summary",
  id: "ts",
  files: [
    {
      path: "src/auth/service.ts",
      additions: 3,
      deletions: 1,
      status: "modified",
    },
    {
      path: "test/auth/race.test.ts",
      additions: 14,
      deletions: 0,
      status: "added",
    },
  ],
}

export const answer = (testsRan: boolean): Json => ({
  kind: "assistant",
  id: "a2",
  text: testsRan
    ? "Fixed. Two requests that fail at once now share **one** refresh, so the second no longer signs the user out. `race.test.ts` covers it, and all **12 tests** pass."
    : "Understood, I didn't run the tests. The fix is in `service.ts` and `race.test.ts` covers it; run `npm test` when you're ready.",
  streaming: false,
})

export const stoppedNotice: Json = {
  kind: "notice",
  id: "n1",
  level: "info",
  text: "Stopped.",
}
