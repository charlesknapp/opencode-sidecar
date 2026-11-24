import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { findGuide, guides } from "@/config/guides"
import { site } from "@/config/site"
import { formatReleaseDate } from "@/lib/changelog"
import { buildGuideStructuredData } from "@/lib/structured-data"
import { anchorFor, GuideBlocks } from "@/components/guide-blocks"
import { InlineMarkdown } from "@/components/inline-markdown"
import { Cross } from "@/components/section"
import { SiteFooter, SiteNav } from "@/components/site-chrome"

type Props = { params: Promise<{ slug: string }> }

export const dynamicParams = false

export async function generateStaticParams() {
  return guides.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guide = findGuide((await params).slug)
  if (!guide) return {}
  const path = `/guides/${guide.slug}`
  return {
    title:
      guide.title.length > 44 ? guide.title : `${guide.title} · ${site.name}`,
    description: guide.description,
    alternates: { canonical: path },
    openGraph: {
      type: "article",
      url: path,
      siteName: site.name,
      title: guide.title,
      description: guide.description,
      modifiedTime: guide.updated,
    },
    twitter: {
      card: "summary_large_image",
      title: guide.title,
      description: guide.description,
    },
  }
}

const asideLink =
  "block py-1.5 text-sm text-muted-foreground transition-[color] duration-150 hover:text-foreground"

export default async function GuidePage({ params }: Props) {
  const guide = findGuide((await params).slug)
  if (!guide) notFound()
  const sections = guide.blocks.flatMap((block) =>
    block.type === "h2" ? [block.text] : []
  )
  const others = guides.filter(({ slug }) => slug !== guide.slug)
  const jsonLd = JSON.stringify(
    buildGuideStructuredData({ site, guide })
  ).replace(/</g, "\\u003c")

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <SiteNav />
      <div className="relative container-page xl:border-x xl:border-line">
        <Cross side="left" />
        <Cross side="right" />
        <div className="grid gap-16 pt-14 pb-24 lg:grid-cols-[minmax(0,1fr)_14rem] lg:pt-20">
          <main className="min-w-0">
            <article className="max-w-[44rem]">
              <nav
                aria-label="Breadcrumb"
                className="flex flex-wrap items-center gap-2 eyebrow"
              >
                <Link
                  href="/guides"
                  className="transition-[color] duration-150 hover:text-foreground"
                >
                  Guides
                </Link>
                <span aria-hidden="true">/</span>
                <span aria-current="page" className="text-muted-foreground">
                  {guide.short}
                </span>
              </nav>
              <h1 className="mt-6 text-[clamp(2.125rem,4.4vw,3.25rem)] leading-[1.05] font-medium tracking-[-0.035em]">
                {guide.title}
              </h1>
              <p className="mt-6 text-lead text-muted-foreground">
                <InlineMarkdown text={guide.summary} />
              </p>
              <p className="mt-6 font-mono text-xs tracking-[0.08em] text-subtle-foreground uppercase">
                Updated{" "}
                <time dateTime={guide.updated}>
                  {formatReleaseDate(guide.updated)}
                </time>
              </p>
              <div className="mt-14 border-t border-line pt-14">
                <GuideBlocks blocks={guide.blocks} />
              </div>
            </article>
          </main>
          <aside className="hidden lg:block">
            <div className="sticky top-8">
              <p className="eyebrow">On this page</p>
              <ul className="mt-3">
                {sections.map((text) => (
                  <li key={text}>
                    <a href={`#${anchorFor(text)}`} className={asideLink}>
                      {text}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-10 eyebrow">More guides</p>
              <ul className="mt-3">
                {others.map(({ slug, short }) => (
                  <li key={slug}>
                    <Link href={`/guides/${slug}`} className={asideLink}>
                      {short}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
      <SiteFooter />
    </>
  )
}
