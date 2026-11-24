"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import { site } from "@/config/site"

const editors = [
  { name: "VS Code", cli: "code" },
  { name: "Cursor", cli: "cursor" },
  { name: "Windsurf", cli: "windsurf" },
  { name: "VSCodium", cli: "codium" },
] as const

export function InstallCommand() {
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const command = `${editors[active].cli} --install-extension ${site.extensionId}`

  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(id)
  }, [copied])

  const select = (index: number) => {
    const next = (index + editors.length) % editors.length
    setActive(next)
    setCopied(false)
    tabs.current[next]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, number> = {
      ArrowRight: active + 1,
      ArrowLeft: active - 1,
      Home: 0,
      End: editors.length - 1,
    }
    if (!(event.key in moves)) return
    event.preventDefault()
    select(moves[event.key])
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="border border-line-strong bg-[#09090a]">
      <div
        role="tablist"
        aria-label="Editor"
        className="flex overflow-x-auto border-b border-line-strong px-1 sm:px-2"
      >
        {editors.map((editor, index) => {
          const selected = index === active
          return (
            <button
              key={editor.name}
              ref={(node) => {
                tabs.current[index] = node
              }}
              type="button"
              role="tab"
              id={`install-tab-${index}`}
              aria-selected={selected}
              aria-controls="install-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => select(index)}
              onKeyDown={onKeyDown}
              className={`relative h-11 shrink-0 px-2 text-[13px] transition-[color] duration-150 after:absolute after:inset-x-2 after:bottom-0 after:h-px after:transition-[background-color] after:duration-150 sm:px-3 sm:text-sm sm:after:inset-x-3 ${
                selected
                  ? "text-foreground after:bg-foreground"
                  : "text-subtle-foreground after:bg-transparent hover:text-muted-foreground"
              }`}
            >
              {editor.name}
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        id="install-panel"
        aria-labelledby={`install-tab-${active}`}
        className="flex items-center gap-3 py-2 pr-2 pl-5"
      >
        <code className="min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto font-mono text-[13px] whitespace-nowrap text-muted-foreground">
          <span className="text-foreground">{editors[active].cli}</span>{" "}
          --install-extension {site.extensionId}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy the install command"
          className="grid size-10 shrink-0 place-items-center text-subtle-foreground transition-[color] duration-150 hover:text-foreground"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          >
            {copied ? (
              <path d="M3 8.5l3 3 7-7" />
            ) : (
              <>
                <rect x="5.5" y="5.5" width="8" height="8" />
                <path d="M10.5 3.5v-1h-8v8h1" />
              </>
            )}
          </svg>
        </button>
        <span role="status" className="sr-only">
          {copied ? "Copied" : ""}
        </span>
      </div>
    </div>
  )
}
