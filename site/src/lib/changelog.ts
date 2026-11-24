import { readFileSync } from "node:fs"
import path from "node:path"

type ReleaseSection = { title: string | null; items: readonly string[] }

export type Release = {
  version: string
  date: string
  intro: readonly string[]
  sections: readonly ReleaseSection[]
}

type Body = Pick<Release, "intro" | "sections">

const RELEASE_HEADING = /^## (\S+) \((\d{4}-\d{2}-\d{2})\)\s*$/
const GROUP_TITLE = /^\*\*([^*]+)\*\*$/
const ITEM = /^- (.+)$/

const addItem = (
  sections: readonly ReleaseSection[],
  item: string
): readonly ReleaseSection[] => {
  const last = sections.at(-1)
  if (!last) return [{ title: null, items: [item] }]
  return [...sections.slice(0, -1), { ...last, items: [...last.items, item] }]
}

const readLine = (body: Body, line: string): Body => {
  const group = GROUP_TITLE.exec(line)
  if (group)
    return {
      ...body,
      sections: [...body.sections, { title: group[1], items: [] }],
    }
  const item = ITEM.exec(line)
  if (item) return { ...body, sections: addItem(body.sections, item[1]) }
  return { ...body, intro: [...body.intro, line] }
}

const parseBody = (lines: readonly string[]): Body =>
  lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce(readLine, { intro: [], sections: [] })

export const parseChangelog = (markdown: string): readonly Release[] => {
  const lines = markdown.split(/\r?\n/)
  const starts = lines.flatMap((line, index) =>
    RELEASE_HEADING.test(line) ? [index] : []
  )
  return starts.flatMap((start, k) => {
    const heading = RELEASE_HEADING.exec(lines[start])
    if (!heading) return []
    const body = lines.slice(start + 1, starts[k + 1] ?? lines.length)
    return [{ version: heading[1], date: heading[2], ...parseBody(body) }]
  })
}

export const loadReleases = (): readonly Release[] =>
  parseChangelog(
    readFileSync(path.join(process.cwd(), "..", "CHANGELOG.md"), "utf8")
  )

const releaseDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

export const formatReleaseDate = (isoDate: string): string =>
  releaseDate.format(new Date(`${isoDate}T00:00:00Z`))
