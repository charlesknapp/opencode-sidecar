"use client"

import { useEffect, useRef, useState } from "react"

// An iframe that loads only as it nears the viewport. The browser's own
// loading="lazy" starts far too early on phones, where it then competes with the
// first screen for bandwidth.
export function LazyFrame({
  src,
  title,
  className = "",
}: {
  src: string
  title: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || !("IntersectionObserver" in window)) {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: "400px 0px" }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className={className}>
      {near && (
        <iframe
          src={src}
          title={title}
          className="size-full rounded-[inherit]"
        />
      )}
    </div>
  )
}
