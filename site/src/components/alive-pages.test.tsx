import { act, fireEvent, render, screen } from "@testing-library/react"

import { ChangelogSpy } from "./changelog-spy"
import { CopyButton } from "./copy-button"
import { GuideToc } from "./guide-toc"
import { WordmarkSpotlight } from "./wordmark-spotlight"

describe("footer wordmark spotlight", () => {
  it("lights up under a mouse, not a touch, and stays decorative", () => {
    const { container } = render(
      <WordmarkSpotlight
        base={<svg data-testid="base" />}
        lit={<svg data-testid="lit" />}
      />
    )
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveAttribute("aria-hidden", "true")
    fireEvent.pointerMove(root, {
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    })
    expect(root).toHaveAttribute("data-lit", "false")
    fireEvent.pointerMove(root, {
      pointerType: "mouse",
      clientX: 40,
      clientY: 12,
    })
    expect(root).toHaveAttribute("data-lit", "true")
    expect(root.style.getPropertyValue("--spot-x")).toMatch(/px$/)
    fireEvent.pointerLeave(root, { pointerType: "mouse" })
    expect(root).toHaveAttribute("data-lit", "false")
  })
})

describe("changelog: which release you're reading", () => {
  it("starts on the newest release and links to it", () => {
    render(<ChangelogSpy versions={["0.1.6", "0.1.5"]} />)
    expect(
      screen.getByRole("link", { name: /reading.*0\.1\.6/i })
    ).toHaveAttribute("href", "#v0.1.6")
  })
})

describe("guide table of contents", () => {
  it("lists the sections and marks the first as current", () => {
    render(
      <GuideToc
        sections={[
          { id: "with-ollama", text: "With Ollama" },
          { id: "with-lm-studio", text: "With LM Studio" },
        ]}
      />
    )
    const first = screen.getByRole("link", { name: "With Ollama" })
    expect(first).toHaveAttribute("href", "#with-ollama")
    expect(first).toHaveAttribute("aria-current", "location")
    expect(
      screen.getByRole("link", { name: "With LM Studio" })
    ).not.toHaveAttribute("aria-current")
  })
})

describe("copy button", () => {
  it("copies its text and says so", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue()
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    render(<CopyButton text="ollama pull qwen3:8b" label="Copy the commands" />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the commands" }))
    })
    expect(writeText).toHaveBeenCalledWith("ollama pull qwen3:8b")
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i)
  })
})
