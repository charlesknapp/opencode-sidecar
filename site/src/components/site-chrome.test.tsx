import { render, screen, within } from "@testing-library/react"

import { site } from "@/config/site"
import { loadReleases } from "@/lib/changelog"

import { SiteFooter } from "./site-chrome"

describe("site footer", () => {
  it("groups the links people look for", () => {
    render(<SiteFooter />)
    const footer = screen.getByRole("contentinfo")
    for (const [name, href] of [
      [/vs code marketplace/i, site.links.marketplace],
      [/open vsx/i, site.links.openVsx],
      [/^changelog$/i, "/changelog"],
      [/report an issue/i, site.links.issues],
      [/source on github/i, site.links.source],
      [/llms\.txt/i, "/llms.txt"],
      [/all guides/i, "/guides"],
      [/^mcp servers$/i, "/guides/opencode-mcp-servers-vs-code"],
    ] as const) {
      expect(within(footer).getByRole("link", { name })).toHaveAttribute(
        "href",
        href
      )
    }
  })

  it("names the latest release", () => {
    render(<SiteFooter />)
    expect(
      within(screen.getByRole("contentinfo")).getByRole("link", {
        name: new RegExp(`v${loadReleases()[0].version}`),
      })
    ).toHaveAttribute("href", "/changelog")
  })
})
