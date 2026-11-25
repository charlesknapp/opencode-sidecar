import { render, screen, within } from "@testing-library/react"

import { faq, site } from "@/config/site"
import { loadReleases } from "@/lib/changelog"

import Home from "./page"

const renderHome = () => render(<Home />)

describe("home page", () => {
  it("has exactly one main heading", () => {
    renderHome()
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
  })

  it("offers installs for VS Code and for Open VSX editors", () => {
    renderHome()
    const hero = screen.getByRole("banner")
    expect(
      within(hero).getByRole("link", { name: /install for vs code/i })
    ).toHaveAttribute("href", site.links.marketplace)
    expect(
      within(hero).getByRole("link", { name: /open vsx/i })
    ).toHaveAttribute("href", site.links.openVsx)
  })

  it("lets people with VS Code open the extension directly, from the footer", () => {
    renderHome()
    expect(
      within(screen.getByRole("contentinfo")).getByRole("link", {
        name: /open in vs code/i,
      })
    ).toHaveAttribute("href", "vscode:extension/cadogy.opencode-sidecar")
  })

  it("names the latest release and links to the changelog", () => {
    renderHome()
    const link = within(screen.getByRole("banner")).getByRole("link", {
      name: /what's new/i,
    })
    expect(link).toHaveAttribute("href", "/changelog")
    expect(link).toHaveTextContent(`v${loadReleases()[0].version}`)
  })

  it("shows the demo as a silent loop that respects the page", () => {
    renderHome()
    const video = screen.getByLabelText(/demo of sidecar/i)
    expect(video).toHaveProperty("muted", true)
    expect(video).toHaveAttribute("loop")
    expect(video).toHaveAttribute("playsinline")
  })

  it("embeds the interactive demo of the real panel", () => {
    renderHome()
    expect(
      screen.getByTitle(/interactive demo of the sidecar panel/i)
    ).toHaveAttribute("src", "/demo/index.html")
  })

  it("answers the FAQ in questions that open, with every answer in the page", () => {
    renderHome()
    faq.forEach(({ question, answer }) => {
      const heading = screen.getByRole("heading", { name: question })
      const item = heading.closest("details")
      expect(item).not.toBeNull()
      expect(item).toHaveTextContent(answer)
    })
  })

  it("names the editors it works in", () => {
    renderHome()
    const list = screen.getByRole("list", { name: /works in/i })
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent)
    ).toEqual(site.editors)
  })

  it("shows real numbers about the project", () => {
    renderHome()
    const stats = screen.getByRole("list", { name: /in numbers/i })
    expect(stats).toHaveTextContent(`${loadReleases().length}releases`)
    expect(stats).toHaveTextContent(/0telemetry/)
    expect(stats).toHaveTextContent(/\d+\+?tests/)
  })

  it("links the three latest releases to their changelog entries", () => {
    renderHome()
    const updates = screen.getByRole("region", { name: /latest updates/i })
    loadReleases()
      .slice(0, 3)
      .forEach(({ version }) =>
        expect(
          within(updates).getByRole("link", {
            name: new RegExp(`^${version.replace(/\./g, "\\.")}`),
          })
        ).toHaveAttribute("href", `/changelog#v${version}`)
      )
  })

  it("says plainly that it is not an official OpenCode project", () => {
    renderHome()
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      /not affiliated with OpenCode/i
    )
  })
})
