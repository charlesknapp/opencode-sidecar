import Link from "next/link"

import { comparison, faq, features, site, steps } from "@/config/site"
import { formatReleaseDate, loadReleases } from "@/lib/changelog"
import { buildStructuredData } from "@/lib/structured-data"
import { DemoVideo } from "@/components/demo-video"
import { FeatureCard } from "@/components/feature-card"
import { Mark } from "@/components/mark"
import { Pill } from "@/components/pill"
import { SiteFooter, SiteNav } from "@/components/site-chrome"

const jsonLd = JSON.stringify(buildStructuredData({ site, faq })).replace(
  /</g,
  "\\u003c"
)

const inlineLink =
  "text-foreground underline decoration-line-hover underline-offset-4 transition-[text-decoration-color] duration-150 hover:decoration-foreground"

export default function Home() {
  const [latest] = loadReleases()
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <header>
        <SiteNav />
        <div className="container-page pt-14 pb-16 lg:pt-24 lg:pb-20">
          <Link
            href="/changelog"
            className="inline-flex h-8 items-center gap-2 rounded-full border border-line-strong px-3.5 text-sm text-muted-foreground transition-[border-color,color] duration-150 hover:border-line-hover hover:text-foreground"
          >
            <span className="font-medium text-foreground">
              v{latest.version}
            </span>
            <span aria-hidden="true" className="h-3 w-px bg-line-strong" />
            {formatReleaseDate(latest.date)} · What&apos;s new →
          </Link>
          <h1 className="mt-8 max-w-4xl text-display">
            OpenCode,{" "}
            <span className="text-muted-foreground">in your sidebar.</span>
          </h1>
          <p className="mt-7 max-w-[38rem] text-lead text-muted-foreground">
            {site.summary}
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Pill href={site.links.marketplace} variant="primary">
              Install for VS Code
            </Pill>
            <Pill href={site.links.openVsx}>
              Open VSX: Cursor, Windsurf, VSCodium
            </Pill>
          </div>
          <p className="mt-6 text-sm text-subtle-foreground">
            Free · Open source (MIT) · No telemetry ·{" "}
            <a href={site.links.openInVsCode} className={inlineLink}>
              Open it in VS Code directly
            </a>
          </p>
        </div>
      </header>

      <main>
        <section
          aria-labelledby="demo"
          className="container-page pb-24 lg:pb-32"
        >
          <h2 id="demo" className="sr-only">
            Demo
          </h2>
          <DemoVideo label="Demo of Sidecar: a prompt landing on the timeline, its diff, and live subagents" />
          <p className="mt-4 text-sm text-subtle-foreground">
            The real extension, replaying a scripted session.{" "}
            <a href={site.links.video} className={inlineLink}>
              Watch the one-minute film
            </a>
          </p>
        </section>

        <section
          aria-labelledby="features"
          className="border-t border-line section"
        >
          <div className="container-page">
            <div className="grid gap-6 lg:grid-cols-2 lg:items-end">
              <h2 id="features" className="max-w-xl text-h2">
                See and steer everything the agent does.
              </h2>
              <p className="max-w-xl text-lead text-muted-foreground lg:justify-self-end">
                Every step, subagent and permission request in a panel beside
                your code, built on OpenCode&apos;s own API.
              </p>
            </div>
            <ul className="mt-14 grid gap-5 md:grid-cols-2 lg:mt-16 lg:grid-cols-3">
              {features.map((feature) => (
                <FeatureCard key={feature.title} feature={feature} />
              ))}
            </ul>
          </div>
        </section>

        <section
          aria-labelledby="compare"
          className="border-t border-line section"
        >
          <div className="container-page">
            <h2 id="compare" className="max-w-2xl text-h2">
              Sidecar or the official OpenCode extension?
            </h2>
            <p className="mt-6 max-w-2xl text-lead text-muted-foreground">
              The official extension, sst-dev.opencode, opens OpenCode&apos;s
              terminal UI in a split terminal. Sidecar is a graphical chat panel
              instead. Both use the same OpenCode, so you can install both and
              move between them.
            </p>
            <dl className="mt-12 md:hidden">
              {comparison.map((row) => (
                <div key={row.topic} className="border-t border-line py-6">
                  <dt className="font-medium">{row.topic}</dt>
                  <dd className="mt-3 text-[15px] leading-relaxed">
                    <span className="text-subtle-foreground">Sidecar · </span>
                    {row.sidecar}
                  </dd>
                  <dd className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                    <span className="text-subtle-foreground">Official · </span>
                    {row.official}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-14 hidden md:block">
              <table className="w-full border-separate border-spacing-0 text-left text-[15px]">
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="w-[18%] pb-4 align-bottom font-normal"
                    >
                      <span className="sr-only">Topic</span>
                    </th>
                    <th
                      scope="col"
                      className="w-[36%] pr-8 pb-4 align-bottom font-normal text-muted-foreground"
                    >
                      Official extension
                    </th>
                    <th
                      scope="col"
                      className="rounded-t-media border-x border-t border-line bg-raised px-6 pt-5 pb-4 align-bottom font-medium"
                    >
                      Sidecar for OpenCode
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row, index) => {
                    const last = index === comparison.length - 1
                    return (
                      <tr key={row.topic} className="align-top">
                        <th
                          scope="row"
                          className="border-t border-line py-5 pr-6 font-medium"
                        >
                          {row.topic}
                        </th>
                        <td className="border-t border-line py-5 pr-8 text-muted-foreground">
                          {row.official}
                        </td>
                        <td
                          className={`border-x border-t border-line bg-raised px-6 py-5 ${
                            last ? "rounded-b-media border-b" : ""
                          }`}
                        >
                          {row.sidecar}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="start"
          className="border-t border-line section"
        >
          <div className="container-page grid gap-12 lg:grid-cols-2 lg:gap-20">
            <div>
              <h2 id="start" className="text-h2">
                Get started in a minute
              </h2>
              <p className="mt-6 max-w-md text-lead text-muted-foreground">
                You need VS Code 1.95 or newer and{" "}
                <a href={site.links.opencodeInstall} className={inlineLink}>
                  OpenCode 2
                </a>
                . Sidecar works with the models you already use in OpenCode,
                local ones included.
              </p>
            </div>
            <ol className="space-y-2">
              {steps.map((step, index) => (
                <li
                  key={step}
                  className="flex gap-5 border-t border-line pt-5 pb-3"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line-strong font-mono text-[13px] text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span className="pt-0.5 leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="faq" className="border-t border-line section">
          <div className="container-page grid gap-12 lg:grid-cols-[1fr_2fr] lg:gap-20">
            <div>
              <h2 id="faq" className="text-h2 lg:sticky lg:top-12">
                Questions
              </h2>
            </div>
            <div>
              {faq.map(({ question, answer }) => (
                <div
                  key={question}
                  className="border-t border-line py-7 first:border-t-0 first:pt-0"
                >
                  <h3 className="text-h3">{question}</h3>
                  <p className="mt-2.5 max-w-[42rem] leading-relaxed text-muted-foreground">
                    {answer}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="cta" className="border-t border-line section">
          <div className="container-page flex flex-col items-center text-center">
            <Mark className="size-14" />
            <h2 id="cta" className="mt-8 text-h2">
              Try it in your editor.
            </h2>
            <p className="mt-4 text-lead text-muted-foreground">
              Search “OpenCode Sidecar” in your Extensions view.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Pill href={site.links.marketplace} variant="primary">
                VS Code Marketplace
              </Pill>
              <Pill href={site.links.openVsx}>Open VSX</Pill>
              <Pill href={site.links.source}>Source on GitHub</Pill>
            </div>
            <p className="mt-9 text-sm text-subtle-foreground">
              Like it?{" "}
              <a href={site.links.rate} className={inlineLink}>
                A rating
              </a>{" "}
              helps other OpenCode users find it. Bugs and ideas go in{" "}
              <a href={site.links.issues} className={inlineLink}>
                Issues
              </a>
              .
            </p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  )
}
