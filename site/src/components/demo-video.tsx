"use client"

import { useEffect, useRef, useState } from "react"

// The poster paints first (it is the page's largest element); the video itself is
// fetched only once the page has loaded, so it never competes with the first screen.
export function DemoVideo({
  label,
  src,
  poster,
}: {
  label: string
  src: string
  poster: string
}) {
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

  useEffect(() => {
    const attach = () => {
      if (ref.current && !ref.current.getAttribute("src")) {
        ref.current.setAttribute("src", src)
      }
    }
    if (document.readyState === "complete") {
      attach()
      return
    }
    window.addEventListener("load", attach, { once: true })
    return () => window.removeEventListener("load", attach)
  }, [src])

  return (
    <div className="relative overflow-hidden rounded-media after:pointer-events-none after:absolute after:inset-0 after:rounded-media after:border after:border-line-strong">
      <video
        ref={ref}
        aria-label={label}
        className="block aspect-video w-full object-cover"
        poster={poster}
        autoPlay={!reducedMotion}
        controls={reducedMotion}
        muted
        loop
        playsInline
        preload={reducedMotion ? "none" : "auto"}
      />
    </div>
  )
}
