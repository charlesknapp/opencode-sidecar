import { faq, features, site } from "@/config/site"
import { loadReleases } from "@/lib/changelog"
import { buildLlmsTxt } from "@/lib/llms"

export const dynamic = "force-static"

export function GET(): Response {
  return new Response(
    buildLlmsTxt({ site, faq, features, latest: loadReleases()[0] }),
    {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }
  )
}
