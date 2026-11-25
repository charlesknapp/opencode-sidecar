import type { ReactNode } from "react"

const base =
  "relative inline-flex h-11 items-center justify-center gap-2 px-6 text-[15px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98]"

// The secondary button is solid (nothing behind it shows through), with a plain
// hairline border that brightens on hover over a fine hatch.
const variants = {
  primary: `${base} bg-foreground text-background hover:bg-foreground-hover`,
  secondary: `${base} border border-line-strong bg-background text-foreground hover:border-line-hover hover:bg-[repeating-linear-gradient(135deg,var(--line)_0_1px,var(--background)_1px_7px)]`,
} as const

export function ButtonLink({
  href,
  variant = "secondary",
  className = "",
  children,
}: {
  href: string
  variant?: keyof typeof variants
  className?: string
  children: ReactNode
}) {
  return (
    <a href={href} className={`${variants[variant]} ${className}`}>
      {children}
    </a>
  )
}
