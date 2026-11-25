import type { ReactNode } from "react"

// A "+" where a section's top rule meets the page rails.
export function Cross({ side }: { side: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 11 11"
      className={`absolute top-0 hidden size-[11px] -translate-y-1/2 text-line-hover xl:block ${
        side === "left" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"
      }`}
    >
      <path d="M5.5 0v11M0 5.5h11" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function Section({
  id,
  index,
  label,
  children,
  className = "",
  crosses = true,
}: {
  id: string
  index?: string
  label?: string
  children: ReactNode
  className?: string
  /** False under a full-width band, where the rails don't meet the section's top edge. */
  crosses?: boolean
}) {
  return (
    <section aria-labelledby={id} className="border-t border-line">
      <div
        className={`relative container-page section xl:border-x xl:border-line ${className}`}
      >
        {crosses && <Cross side="left" />}
        {crosses && <Cross side="right" />}
        {label && (
          <p className="mb-10 flex items-center gap-4 eyebrow lg:mb-12">
            <span className="text-muted-foreground tabular-nums">{index}</span>
            <span>{label}</span>
            <span aria-hidden="true" className="rule-in h-px flex-1 bg-line" />
          </p>
        )}
        {children}
      </div>
    </section>
  )
}
