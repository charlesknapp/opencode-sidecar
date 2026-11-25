"use client"

import { useRef, useState, type ReactNode } from "react"

/**
 * The footer wordmark with a soft spotlight that follows the mouse: a brighter copy
 * of the wordmark shows through a circle under the pointer. Touch and keyboard see
 * the plain wordmark; reduced motion keeps the light but drops its fade.
 */
export function WordmarkSpotlight({
  base,
  lit,
}: {
  base: ReactNode
  lit: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [on, setOn] = useState(false)

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-lit={on ? "true" : "false"}
      className="wordmark-spotlight relative"
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
      {base}
      <div className="wordmark-lit pointer-events-none absolute inset-0">
        {lit}
      </div>
    </div>
  )
}
