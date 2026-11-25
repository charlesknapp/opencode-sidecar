import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { act, render, screen } from "@testing-library/react"

import { versioned } from "@/lib/assets"

import nextConfig from "../../next.config"
import { DemoVideo } from "./demo-video"
import { LazyFrame } from "./lazy-frame"

describe("versioned asset URLs", () => {
  it("stamps a public file's URL with a hash of its content", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "assets-"))
    writeFileSync(path.join(dir, "clip.mp4"), "one")
    const first = versioned("/clip.mp4", dir)
    expect(first).toMatch(/^\/clip\.mp4\?v=[0-9a-f]{10}$/)
    writeFileSync(path.join(dir, "clip.mp4"), "two")
    expect(versioned("/clip.mp4", dir)).not.toBe(first)
  })

  it("caches versioned files for a year, since a new file gets a new URL", async () => {
    const rules = await nextConfig.headers!()
    const rule = rules.find((r) =>
      r.has?.some((h) => h.type === "query" && h.key === "v")
    )
    expect(rule?.headers).toContainEqual({
      key: "Cache-Control",
      value: "public, max-age=31536000, immutable",
    })
  })
})

describe("deferred loading", () => {
  it("shows the poster first and fetches the video only once the page has loaded", () => {
    Object.defineProperty(document, "readyState", {
      value: "loading",
      configurable: true,
    })
    render(
      <DemoVideo label="Demo" src="/clip.mp4?v=1" poster="/poster.webp?v=1" />
    )
    const video = screen.getByLabelText("Demo")
    expect(video).toHaveAttribute("poster", "/poster.webp?v=1")
    expect(video).not.toHaveAttribute("src")
    act(() => {
      window.dispatchEvent(new Event("load"))
    })
    expect(video).toHaveAttribute("src", "/clip.mp4?v=1")
    Object.defineProperty(document, "readyState", {
      value: "complete",
      configurable: true,
    })
  })

  it("mounts the demo frame only when it nears the viewport", () => {
    let fire: (entries: { isIntersecting: boolean }[]) => void = () => {}
    const original = window.IntersectionObserver
    window.IntersectionObserver = class {
      constructor(cb: typeof fire) {
        fire = cb
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver
    render(<LazyFrame src="/demo/index.html" title="Demo frame" />)
    expect(screen.queryByTitle("Demo frame")).toBeNull()
    act(() => fire([{ isIntersecting: true }]))
    expect(screen.getByTitle("Demo frame")).toHaveAttribute(
      "src",
      "/demo/index.html"
    )
    window.IntersectionObserver = original
  })
})
