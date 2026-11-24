import type { MetadataRoute } from "next"

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
    { url: `${site.url}/llms.txt`, changeFrequency: "monthly", priority: 0.5 },
  ]
}
