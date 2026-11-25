import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

const publicDir = path.join(process.cwd(), "public")

// A public file's URL with a hash of its content. The page is built ahead of time, so
// this runs at build: a replaced file gets a new URL, which lets it be cached for a
// year without ever going stale (see the headers in next.config.ts).
export function versioned(file: string, root = publicDir): string {
  const hash = createHash("sha256")
    .update(readFileSync(path.join(root, file)))
    .digest("hex")
    .slice(0, 10)
  return `${file}?v=${hash}`
}
