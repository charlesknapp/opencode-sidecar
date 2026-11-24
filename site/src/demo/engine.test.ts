import { createDemo, type HostMessage } from "@/demo/engine"
import { PROMPT } from "@/demo/story"

type Timer = { at: number; run: () => void; cancelled: boolean }

const harness = () => {
  const posted: HostMessage[] = []
  const timers: Timer[] = []
  const clock = { now: 1_000_000 }
  const demo = createDemo({
    post: (message) => posted.push(message),
    now: () => clock.now,
    after: (ms, run) => {
      const timer = { at: clock.now + ms, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  const flush = () => {
    const due = () =>
      timers.filter((t) => !t.cancelled).sort((a, b) => a.at - b.at)[0]
    for (let next = due(); next; next = due()) {
      clock.now = next.at
      next.cancelled = true
      next.run()
    }
  }
  const last = (type: string) =>
    [...posted].reverse().find((m) => m.type === type)
  const items = () =>
    (last("transcript")?.items ?? []) as Record<string, unknown>[]
  const state = () => (last("state")?.state ?? {}) as Record<string, unknown>
  return { demo, posted, flush, items, state, last }
}

const kinds = (items: Record<string, unknown>[]) =>
  items.map((i) => `${i.kind}:${i.id}`)

describe("the interactive demo", () => {
  it("greets the webview with an idle session and the prompt ready to send", () => {
    const h = harness()
    h.demo.handle({ type: "ready" })
    expect(h.state().busy).toBe(false)
    expect(h.items()).toEqual([])
    expect(h.last("restoreInput")?.text).toBe(PROMPT)
  })

  it("runs the visitor's own prompt and stops to ask before running the tests", () => {
    const h = harness()
    h.demo.handle({ type: "ready" })
    h.demo.handle({ type: "send", text: "Why do users get signed out?" })
    expect(h.items()[0]).toMatchObject({
      kind: "user",
      text: "Why do users get signed out?",
    })
    expect(h.state().busy).toBe(true)
    h.flush()
    expect(kinds(h.items())).toEqual([
      "user:u1",
      "reasoning:r1",
      "tool:g1",
      "tool:rd1",
      "tool:sh1",
      "tool:e1",
      "assistant:a1",
      "tool:t1",
      "tool:t2",
      "tool:t3",
      "permission:perm:p1",
    ])
    expect(h.items().at(-1)).toMatchObject({ status: "pending" })
    expect(h.state().busy).toBe(true)
  })

  it("finishes the task with passing tests once the visitor allows it", () => {
    const h = harness()
    h.demo.handle({ type: "ready" })
    h.demo.handle({ type: "send", text: PROMPT })
    h.flush()
    h.demo.handle({
      type: "respondPermission",
      requestId: "p1",
      decision: "once",
    })
    h.flush()
    expect(kinds(h.items()).slice(-4)).toEqual([
      "permission:perm:p1",
      "tool:sh2",
      "turn-summary:ts",
      "assistant:a2",
    ])
    expect(h.items().find((i) => i.kind === "permission")).toMatchObject({
      status: "once",
    })
    expect(h.state().busy).toBe(false)
  })

  it("respects a refusal: no tests, and the agent says so", () => {
    const h = harness()
    h.demo.handle({ type: "ready" })
    h.demo.handle({ type: "send", text: PROMPT })
    h.flush()
    h.demo.handle({
      type: "respondPermission",
      requestId: "p1",
      decision: "reject",
    })
    h.flush()
    expect(kinds(h.items())).not.toContain("tool:sh2")
    expect(String(h.items().at(-1)?.text)).toMatch(/didn't run the tests/)
    expect(h.state().busy).toBe(false)
  })

  it("stops a single subagent when its Stop is clicked", () => {
    const h = harness()
    h.demo.handle({ type: "ready" })
    h.demo.handle({ type: "send", text: PROMPT })
    h.flush()
    h.demo.handle({ type: "stopSubagent", sessionID: "sub-3" })
    const rows = h.state().subagents as Record<string, unknown>[]
    expect(rows.find((r) => r.sessionID === "sub-3")).toMatchObject({
      status: "stopped",
    })
    expect(rows.find((r) => r.sessionID === "sub-1")).toMatchObject({
      status: "running",
    })
  })

  it("stops everything on Stop, and starts over on New session", () => {
    const h = harness()
    h.demo.handle({ type: "ready" })
    h.demo.handle({ type: "send", text: PROMPT })
    h.demo.handle({ type: "stop" })
    h.flush()
    expect(h.items().at(-1)).toMatchObject({ kind: "notice", text: "Stopped." })
    expect(h.state().busy).toBe(false)
    h.demo.handle({ type: "newSession" })
    expect(h.items()).toEqual([])
    expect(h.last("restoreInput")?.text).toBe(PROMPT)
  })

  it("ignores messages it has no part for", () => {
    const h = harness()
    h.demo.handle({ type: "openFile", path: "src/auth/service.ts" })
    h.demo.handle("not a message")
    expect(h.posted).toEqual([])
  })
})
