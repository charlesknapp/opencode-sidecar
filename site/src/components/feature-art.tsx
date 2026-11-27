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
