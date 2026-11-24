import Link from "next/link"

import { guides } from "@/config/guides"
import { comparison, faq, features, site, steps } from "@/config/site"
import { formatReleaseDate, loadReleases } from "@/lib/changelog"
import { buildStructuredData } from "@/lib/structured-data"
import { ButtonLink } from "@/components/button-link"
import { DemoVideo } from "@/components/demo-video"
import { FeatureCard } from "@/components/feature-card"
import { InstallCommand } from "@/components/install-command"
import { Mark } from "@/components/mark"
import { Cross, Section } from "@/components/section"
import { SiteFooter, SiteNav } from "@/components/site-chrome"

const jsonLd = JSON.stringify(buildStructuredData({ site, faq })).replace(
  /</g,
  "\\u003c"
)

const tryIt = [
  "Watch each step land on the timeline as the agent works.",
  "Answer its permission request: Yes, Always, No, or tell it what to do instead.",
  "Stop a single subagent, or press Stop to halt the whole task.",
  "Start over with the New session button at the top.",
] as const

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
        <div className="relative container-page pt-14 pb-20 lg:pt-24 lg:pb-28 xl:border-x xl:border-line">
          <Cross side="left" />
          <Cross side="right" />
          <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-end lg:gap-16">
            <div>
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
              <h1 className="mt-8 text-display">
                OpenCode,{" "}
                <span className="text-muted-foreground">in your sidebar.</span>
              </h1>
            </div>
            <div>
              <p className="max-w-[34rem] text-lead text-muted-foreground">
                {site.summary}
              </p>
              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-4">
                <ButtonLink href={site.links.marketplace} variant="primary">
                  Install for VS Code
                </ButtonLink>
                <ButtonLink href={site.links.openVsx}>Open VSX</ButtonLink>
              </div>
            </div>
          </div>

          <div className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-4 lg:mt-16 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <InstallCommand />
            <p className="text-sm text-subtle-foreground lg:max-w-[16rem]">
              Free · Open source (MIT) · No telemetry ·{" "}
              <a
                href={site.links.openInVsCode}
                className={`${inlineLink} whitespace-nowrap`}
              >
                Open it in VS Code directly
              </a>
            </p>
          </div>

          <div className="mt-10 lg:mt-12">
            <DemoVideo label="Demo of Sidecar: a prompt landing on the timeline, its diff, and live subagents" />
            <p className="mt-4 text-sm text-subtle-foreground">
              The real extension, replaying a scripted session.{" "}
              <a href={site.links.video} className={inlineLink}>
                Watch the one-minute film
              </a>
            </p>
          </div>
        </div>
      </header>

      <main>
        <Section id="try" index="01" label="Try it">
          <div className="grid gap-12 lg:grid-cols-[1fr_440px] lg:items-center lg:gap-20">
            <div>
              <h2 id="try" className="max-w-lg text-h2">
                Try the real panel, right here.
              </h2>
              <p className="mt-6 max-w-md text-lead text-muted-foreground">
                This is Sidecar&apos;s actual interface running in your browser,
                with a scripted OpenCode on the other end. Send the prompt,
                then:
              </p>
              <ul className="mt-8 max-w-md space-y-4">
                {tryIt.map((line) => (
                  <li
                    key={line}
                    className="flex gap-4 text-[15px] leading-relaxed"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[0.65em] size-1 shrink-0 rounded-full bg-muted-foreground"
                    />
                    {line}
                  </li>
                ))}
              </ul>
              <p className="mt-6 max-w-md text-sm text-subtle-foreground">
                No account and no install. The replies come from a script in
                this page, and nothing is sent anywhere.
              </p>
            </div>
            <iframe
              src="/demo/index.html"
              title="Interactive demo of the Sidecar panel"
              loading="lazy"
              className="h-[680px] w-full rounded-media border border-line-strong bg-raised"
            />
          </div>
        </Section>

        <Section id="features" index="02" label="Features">
          <div>
            <div className="grid gap-6 lg:grid-cols-2 lg:items-end">
              <h2 id="features" className="max-w-xl text-h2">
                See and steer everything the agent does.
              </h2>
              <p className="max-w-xl text-lead text-muted-foreground lg:justify-self-end">
                Every step, subagent and permission request in a panel beside
                your code, built on OpenCode&apos;s own API.
              </p>
            </div>
            <ul className="mt-14 grid overflow-hidden rounded-media border border-line md:grid-cols-2 lg:mt-16 lg:grid-cols-3">
              {features.map((feature, index) => (
                <FeatureCard
                  key={feature.title}
                  feature={feature}
                  index={index}
                />
              ))}
            </ul>
          </div>
        </Section>

        <Section id="compare" index="03" label="Compare">
          <div>
            <h2 id="compare" className="max-w-2xl text-h2">
              Sidecar or the official OpenCode extension?
            </h2>
            <p className="mt-6 max-w-2xl text-lead text-muted-foreground">
              The official extension,{" "}
              <code className="font-mono text-[0.92em] whitespace-nowrap text-foreground">
                sst-dev.opencode
              </code>
              , opens OpenCode&apos;s terminal UI in a split terminal. Sidecar
              is a graphical chat panel instead. Both use the same OpenCode, so
              you can install both and move between them.
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
        </Section>

        <Section id="start" index="04" label="Get started">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-20">
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
              <p className="mt-10 eyebrow">Guides</p>
              <ul className="mt-3 max-w-md">
                {guides.map(({ slug, short }) => (
                  <li key={slug}>
                    <Link
                      href={`/guides/${slug}`}
                      className="group inline-flex min-h-10 items-center gap-2 text-muted-foreground transition-[color] duration-150 hover:text-foreground"
                    >
                      {short}
                      <span
                        aria-hidden="true"
                        className="transition-transform duration-150 group-hover:translate-x-0.5"
                      >
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <ol className="space-y-9 lg:pt-1">
              {steps.map((step, index) => (
                <li key={step} className="flex gap-6">
                  <span className="w-6 shrink-0 pt-[0.2em] font-mono text-[13px] text-subtle-foreground tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="max-w-[30rem] text-[17px] leading-relaxed">
                    {step}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </Section>

        <Section id="faq" index="05" label="FAQ">
          <div className="grid gap-12 lg:grid-cols-[1fr_2fr] lg:gap-20">
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
        </Section>

        <Section id="cta">
          <div className="flex flex-col items-center text-center">
            <Mark className="size-14" />
            <h2 id="cta" className="mt-8 text-h2">
              Try it in your editor.
            </h2>
            <p className="mt-4 text-lead text-muted-foreground">
              Search “OpenCode Sidecar” in your Extensions view.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <ButtonLink href={site.links.marketplace} variant="primary">
                VS Code Marketplace
              </ButtonLink>
              <ButtonLink href={site.links.openVsx}>Open VSX</ButtonLink>
              <ButtonLink href={site.links.source}>Source on GitHub</ButtonLink>
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
        </Section>
      </main>

      <SiteFooter />
    </>
  )
}
