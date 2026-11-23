// Renders media/icon.png (256×256) from media/src/icon.svg, and a preview sheet of the
// activity-bar icon on dark and light bars. Usage: node scripts/icons.mjs [previewDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && fs.existsSync(p));
const icon = fs.readFileSync(path.join(root, "media", "src", "icon.svg"), "utf8");
const activity = fs.readFileSync(path.join(root, "media", "activity.svg"), "utf8");
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();

await page.setViewport({ width: 256, height: 256 });
await page.setContent(`<html><body style="margin:0;background:transparent">${icon}</body></html>`);
await page.screenshot({
  path: path.join(root, "media", "icon.png"),
  omitBackground: true,
  clip: { x: 0, y: 0, width: 256, height: 256 },
});

const preview = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-icons-"));
fs.mkdirSync(preview, { recursive: true });
// Activity bar icons are drawn as a mask in one colour; preview them at 24px on both bars.
const glyph = (color) => activity.replace(/currentColor/g, color);
const bars = ["#181818:#cccccc", "#2c2c2c:#ffffff", "#f8f8f8:#424242"]
  .map((pair) => {
    const [bg, fg] = pair.split(":");
    return `<div style="background:${bg};padding:12px;display:inline-flex;gap:16px;align-items:center">${glyph(fg)}<div style="transform:scale(2);transform-origin:left">${glyph(fg)}</div></div>`;
  })
  .join("");
await page.setViewport({ width: 520, height: 300 });
await page.setContent(
  `<html><body style="margin:0;background:#888;display:flex;flex-direction:column;gap:8px;padding:8px">${bars}<div style="display:flex;gap:12px;align-items:end"><img src="data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}" width="128"><img src="data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}" width="48"><img src="data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}" width="24"></div></body></html>`,
);
await page.screenshot({ path: path.join(preview, "icons-preview.png") });
await browser.close();
console.log("media/icon.png written; preview in", preview);
