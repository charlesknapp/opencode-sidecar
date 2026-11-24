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
    <video
      ref={ref}
      aria-label={label}
      className="aspect-video w-full rounded-media border border-line-strong bg-raised"
      poster="/demo-poster.jpg"
      autoPlay={!reducedMotion}
      controls={reducedMotion}
      muted
      loop
      playsInline
      preload="metadata"
    >
      <source src="/demo.mp4" type="video/mp4" />
    </video>
  )
}
