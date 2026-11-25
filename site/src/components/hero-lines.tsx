"use client"

import { useEffect, useRef } from "react"

const LINES = 30

/**
 * A bundle of thin lines sweeping through the hero, slowly undulating. Decorative:
 * hidden from assistive tech, paused when off screen or in a hidden tab, and drawn
 * once, still, with reduced motion.
 */
export function HeroLines() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext?.("2d")
    if (!canvas || !ctx) return
    const still =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    let width = 0
    let height = 0
    let frame = 0
    let visible = true
    let last = 0

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height)
      const t = time / 1000
      for (let i = 0; i < LINES; i++) {
        const k = i / (LINES - 1)
        const wave = Math.sin(t * 0.35 + k * 2.4) * 22
        const drift = Math.cos(t * 0.22 + k * 1.7) * 16
        // From low on the left of the lead text, up and out past the top right.
        const x0 = width * (0.3 + k * 0.16)
        const y0 = height * 1.04
        const x3 = width * 1.04
        const y3 = height * (-0.02 + k * 0.62)
        const x1 = width * (0.6 + k * 0.12) + drift
        const y1 = height * (0.95 - k * 0.1) + wave
        const x2 = width * (0.74 + k * 0.05) - drift
        const y2 = height * (0.12 + k * 0.5) - wave
        const alpha = 0.04 + 0.09 * Math.sin(Math.PI * k)
        ctx.strokeStyle = `rgba(237, 237, 239, ${alpha.toFixed(3)})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3)
        ctx.stroke()
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
    })
    observer.observe(canvas)
    if (!still) frame = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frame)
      resizer.disconnect()
      observer.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 size-full [mask-image:linear-gradient(to_right,transparent_30%,black_70%)]"
    />
  )
}
