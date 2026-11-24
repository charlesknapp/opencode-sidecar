import type { ReactNode } from "react"

const TOKEN =
  /(\*\*[^*]+\*\*|`[^`]+`|(?<![\w])_[^_]+_(?![\w])|\[[^\]]+\]\([^)\s]+\))/g
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/

const renderToken = (token: string, key: number): ReactNode => {
  if (token.startsWith("**"))
    return (
      <strong key={key} className="font-medium text-foreground">
        {token.slice(2, -2)}
      </strong>
    )
  if (token.startsWith("`"))
    return (
      <code
        key={key}
        className="rounded-[4px] bg-raised px-1 py-0.5 font-mono text-[0.9em] text-foreground"
      >
        {token.slice(1, -1)}
      </code>
    )
  if (token.startsWith("_")) return <em key={key}>{token.slice(1, -1)}</em>
  const link = LINK.exec(token)
  if (link)
    return (
      <a
        key={key}
        href={link[2]}
        className="text-foreground underline underline-offset-4"
      >
        {link[1]}
      </a>
    )
  return token
}

export function InlineMarkdown({ text }: { text: string }) {
  return (
    <>
      {text
        .split(TOKEN)
        .map((part, index) =>
          index % 2 === 1 ? renderToken(part, index) : part
        )}
    </>
  )
}
