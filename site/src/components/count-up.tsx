"use client"

import { useEffect, useRef, useState } from "react"

/**
 * A figure that counts up from zero the first time it scrolls into view. The real
 * value is always in the page (for screen readers, search engines and no-JS
 * visitors); only the visible copy animates. Values that aren't numbers, and
 * reduced motion, show the value as it is.
 */
export function CountUp({ value }: { value: string }) {
  const match = /^(\d+)(.*)$/.exec(value)
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(value)

  useEffect(() => {
    const node = ref.current
    if (!match || !node) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    if (typeof IntersectionObserver === "undefined") return
    const target = Number(match[1])
    const suffix = match[2]
    let frame = 0
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        observer.disconnect()
        const start = performance.now()
        const duration = 900
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration)
          const eased = 1 - Math.pow(1 - t, 3)
          setShown(`${Math.round(target * eased)}${t === 1 ? suffix : ""}`)
          if (t < 1) frame = requestAnimationFrame(tick)
        }
        setShown(`0`)
        frame = requestAnimationFrame(tick)
      },
      { threshold: 0.6 }
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
    // The value is fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!match) return <>{value}</>
  return (
    <span ref={ref}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true">{shown}</span>
    </span>
  )
}
