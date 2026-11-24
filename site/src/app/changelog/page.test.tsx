import { render, screen } from "@testing-library/react"

import { loadReleases } from "@/lib/changelog"

import Changelog from "./page"

describe("changelog page", () => {
  it("has one main heading and a heading for every release", () => {
    render(<Changelog />)
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    loadReleases().forEach(({ version }) =>
      expect(
        screen.getByRole("heading", {
          level: 2,
          name: new RegExp(`^${version.replace(/\./g, "\.")}`),
        })
      ).toBeInTheDocument()
    )
  })
})
