import type { FaqEntry, Feature, Site } from "@/config/site"
import type { Release } from "@/lib/changelog"

export const buildLlmsTxt = ({
  site,
  faq,
  features,
  latest,
}: {
  site: Site
  faq: readonly FaqEntry[]
  features: readonly Feature[]
  latest: Release
}): string =>
  [
    `# ${site.name}`,
    "",
    `> ${site.summary}`,
    "",
    `Sidecar for OpenCode is an independent community project, not affiliated with OpenCode. It is free and MIT licensed, collects no telemetry, and runs in ${site.editors.join(", ")}. Extension ID: ${site.extensionId}.`,
    "",
    `Latest version: ${latest.version} (${latest.date}).`,
    "",
    "## Links",
    "",
    `- [VS Code Marketplace](${site.links.marketplace}): install for VS Code`,
    `- [Open VSX](${site.links.openVsx}): install for Cursor, Windsurf and VSCodium`,
    `- [Source code](${site.links.source}): MIT licensed, with the full README`,
    `- [Demo video](${site.links.video}): one minute of the real extension`,
    `- [Changelog](${site.url}/changelog): every release, newest first`,
    `- [OpenCode](${site.links.opencode}): the coding agent Sidecar works with`,
    "",
    "## Features",
    "",
    ...features.map(
      ({ title, description }) => `- **${title}**: ${description}`
    ),
    "",
    "## FAQ",
    "",
    ...faq.flatMap(({ question, answer }) => [
      `### ${question}`,
      "",
      answer,
      "",
    ]),
  ].join("\n")
