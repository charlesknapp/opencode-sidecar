import { faq, site } from "@/config/site"
import { buildStructuredData } from "@/lib/structured-data"

const graphOf = () => buildStructuredData({ site, faq })["@graph"]
const nodeOfType = (type: string) =>
  graphOf().find((node) => node["@type"] === type)

describe("structured data", () => {
  it("describes Sidecar as a free, MIT-licensed developer tool", () => {
    expect(nodeOfType("SoftwareApplication")).toMatchObject({
      name: "Sidecar for OpenCode",
      applicationCategory: "DeveloperApplication",
      isAccessibleForFree: true,
      license: "https://opensource.org/licenses/MIT",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      url: site.url,
    })
  })

  it("links every place the extension is published", () => {
    expect(nodeOfType("SoftwareApplication")?.sameAs).toEqual([
      site.links.marketplace,
      site.links.openVsx,
      site.links.source,
      site.links.video,
    ])
  })

  it("answers every FAQ question in the page's own words", () => {
    const page = nodeOfType("FAQPage")
    expect(page?.mainEntity).toHaveLength(faq.length)
    expect(page?.mainEntity?.[0]).toEqual({
      "@type": "Question",
      name: faq[0].question,
      acceptedAnswer: { "@type": "Answer", text: faq[0].answer },
    })
  })
})
