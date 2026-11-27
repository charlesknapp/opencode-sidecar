"use client"

import { useEffect, useRef } from "react"

const LINES = 14

/**
 * The hero's line bundle, back at the end of the page: thin lines from both sides
 * that gather into Sidecar's mark, slowly undulating. Decorative: hidden from
 * assistive tech, paused when off screen or in a hidden tab, and drawn once, still,
 * with reduced motion. `target` names the element the lines meet at.
 */
export function CtaLines({ target }: { target: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext?.("2d")
    if (!canvas || !ctx) return
    const still =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    let width = 0
    let height = 0
    let tx = 0
    let ty = 0
    let frame = 0
    let visible = false
    let last = 0

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const box = canvas.getBoundingClientRect()
      const mark = document.getElementById(target)?.getBoundingClientRect()
      tx = mark ? mark.left + mark.width / 2 - box.left : width / 2
      ty = mark ? mark.top + mark.height / 2 - box.top : height * 0.2
    }

    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height)
      const t = time / 1000
      for (const side of [-1, 1]) {
        for (let i = 0; i < LINES; i++) {
          const k = i / (LINES - 1)
          const wave = Math.sin(t * 0.35 + k * 2.4 + side) * 18
          // From the side, spread over the section's height, into the mark.
          const x0 = side < 0 ? -width * 0.02 : width * 1.02
          const y0 = height * (0.05 + k * 0.9)
          const x1 = tx + side * width * (0.32 - k * 0.06)
          const y1 = y0 + wave
          const x2 = tx + side * width * 0.1
          const y2 = ty + (k - 0.5) * 40 - wave * 0.6
          const alpha = 0.035 + 0.08 * Math.sin(Math.PI * k)
          ctx.strokeStyle = `rgba(237, 237, 239, ${alpha.toFixed(3)})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.bezierCurveTo(x1, y1, x2, y2, tx, ty)
          ctx.stroke()
        }
      }
    }

    const loop = (time: number) => {
      frame = requestAnimationFrame(loop)
      if (!visible || document.hidden || time - last < 33) return
      last = time
      draw(time)
    }

    resize()
    draw(0)
    const resizer = new ResizeObserver(() => {
      resize()
      draw(last)
    })
    resizer.observe(canvas)
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      if (visible) resize()
    })
    observer.observe(canvas)
    if (!still) frame = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frame)
      resizer.disconnect()
      observer.disconnect()
    }
  }, [target])

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 size-full [mask-image:radial-gradient(ellipse_60%_80%_at_50%_30%,black_35%,transparent_100%)]"
    />
  )
}
