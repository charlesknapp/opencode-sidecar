import { site } from "@/config/site"

import robots from "./robots"
import sitemap from "./sitemap"

describe("crawler files", () => {
  it("lets every crawler in, AI crawlers included, and points to the sitemap", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: `${site.url}/sitemap.xml`,
      host: site.url,
    })
  })

  it("lists the home page, the changelog and llms.txt", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual([
      site.url,
      `${site.url}/changelog`,
      `${site.url}/llms.txt`,
    ])
  })
})
