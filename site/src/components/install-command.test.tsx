import { act, fireEvent, render, screen } from "@testing-library/react"

import { InstallCommand } from "./install-command"

const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  writeText.mockReset().mockResolvedValue()
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
})

describe("install command", () => {
  it("starts on VS Code with its install command", () => {
    render(<InstallCommand />)
    expect(screen.getByRole("tab", { name: "VS Code" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("tabpanel")).toHaveTextContent(
      "code --install-extension cadogy.opencode-sidecar"
    )
  })

  it("switches to the command for each editor", () => {
    render(<InstallCommand />)
    for (const [editor, cli] of [
      ["Cursor", "cursor"],
      ["Windsurf", "windsurf"],
      ["VSCodium", "codium"],
    ]) {
      fireEvent.click(screen.getByRole("tab", { name: editor }))
      expect(screen.getByRole("tabpanel")).toHaveTextContent(
        `${cli} --install-extension cadogy.opencode-sidecar`
      )
    }
  })

  it("moves between editors with the arrow keys", () => {
    render(<InstallCommand />)
    fireEvent.keyDown(screen.getByRole("tab", { name: "VS Code" }), {
      key: "ArrowRight",
    })
    expect(screen.getByRole("tab", { name: "Cursor" })).toHaveFocus()
    expect(screen.getByRole("tab", { name: "Cursor" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.keyDown(screen.getByRole("tab", { name: "Cursor" }), {
      key: "ArrowLeft",
    })
    expect(screen.getByRole("tab", { name: "VS Code" })).toHaveFocus()
  })

  it("copies the shown command and says so", async () => {
    render(<InstallCommand />)
    fireEvent.click(screen.getByRole("tab", { name: "VSCodium" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy/i }))
    })
    expect(writeText).toHaveBeenCalledWith(
      "codium --install-extension cadogy.opencode-sidecar"
    )
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i)
  })
})
