import { act, fireEvent, render, screen } from "@testing-library/react"

import { steps } from "@/config/site"

import { CtaLines } from "./cta-lines"
import { GridSpotlight } from "./grid-spotlight"
import { StepTimeline } from "./step-timeline"

describe("features grid spotlight", () => {
  it("lights under a mouse, not a touch", () => {
    render(
      <GridSpotlight>
        <li>One</li>
      </GridSpotlight>
    )
    const grid = screen.getByRole("list")
    fireEvent.pointerMove(grid, { pointerType: "touch", clientX: 5 })
    expect(grid).toHaveAttribute("data-lit", "false")
    fireEvent.pointerMove(grid, {
      pointerType: "mouse",
      clientX: 30,
      clientY: 20,
    })
    expect(grid).toHaveAttribute("data-lit", "true")
    expect(grid.style.getPropertyValue("--spot-x")).toMatch(/px$/)
    fireEvent.pointerLeave(grid, { pointerType: "mouse" })
    expect(grid).toHaveAttribute("data-lit", "false")
  })
})

describe("get started timeline", () => {
  let report: (() => void) | undefined

  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: unknown[]) => void) {
          report = () => callback([{}])
        }
        observe() {}
        disconnect() {}
      }
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it("lists every step, waiting, with the first step's extra", () => {
    render(<StepTimeline steps={steps} extra={{ 0: <p>Install box</p> }} />)
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(steps.length)
    items.forEach((item) => expect(item).toHaveAttribute("data-state", "wait"))
    expect(
      screen.getByRole("heading", { name: `Step 1: ${steps[0].title}` })
    ).toBeInTheDocument()
    expect(screen.getByText("Install box")).toBeInTheDocument()
  })

  it("marks steps above the middle of the screen done, and the next one running", () => {
    render(<StepTimeline steps={steps} extra={{}} />)
    const items = screen.getAllByRole("listitem")
    items.forEach((item, index) => {
      item.getBoundingClientRect = () =>
        ({ top: index < 2 ? 10 : 5000 }) as DOMRect
    })
    act(() => report?.())
    expect(items.map((item) => item.dataset.state)).toEqual([
      "done",
      "run",
      "wait",
      "wait",
    ])
  })
})

describe("closing section lines", () => {
  it("draw on a decorative canvas, and cope without a 2D context", () => {
    const { container } = render(<CtaLines target="nowhere" />)
    expect(container.querySelector("canvas")).toHaveAttribute(
      "aria-hidden",
      "true"
    )
  })
})
