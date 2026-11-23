// Renders the README hero (docs/marketplace/hero.png) from the icon and two screenshots.
// Run after scripts/screenshots.mjs: node scripts/hero.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && fs.existsSync(p));
const shots = path.join(root, "docs", "marketplace", "screenshots");
const data = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
const icon = data(path.join(root, "media", "src", "icon.svg"), "image/svg+xml");
const left = data(path.join(shots, "timeline.png"), "image/png");
const right = data(path.join(shots, "subagents.png"), "image/png");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 640px; overflow: hidden; background: #0a0a0a;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif; color: #fafafa; }
  .wrap { display: grid; grid-template-columns: 560px 1fr; height: 100%; }
  .text { padding: 92px 0 0 76px; display: flex; flex-direction: column; gap: 22px; }
  .brand { display: flex; align-items: center; gap: 18px; }
  .brand img { width: 84px; height: 84px; }
  h1 { margin: 0; font-size: 46px; line-height: 1.08; font-weight: 700; letter-spacing: -0.5px; }
  p { margin: 0; font-size: 22px; line-height: 1.45; color: #a3a3a3; max-width: 440px; }
  ul { margin: 6px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; font-size: 18px; color: #e5e5e5; }
  li { display: flex; gap: 14px; align-items: center; }
  li::before { content: ""; width: 14px; height: 1.5px; background: #737373; flex: none; }
  .foot { margin-top: auto; padding-bottom: 56px; font-size: 15px; color: #737373; letter-spacing: 0.02em; }
  .shots { position: relative; }
  .shots img { position: absolute; width: 300px; border-radius: 12px; border: 1px solid #2a2a2a;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7); }
  .a { left: 40px; top: 46px; }
  .b { left: 370px; top: 96px; }
</style></head><body><div class="wrap">
  <div class="text">
    <div class="brand"><img src="${icon}" alt=""><h1>Sidecar<br>for OpenCode</h1></div>
    <p>The complete OpenCode experience inside VS Code.</p>
    <ul>
      <li>A timeline of every step, tool call and diff</li>
      <li>Live subagents you can open and stop</li>
      <li>Permissions and questions answered in place</li>
      <li>Fork, rewind, @ mentions and images</li>
    </ul>
    <div class="foot">Free · open source · runs on your own OpenCode</div>
  </div>
  <div class="shots"><img class="a" src="${left}" alt=""><img class="b" src="${right}" alt=""></div>
</div></body></html>`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: path.join(root, "docs", "marketplace", "hero.png") });
await browser.close();
console.log("docs/marketplace/hero.png written");
