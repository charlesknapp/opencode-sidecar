import type { Guide } from "@/config/guides"
import type { FaqEntry, Site } from "@/config/site"

type Question = {
  "@type": "Question"
  name: string
  acceptedAnswer: { "@type": "Answer"; text: string }
}

type JsonLdNode = {
  "@type": string
  sameAs?: readonly string[]
  mainEntity?: readonly Question[]
  [key: string]: unknown
}

type StructuredData = {
  "@context": "https://schema.org"
  "@graph": readonly JsonLdNode[]
}

const toQuestion = ({ question, answer }: FaqEntry): Question => ({
  "@type": "Question",
  name: question,
  acceptedAnswer: { "@type": "Answer", text: answer },
})

export const buildStructuredData = ({
  site,
  faq,
}: {
  site: Site
  faq: readonly FaqEntry[]
}): StructuredData => ({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: site.name,
      alternateName: "OpenCode Sidecar",
      description: site.summary,
      url: site.url,
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "VS Code extension",
      operatingSystem: "Windows, macOS, Linux",
      downloadUrl: site.links.marketplace,
      installUrl: site.links.marketplace,
      isAccessibleForFree: true,
      license: "https://opensource.org/licenses/MIT",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@type": "Organization", name: site.publisher },
      sameAs: [
        site.links.marketplace,
        site.links.openVsx,
        site.links.source,
        site.links.video,
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: faq.map(toQuestion),
    },
  ],
})

export const buildGuideStructuredData = ({
  site,
  guide,
}: {
  site: Site
  guide: Guide
}): StructuredData => {
  const url = `${site.url}/guides/${guide.slug}`
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: guide.title,
        description: guide.description,
        url,
        mainEntityOfPage: url,
        dateModified: guide.updated,
        inLanguage: "en",
        author: { "@type": "Organization", name: site.publisher },
        publisher: { "@type": "Organization", name: site.publisher },
        about: {
          "@type": "SoftwareApplication",
          name: site.name,
          url: site.url,
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: site.url },
          {
            "@type": "ListItem",
            position: 2,
            name: "Guides",
            item: `${site.url}/guides`,
          },
          { "@type": "ListItem", position: 3, name: guide.short, item: url },
        ],
      },
    ],
  }
}
