import { fireEvent, render, screen } from "@testing-library/react"

import { FeatureCell } from "./feature-cell"

describe("feature cell", () => {
  it("plays its interaction while a mouse is over it, and stops after", () => {
    render(
      <ul>
        <FeatureCell>Budget Guard</FeatureCell>
      </ul>
    )
    const cell = screen.getByRole("listitem")
    expect(cell).toHaveAttribute("data-on", "false")
    fireEvent.pointerEnter(cell, { pointerType: "mouse" })
    expect(cell).toHaveAttribute("data-on", "true")
    fireEvent.pointerLeave(cell, { pointerType: "mouse" })
    expect(cell).toHaveAttribute("data-on", "false")
  })

  it("leaves touches to the in-view trigger", () => {
    render(
      <ul>
        <FeatureCell>Budget Guard</FeatureCell>
      </ul>
    )
    const cell = screen.getByRole("listitem")
    fireEvent.pointerEnter(cell, { pointerType: "touch" })
    expect(cell).toHaveAttribute("data-on", "false")
  })
})
