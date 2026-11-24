import type { MetadataRoute } from "next"

import { guides } from "@/config/guides"
import { site } from "@/config/site"
import { loadReleases } from "@/lib/changelog"

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = loadReleases()[0].date
  return [
    { url: site.url, lastModified, changeFrequency: "monthly", priority: 1 },
    {
      url: `${site.url}/changelog`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${site.url}/guides`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    ...guides.map((guide) => ({
      url: `${site.url}/guides/${guide.slug}`,
      lastModified: guide.updated,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
    { url: `${site.url}/llms.txt`, changeFrequency: "monthly", priority: 0.5 },
  ]
}
