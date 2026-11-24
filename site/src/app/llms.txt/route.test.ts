import { guides } from "@/config/guides"
import { site } from "@/config/site"

import { GET } from "./route"

describe("/llms.txt", () => {
  it("serves plain text that starts with the project name", async () => {
    const response = GET()
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    )
    expect((await response.text()).startsWith("# Sidecar for OpenCode")).toBe(
      true
    )
  })

  it("points AI assistants to every guide", async () => {
    const text = await GET().text()
    guides.forEach(({ slug, title }) =>
      expect(text).toContain(`[${title}](${site.url}/guides/${slug})`)
    )
  })
})
