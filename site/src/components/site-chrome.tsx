import Link from "next/link"

import { site } from "@/config/site"
import { Mark } from "@/components/mark"

export function SiteNav() {
  return (
    <nav
      className="container-page flex h-16 items-center justify-between"
      aria-label="Site"
    >
      <Link
        href="/"
        className="flex items-center gap-2.5 text-[15px] font-medium"
      >
        <Mark className="size-7" />
        {site.shortName}
      </Link>
      <p className="flex gap-6 text-[15px] text-muted-foreground">
        <Link href="/changelog" className="hover:text-foreground">
          Changelog
        </Link>
        <a href={site.links.source} className="hover:text-foreground">
          GitHub
        </a>
      </p>
    </nav>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="container-page flex flex-col gap-4 py-10 text-sm text-muted-foreground md:flex-row md:justify-between">
        <p>
          Sidecar for OpenCode is an independent community project, not
          affiliated with OpenCode. Free and open source under the MIT license.
          This site counts visits with cookieless Vercel Analytics; the
          extension itself collects nothing.
        </p>
        <p className="flex gap-5">
          <a href={site.links.opencode} className="hover:text-foreground">
            OpenCode
          </a>
          <Link href="/changelog" className="hover:text-foreground">
            Changelog
          </Link>
          <a href="/llms.txt" className="hover:text-foreground">
            llms.txt
          </a>
          <a href={site.links.source} className="hover:text-foreground">
            GitHub
          </a>
        </p>
      </div>
    </footer>
  )
}
