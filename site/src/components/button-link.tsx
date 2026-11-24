import type { ReactNode } from "react"

const base =
  "relative inline-flex h-11 items-center justify-center gap-2 px-6 text-[15px] font-medium transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98]"

// The secondary button's hairlines run past its corners, and it fills with a fine
// hatch on hover.
const variants = {
  primary: `${base} bg-foreground text-background hover:bg-foreground-hover`,
  secondary: `${base} text-foreground before:pointer-events-none before:absolute before:-inset-x-2 before:inset-y-0 before:border-y before:border-line-strong after:pointer-events-none after:absolute after:inset-x-0 after:-inset-y-2 after:border-x after:border-line-strong hover:bg-[repeating-linear-gradient(135deg,var(--line)_0_1px,transparent_1px_7px)]`,
} as const

export function ButtonLink({
  href,
  variant = "secondary",
  children,
}: {
  href: string
  variant?: keyof typeof variants
  children: ReactNode
}) {
  return (
    <a href={href} className={variants[variant]}>
      {children}
    </a>
  )
}
