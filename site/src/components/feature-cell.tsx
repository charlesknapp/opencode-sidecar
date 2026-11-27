"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

// A feature card whose art plays while a mouse is over it. Screens without hover play
// it while most of the card is in view instead, and so does every screen with play="view".
export function FeatureCell({
  children,
  className = "",
  as: Tag = "li",
  play = "hover",
}: {
  children: ReactNode
  className?: string
  as?: "li" | "figure"
  play?: "hover" | "view"
}) {
  const ref = useRef<HTMLElement>(null)
  const [on, setOn] = useState(false)

  useEffect(() => {
    const node = ref.current
    const byView =
      play === "view" || window.matchMedia?.("(hover: none)").matches
    if (!node || !byView) return
    const observer = new IntersectionObserver(
      ([entry]) => setOn((entry?.intersectionRatio ?? 0) >= 0.6),
      { threshold: [0, 0.6, 1] }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [play])

  return (
    <Tag
      ref={ref as never}
      data-on={on ? "true" : "false"}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse" && play === "hover") setOn(true)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && play === "hover") setOn(false)
      }}
      className={className}
    >
      {children}
    </Tag>
  )
}
