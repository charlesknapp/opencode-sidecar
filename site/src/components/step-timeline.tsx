"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

import type { Step } from "@/config/site"

// Sidecar's timeline dots: a step is waiting, running or done.
const state = (index: number, reached: number) =>
  index < reached ? "done" : index === reached ? "run" : "wait"

const box = {
  wait: "border-line-strong text-muted-foreground",
  run: "border-[#4daafc]/60 text-[#4daafc]",
  done: "border-[#73c991]/50 text-[#73c991]",
}

const dot = {
  wait: "bg-line-hover",
  run: "bg-[#4daafc]",
  done: "bg-[#73c991]",
}

/**
 * The Get started steps as a task timeline that runs while you scroll: each step
 * turns blue as it reaches the middle of the screen, then green once you're past
 * it, and the line to the next step fills in. Without JavaScript the steps read
 * the same, waiting.
 */
export function StepTimeline({
  steps,
  extra,
}: {
  steps: readonly Step[]
  /** Shown under a step, by index: the first step's install command. */
  extra: Readonly<Record<number, ReactNode>>
}) {
  const refs = useRef<(HTMLLIElement | null)[]>([])
  const [reached, setReached] = useState(-1)

  useEffect(() => {
    const nodes = refs.current.filter(Boolean) as HTMLLIElement[]
    const observer = new IntersectionObserver(
      (entries) => {
        // The furthest step whose top is above the middle of the screen.
        const middle = window.innerHeight * 0.55
        let furthest = -1
        nodes.forEach((node, index) => {
          if (node.getBoundingClientRect().top < middle) furthest = index
        })
        if (entries.length) setReached(furthest)
      },
      { rootMargin: "0px 0px -45% 0px", threshold: [0, 1] }
    )
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [])

  return (
    <ol className="mt-12">
      {steps.map((step, index) => {
        const now = state(index, reached)
        return (
          <li
            key={step.title}
            ref={(node) => {
              refs.current[index] = node
            }}
            data-state={now}
            className="relative flex gap-6 pb-10 last:pb-0"
          >
            {index < steps.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute top-9 bottom-1 left-[13px] w-px overflow-hidden bg-line-strong"
              >
                <span
                  className={`step-fill block size-full origin-top bg-[#73c991]/60 ${
                    now === "done" ? "scale-y-100" : "scale-y-0"
                  }`}
                />
              </span>
            )}
            <span
              aria-hidden="true"
              className={`step-box relative grid size-7 shrink-0 place-items-center border bg-background font-mono text-xs tabular-nums ${box[now]}`}
            >
              {String(index + 1).padStart(2, "0")}
              <span
                className={`step-box absolute -top-[3px] -right-[3px] size-[7px] rounded-full ${dot[now]} ${
                  now === "run" ? "animate-pulse" : ""
                }`}
              />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h3 className="text-[17px] font-medium">
                <span className="sr-only">Step {index + 1}: </span>
                {step.title}
              </h3>
              <p className="mt-1.5 max-w-[34rem] leading-relaxed text-muted-foreground">
                {step.text}
              </p>
              {extra[index]}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
