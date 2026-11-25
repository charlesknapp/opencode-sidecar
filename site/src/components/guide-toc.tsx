"use client"

import { useEffect, useState } from "react"

type Section = { id: string; text: string }

/**
 * "On this page" for a guide: the section you're reading is highlighted, and a thin
 * line along the list fills as you read through the article.
 */
export function GuideToc({ sections }: { sections: readonly Section[] }) {
  const [current, setCurrent] = useState(sections[0]?.id ?? "")
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const headings = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => !!el)
    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver !== "undefined" && headings.length) {
      observer = new IntersectionObserver(
        (entries) => {
          const hit = entries.filter((e) => e.isIntersecting).at(-1)
          if (hit) setCurrent(hit.target.id)
        },
        { rootMargin: "0px 0px -70% 0px" }
      )
      for (const el of headings) observer.observe(el)
    }
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const article = document.querySelector("article")
        if (!article) return
        const r = article.getBoundingClientRect()
        const span = r.height - window.innerHeight
        setProgress(span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1)
      })
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener("scroll", onScroll)
      cancelAnimationFrame(frame)
    }
  }, [sections])

  return (
    <div className="relative mt-3 pl-4">
      <span
        aria-hidden="true"
        className="absolute inset-y-1 left-0 w-px bg-line"
      />
      <span
        aria-hidden="true"
        className="absolute top-1 left-0 w-px origin-top bg-foreground transition-[height] duration-150 ease-out"
        style={{ height: `calc((100% - 0.5rem) * ${progress})` }}
      />
      <ul>
        {sections.map(({ id, text }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              aria-current={id === current ? "location" : undefined}
              className={`block py-1.5 text-sm transition-[color] duration-150 hover:text-foreground ${
                id === current ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
