"use client"

import { useEffect, useState } from "react"

/** Copies `text` to the clipboard; the icon turns into a tick and a status says "Copied". */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(id)
  }, [copied])

  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }}
        className="grid size-8 place-items-center text-subtle-foreground transition-[color] duration-150 hover:text-foreground"
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
    </>
  )
}
