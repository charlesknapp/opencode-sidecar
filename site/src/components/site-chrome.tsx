import Link from "next/link"

import { site } from "@/config/site"
import { loadReleases } from "@/lib/changelog"
import { Mark } from "@/components/mark"
import { Cross } from "@/components/section"

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
    title: "More",
    links: [
      ["OpenCode", site.links.opencode],
      ["The one-minute film", site.links.video],
      ["llms.txt", "/llms.txt"],
    ],
  },
] as const

const footerLink =
  "inline-flex min-h-9 items-center text-muted-foreground transition-[color] duration-150 hover:text-foreground"

export function SiteFooter() {
  const [latest] = loadReleases()
  return (
    <footer className="border-t border-line">
      <div className="relative container-page pt-16 pb-10 xl:border-x xl:border-line">
        <Cross side="left" />
        <Cross side="right" />
        <div className="grid gap-12 md:grid-cols-[1.5fr_repeat(3,1fr)] md:gap-8">
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
              <span aria-hidden="true" className="size-1.5 bg-[#73c991]" />v
              {latest.version} · latest release
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

        <Wordmark />

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

// The name, large and hatched, in the manner of a blueprint.
function Wordmark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1000 214"
      className="mt-16 mb-10 block w-full text-line-strong"
    >
      <defs>
        <pattern
          id="wordmark-hatch"
          width="7"
          height="7"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="7" stroke="#202024" strokeWidth="2" />
        </pattern>
      </defs>
      <text
        x="2"
        y="196"
        textLength="996"
        lengthAdjust="spacingAndGlyphs"
        fontSize="262"
        fontWeight="600"
        letterSpacing="-8"
        fill="url(#wordmark-hatch)"
        stroke="currentColor"
        strokeWidth="1.25"
        style={{ fontFamily: "var(--font-geist-sans)" }}
      >
        sidecar
      </text>
    </svg>
  )
}
