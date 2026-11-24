// Builds the interactive demo: the real Sidecar webview (bundled from the extension's own
// source in ../src/webview) plus the scripted host in src/demo, into public/demo/.
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.resolve(site, "..")
const out = path.join(site, "public", "demo")
mkdirSync(out, { recursive: true })

const shared = {
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  nodePaths: [path.join(site, "node_modules")],
}

await esbuild.build({ ...shared, entryPoints: [path.join(repo, "src", "webview", "main.ts")], outfile: path.join(out, "webview.js") })
await esbuild.build({
  ...shared,
  entryPoints: [path.join(site, "src", "demo", "browser", "player.ts")],
  outfile: path.join(out, "player.js"),
  alias: { "@": path.join(site, "src") },
})
copyFileSync(path.join(repo, "media", "main.css"), path.join(out, "main.css"))

// Each asset URL carries a hash of its content, so a change is never hidden by a cache.
const stamp = (file) =>
  createHash("sha256").update(readFileSync(path.join(out, file))).digest("hex").slice(0, 10)
const page = ["player.js", "webview.js", "main.css", "theme.css"].reduce(
  (html, file) => html.replace(`./${file}"`, `./${file}?v=${stamp(file)}"`),
  readFileSync(path.join(site, "scripts", "demo-index.html"), "utf8")
)
writeFileSync(path.join(out, "index.html"), page)
process.stdout.write("demo built: public/demo/{index.html,webview.js,player.js,main.css}\n")
