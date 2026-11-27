import type { CSSProperties, ReactNode } from "react"

import type { ArtName } from "@/config/site"

// Miniatures of Sidecar's own panel (VS Code's Dark Modern colours). Each plays one
// short interaction while its card is active; see `.art` in globals.css.

const vars = (values: Record<string, string>) => values as CSSProperties

const tone = {
  ok: "bg-[#73c991]",
  run: "bg-[#4daafc]",
  idle: "bg-[#6e6e6e]",
  bad: "bg-[#f85149]",
}

function Dot({ kind }: { kind: keyof typeof tone }) {
  return (
    <span
      className={`mt-[0.45em] size-[7px] shrink-0 rounded-full ${tone[kind]}`}
    />
  )
}

function Header({ title }: { title: string }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-[#2b2b2b] px-3">
      <span className="truncate font-medium">{title}</span>
      <span className="truncate text-[#9d9d9d]">⑂ fix/random-sign-outs</span>
    </div>
  )
}

function Step({
  dot,
  children,
  className = "",
  style,
  enter,
}: {
  dot: keyof typeof tone
  children: ReactNode
  className?: string
  style?: CSSProperties
  enter?: boolean
}) {
  return (
    <div
      className={`flex gap-2.5 ${className}`}
      style={style}
      {...(enter ? { "data-enter": "" } : {})}
    >
      <Dot kind={dot} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

const code = "font-mono text-[10.5px]"
const path = `${code} text-[#4daafc]`
const box = "rounded-[3px] border border-[#2b2b2b] bg-[#1f1f1f]"

function Composer({ children }: { children?: ReactNode }) {
  return (
    <div className={`${box} mx-3 mb-3`}>
      <div className="h-9 px-3 pt-2 text-[#9d9d9d]">
        {children ?? "Ask anything..."}
      </div>
      <div className="flex items-center gap-3 px-3 pb-2 text-[#9d9d9d]">
        <span>+</span>
        <span>◷ 3m</span>
        <span className="ml-auto">Build</span>
        <span className="grid size-5 place-items-center rounded-[3px] bg-[#0078d4] text-white">
          ↑
        </span>
      </div>
    </div>
  )
}

function Timeline() {
  return (
    <>
      <Header title="Shared token refresh" />
      <div className="space-y-3 p-3">
        <div className={`${box} px-3 py-2`}>
          Make concurrent 401s share one refresh.
        </div>
        <Step dot="ok">
          Edit <span className={path}>src/auth/service.ts</span>
          <div className="text-[#9d9d9d]">Added 3, removed 1 line</div>
          <div className={`${box} mt-1.5 overflow-hidden py-1 ${code}`}>
            <div className="px-2 text-[#9d9d9d]">
              import {"{"} refreshToken {"}"} from &quot;./token&quot;
            </div>
            <div className="relative px-2">
              <span
                data-enter=""
                style={vars({ "--d": "150ms" })}
                className="absolute inset-0 bg-[#4b1818]"
              />
              <span className="relative">
                <span className="text-[#f85149]">-</span> export const refresh =
                () =&gt; refreshToken()
              </span>
            </div>
            {[
              "let inflight: Promise<boolean> | null",
              "export const refresh = () =>",
              "  (inflight ??= refreshToken())",
            ].map((line, i) => (
              <div
                key={line}
                data-enter=""
                style={vars({ "--d": `${450 + i * 260}ms` })}
                className="bg-[#373d29] px-2 whitespace-pre"
              >
                <span className="text-[#73c991]">+</span> {line}
              </div>
            ))}
          </div>
        </Step>
        <Step dot="run" enter style={vars({ "--d": "1400ms" })}>
          Shell <span className={code}>npm test -- race</span>
          <div className="text-[#9d9d9d]">Running · 0:02</div>
        </Step>
      </div>
    </>
  )
}

const agents = [
  {
    task: "Find every caller of refreshToken",
    kind: "explore",
    now: "Running · 12 tools · 0:44",
    then: "Finished · 14 tools · 0:51",
  },
  {
    task: "Update the session tests",
    kind: "general",
    now: "Running · 4 tools · 0:31",
    then: "Running · 6 tools · 0:38",
  },
  {
    task: "Map the token storage",
    kind: "explore",
    now: "Running · 7 tools · 0:20",
    then: "Stopped · 7 tools · 0:22",
  },
]

function Subagents() {
  return (
    <>
      <Header title="Token refresh refactor" />
      <div className="space-y-3.5 p-3">
        {agents.map((agent, i) => (
          <Step key={agent.task} dot="run">
            <div className="truncate">
              Agent: <span className={code}>{agent.task}</span>{" "}
              <span className="text-[#9d9d9d]">{agent.kind}</span>
            </div>
            <div className="relative mt-1 h-4 text-[#9d9d9d]">
              <span
                data-leave=""
                style={vars({ "--d": `${500 + i * 450}ms` })}
                className="absolute inset-0 flex gap-2"
              >
                {agent.now}
                <span className="text-[#4daafc]">Stop</span>
                <span className="text-[#4daafc]">Open ›</span>
              </span>
              <span
                data-enter=""
                style={vars({ "--d": `${640 + i * 450}ms` })}
                className={`absolute inset-0 flex gap-2 ${
                  i === 2 ? "text-[#f85149]" : ""
                }`}
              >
                {agent.then}
                <span className="text-[#4daafc]">Open ›</span>
              </span>
            </div>
          </Step>
        ))}
        <div
          data-enter=""
          style={vars({ "--d": "1100ms" })}
          className="truncate pl-[17px] text-[#9d9d9d] italic"
        >
          Report from explore · Every caller found: 2 files ›
        </div>
      </div>
    </>
  )
}

const choices = [
  "Yes",
  "Yes, always allow npm test *",
  "No",
  "Tell the agent what to do instead",
]

function Permission() {
  return (
    <div className="flex h-full flex-col justify-end">
      <div className="space-y-1 px-3 pb-3">
        <Step dot="run">
          Permission <span className={code}>bash: npm test -- session</span>
          <div className="relative h-4 text-[#9d9d9d]">
            <span
              data-leave=""
              style={vars({ "--d": "900ms" })}
              className="absolute inset-0"
            >
              Waiting for your answer below
            </span>
            <span
              data-enter=""
              style={vars({ "--d": "1000ms" })}
              className="absolute inset-0 text-[#73c991]"
            >
              Allowed always: npm test *
            </span>
          </div>
        </Step>
      </div>
      <div className={`${box} mx-3 mb-3 p-3`}>
        <div className="font-medium">Allow this shell command?</div>
        <div className="mt-0.5 truncate text-[#9d9d9d]">
          From subagent <span className="text-[9px] uppercase">general</span>{" "}
          Update the session tests
        </div>
        <div className={`${code} mt-1.5`}>npm test -- session</div>
        <div className="relative mt-2 space-y-1">
          <span
            data-move=""
            style={vars({
              "--d": "250ms",
              "--dur": "380ms",
              "--to": "translateY(calc(100% + 4px))",
            })}
            className="absolute inset-x-0 top-0 h-[26px] rounded-[3px] bg-[#04395e]"
          />
          {choices.map((choice, i) => (
            <div
              key={choice}
              className="relative flex h-[26px] items-center gap-2 rounded-[3px] border border-[#2b2b2b] px-2"
            >
              {i < 3 && <span className="text-[#9d9d9d]">{i + 1}</span>}
              <span className="truncate">{choice}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Budget() {
  return (
    <>
      <Header title="New logger everywhere" />
      <div className="space-y-3 p-3">
        <Step dot="ok">
          Edit <span className="text-[#9d9d9d]">Edited logger.ts</span>
          <div className="text-[#9d9d9d]">Added 12 lines</div>
        </Step>
        <div className="ml-[17px] rounded-[3px] border border-[#b89500] bg-[#3d3300] px-2.5 py-1.5">
          ⚠ Task budget is nearly exhausted.
        </div>
        <Step dot="ok" enter style={vars({ "--d": "300ms" })}>
          Edit <span className="text-[#9d9d9d]">Edited orders.ts</span>
        </Step>
        <Step dot="idle" enter style={vars({ "--d": "800ms" })}>
          Stopped.
        </Step>
        <div
          data-enter=""
          style={vars({ "--d": "1150ms" })}
          className="ml-[17px] rounded-[3px] border border-[#be1100] bg-[#2b1414] p-2.5"
        >
          <div>⛔ Task budget reached. The agent was stopped.</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-[2px] bg-[#0078d4] px-2 py-0.5 text-white">
              Continue once
            </span>
            <span className="rounded-[2px] bg-[#313131] px-2 py-0.5">
              Increase budget
            </span>
          </div>
        </div>
      </div>
    </>
  )
}

const mentions = [
  ["src/auth/service.ts", "File"],
  ["src/auth/session.ts", "File"],
  ["src/auth/", "Folder"],
  ["explore", "Subagent"],
] as const

function ComposerArt() {
  return (
    <div className="flex h-full flex-col justify-end">
      <div className="space-y-3 px-3 pb-3">
        <Step dot="idle">Thought for 3s</Step>
        <Step dot="idle">
          All <b>11 tests</b> pass, but none sends two requests at once.
        </Step>
      </div>
      <div className="relative">
        <div
          data-enter=""
          style={vars({ "--d": "900ms" })}
          className={`${box} absolute inset-x-3 bottom-full mb-1.5 py-1 shadow-[0_8px_24px_rgb(0_0_0/0.45)]`}
        >
          {mentions.map(([name, kind], i) => (
            <div
              key={name}
              className={`flex items-center gap-2 px-2.5 py-1 ${
                i === 0 ? "bg-[#04395e]" : ""
              }`}
            >
              <span className="truncate">{name}</span>
              <span className="ml-auto text-[#9d9d9d]">{kind}</span>
            </div>
          ))}
        </div>
        <Composer>
          <span className="relative text-[#cccccc]">
            <span
              data-leave=""
              style={vars({ "--d": "0ms", "--dur": "120ms" })}
              className="absolute inset-0 whitespace-nowrap text-[#9d9d9d]"
            >
              Ask anything...
            </span>
            <span
              data-type=""
              style={vars({
                "--d": "120ms",
                "--dur": "760ms",
                "--steps": "16",
                "--w": "16ch",
              })}
            >
              Check how @serv
            </span>
          </span>
        </Composer>
      </div>
    </div>
  )
}

function Session() {
  return (
    <>
      <Header title="Random sign-outs" />
      <div className="relative h-[calc(100%-2rem)] overflow-hidden">
        <div className="absolute inset-x-0 top-0 z-10 border-b border-[#2b2b2b] bg-[#181818] px-3 py-2">
          <div className={`${box} relative h-9 overflow-hidden`}>
            <span
              data-leave=""
              style={vars({ "--d": "1150ms", "--dur": "200ms" })}
              className="absolute inset-0 truncate px-3 py-2"
            >
              Users get signed out at random. Can you find out why?
            </span>
            <span
              data-enter=""
              style={vars({ "--d": "1250ms", "--dur": "240ms" })}
              className="absolute inset-0 truncate px-3 py-2"
            >
              Yes, check the other callers too.
            </span>
          </div>
        </div>
        <div
          data-move=""
          style={vars({
            "--dur": "1900ms",
            "--to": "translateY(-150px)",
          })}
          className="space-y-3 px-3 pt-[66px]"
        >
          <Step dot="idle">
            The access token lives for <b>45 minutes</b> and the refresh token
            rotates on every use.
          </Step>
          <Step dot="idle">
            The sign-out comes from a race: two requests fail with 401 at once,
            and the second refresh is rejected.
            <div className="mt-1 flex gap-3 text-[#9d9d9d]">
              <span>Copy</span>
              <span>Bookmark</span>
            </div>
          </Step>
          <div className={`${box} px-3 py-2`}>
            Yes, check the other callers too.
          </div>
          <Step dot="ok">
            Shell <span className={code}>npm test -- session</span>
          </Step>
          <Step dot="idle">
            All <b>11 tests</b> pass, but none sends two requests at once.
          </Step>
          <Step dot="ok">
            Write <span className={path}>test/auth/race.test.ts</span>
          </Step>
          <Step dot="idle">
            Added a test for two 401s at once. All <b>12 tests</b> pass.
            <div className="mt-1 flex gap-3 text-[#9d9d9d]">
              <span>Copy</span>
              <span>Bookmark</span>
            </div>
          </Step>
        </div>
      </div>
    </>
  )
}

const lens = "flex h-5 items-center gap-1.5 px-2 text-[10px] text-[#9d9d9d]"

function Review() {
  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-[#2b2b2b] px-3">
        <span className={path}>service.ts</span>
        <span className="ml-auto text-[#9d9d9d]">
          <span className="text-[#4daafc]">Keep file</span> |{" "}
          <span className="text-[#4daafc]">Undo file</span>
        </span>
      </div>
      <div className={`py-2 ${code}`}>
        <div className="px-3 text-[#9d9d9d]">
          import {"{"} refreshToken {"}"} from &quot;./token&quot;
        </div>
        <div className={lens}>
          <span className="text-[#4daafc]">Keep</span> |{" "}
          <span className="text-[#4daafc]">Undo</span>
          <span
            data-enter=""
            style={vars({ "--d": "300ms" })}
            className="ml-1 text-[#73c991]"
          >
            ✓ Kept
          </span>
        </div>
        <div className="relative">
          <span
            data-leave=""
            style={vars({ "--d": "300ms" })}
            className="absolute inset-0 bg-[#373d29]"
          />
          <div className="relative px-3 whitespace-pre">
            let inflight: Promise&lt;boolean&gt; | null
          </div>
        </div>
        <div className="px-3 text-[#9d9d9d]">&nbsp;</div>
        <div className={lens}>
          <span className="text-[#4daafc]">Keep</span> |{" "}
          <span className="text-[#4daafc]">Undo</span>
          <span
            data-enter=""
            style={vars({ "--d": "1000ms" })}
            className="ml-1 text-[#f85149]"
          >
            ↺ Undone
          </span>
        </div>
        <div className="relative h-[3.1em]">
          <div
            data-leave=""
            style={vars({ "--d": "1000ms" })}
            className="absolute inset-0 bg-[#373d29] px-3 whitespace-pre"
          >
            {"export const refresh = () =>\n  (inflight ??= refreshToken())"}
          </div>
          <div
            data-enter=""
            style={vars({ "--d": "1100ms" })}
            className="absolute inset-0 px-3 whitespace-pre"
          >
            export const refresh = () =&gt; refreshToken()
          </div>
        </div>
      </div>
      <div className="mx-3 mt-1 mb-3 flex items-center gap-2 text-[#9d9d9d]">
        <span className="relative h-4 flex-1">
          <span
            data-leave=""
            style={vars({ "--d": "1100ms" })}
            className="absolute inset-0"
          >
            2 changes to review
          </span>
          <span
            data-enter=""
            style={vars({ "--d": "1200ms" })}
            className="absolute inset-0"
          >
            Reviewed · 1 kept, 1 undone
          </span>
        </span>
        <span className="rounded-[2px] bg-[#313131] px-2 py-0.5 text-[#cccccc]">
          Stage kept changes
        </span>
      </div>
    </>
  )
}

const modes = [
  ["Ask", "Asks before every edit, command and web request"],
  ["Balanced", "Edits in the folder run; commands and the web ask"],
  ["Auto", "Everything runs, except destructive commands"],
] as const

function Modes() {
  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-[#2b2b2b] px-3">
        <span className="truncate font-medium">Token refresh refactor</span>
        <span className="relative ml-auto h-5 w-[74px] shrink-0">
          <span
            data-leave=""
            style={vars({ "--d": "900ms" })}
            className="absolute inset-0 grid place-items-center rounded-[3px] border border-[#2b2b2b]"
          >
            Ask
          </span>
          <span
            data-enter=""
            style={vars({ "--d": "1000ms" })}
            className="absolute inset-0 grid place-items-center rounded-[3px] border border-[#2b2b2b] text-[#73c991]"
          >
            Balanced
          </span>
        </span>
      </div>
      <div
        className={`${box} relative mx-3 mt-2 py-1 shadow-[0_8px_24px_rgb(0_0_0/0.45)]`}
      >
        <span
          data-move=""
          style={vars({
            "--d": "250ms",
            "--dur": "420ms",
            "--to": "translateY(100%)",
          })}
          className="absolute inset-x-1 top-1 h-[38px] rounded-[3px] bg-[#04395e]"
        />
        {modes.map(([name, text]) => (
          <div key={name} className="relative h-[38px] px-2.5 py-1">
            <div className={name === "Auto" ? "text-[#cca700]" : ""}>
              {name}
            </div>
            <div className="truncate text-[#9d9d9d]">{text}</div>
          </div>
        ))}
        <div className="relative mt-1 flex gap-3 border-t border-[#2b2b2b] px-2.5 pt-1.5 text-[#9d9d9d]">
          <span>Apply to: This session</span>
          <span className="text-[#4daafc]">Permission rules…</span>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <Step dot="ok" enter style={vars({ "--d": "1250ms" })}>
          Edit <span className={path}>src/auth/service.ts</span>
          <div className="text-[#9d9d9d]">Ran without asking: Balanced</div>
        </Step>
      </div>
    </>
  )
}

const tabs = [
  { name: "Token refresh", dot: "run" },
  { name: "Docs pass", dot: "idle" },
  { name: "Flaky CI", dot: "run" },
] as const

function Sessions() {
  return (
    <>
      <Header title="Token refresh" />
      <div className="flex h-7 shrink-0 items-stretch border-b border-[#2b2b2b] px-1.5">
        {tabs.map((tab, i) => (
          <span
            key={tab.name}
            className={`flex min-w-0 items-center gap-1.5 px-2 ${
              i === 0 ? "border-b border-[#0078d4]" : "text-[#9d9d9d]"
            }`}
          >
            <span className="relative size-[7px] shrink-0">
              <span
                className={`absolute inset-0 rounded-full ${tone[tab.dot]}`}
              />
              {i === 2 && (
                <span
                  data-enter=""
                  style={vars({ "--d": "700ms" })}
                  className="absolute inset-0 rounded-full bg-[#cca700]"
                />
              )}
              {i === 1 && (
                <span
                  data-enter=""
                  style={vars({ "--d": "200ms" })}
                  className={`absolute inset-0 rounded-full ${tone.ok}`}
                />
              )}
            </span>
            <span className="truncate">{tab.name}</span>
            <span className="text-[#6e6e6e]">×</span>
          </span>
        ))}
      </div>
      <div className="space-y-3 p-3">
        <Step dot="ok">
          Edit <span className={path}>src/auth/service.ts</span>
        </Step>
        <Step dot="run">
          Shell <span className={code}>npm test -- race</span>
          <div className="text-[#9d9d9d]">Running · 0:04</div>
        </Step>
      </div>
      <div
        data-enter=""
        style={vars({ "--d": "900ms" })}
        className={`${box} mx-3 mb-3 p-2.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]`}
      >
        <div>ⓘ Flaky CI needs your answer: Allow this shell command?</div>
        <div className="mt-2 flex justify-end">
          <span className="rounded-[2px] bg-[#0078d4] px-2 py-0.5 text-white">
            Open
          </span>
        </div>
      </div>
    </>
  )
}

/** One text leaving while another takes its place, at the same spot. */
function Swap({
  from,
  to,
  d,
  className = "",
  toClass = "",
}: {
  from: ReactNode
  to: ReactNode
  d: number
  className?: string
  toClass?: string
}) {
  return (
    <span className={`relative inline-grid ${className}`}>
      <span
        data-leave=""
        style={vars({ "--d": `${d}ms` })}
        className="col-start-1 row-start-1 whitespace-nowrap"
      >
        {from}
      </span>
      <span
        data-enter=""
        style={vars({ "--d": `${d + 100}ms` })}
        className={`col-start-1 row-start-1 whitespace-nowrap ${toClass}`}
      >
        {to}
      </span>
    </span>
  )
}

const btn = "rounded-[2px] bg-[#313131] px-2 py-0.5 text-[#cccccc]"
const primary = "rounded-[2px] bg-[#0078d4] px-2 py-0.5 text-white"
const badge =
  "inline-block rounded-[3px] border border-current px-1 text-[9.5px] leading-[14px]"
const muted = "text-[#9d9d9d]"
const green = "text-[#73c991]"
const yellow = "text-[#cca700]"
const red = "text-[#f85149]"

/** One of Sidecar's panels (Providers, MCP servers, Agents), as a modal over the chat. */
function Panel({
  title,
  note,
  children,
  foot,
}: {
  title: string
  note: string
  children: ReactNode
  foot: ReactNode
}) {
  return (
    <div className="flex h-full flex-col p-3">
      <div className="text-[13px] font-medium">{title}</div>
      <div className={`mt-0.5 truncate ${muted}`}>{note}</div>
      <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-hidden">
        {children}
      </div>
      <div className="mt-2 flex justify-end gap-1.5 border-t border-[#2b2b2b] pt-2">
        {foot}
      </div>
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className={`${box} px-2.5 py-1.5`}>{children}</div>
}

const sub = "mt-1 text-[10px] font-medium tracking-wide text-[#9d9d9d]"

const localModels = [
  ["OpenCode Go", "Qwen3.7 Plus", "262k context"],
  ["Ollama", "qwen3:8b", "41k context"],
  [null, "gpt-oss:20b", "131k context"],
  ["LM Studio", "qwen3-coder-30b", "262k context"],
] as const

function Models() {
  return (
    <div className="flex h-full flex-col justify-end">
      <div
        className={`${box} relative mx-3 mb-1.5 py-1 shadow-[0_8px_24px_rgb(0_0_0/0.45)]`}
      >
        <div className={`px-2.5 pb-0.5 ${muted}`}>Select a model</div>
        <div className="relative">
          <span
            data-move=""
            style={vars({
              "--d": "250ms",
              "--dur": "420ms",
              "--to": "translateY(calc(100% + 16px))",
            })}
            className="absolute inset-x-1 top-[16px] h-[32px] rounded-[3px] bg-[#04395e]"
          />
          {localModels.map(([group, name, context], i) => (
            <div key={name} className="relative">
              {group && <div className={`px-2.5 ${muted}`}>{group}</div>}
              <div className="flex h-[32px] items-center px-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate">{name}</div>
                  <div className={`text-[10px] ${muted}`}>{context}</div>
                </div>
                {i === 0 && (
                  <span data-leave="" style={vars({ "--d": "700ms" })}>
                    ✓
                  </span>
                )}
                {i === 1 && (
                  <span data-enter="" style={vars({ "--d": "800ms" })}>
                    ✓
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-1 border-t border-[#2b2b2b] px-2.5 pt-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate">Budget Guard (Medium)</span>
            <span className="ml-auto flex gap-1.5">
              {[0, 1, 2, 3, 4].map((dot) => (
                <span
                  key={dot}
                  className={`size-1 rounded-full ${
                    dot === 2 ? "scale-[2.4] bg-[#cccccc]" : "bg-[#6e6e6e]"
                  }`}
                />
              ))}
            </span>
          </div>
          <div className="mt-1 py-0.5">Manage providers…</div>
        </div>
      </div>
      <div className={`${box} mx-3 mb-3`}>
        <div className={`h-7 px-3 pt-1.5 ${muted}`}>Ask anything...</div>
        <div className={`flex items-center gap-3 px-3 pb-2 ${muted}`}>
          <span>+</span>
          <span>/</span>
          <Swap
            d={850}
            from={
              <>
                Qwen3.7 Plus <span className="opacity-70">high</span>
              </>
            }
            to="qwen3:8b"
            toClass="text-[#cccccc]"
          />
          <span className="ml-auto">Build</span>
          <span className="grid size-5 place-items-center rounded-[3px] bg-[#0078d4] text-white">
            ↑
          </span>
        </div>
      </div>
    </div>
  )
}

const checklist = [
  ["Extension installed", "✓", null],
  ["OpenCode installed", "✓", null],
  ["OpenCode connected", "○", 450],
  ["Account signed in", "…", 700],
  ["Models available", "…", 900],
] as const

function Setup() {
  return (
    <div className="relative h-full">
      <div
        data-leave=""
        style={vars({ "--d": "1300ms" })}
        className="absolute inset-0 p-4"
      >
        <div className="text-[14px] font-medium">OpenCode is installed</div>
        <p className={`mt-1 ${muted}`}>
          Its background service is not running. Start it to continue.
        </p>
        <div className="mt-2.5 flex gap-1.5">
          <span className={`${primary} relative`}>
            Start OpenCode
            <span
              data-enter=""
              style={vars({ "--d": "200ms", "--dur": "200ms" })}
              className="absolute inset-0 rounded-[2px] ring-2 ring-[#4daafc]/60"
            />
          </span>
          <span className={btn}>Check again</span>
        </div>
        <ul className="mt-3 space-y-1 border-t border-[#2b2b2b] pt-2.5">
          {checklist.map(([label, mark, d]) => (
            <li key={label} className="flex gap-2">
              {d === null ? (
                <span className={`w-3 ${green}`}>✓</span>
              ) : (
                <Swap
                  d={d}
                  className="w-3"
                  from={
                    <span className={mark === "○" ? yellow : muted}>
                      {mark}
                    </span>
                  }
                  to={<span className={green}>✓</span>}
                />
              )}
              <span
                className={label === "OpenCode connected" ? "font-medium" : ""}
              >
                {label}
              </span>
            </li>
          ))}
        </ul>
        <div className={`mt-2.5 ${muted}`}>
          Need help? <span className="text-[#4daafc]">View setup guide</span>
        </div>
      </div>
      <div
        data-enter=""
        style={vars({ "--d": "1450ms" })}
        className="absolute inset-0 flex flex-col"
      >
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <div className="text-[14px] font-medium">Ask OpenCode anything</div>
            <div className={`mt-1 ${muted}`}>
              Type / for commands and settings, @ to mention a file, agent or
              skill.
            </div>
          </div>
        </div>
        <Composer />
      </div>
    </div>
  )
}

const modesToImport = [
  {
    name: "docs-writer",
    mode: "Primary and subagent",
    from: "Docs Writer · .roomodes",
    on: true,
  },
  {
    name: "orchestrator",
    mode: "Primary",
    from: "Orchestrator · .roomodes",
    on: true,
  },
  {
    name: "architect",
    mode: "Primary and subagent",
    from: "Architect · Roo Code (global)",
    on: false,
  },
] as const

function Check({ on, d }: { on: boolean; d?: number }) {
  const mark = "grid size-3 place-items-center rounded-[2px] text-[9px]"
  return on ? (
    <span className={`${mark} bg-[#0078d4] text-white`}>✓</span>
  ) : (
    <span className="relative size-3 shrink-0">
      <span className={`${mark} absolute inset-0 border border-[#6e6e6e]`} />
      <span
        data-enter=""
        style={vars({ "--d": `${d ?? 0}ms` })}
        className={`${mark} absolute inset-0 bg-[#0078d4] text-white`}
      >
        ✓
      </span>
    </span>
  )
}

function Import() {
  return (
    <Panel
      title="Import Roo Code modes"
      note="Each mode becomes an agent file. Its role and instructions become the prompt, its tool groups permissions."
      foot={
        <>
          <span className={btn}>Back</span>
          <Swap
            d={700}
            from={
              <span className={`${primary} inline-block`}>Import 2 modes</span>
            }
            to={
              <span className={`${primary} inline-block`}>Import 3 modes</span>
            }
          />
        </>
      }
    >
      {modesToImport.map((item) => (
        <Row key={item.name}>
          <div className="flex items-center gap-2">
            <Check on={item.on} d={500} />
            <span className="font-medium">{item.name}</span>
            <span className={`${badge} ${muted}`}>{item.mode}</span>
          </div>
          <div className={`mt-0.5 truncate pl-5 ${muted}`}>{item.from}</div>
          {item.name === "docs-writer" && (
            <div className={`truncate pl-5 ${muted}`}>
              • MCP tools are not limited: OpenCode&apos;s permissions name each
              MCP tool, not a group.
            </div>
          )}
        </Row>
      ))}
    </Panel>
  )
}

function Providers() {
  return (
    <Panel
      title="Providers"
      note="OpenCode signs in and stores the keys. Sidecar never sees or keeps them."
      foot={
        <>
          <span className={btn}>Reload config</span>
          <span className={btn}>Check setup</span>
          <span className={primary}>Done</span>
        </>
      }
    >
      <div className={sub}>Connected</div>
      <Row>
        <div className="flex items-center gap-2">
          <span className="font-medium">OpenCode</span>
          <span className={`${badge} ${green}`}>Connected</span>
        </div>
        <div className={muted}>Free models, no sign-in · 6 models</div>
      </Row>
      <Row>
        <div className="flex items-center gap-2">
          <span className="font-medium">Anthropic</span>
          <Swap
            d={900}
            from={<span className={`${badge} ${yellow}`}>Needs sign-in</span>}
            to={<span className={`${badge} ${green}`}>Connected</span>}
          />
        </div>
        <div className={muted}>OAuth · 9 models</div>
        <div className="mt-1 flex gap-1.5">
          <span className={`${btn} relative`}>
            Sign in again
            <span
              data-enter=""
              style={vars({ "--d": "250ms", "--dur": "200ms" })}
              className="absolute inset-0 rounded-[2px] ring-2 ring-[#4daafc]/60"
            />
          </span>
          <span className={btn}>Disconnect</span>
        </div>
      </Row>
      <div className={sub}>Connect a provider</div>
      <div className={`${box} px-2.5 py-1 ${muted}`}>Search providers</div>
    </Panel>
  )
}

function Mcp() {
  return (
    <Panel
      title="MCP servers"
      note="Changes here last for this OpenCode run. OpenCode's config is not changed."
      foot={
        <>
          <span className={btn}>Reload config</span>
          <span className={primary}>Done</span>
        </>
      }
    >
      <Row>
        <div className="flex items-center gap-2">
          <span className="font-medium">github</span>
          <span className={`${badge} ${green}`}>Connected</span>
          <span className={`${btn} ml-auto`}>Disconnect</span>
        </div>
      </Row>
      <Row>
        <div className="flex items-center gap-2">
          <span className="font-medium">sentry</span>
          <Swap
            d={1000}
            from={<span className={`${badge} ${yellow}`}>Needs sign-in</span>}
            to={<span className={`${badge} ${green}`}>Connected</span>}
          />
          <Swap
            d={1000}
            className="ml-auto justify-items-end"
            from={<span className={`${btn} inline-block`}>Sign in</span>}
            to={<span className={`${btn} inline-block`}>Disconnect</span>}
          />
        </div>
      </Row>
      <Row>
        <div className="flex items-center gap-2">
          <span className="font-medium">docs</span>
          <Swap
            d={300}
            from={<span className={`${badge} ${red}`}>Failed</span>}
            to={
              <Swap
                d={650}
                from={<span className={`${badge} ${muted}`}>Connecting…</span>}
                to={<span className={`${badge} ${green}`}>Connected</span>}
              />
            }
          />
          <span className="ml-auto flex gap-1.5">
            <Swap
              d={750}
              className="justify-items-end"
              from={<span className={`${btn} inline-block`}>Retry</span>}
              to={<span className={`${btn} inline-block`}>Disconnect</span>}
            />
            <span className={btn}>Remove</span>
          </span>
        </div>
        <div className={muted}>added for this OpenCode run</div>
      </Row>
      <div className={sub}>Add a server for this OpenCode run</div>
      <div className="flex gap-1.5">
        <span className={`${box} w-14 px-2 py-0.5 ${muted}`}>Name</span>
        <span className={`${box} min-w-0 flex-1 truncate px-2 py-0.5 ${muted}`}>
          npx -y some-server, or https://…
        </span>
        <span className={btn}>Add</span>
      </div>
    </Panel>
  )
}

function Aside() {
  return (
    <>
      <Header title="Token refresh" />
      <div className={`${box} mx-3 mt-2.5 p-2.5`}>
        <div className="flex items-center gap-2">
          <span className="font-medium">Ask aside</span>
          <Swap
            d={1250}
            className={muted}
            from={
              <Swap d={550} from="Answering…" to="Not added to this session" />
            }
            to="Added to session"
          />
          <span className={`ml-auto ${muted}`}>˄ ×</span>
        </div>
        <div className="mt-2 rounded-[3px] bg-[#2a2d2e] px-2 py-1">
          what does the retry option in fetchUser do?
        </div>
        <div className="relative mt-1.5 h-[3.2em]">
          <span
            data-leave=""
            style={vars({ "--d": "500ms" })}
            className={`absolute inset-0 ${muted}`}
          >
            Thinking…
          </span>
          <span
            data-enter=""
            style={vars({ "--d": "650ms" })}
            className="absolute inset-0"
          >
            It retries a failed request up to <b>3 times</b>, waiting longer
            each time, and only for network errors, never for a 401.
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className={`${box} min-w-0 flex-1 truncate px-2 py-0.5 ${muted}`}
          >
            Ask a follow-up…
          </span>
          <span className={btn}>Ask</span>
          <span
            data-enter=""
            style={vars({ "--d": "750ms" })}
            className="inline-flex"
          >
            <Swap
              d={1200}
              from={
                <span className={`${btn} inline-block`}>Add to session</span>
              }
              to={
                <span className={`${btn} inline-block opacity-60`}>
                  Added to session
                </span>
              }
            />
          </span>
        </div>
      </div>
      <div className="space-y-3 p-3">
        <Step dot="ok">
          Edit <span className={path}>src/auth/service.ts</span>
        </Step>
        <Step dot="run">
          Shell <span className={code}>npm test -- race</span>
          <div className={muted}>
            <Swap d={600} from="Running · 0:04" to="Running · 0:06" />
          </div>
        </Step>
      </div>
    </>
  )
}

function Goal() {
  return (
    <>
      <Header title="Auth tests" />
      <div className="relative mx-3 mt-2.5 rounded-[3px] border border-[#2b2b2b] bg-[#1f1f1f] py-2 pr-2.5 pl-3">
        <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-[3px] bg-[#0078d4]" />
        <span
          data-enter=""
          style={vars({ "--d": "1100ms" })}
          className="absolute inset-y-0 left-0 w-[3px] rounded-l-[3px] bg-[#73c991]"
        />
        <div className="flex items-center gap-2">
          <span className="font-medium">◎ Goal</span>
          <span className="min-w-0 flex-1 truncate">
            make every test in test/auth pass
          </span>
          <Swap
            d={1100}
            from={<span className={badge}>In progress</span>}
            to={<span className={`${badge} ${green}`}>Achieved</span>}
          />
          <span className={muted}>˄</span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Swap
            d={1100}
            className={`mr-auto ${muted}`}
            from="Round 3 of 50"
            to="3 rounds"
          />
          <span className={btn}>Rounds</span>
          <Swap
            d={1100}
            className="justify-items-end"
            from={
              <span className="flex gap-1.5">
                <span className={btn}>Pause</span>
                <span className={btn}>End goal</span>
              </span>
            }
            to={<span className={`${btn} inline-block`}>Clear</span>}
          />
        </div>
      </div>
      <div className="space-y-3 p-3">
        <Step dot="ok">
          Edit <span className={path}>test/auth/refresh.test.ts</span>
        </Step>
        <Step dot="run">
          Shell <span className={code}>npm test -- test/auth</span>
          <div className={muted}>
            <Swap
              d={700}
              from="Running · 0:03"
              to={<span className={green}>12 passing</span>}
            />
          </div>
        </Step>
        <Step dot="idle" enter style={vars({ "--d": "900ms" })}>
          Every test in <span className={path}>test/auth</span> passes.
        </Step>
      </div>
    </>
  )
}

const arts: Record<ArtName, () => ReactNode> = {
  timeline: Timeline,
  subagents: Subagents,
  permission: Permission,
  budget: Budget,
  composer: ComposerArt,
  session: Session,
  review: Review,
  modes: Modes,
  sessions: Sessions,
  models: Models,
  setup: Setup,
  import: Import,
  providers: Providers,
  mcp: Mcp,
  aside: Aside,
  goal: Goal,
}

export function FeatureArt({ name }: { name: ArtName }) {
  const Art = arts[name]
  return (
    <div
      aria-hidden="true"
      className="art absolute inset-0 flex flex-col bg-[#181818] text-[11px] leading-[1.45] text-[#cccccc] select-none"
    >
      <Art />
    </div>
  )
}
