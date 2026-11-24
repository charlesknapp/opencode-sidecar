import { render, screen } from "@testing-library/react"

import { InlineMarkdown } from "@/components/inline-markdown"

describe("InlineMarkdown", () => {
  it("renders bold, code, italics and links from changelog text", () => {
    const { container } = render(
      <p>
        <InlineMarkdown text="**Find** with `Ctrl+F`, _fast_, see [the docs](https://example.com)." />
      </p>
    )
    expect(container.querySelector("strong")).toHaveTextContent("Find")
    expect(container.querySelector("code")).toHaveTextContent("Ctrl+F")
    expect(container.querySelector("em")).toHaveTextContent("fast")
    expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
      "href",
      "https://example.com"
    )
    expect(container).toHaveTextContent("Find with Ctrl+F, fast, see the docs.")
  })
})
