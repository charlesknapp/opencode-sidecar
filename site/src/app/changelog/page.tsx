import type { Metadata } from "next"

import { site } from "@/config/site"
import { formatReleaseDate, loadReleases } from "@/lib/changelog"
import { InlineMarkdown } from "@/components/inline-markdown"
import { SiteFooter, SiteNav } from "@/components/site-chrome"

export const metadata: Metadata = {
  title: `Changelog · ${site.name}`,
  description: `Every release of ${site.name}, newest first.`,
  alternates: { canonical: "/changelog" },
}

export default function Changelog() {
  const releases = loadReleases()
  return (
    <>
      <header>
        <SiteNav />
        <div className="container-page pt-14 pb-12 lg:pt-24">
          <h1 className="text-display">Changelog</h1>
          <p className="mt-6 max-w-2xl text-lead text-muted-foreground">
            Every release of Sidecar for OpenCode, newest first. Updates install
            automatically from the{" "}
            <a
              href={site.links.marketplace}
              className="text-foreground underline underline-offset-4"
            >
              Marketplace
            </a>{" "}
            and{" "}
            <a
              href={site.links.openVsx}
              className="text-foreground underline underline-offset-4"
            >
              Open VSX
            </a>
            .
          </p>
        </div>
      </header>
      <main className="container-page pb-24">
        {releases.map((release) => (
          <section
            key={release.version}
            aria-labelledby={`v${release.version}`}
            className="grid gap-6 border-t border-line py-12 lg:grid-cols-[1fr_3fr]"
          >
            <h2 id={`v${release.version}`} className="text-h2">
              {release.version}
              <time
                dateTime={release.date}
                className="mt-2 block text-[15px] tracking-normal text-muted-foreground"
              >
                {formatReleaseDate(release.date)}
              </time>
            </h2>
            <div className="max-w-3xl">
              {release.intro.map((paragraph) => (
                <p key={paragraph} className="mb-5 leading-relaxed">
                  <InlineMarkdown text={paragraph} />
                </p>
              ))}
              {release.sections.map((section, index) => (
                <div key={section.title ?? index} className="mb-8 last:mb-0">
                  {section.title && (
                    <h3 className="mb-3 text-h3">{section.title}</h3>
                  )}
                  <ul className="space-y-3">
                    {section.items.map((item) => (
                      <li
                        key={item}
                        className="flex gap-3 leading-relaxed text-muted-foreground"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-[0.7em] size-1 shrink-0 rounded-full bg-muted-foreground"
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
        ))}
      </main>
      <SiteFooter />
    </>
  )
}
