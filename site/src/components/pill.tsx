import type { ReactNode } from "react"

const base =
  "inline-flex h-11 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98]"

const variants = {
  primary: `${base} bg-foreground text-background hover:bg-foreground-hover`,
  secondary: `${base} border border-line-strong text-foreground hover:border-line-hover hover:bg-raised`,
} as const

export function Pill({
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
