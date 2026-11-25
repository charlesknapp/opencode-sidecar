"use client"

import { useEffect, useRef, useState } from "react"

export function DemoVideo({ label }: { label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const apply = () => {
      setReducedMotion(query.matches)
      if (query.matches) ref.current?.pause()
    }
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])

  return (
    <div className="relative overflow-hidden rounded-media after:pointer-events-none after:absolute after:inset-0 after:rounded-media after:border after:border-line-strong">
      <video
        ref={ref}
        aria-label={label}
        className="block aspect-video w-full object-cover"
        poster="/demo-loop-poster.jpg"
        autoPlay={!reducedMotion}
        controls={reducedMotion}
        muted
        loop
        playsInline
        preload="metadata"
      >
        <source src="/demo-loop.mp4" type="video/mp4" />
      </video>
    </div>
  )
}
