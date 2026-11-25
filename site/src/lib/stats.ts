import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// Numbers about the project, read from the repository at build time, so the site
// never claims more than is there.

const TEST_CASE = /(^|[^.\w])it\(\s*["'`]/gm

/** Test cases defined in a folder of `.ts` test files (cases generated in loops count once). */
export function countTests(dir: string): number {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += countTests(full)
    else if (entry.name.endsWith(".ts"))
      total += readFileSync(full, "utf8").match(TEST_CASE)?.length ?? 0
  }
  return total
}

/** "480+" for 483: a tens floor for large numbers, so the figure is never higher than the truth. */
export function roundedCount(n: number): string {
  if (n < 20) return String(n)
  const floor = Math.floor(n / 10) * 10
  return floor === n ? String(n) : `${floor}+`
}

/** The extension's own test suite, next to the site in the repository. */
export const extensionTests = () =>
  countTests(path.join(process.cwd(), "..", "test"))
