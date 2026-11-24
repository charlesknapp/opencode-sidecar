"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

// A feature card whose art plays while a mouse is over it. Screens without hover play
// it while most of the card is in view instead.
export function FeatureCell({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLLIElement>(null)
  const [on, setOn] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node || !window.matchMedia?.("(hover: none)").matches) return
    const observer = new IntersectionObserver(
      ([entry]) => setOn((entry?.intersectionRatio ?? 0) >= 0.6),
      { threshold: [0, 0.6, 1] }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <li
      ref={ref}
      data-on={on ? "true" : "false"}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setOn(true)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setOn(false)
      }}
      className={className}
    >
      {children}
    </li>
  )
}
