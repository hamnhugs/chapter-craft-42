// Deleting pages and spotting the ones that did not come in well, through the
// lab. Start `npx vite --port 8093 --strictPort`, then:
//   node docs/paper-books/shoot-pages.mjs
import { createRequire } from "node:module";
const require = createRequire(`${process.env.PW || process.env.HOME + "/Work/even-plate"}/`);
const { chromium } = require("playwright-core");
const OUT = new URL("./shots/", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--hide-scrollbars"] });
const ctx = await b.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const out = {};
const head = () => p.locator(".cc-paper-head").innerText();
const pager = () => p.locator(".cc-paper-pages").innerText();
await p.goto("http://localhost:8093/#/arena-lab?paper&resume"); await p.waitForSelector(".cc-paper-sheet");
const b64 = await p.evaluate(() => { const c = document.createElement("canvas"); c.width = 900; c.height = 1300; const g = c.getContext("2d"); g.fillStyle = "#f6f2e8"; g.fillRect(0, 0, 900, 1300); g.fillStyle = "#111"; g.font = "26px Georgia"; for (let y = 90; y < 1240; y += 38) g.fillText("The quick brown fox jumps over the lazy dog and keeps on going.", 60, y); return c.toDataURL("image/jpeg", 0.9).split(",")[1]; });
const photo = { name: "p.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
const give = () => p.setInputFiles("[data-paper-gallery]", photo);

out["a good book shows no flags"] = await p.locator(".cc-paper-flagchip").count() === 0 && await p.locator(".cc-paper-doubt").count() === 0;
// A page comes back as rubbish.
await p.evaluate(() => { window.__paperLab.next = "garbled"; });
await give();
await p.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("4 pages"));
await p.waitForSelector(".cc-paper-doubt");
await p.screenshot({ path: `${OUT}phone-360-22-flagged-page.png` });
const why = await p.locator(".cc-paper-doubt").innerText();
out["the rubbish page is flagged, with reasons"] = /could not be read/.test(why) && /does not read like sentences/.test(why);
out["the pager counts pages to check"] = (await p.locator(".cc-paper-flagchip").innerText()).trim().startsWith("flag\n1") || /1/.test(await p.locator(".cc-paper-flagchip").innerText());
// Retake: the next photo takes that page's place.
await p.evaluate(() => { localStorage.setItem("cc_paper_camera", "native"); });
const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator(".cc-paper-doubt").getByRole("button", { name: /Retake/ }).click()]);
out["retake says what it will replace"] = (await p.locator(".cc-paper-turn").first().innerText()).includes("The next photo replaces");
await chooser.setFiles(photo);
await p.waitForFunction(() => !document.querySelector(".cc-paper-doubt") && !document.querySelector(".cc-paper-queue"));
out["retake replaced the page in place"] = (await head()).includes("4 pages") && (await pager()).includes("4 of 4") && await p.locator(".cc-paper-flagchip").count() === 0;
// Delete from the pager, then Undo.
const before = await p.locator(".cc-paper-sheet").innerText();
await p.getByRole("button", { name: "Delete this page" }).click();
await p.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("3 pages"));
await p.screenshot({ path: `${OUT}phone-360-23-deleted-undo.png` });
out["delete is one tap and offers Undo"] = await p.getByRole("button", { name: "Undo" }).count() === 1;
await p.getByRole("button", { name: "Undo" }).click();
await p.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("4 pages"));
await p.getByRole("button", { name: "Next page", exact: true }).click().catch(() => {});
out["undo puts it back where it was"] = (await pager()).includes("4 of 4") && (await p.locator(".cc-paper-sheet").innerText()) === before;
// Two bad pages, then the list: jump, "it is fine", delete the flagged.
for (let i = 0; i < 2; i++) { await p.evaluate(() => { window.__paperLab.next = "garbled"; }); await give(); await p.waitForFunction((n) => document.querySelector(".cc-paper-head")?.textContent.includes(`${n} pages`), 5 + i); }
// Identical rubbish twice is also "the same as" each other.
await p.locator(".cc-paper-pages").click();
await p.waitForSelector(".cc-paper-list");
await p.screenshot({ path: `${OUT}phone-360-24-pages-list.png` });
out["the list marks the flagged pages"] = await p.locator(".cc-paper-row-label .material-symbols-outlined").count() === 2;
out["list rows are 48px or more"] = await p.evaluate(() => [...document.querySelectorAll(".cc-paper-row-main")].every((e) => e.getBoundingClientRect().height >= 48));
await p.getByRole("button", { name: /Delete the 2 flagged pages/ }).click();
await p.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("4 pages"));
await p.waitForFunction(() => !document.querySelector(".cc-paper-list")); // the sheet hides the page from assistive tech while it closes
out["flagged pages delete together, with one Undo"] = await p.getByRole("button", { name: "Undo" }).count() === 1 && await p.locator(".cc-paper-flagchip").count() === 0;
// "It is fine" clears a flag for good.
await p.evaluate(() => { window.__paperLab.next = "garbled"; }); await give();
await p.waitForSelector(".cc-paper-doubt");
await p.getByRole("button", { name: "It is fine" }).click();
await p.waitForFunction(() => !document.querySelector(".cc-paper-doubt"));
await p.waitForFunction(() => document.querySelector(".cc-paper-save")?.textContent.includes("Saved"));
await p.evaluate(() => document.querySelector('[data-mobile-nav] button[aria-label="Library"]').click());
await p.evaluate(() => document.querySelector('[data-mobile-nav] button[aria-label="Read"]').click());
await p.waitForSelector(".cc-paper-sheet");
out["“It is fine” is remembered"] = await p.locator(".cc-paper-flagchip").count() === 0;
out["no sideways overflow"] = !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));
out["no page errors"] = errors.length === 0;
console.log(JSON.stringify(out, null, 1), errors.join("\n"));
await b.close();
if (Object.values(out).some((v) => !v)) process.exit(1);
