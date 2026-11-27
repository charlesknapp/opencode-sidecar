"use client"

import { useState, type ReactNode } from "react"

/**
 * A grid whose 1px gaps are its lines, with a soft light under the mouse that
 * brightens the lines near it (see `.grid-spotlight` in globals.css). Touch and
 * keyboard see the plain grid.
 */
export function GridSpotlight({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}) {
  const [on, setOn] = useState(false)

  return (
    <ul
      data-lit={on ? "true" : "false"}
      className={`grid-spotlight ${className}`}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse") return
        const r = event.currentTarget.getBoundingClientRect()
        event.currentTarget.style.setProperty(
          "--spot-x",
          `${event.clientX - r.left}px`
        )
        event.currentTarget.style.setProperty(
          "--spot-y",
          `${event.clientY - r.top}px`
        )
        if (!on) setOn(true)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setOn(false)
      }}
    >
      {children}
    </ul>
  )
}
