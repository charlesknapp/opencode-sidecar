import { faq, features, site } from "@/config/site"
import { buildLlmsTxt } from "@/lib/llms"

const latest = { version: "0.9.0", date: "2027-01-02", intro: [], sections: [] }
const text = () => buildLlmsTxt({ site, faq, features, latest })

describe("llms.txt", () => {
  it("starts with the name as a heading and a one-line summary as a quote", () => {
    const [heading, blank, summary] = text().split("\n")
    expect(heading).toBe("# Sidecar for OpenCode")
    expect(blank).toBe("")
    expect(summary).toBe(`> ${site.summary}`)
  })

  it("lists install, source and demo links in a links section", () => {
    const links = text().split("## Links")[1]
    expect(links).toContain(`[VS Code Marketplace](${site.links.marketplace})`)
    expect(links).toContain(`[Open VSX](${site.links.openVsx})`)
    expect(links).toContain(`[Source code](${site.links.source})`)
    expect(links).toContain(`[Demo video](${site.links.video})`)
  })

  it("states the latest version and links the changelog", () => {
    expect(text()).toContain("Latest version: 0.9.0 (2027-01-02)")
    expect(text()).toContain(`[Changelog](${site.url}/changelog)`)
  })

  it("includes every FAQ answer and states that it is unofficial", () => {
    faq.forEach(({ question, answer }) => {
      expect(text()).toContain(`### ${question}`)
      expect(text()).toContain(answer)
    })
    expect(text()).toContain("not affiliated with OpenCode")
  })
})
