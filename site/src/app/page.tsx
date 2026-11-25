import Link from "next/link"
import { preload } from "react-dom"

import { guides } from "@/config/guides"
import { comparison, faq, features, site, steps } from "@/config/site"
import { versioned } from "@/lib/assets"
import { formatReleaseDate, loadReleases } from "@/lib/changelog"
import { extensionTests, roundedCount } from "@/lib/stats"
import { buildStructuredData } from "@/lib/structured-data"
import { ButtonLink } from "@/components/button-link"
import { CountUp } from "@/components/count-up"
import { DemoVideo } from "@/components/demo-video"
import { FeatureCard } from "@/components/feature-card"
import { HeroLines } from "@/components/hero-lines"
import { InstallCommand } from "@/components/install-command"
import { LazyFrame } from "@/components/lazy-frame"
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

/** A changelog line as plain text: no emphasis, code ticks or link targets. */
const plain = (text: string) =>
  text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/(\*\*|__|`|_)/g, "")

export default function Home() {
  // The demo's poster is the largest thing on the first screen: fetch it first.
  const poster = versioned("/demo-loop-poster.webp")
  preload(poster, { as: "image", fetchPriority: "high" })
  const releases = loadReleases()
  const [latest] = releases
  const numbers = [
    {
      value: roundedCount(extensionTests()),
      label: "tests",
      note: "unit and browser tests on every change",
    },
    {
      value: String(releases.length),
      label: "releases",
      note: `since ${formatReleaseDate(releases.at(-1)!.date)}`,
    },
    {
      value: "0",
      label: "telemetry",
      note: "only talks to your local OpenCode",
    },
    {
      value: "MIT",
      label: "open source",
      note: "free, source on GitHub",
    },
  ]
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
          <div className="relative isolate grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-end lg:gap-16">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-y-24 -right-8 left-0 -z-10 hidden lg:block"
            >
              <HeroLines />
            </div>
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
              <p className="max-w-120 text-lead text-muted-foreground">
                {site.lead}
              </p>
              <div className="mt-8 flex flex-wrap gap-x-5 gap-y-4">
                <ButtonLink href={site.links.marketplace} variant="primary">
                  Install for VS Code
                </ButtonLink>
                <ButtonLink href={site.links.openVsx}>Open VSX</ButtonLink>
              </div>
            </div>
          </div>

          <div className="relative mt-14 lg:mt-16">
            <InstallCommand />
          </div>

          <div className="mt-10 lg:mt-12">
            <DemoVideo
              label="Demo of Sidecar: a prompt landing on the timeline, its diff, and live subagents"
              src={versioned("/demo-loop.mp4")}
              poster={poster}
            />
            <p className="mt-4 text-sm text-subtle-foreground">
              The real extension, replaying a scripted session.{" "}
              <a href={site.links.video} className={inlineLink}>
                Watch the one-minute film
              </a>
            </p>
          </div>
        </div>
      </header>

      {/* A full-width band: the page rails stop here, so the strip reads edge to edge. */}
      <section
        aria-label="Works with"
        className="border-t border-line bg-raised"
      >
        <div className="container-page flex flex-col gap-5 py-10 lg:flex-row lg:items-center lg:gap-12">
          <p className="shrink-0 eyebrow">Works in</p>
          {/* Below desktop width the names glide by as a ticker: the list, then a copy
              of it hidden from assistive tech, moving half the track's width per loop. */}
          <div className="ticker -mx-5 overflow-hidden md:-mx-8 lg:mx-0 lg:overflow-visible">
            <div className="ticker-track flex w-max lg:w-auto">
              {[false, true].map((copy) => (
                <ul
                  key={String(copy)}
                  aria-label={copy ? undefined : "Works in"}
                  aria-hidden={copy || undefined}
                  className={`flex shrink-0 gap-x-10 pr-10 text-[1.375rem] font-medium tracking-[-0.02em] text-muted-foreground lg:flex-wrap lg:pr-0 ${
                    copy ? "lg:hidden" : ""
                  }`}
                >
                  {site.editors.map((editor) => (
                    <li key={editor} className="whitespace-nowrap">
                      {editor}
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          </div>
          <p className="text-sm leading-relaxed text-subtle-foreground lg:ml-auto lg:max-w-[16rem] lg:text-right">
            With any model OpenCode supports, local ones included.
          </p>
        </div>
      </section>

      <main>
        <Section id="try" index="01" label="Try it" crosses={false}>
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
            <LazyFrame
              src="/demo/index.html"
              title="Interactive demo of the Sidecar panel"
              className="h-[680px] w-full overflow-hidden rounded-media border border-line-strong bg-raised"
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

        {/* A full-width band, like "Works in": the rails stop here. */}
        <section
          aria-label="Sidecar in numbers"
          className="border-t border-line bg-raised"
        >
          <div className="container-page">
            <ul
              aria-label="Sidecar in numbers"
              className="grid grid-cols-2 lg:grid-cols-4"
            >
              {numbers.map(({ value, label, note }) => (
                <li
                  key={label}
                  className="-mb-px border-b border-line py-8 pr-5 odd:border-r even:pl-5 lg:-mr-px lg:border-r lg:border-b-0 lg:px-8 lg:py-10 lg:first:pl-0 lg:last:border-r-0"
                >
                  <span className="block text-[clamp(2.25rem,4vw,3rem)] leading-none font-medium tracking-[-0.04em] tabular-nums">
                    <CountUp value={value} />
                  </span>
                  <span className="mt-3 block eyebrow">{label}</span>
                  <span className="mt-2 block text-sm leading-relaxed text-subtle-foreground">
                    {note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <Section id="compare" index="03" label="Compare" crosses={false}>
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

        <Section id="updates" index="05" label="Latest updates">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 id="updates" className="text-h2">
              Latest updates
            </h2>
            <Link
              href="/changelog"
              className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase transition-[color] duration-150 hover:text-foreground"
            >
              All releases →
            </Link>
          </div>
          <ul className="mt-12 grid overflow-hidden rounded-media border border-line md:grid-cols-3">
            {releases.slice(0, 3).map((release) => {
              const items = [
                ...release.intro,
                ...release.sections.flatMap((section) => section.items),
              ]
              return (
                <li
                  key={release.version}
                  className="relative -mr-px -mb-px flex flex-col border-r border-b border-line p-7 transition-[background-color] duration-200 hover:bg-raised"
                >
                  <Link
                    href={`/changelog#v${release.version}`}
                    className="text-[1.75rem] leading-none font-medium tracking-[-0.03em] after:absolute after:inset-0"
                  >
                    {release.version}
                    <span className="sr-only">
                      , {formatReleaseDate(release.date)}
                    </span>
                  </Link>
                  <time
                    dateTime={release.date}
                    className="mt-3 eyebrow"
                    aria-hidden="true"
                  >
                    {formatReleaseDate(release.date)}
                  </time>
                  <p className="mt-5 line-clamp-3 text-[15px] leading-relaxed text-muted-foreground">
                    {plain(items[0] ?? "")}
                  </p>
                  <span className="mt-auto pt-6 font-mono text-xs tracking-[0.08em] text-subtle-foreground uppercase">
                    {items.length === 1
                      ? "1 change"
                      : `${items.length} changes`}{" "}
                    →
                  </span>
                </li>
              )
            })}
          </ul>
        </Section>

        <Section id="faq" index="06" label="FAQ">
          <div className="grid lg:grid-cols-[1fr_2fr] lg:gap-20">
            <div>
              <h2
                id="faq"
                className="sr-only lg:not-sr-only lg:sticky lg:top-12 lg:text-h2"
              >
                Questions
              </h2>
            </div>
            <div>
              {faq.map(({ question, answer }) => (
                <details
                  key={question}
                  className="group border-t border-line first:border-t-0"
                >
                  <summary className="-mx-3 my-1 flex cursor-pointer list-none items-center justify-between gap-6 rounded-lg px-3 py-4 transition-[background-color,color] duration-150 hover:text-foreground-hover focus-visible:bg-raised focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-line-hover [&::-webkit-details-marker]:hidden">
                    <h3 className="text-h3">{question}</h3>
                    {/* A thin plus; its upright fades out to leave a minus when open. */}
                    <span
                      aria-hidden="true"
                      className="relative size-3 shrink-0 text-muted-foreground transition-[color] duration-150 group-hover:text-foreground"
                    >
                      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current" />
                      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-current transition-[transform,opacity] duration-200 group-open:scale-y-0 group-open:opacity-0" />
                    </span>
                  </summary>
                  <p className="max-w-[42rem] pb-6 leading-relaxed text-muted-foreground">
                    {answer}
                  </p>
                </details>
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
            <div className="mt-9 grid w-full max-w-sm grid-cols-2 gap-3 sm:flex sm:w-auto sm:max-w-none sm:flex-wrap sm:justify-center">
              <ButtonLink
                href={site.links.marketplace}
                variant="primary"
                className="col-span-2"
              >
                VS Code Marketplace
              </ButtonLink>
              <ButtonLink
                href={site.links.openVsx}
                className="px-3! whitespace-nowrap sm:px-6!"
              >
                Open VSX
              </ButtonLink>
              <ButtonLink
                href={site.links.source}
                className="px-3! whitespace-nowrap sm:px-6!"
              >
                Source on GitHub
              </ButtonLink>
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
