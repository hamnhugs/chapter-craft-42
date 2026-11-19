// Many photos at once, through the lab. Start `npx vite --port 8093 --strictPort`, then:
//   node docs/paper-books/shoot-batch.mjs
import { createRequire } from "node:module";
const require = createRequire(`${process.env.PW || process.env.HOME + "/Work/even-plate"}/`);
const { chromium } = require("playwright-core");
const OUT = new URL("./shots/", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--hide-scrollbars"] });
const ctx = await b.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const out = {};
await p.goto("http://localhost:8093/#/arena-lab?paper"); await p.waitForSelector(".cc-paper-start");
// Each photo is a little taller than the last: the lab reads that back as its number.
const N = 12;
const make = (extra) => p.evaluate((extra) => { const c = document.createElement("canvas"); c.width = 900; c.height = 1300 + extra; const g = c.getContext("2d"); g.fillStyle = "#f6f2e8"; g.fillRect(0, 0, 900, c.height); g.fillStyle = "#111"; g.font = "26px Georgia"; for (let y = 90; y < 1240; y += 38) g.fillText("The quick brown fox jumps over the lazy dog and keeps on going.", 60, y); return c.toDataURL("image/jpeg", 0.9).split(",")[1]; }, extra);
const files = [];
for (let i = 0; i < N; i++) files.push({ name: `IMG_${String(100 + i)}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(await make(i + 1), "base64"), lastModified: 1_700_000_000_000 + i * 1000 });
// Handed over in order; the lab finishes reads OUT of order, and the book
// must still come out in the order given. (Putting a scrambled pick back in
// the order taken is orderPhotos, which is unit-tested: this script cannot
// set the timestamps the browser reports for its files.)
const scrambled = files;
out["start screen offers a multi-photo upload"] = await p.getByRole("button", { name: /Upload several photos at once/ }).count() === 1;
out["the picker takes many files"] = await p.evaluate(() => document.querySelector("[data-paper-gallery]").multiple);
await p.evaluate(() => { window.__paperLab.plain = true; });
await p.setInputFiles("[data-paper-gallery]", scrambled);
await p.waitForSelector(".cc-paper-queue");
await p.waitForFunction(() => /of 12/.test(document.querySelector(".cc-paper-queue")?.textContent || ""));
await p.waitForFunction(() => /[4-9] of 12/.test(document.querySelector(".cc-paper-queue")?.textContent || ""));
await p.screenshot({ path: `${OUT}phone-360-20-batch-queue.png` });
out["one progress row, not twelve"] = await p.locator(".cc-paper-shot").count() === 1;
await p.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("12 pages"), null, { timeout: 30000 });
await p.waitForFunction(() => !document.querySelector(".cc-paper-queue"));
out["all twelve became pages"] = true;
out["never more than three read at once"] = await p.evaluate(() => window.__paperLab.peak) <= 3;
// Walk the book: page k must be the photo whose read started k-th.
const order = [];
while (await p.getByRole("button", { name: "Previous page", exact: true }).isEnabled()) await p.getByRole("button", { name: "Previous page", exact: true }).click();
for (let i = 0; i < N; i++) {
  order.push(Number(/Photo number (\d+)/.exec(await p.locator(".cc-paper-sheet").innerText())?.[1]));
  if (i < N - 1) await p.getByRole("button", { name: "Next page", exact: true }).click();
}
out["pages are in the order the photos were taken"] = order.join() === Array.from({ length: N }, (_, i) => i + 1).join();
await p.screenshot({ path: `${OUT}phone-360-21-bar-with-upload.png` });
out["Upload sits beside Snap, 48px or more"] = await p.evaluate(() => { const r = document.querySelector(".cc-paper-upload").getBoundingClientRect(); return Math.min(r.width, r.height) >= 48; });
out["no sideways overflow"] = !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));
// Cancel the rest: what is in stays in, the line empties.
await p.setInputFiles("[data-paper-gallery]", files);
await p.waitForSelector(".cc-paper-queue");
await p.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("13 pages"));
await p.getByRole("button", { name: /Cancel the rest/ }).click();
await p.waitForTimeout(2500);
const count = Number(/(\d+) pages/.exec(await p.locator(".cc-paper-head").innerText())[1]);
out["cancel keeps the pages already in and drops the rest"] = count >= 13 && count < 24 && await p.locator(".cc-paper-queue").count() === 0;
out["no page errors"] = errors.length === 0;
console.log(JSON.stringify(out, null, 1), "order:", order.join(","), "after cancel:", count, errors.join("\n"));
await b.close();
if (Object.values(out).some((v) => !v)) process.exit(1);
