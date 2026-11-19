// Drives the paper-book desk through the dev-only lab and takes screenshots.
// Start `npx vite --port 8093 --strictPort`, then:
//   node docs/paper-books/shoot.mjs
// Needs playwright-core (PW=<dir containing node_modules/playwright-core>) and /usr/bin/chromium.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(`${process.env.PW || process.env.HOME + "/Work/even-plate"}/`);
const { chromium } = require("playwright-core");
const OUT = new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:8093/#/arena-lab?paper";
const SIZES = { "phone-360": [360, 740, true], "desk-956": [956, 506, false], "desk-476": [476, 506, false] };
const only = process.argv[2];
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--hide-scrollbars"] });
const results = {};
const fail = [];
const check = (size, name, ok, detail = "") => { (results[size] ??= {})[name] = ok; if (!ok) fail.push(`${size}: ${name} ${detail}`); };

// A stand-in page photo: sharp dark text on white, so the on-device check passes.
async function pagePhoto(ctx, { blank = false } = {}) {
  const p = await ctx.newPage();
  const b64 = await p.evaluate((blank) => {
    const c = document.createElement("canvas"); c.width = 900; c.height = 1300;
    const g = c.getContext("2d"); g.fillStyle = blank ? "#bbb" : "#f6f2e8"; g.fillRect(0, 0, 900, 1300);
    if (!blank) { g.fillStyle = "#111"; g.font = "26px Georgia"; for (let y = 90; y < 1240; y += 38) g.fillText("The quick brown fox jumps over the lazy dog and keeps on going.", 60, y); }
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  }, blank);
  await p.close();
  return { name: "page.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
}

for (const [size, [w, h, touch]] of Object.entries(SIZES)) {
  if (only && !size.includes(only)) continue;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  const photo = await pagePhoto(ctx);
  const soft = await pagePhoto(ctx, { blank: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !/supabase|Failed to load resource|net::|401|uuid|"key" prop is being spread/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
  const shot = (n) => page.screenshot({ path: `${OUT}${size}-${n}.png` });
  const give = (file, sel = "[data-paper-camera]") => page.setInputFiles(sel, file);
  // The dock by DOM click: a toast may sit over it, and the phone reader hides it.
  const dock = (label) => page.evaluate((l) => document.querySelector(`[data-mobile-nav] button[aria-label="${l}"]`).click(), label);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

  // 1. Start screen.
  await page.goto(BASE); await page.waitForSelector(".cc-paper-start");
  await shot("1-start");
  check(size, "start screen has one primary button", await page.locator(".cc-paper-snap-wide[data-tone=\"accent\"]").count() === 1);
  check(size, "no sideways overflow (start)", !(await overflow()));

  // 2. A soft photo is caught before any model call.
  await give(soft); await page.waitForSelector('.cc-paper-shot[data-tone="warn"]');
  await shot("2-blurry-warning");
  check(size, "soft photo warns", (await page.locator(".cc-paper-shot").innerText()).includes("blurry"));
  await page.getByRole("button", { name: "Use anyway" }).click();
  await page.waitForSelector(".cc-paper-sheet");
  // 3. First page in: the book exists, the nudge names the two choices.
  await page.waitForFunction(() => document.querySelector(".cc-paper-save")?.textContent.includes("Saved"));
  await shot("3-first-page");
  check(size, "first page shows its text", (await page.locator(".cc-paper-sheet").innerText()).includes("lighthouse keeper"));
  check(size, "nudge offers listen or ask", (await page.locator(".cc-paper-turn").innerText()).includes("Listen"));
  check(size, "header counts the page", (await page.locator(".cc-paper-head").innerText()).includes("1 page · last p. 41"));
  check(size, "no sideways overflow (page)", !(await overflow()));
  const targets = await page.evaluate(() => [...document.querySelectorAll(".cc-paper-bar button")].map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  check(size, "bar targets are 48px or more", targets.length >= 3 && targets.every((t) => t >= 48), JSON.stringify(targets));

  // 4. Two more pages, quickly: they land in the order taken.
  await give(photo); await give(photo);
  await page.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("3 pages"));
  await page.waitForFunction(() => !document.querySelector(".cc-paper-shot"));
  check(size, "pages land in order", (await page.locator(".cc-paper-head").innerText()).includes("last p. 43"));
  // 5. A spread comes back as two pages.
  await page.evaluate(() => { window.__paperLab.next = "spread"; });
  await give(photo);
  await page.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("5 pages"));
  await shot("4-five-pages");
  // 6. Offline: the photo is kept for one retry, then let go.
  await page.evaluate(() => { window.__paperLab.next = "offline"; });
  await give(photo); await page.waitForSelector('.cc-paper-shot[data-tone="warn"]');
  await shot("5-offline-retry");
  check(size, "offline offers Try again", await page.getByRole("button", { name: "Try again" }).count() === 1);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("6 pages"));
  // 7. Unreadable: nothing to retry with, only Retake.
  await page.evaluate(() => { window.__paperLab.next = "unreadable"; });
  await give(photo); await page.waitForSelector('.cc-paper-shot[data-tone="warn"]');
  check(size, "unreadable offers Retake, not Try again", await page.getByRole("button", { name: "Try again" }).count() === 0 && await page.getByRole("button", { name: "Retake" }).count() === 1);
  await page.getByRole("button", { name: "Dismiss" }).click();
  // 8. Cover names the book.
  await page.evaluate(() => { window.__paperLab.next = "cover"; });
  await give(photo);
  await page.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("The Keeper's Rules"));
  check(size, "cover names the book", true);
  // 9. Pager, and the menu.
  await page.getByRole("button", { name: "Previous page" }).click();
  await page.getByRole("button", { name: "Book options" }).click();
  await page.waitForSelector('[role="menu"]');
  await shot("6-menu");
  await page.keyboard.press("Escape");
  // 10. Listen: headless Chromium has no voice, so only the control state is checked.
  await page.getByRole("button", { name: "Listen" }).click();
  await page.waitForTimeout(500);
  await shot("7-listening");
  if (await page.locator(".cc-paper-stop").count()) await page.locator(".cc-paper-stop").click();
  // 11. Library: the Unfinished tab and the card.
  await dock("Library");
  await page.waitForSelector('[data-paper="open"]');
  await shot("8-library-card");
  check(size, "Unfinished tab is there", await page.getByRole("tab", { name: /Unfinished/ }).count() === 1);
  await page.getByRole("tab", { name: /Unfinished/ }).click();
  await page.waitForTimeout(200);
  await shot("9-unfinished-tab");
  await page.locator('[data-paper="open"]').first().click();
  await page.waitForSelector(".cc-card-menu");
  check(size, "card menu says Keep scanning", (await page.locator(".cc-card-menu").innerText()).includes("Keep scanning"));
  await shot("10-card-menu");
  await page.getByRole("menuitem", { name: /Keep scanning/ }).click();
  await page.waitForSelector(".cc-paper-sheet");
  check(size, "resumes on the last page", (await page.locator(".cc-paper-pager").innerText()).includes("6 of 6"));
  // 12. Ask: Counsel gets the book, and its own shutter.
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForSelector(".cc-paper-chip");
  await shot("11-counsel-chip");
  check(size, "Counsel has the shutter", (await page.locator(".cc-paper-chip").innerText()).includes("Snap the next page"));
  check(size, "draft names the page", (await page.locator("textarea").first().inputValue()).includes("About p."));
  // 13. Finish: it becomes an ordinary book in the reader.
  await dock("Read");
  await page.getByRole("button", { name: "Book options" }).click();
  await page.getByRole("menuitem", { name: /Finish this book/ }).click();
  await shot("12-finish-confirm");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.waitForSelector("iframe");
  await page.waitForTimeout(600);
  await shot("13-finished-in-reader");
  check(size, "finished book opens in the reader", await page.locator(".cc-paper-bar").count() === 0);
  await dock("Library");
  await page.waitForTimeout(300);
  check(size, "finished book left Unfinished", await page.locator('[data-paper="open"]').count() === 0);

  // 14. Resume: a returning reader lands on the last page of an unfinished book.
  await page.goto("about:blank"); await page.goto(BASE + "&resume"); await page.waitForSelector(".cc-paper-sheet");
  await shot("14-resume");
  check(size, "resume shows where they stopped", (await page.locator(".cc-paper-pager").innerText()).includes("p. 43"));
  await dock("Library");
  await page.waitForSelector('[data-paper="open"]');
  await shot("15-library-resume");
  check(size, "no console errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${OUT}results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 1));
if (fail.length) { console.error("FAILED:\n" + fail.join("\n")); process.exit(1); }
