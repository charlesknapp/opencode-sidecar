import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { countTests, roundedCount } from "./stats"

describe("project stats", () => {
  it("counts the test cases defined in a folder of test files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stats-"))
    mkdirSync(path.join(dir, "webview"))
    writeFileSync(
      path.join(dir, "a.test.ts"),
      'it("one", () => {})\n  it(`two`, () => {})\nvisit("not a test")'
    )
    writeFileSync(
      path.join(dir, "webview", "b.test.ts"),
      "it('three', () => {})"
    )
    writeFileSync(path.join(dir, "notes.md"), 'it("not code")')
    expect(countTests(dir)).toBe(3)
  })

  it("never overstates: large counts round down to a tens floor", () => {
    expect(roundedCount(483)).toBe("480+")
    expect(roundedCount(480)).toBe("480")
    expect(roundedCount(7)).toBe("7")
  })

  it("reads 0 for a folder that is not there", () => {
    expect(countTests(path.join(tmpdir(), "no-such-folder-xyz"))).toBe(0)
  })
})
