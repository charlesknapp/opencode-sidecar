"use client"

import { useEffect, useState } from "react"

/**
 * Follows the release you're reading on the changelog: its timeline marker lights up
 * (`data-current` on the release, styled in CSS) and this row names it.
 */
export function ChangelogSpy({ versions }: { versions: readonly string[] }) {
  const [current, setCurrent] = useState(versions[0] ?? "")

  useEffect(() => {
    const releases = [
      ...document.querySelectorAll<HTMLElement>("[data-release]"),
    ]
    const mark = (version: string) => {
      setCurrent(version)
      for (const el of releases)
        el.dataset.current = String(el.dataset.release === version)
    }
    mark(versions[0] ?? "")
    if (typeof IntersectionObserver === "undefined" || !releases.length) return
    // The release crossing a line a third of the way down the window is the one being read.
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).at(-1)
        const version = (hit?.target as HTMLElement | undefined)?.dataset
          .release
        if (version) mark(version)
      },
      { rootMargin: "-33% 0px -66% 0px" }
    )
    for (const el of releases) observer.observe(el)
    return () => observer.disconnect()
  }, [versions])

  return (
    <a
      href={`#v${current}`}
      className="flex min-h-11 items-center justify-between border-t border-line font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase transition-[color] duration-150 hover:text-foreground"
    >
      Reading
      <span className="text-foreground tabular-nums">v{current}</span>
    </a>
  )
}
