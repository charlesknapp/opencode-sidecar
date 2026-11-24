import type { Metadata } from "next"
import Link from "next/link"

import { site } from "@/config/site"
import { formatReleaseDate, loadReleases } from "@/lib/changelog"
import { InlineMarkdown } from "@/components/inline-markdown"
import { SiteFooter, SiteNav } from "@/components/site-chrome"

export const metadata: Metadata = {
  title: `Changelog · ${site.name}`,
  description: `Every release of ${site.name}, newest first.`,
  alternates: { canonical: "/changelog" },
}

const asideLink =
  "flex min-h-11 items-center justify-between border-t border-line font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase transition-[color] duration-150 hover:text-foreground"

export default function Changelog() {
  const releases = loadReleases()
  const [latest] = releases
  return (
    <>
      <SiteNav />
      <div className="relative container-page xl:border-x xl:border-line">
        <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-16">
          <header className="pt-14 pb-12 lg:sticky lg:top-0 lg:self-start lg:pt-24">
            <p className="eyebrow">Changelog</p>
            <h1 className="mt-5 text-h2">Every release, newest first.</h1>
            <p className="mt-5 leading-relaxed text-muted-foreground">
              Updates install automatically from the VS Code Marketplace and
              Open VSX.
            </p>
            <nav
              aria-label="Release links"
              className="mt-10 border-b border-line"
            >
              <Link href={`#v${latest.version}`} className={asideLink}>
                Latest
                <span className="text-foreground">v{latest.version}</span>
              </Link>
              <a href={site.links.marketplace} className={asideLink}>
                VS Code Marketplace <span aria-hidden="true">↗</span>
              </a>
              <a href={site.links.openVsx} className={asideLink}>
                Open VSX <span aria-hidden="true">↗</span>
              </a>
              <a href={`${site.links.source}/releases`} className={asideLink}>
                GitHub releases <span aria-hidden="true">↗</span>
              </a>
            </nav>
          </header>

          <main className="pb-24 lg:border-l lg:border-line lg:pt-24 lg:pl-12">
            <ol>
              {releases.map((release) => (
                <li
                  key={release.version}
                  className="relative border-t border-line py-12 first:border-t-0 first:pt-0 lg:border-t-0"
                >
                  <section aria-labelledby={`v${release.version}`}>
                    <div className="relative flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span
                        aria-hidden="true"
                        className="absolute top-[0.8em] -left-[calc(3rem+4px)] hidden size-[7px] bg-foreground lg:block"
                      />
                      <h2
                        id={`v${release.version}`}
                        className="scroll-mt-8 text-h2"
                      >
                        {release.version}
                      </h2>
                      <time
                        dateTime={release.date}
                        className="font-mono text-xs tracking-[0.08em] text-subtle-foreground uppercase"
                      >
                        {formatReleaseDate(release.date)}
                      </time>
                    </div>
                    <div className="mt-6 max-w-3xl">
                      {release.intro.map((paragraph) => (
                        <p key={paragraph} className="mb-5 leading-relaxed">
                          <InlineMarkdown text={paragraph} />
                        </p>
                      ))}
                      {release.sections.map((section, index) => (
                        <div
                          key={section.title ?? index}
                          className="mb-8 last:mb-0"
                        >
                          {section.title && (
                            <h3 className="mb-3 eyebrow text-muted-foreground">
                              {section.title}
                            </h3>
                          )}
                          <ul className="space-y-3">
                            {section.items.map((item) => (
                              <li
                                key={item}
                                className="flex gap-3 leading-relaxed text-muted-foreground"
                              >
                                <span
                                  aria-hidden="true"
                                  className="mt-[0.7em] h-px w-2 shrink-0 bg-subtle-foreground"
                                />
                                <span>
                                  <InlineMarkdown text={item} />
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </section>
                </li>
              ))}
            </ol>
          </main>
        </div>
      </div>
      <SiteFooter />
    </>
  )
}
