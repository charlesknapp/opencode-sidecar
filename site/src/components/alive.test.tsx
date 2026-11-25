import { render, screen } from "@testing-library/react"

import { CountUp } from "./count-up"
import { HeroLines } from "./hero-lines"

describe("motion touches", () => {
  it("draws the hero lines on a decorative canvas, and copes without a 2D context", () => {
    const { container } = render(<HeroLines />)
    const canvas = container.querySelector("canvas")
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute("aria-hidden", "true")
  })

  it("keeps the real number in the page while the visible one counts up", () => {
    render(<CountUp value="480+" />)
    expect(
      screen.getByText("480+", { selector: ".sr-only" })
    ).toBeInTheDocument()
  })

  it("shows a value that isn't a number as it is", () => {
    const { container } = render(<CountUp value="MIT" />)
    expect(container).toHaveTextContent("MIT")
    expect(container.querySelector("[aria-hidden]")).toBeNull()
  })
})
