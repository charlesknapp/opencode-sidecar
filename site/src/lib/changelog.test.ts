import { readFileSync } from "node:fs"
import path from "node:path"

import {
  formatReleaseDate,
  loadReleases,
  parseChangelog,
} from "@/lib/changelog"

const changelog = [
  "# Changelog",
  "",
  "## 0.2.0 (2026-12-01)",
  "",
  "**New**",
  "",
  "- **Find** in the conversation.",
  "- Export to `Markdown`.",
  "",
  "**Fixes**",
  "",
  "- No empty strip.",
  "",
  "## 0.1.0 (2026-11-23)",
  "",
  "First release of Sidecar for OpenCode.",
  "",
  "- A timeline of the agent's work.",
].join("\n")

describe("parseChangelog", () => {
  it("reads every release, newest first, with its version and date", () => {
    expect(
      parseChangelog(changelog).map(({ version, date }) => ({ version, date }))
    ).toEqual([
      { version: "0.2.0", date: "2026-12-01" },
      { version: "0.1.0", date: "2026-11-23" },
    ])
  })

  it("keeps grouped notes under their group titles", () => {
    expect(parseChangelog(changelog)[0].sections).toEqual([
      {
        title: "New",
        items: ["**Find** in the conversation.", "Export to `Markdown`."],
      },
      { title: "Fixes", items: ["No empty strip."] },
    ])
  })

  it("keeps intro paragraphs and ungrouped notes", () => {
    const [, first] = parseChangelog(changelog)
    expect(first.intro).toEqual(["First release of Sidecar for OpenCode."])
    expect(first.sections).toEqual([
      { title: null, items: ["A timeline of the agent's work."] },
    ])
  })
})

describe("the project's own changelog", () => {
  it("has the version in package.json as its latest release", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "..", "package.json"), "utf8")
    ) as { version: string }
    expect(loadReleases()[0].version).toBe(pkg.version)
  })
})

describe("formatReleaseDate", () => {
  it("writes the date the way people read it", () => {
    expect(formatReleaseDate("2026-11-24")).toBe("Nov 24, 2026")
  })
})
