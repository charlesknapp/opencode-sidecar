import type { Metadata } from "next"
import Link from "next/link"

import { guides } from "@/config/guides"
import { site } from "@/config/site"
import { Cross } from "@/components/section"
import { SiteFooter, SiteNav } from "@/components/site-chrome"

export const metadata: Metadata = {
  title: `Guides · ${site.name}`,
  description:
    "How to run OpenCode with local models, install it in Cursor, Windsurf and VSCodium, and keep the agent in check with permissions and Budget Guard.",
  alternates: { canonical: "/guides" },
}

export default function GuidesIndex() {
  return (
    <>
      <SiteNav />
      <main className="relative container-page pt-14 pb-24 lg:pt-24 xl:border-x xl:border-line">
        <Cross side="left" />
        <Cross side="right" />
        <p className="eyebrow">Guides</p>
        <h1 className="mt-5 max-w-2xl text-h2">
          Set up OpenCode in your editor, and keep it in check.
        </h1>
        <ul className="mt-14 grid overflow-hidden rounded-media border border-line md:grid-cols-3">
          {guides.map((guide, index) => (
            <li
              key={guide.slug}
              className="relative -mr-px -mb-px flex flex-col border-r border-b border-line p-7 transition-[background-color] duration-200 hover:bg-raised"
            >
              <span className="font-mono text-xs text-subtle-foreground tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h2 className="mt-4 text-h3">
                <Link
                  href={`/guides/${guide.slug}`}
                  className="after:absolute after:inset-0"
                >
                  {guide.title}
                </Link>
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                {guide.description}
              </p>
              <span
                aria-hidden="true"
                className="mt-auto pt-8 font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase"
              >
                Read the guide →
              </span>
            </li>
          ))}
        </ul>
      </main>
      <SiteFooter />
    </>
  )
}
