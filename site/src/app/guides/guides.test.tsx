import { render, screen, within } from "@testing-library/react"

import { guides } from "@/config/guides"
import { site } from "@/config/site"

import sitemap from "../sitemap"
import GuidePage, {
  generateMetadata,
  generateStaticParams,
} from "./[slug]/page"
import GuidesIndex from "./page"

describe("guides", () => {
  it("have unique slugs and descriptions short enough for search results", () => {
    expect(new Set(guides.map((g) => g.slug)).size).toBe(guides.length)
    guides.forEach((guide) => {
      expect(guide.slug).toMatch(/^[a-z0-9-]+$/)
      expect(guide.description.length).toBeLessThanOrEqual(160)
      // The footer and the home page's tiles show these on one or two short lines.
      expect(guide.nav.length).toBeLessThanOrEqual(20)
      expect(guide.blurb.length).toBeLessThanOrEqual(45)
    })
  })

  it("are all prerendered", async () => {
    expect(await generateStaticParams()).toEqual(
      guides.map(({ slug }) => ({ slug }))
    )
  })

  it("are listed on the guides page", () => {
    render(<GuidesIndex />)
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    guides.forEach(({ slug, title }) =>
      expect(screen.getByRole("link", { name: title })).toHaveAttribute(
        "href",
        `/guides/${slug}`
      )
    )
  })

  it("render each guide with its sections and a way back", async () => {
    for (const guide of guides) {
      const { unmount } = render(
        await GuidePage({ params: Promise.resolve({ slug: guide.slug }) })
      )
      expect(
        screen.getByRole("heading", { level: 1, name: guide.title })
      ).toBeInTheDocument()
      guide.blocks
        .filter((block) => block.type === "h2")
        .forEach((block) =>
          expect(
            within(screen.getByRole("article")).getByRole("heading", {
              level: 2,
              name: block.text,
            })
          ).toBeInTheDocument()
        )
      expect(
        screen.getByRole("navigation", { name: "Breadcrumb" })
      ).toHaveTextContent("Guides")
      unmount()
    }
  })

  it("give each guide its own title and canonical address", async () => {
    const [guide] = guides
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: guide.slug }),
    })
    expect(metadata.title).toContain(guide.title)
    expect(metadata.alternates?.canonical).toBe(`/guides/${guide.slug}`)
  })

  it("are in the sitemap", () => {
    const urls = sitemap().map((entry) => entry.url)
    expect(urls).toContain(`${site.url}/guides`)
    guides.forEach(({ slug }) =>
      expect(urls).toContain(`${site.url}/guides/${slug}`)
    )
  })
})
