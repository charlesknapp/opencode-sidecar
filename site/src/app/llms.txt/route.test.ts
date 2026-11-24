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
})
