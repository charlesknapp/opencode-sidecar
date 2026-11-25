import type { GuideBlock } from "@/config/guides"
import { CopyButton } from "@/components/copy-button"
import { FeatureArt } from "@/components/feature-art"
import { FeatureCell } from "@/components/feature-cell"
import { InlineMarkdown } from "@/components/inline-markdown"

export const anchorFor = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

function Block({ block }: { block: GuideBlock }) {
  switch (block.type) {
    case "h2":
      return (
        <h2
          id={anchorFor(block.text)}
          className="mt-16 scroll-mt-8 text-[1.5rem] leading-tight font-medium tracking-[-0.02em] first:mt-0"
        >
          {block.text}
        </h2>
      )
    case "p":
      return (
        <p className="mt-5 leading-relaxed text-muted-foreground">
          <InlineMarkdown text={block.text} />
        </p>
      )
    case "steps":
      return (
        <ol className="mt-6 space-y-5">
          {block.items.map((item, index) => (
            <li key={item} className="flex gap-5">
              <span className="w-6 shrink-0 pt-[0.2em] font-mono text-[13px] text-subtle-foreground tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="leading-relaxed">
                <InlineMarkdown text={item} />
              </span>
            </li>
          ))}
        </ol>
      )
    case "list":
      return (
        <ul className="mt-5 space-y-3">
          {block.items.map((item) => (
            <li
              key={item}
              className="flex gap-3 leading-relaxed text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="mt-[0.75em] h-px w-2 shrink-0 bg-subtle-foreground"
              />
              <span>
                <InlineMarkdown text={item} />
              </span>
            </li>
          ))}
        </ul>
      )
    case "code":
      return (
        <figure className="mt-6 border border-line-strong bg-[#09090a]">
          <figcaption className="flex items-center justify-between border-b border-line-strong py-1 pr-2 pl-5 eyebrow">
            {block.label}
            <CopyButton text={block.code} label={`Copy ${block.label}`} />
          </figcaption>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-foreground">
            <code>{block.code}</code>
          </pre>
        </figure>
      )
    case "note":
      return (
        <p className="mt-6 border-l border-line-hover pl-5 text-[15px] leading-relaxed text-muted-foreground">
          <InlineMarkdown text={block.text} />
        </p>
      )
    case "art":
      return (
        <FeatureCell as="figure" className="mt-8">
          <div className="relative aspect-[5/4] w-full max-w-[26rem] overflow-hidden rounded-media border border-line-strong">
            <FeatureArt name={block.name} />
          </div>
          <figcaption className="mt-3 text-sm text-subtle-foreground">
            {block.caption}
          </figcaption>
        </FeatureCell>
      )
  }
}

export function GuideBlocks({ blocks }: { blocks: readonly GuideBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}
