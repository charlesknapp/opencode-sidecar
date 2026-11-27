import {
  answer,
  changes,
  edit,
  grep,
  hostState,
  permission,
  plan,
  PROMPT,
  read,
  runningTask,
  stoppedNotice,
  subagentRows,
  subagentTools,
  summary,
  testFailed,
  testRunning,
  testsPass,
  thinking,
  thought,
  todos,
  userItem,
  type SubagentId,
  type SubagentStatus,
} from "@/demo/story"

type Json = Record<string, unknown>

export type HostMessage = { type: string } & Json

type Decision = "once" | "always" | "reject"

type Story = {
  items: readonly Json[]
  busy: boolean
  waiting: boolean
  title: string
  subagents: Readonly<Record<SubagentId, SubagentStatus>> | null
  subagentsStarted: number
}

type Deps = {
  post: (message: HostMessage) => void
  after: (ms: number, run: () => void) => () => void
  now: () => number
}

const fresh = (): Story => ({
  items: [],
  busy: false,
  waiting: false,
  title: "New session",
  subagents: null,
  subagentsStarted: 0,
})

const allRunning: Readonly<Record<SubagentId, SubagentStatus>> = {
  "sub-1": "running",
  "sub-2": "running",
  "sub-3": "running",
}

const settle = (
  statuses: Readonly<Record<SubagentId, SubagentStatus>>,
  ids: readonly SubagentId[]
) =>
  Object.fromEntries(
    Object.entries(statuses).map(([id, status]) => [
      id,
      ids.includes(id as SubagentId) && status !== "stopped"
        ? "completed"
        : status,
    ])
  ) as Record<SubagentId, SubagentStatus>

const isMessage = (value: unknown): value is HostMessage =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string"

export function createDemo({ post, after, now }: Deps) {
  let story = fresh()
  let timers: (() => void)[] = []

  const render = () => {
    const task = story.busy
      ? runningTask(story.waiting ? "waiting" : "running")
      : null
    post({
      type: "state",
      state: hostState({
        now: now(),
        busy: story.busy,
        task,
        currentSession: { id: "s", title: story.title },
        ...(story.items.length > 0 ? { attachments: [] } : {}),
        subagents: story.subagents
          ? subagentRows(story.subagents, story.subagentsStarted, now())
          : [],
        steps: story.items.filter((item) => item.kind === "tool").length,
        ...changes(story.items),
      }),
    })
    post({ type: "transcript", items: story.items })
  }

  const update = (change: (current: Story) => Story) => {
    story = change(story)
    render()
  }

  const at = (ms: number, change: (current: Story) => Story) => {
    timers = [...timers, after(ms, () => update(change))]
  }

  const cancelAll = () => {
    timers.forEach((cancel) => cancel())
    timers = []
  }

  const reset = () => {
    cancelAll()
    story = fresh()
    render()
    post({ type: "restoreInput", text: PROMPT })
  }

  const replace = (items: readonly Json[], id: string, next: Json) =>
    items.map((item) => (item.id === id ? next : item))

  const run = (text: string) => {
    if (story.busy) return
    const started = now()
    update(() => ({
      ...fresh(),
      title: "Random sign-outs",
      busy: true,
      items: [userItem(text), thinking(started)],
    }))
    at(1400, (s) => ({ ...s, items: [s.items[0], thought(started), grep] }))
    at(2300, (s) => ({ ...s, items: [...s.items, read] }))
    at(2700, (s) => ({
      ...s,
      items: [
        ...s.items,
        todos("td1", ["in_progress", "pending", "pending", "pending"]),
      ],
    }))
    at(3100, (s) => ({ ...s, items: [...s.items, testRunning] }))
    at(4100, (s) => ({ ...s, items: replace(s.items, "sh1", testFailed) }))
    at(5100, (s) => ({ ...s, items: [...s.items, edit] }))
    at(5700, (s) => ({
      ...s,
      items: [
        ...s.items,
        todos("td2", ["completed", "completed", "in_progress", "pending"]),
      ],
    }))
    at(6300, (s) => ({
      ...s,
      items: [...s.items, plan, ...subagentTools],
      subagents: allRunning,
      subagentsStarted: now(),
    }))
    at(8300, (s) => ({
      ...s,
      waiting: true,
      items: [...s.items, permission("pending")],
      subagents: s.subagents
        ? {
            ...s.subagents,
            "sub-2": s.subagents["sub-2"] === "stopped" ? "stopped" : "waiting",
          }
        : null,
    }))
  }

  const finish = (testsRan: boolean) => {
    if (testsRan) {
      at(600, (s) => ({
        ...s,
        waiting: false,
        subagents: s.subagents && settle(s.subagents, ["sub-2"]),
      }))
      at(1300, (s) => ({
        ...s,
        items: [...s.items, testsPass],
        subagents: s.subagents && settle(s.subagents, ["sub-1", "sub-3"]),
      }))
      at(2300, (s) => ({
        ...s,
        busy: false,
        items: [
          ...s.items,
          todos("td3", ["completed", "completed", "completed", "completed"]),
          summary,
          answer(true),
        ],
      }))
      return
    }
    at(700, (s) => ({
      ...s,
      busy: false,
      waiting: false,
      items: [
        ...s.items,
        todos("td3", ["completed", "completed", "completed", "cancelled"]),
        summary,
        answer(false),
      ],
      subagents: s.subagents && settle(s.subagents, ["sub-1", "sub-3"]),
    }))
  }

  const pending = () =>
    story.items.some(
      (item) => item.kind === "permission" && item.status === "pending"
    )

  const respond = (decision: Decision) => {
    if (!pending()) return
    update((s) => ({
      ...s,
      items: replace(s.items, "perm:p1", permission(decision)),
    }))
    finish(decision !== "reject")
  }

  const stopSubagent = (id: SubagentId) => {
    if (!story.subagents) return
    const askedForPermission = id === "sub-2" && pending()
    update((s) => ({
      ...s,
      subagents: s.subagents && { ...s.subagents, [id]: "stopped" },
      items: askedForPermission
        ? replace(s.items, "perm:p1", permission("expired"))
        : s.items,
    }))
    if (askedForPermission) finish(false)
  }

  const stop = () => {
    if (!story.busy) return
    cancelAll()
    update((s) => ({
      ...s,
      busy: false,
      waiting: false,
      items: [
        ...s.items.map((item) =>
          item.kind === "reasoning" ? thought(Number(item.started)) : item
        ),
        stoppedNotice,
      ],
      subagents:
        s.subagents &&
        (Object.fromEntries(
          Object.entries(s.subagents).map(([id, status]) => [
            id,
            status === "completed" ? status : "stopped",
          ])
        ) as Record<SubagentId, SubagentStatus>),
    }))
  }

  const handle = (message: unknown) => {
    if (!isMessage(message)) return
    switch (message.type) {
      case "ready":
      case "newSession":
        return reset()
      case "send":
        return run(
          typeof message.text === "string" && message.text.trim()
            ? message.text.trim()
            : PROMPT
        )
      case "respondPermission":
        return respond(
          message.decision === "reject"
            ? "reject"
            : message.decision === "always"
              ? "always"
              : "once"
        )
      case "stopSubagent":
        return stopSubagent(message.sessionID as SubagentId)
      case "stop":
        return stop()
      default:
        return undefined
    }
  }

  return { handle }
}
