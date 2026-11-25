import Link from "next/link"

import { guides } from "@/config/guides"
import { site } from "@/config/site"
import { loadReleases } from "@/lib/changelog"
import { Mark } from "@/components/mark"
import { Cross } from "@/components/section"
import { WordmarkSpotlight } from "@/components/wordmark-spotlight"

export function SiteNav() {
  return (
    <div className="border-b border-line">
      <nav
        className="container-page flex h-16 items-center justify-between xl:border-x xl:border-line"
        aria-label="Site"
      >
        <Link
          href="/"
          className="flex min-h-11 items-center gap-2.5 text-[15px] font-medium"
        >
          <Mark className="size-7" />
          {site.shortName}
        </Link>
        <p className="flex gap-5 text-[15px] text-muted-foreground">
          <Link
            href="/guides"
            className="inline-flex min-h-11 items-center transition-[color] duration-150 hover:text-foreground"
          >
            Guides
          </Link>
          <Link
            href="/changelog"
            className="inline-flex min-h-11 items-center transition-[color] duration-150 hover:text-foreground"
          >
            Changelog
          </Link>
          <a
            href={site.links.source}
            className="inline-flex min-h-11 items-center transition-[color] duration-150 hover:text-foreground"
          >
            GitHub
          </a>
        </p>
      </nav>
    </div>
  )
}

const footerLinks = [
  {
    title: "Install",
    links: [
      ["VS Code Marketplace", site.links.marketplace],
      ["Open VSX", site.links.openVsx],
      ["Open in VS Code", site.links.openInVsCode],
    ],
  },
  {
    title: "Project",
    links: [
      ["Changelog", "/changelog"],
      ["Source on GitHub", site.links.source],
      ["Report an issue", site.links.issues],
      ["Rate it", site.links.rate],
    ],
  },
  {
    title: "Guides",
    links: guides.map(({ slug, short }) => [short, `/guides/${slug}`] as const),
  },
  {
    title: "More",
    links: [
      ["OpenCode", site.links.opencode],
      ["The one-minute film", site.links.video],
      ["llms.txt", "/llms.txt"],
    ],
  },
] as const

const footerLink =
  "inline-block py-1.5 leading-snug text-muted-foreground transition-[color] duration-150 hover:text-foreground"

export function SiteFooter() {
  const [latest] = loadReleases()
  return (
    <footer className="border-t border-line">
      <div className="relative container-page pt-16 pb-10 xl:border-x xl:border-line">
        <Cross side="left" />
        <Cross side="right" />
        <div className="grid gap-12 md:grid-cols-2 md:gap-8 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center gap-2.5 font-medium"
            >
              <Mark className="size-7" />
              {site.name}
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
              The OpenCode coding agent in a chat panel beside your code.
            </p>
            <Link
              href="/changelog"
              className="mt-6 inline-flex min-h-9 items-center gap-2.5 font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase transition-[color] duration-150 hover:text-foreground"
            >
              <span aria-hidden="true" className="relative size-1.5">
                <span className="absolute inset-0 animate-ping bg-[#73c991] opacity-60 [animation-duration:2.4s] motion-reduce:hidden" />
                <span className="absolute inset-0 bg-[#73c991]" />
              </span>
              v{latest.version} · latest release
            </Link>
          </div>
          {footerLinks.map((group) => (
            <div key={group.title}>
              <h2 className="eyebrow">{group.title}</h2>
              <ul className="mt-4">
                {group.links.map(([name, href]) => (
                  <li key={name}>
                    {href.startsWith("/") ? (
                      <Link href={href} className={footerLink}>
                        {name}
                      </Link>
                    ) : (
                      <a href={href} className={footerLink}>
                        {name}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-16 mb-10">
          <WordmarkSpotlight base={<Wordmark />} lit={<Wordmark lit />} />
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-6 text-sm text-subtle-foreground md:flex-row md:justify-between md:gap-10">
          <p className="max-w-2xl">
            An independent community project, not affiliated with OpenCode. Free
            and open source under the MIT license. This site counts visits with
            cookieless Vercel Analytics; the extension itself collects nothing.
          </p>
          <p className="shrink-0 font-mono text-xs tracking-[0.08em] uppercase">
            MIT · {new Date(latest.date).getUTCFullYear()}
          </p>
        </div>
      </div>
    </footer>
  )
}

// The name, large and hatched, in the manner of a blueprint. `lit` is the brighter
// copy the footer's spotlight reveals under the mouse; each copy has its own ids.
function Wordmark({ lit = false }: { lit?: boolean }) {
  const id = lit ? "wordmark-lit" : "wordmark"
  const hatch = lit ? "#3a3a41" : "#202024"
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1000 214"
      className={`block w-full ${lit ? "text-subtle-foreground" : "text-line-strong"}`}
    >
      <defs>
        <pattern
          id={`${id}-hatch`}
          width="7"
          height="7"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          {/* Two lines a tile apart drift one tile, so the hatch flows without a seam. */}
          <g className="hatch-drift">
            <line x1="0" y1="0" x2="0" y2="7" stroke={hatch} strokeWidth="2" />
            <line
              x1="-7"
              y1="0"
              x2="-7"
              y2="7"
              stroke={hatch}
              strokeWidth="2"
            />
          </g>
        </pattern>
        {/* The outline is a ring around the letters' combined shape. A stroke would also
            trace where a glyph's own outlines overlap, leaving notches inside "a" and "r". */}
        <filter id={`${id}-outline`} x="-1%" y="-5%" width="102%" height="110%">
          <feMorphology
            in="SourceAlpha"
            operator="dilate"
            radius="1.1"
            result="grown"
          />
          <feComposite
            in="grown"
            in2="SourceAlpha"
            operator="out"
            result="ring"
          />
          <feFlood floodColor="currentColor" />
          <feComposite in2="ring" operator="in" />
        </filter>
      </defs>
      {[
        { fill: `url(#${id}-hatch)` },
        { fill: "#000", filter: `url(#${id}-outline)` },
      ].map((paint) => (
        <text
          key={paint.fill}
          x="2"
          y="196"
          textLength="996"
          lengthAdjust="spacingAndGlyphs"
          fontSize="262"
          fontWeight="600"
          letterSpacing="-8"
          {...paint}
          style={{ fontFamily: "var(--font-geist-sans)" }}
        >
          sidecar
        </text>
      ))}
    </svg>
  )
}
