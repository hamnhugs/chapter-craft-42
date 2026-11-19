// The in-app camera and the reload recovery, through the lab, with Chromium's
// fake camera. Start `npx vite --port 8093 --strictPort`, then:
//   node docs/paper-books/shoot-camera.mjs
import { createRequire } from "node:module";
const require = createRequire(`${process.env.PW || process.env.HOME + "/Work/even-plate"}/`);
const { chromium } = require("playwright-core");
const OUT = new URL("./shots/", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--hide-scrollbars"] });
const ctx = await b.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, permissions: ["camera"] });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const out = {};
await p.goto("http://localhost:8093/#/arena-lab?paper&resume"); await p.waitForSelector(".cc-paper-sheet");

// Snap opens the camera in the page, not a file chooser.
let chooser = false; p.on("filechooser", () => { chooser = true; });
await p.getByRole("button", { name: "Snap the next page" }).click();
await p.waitForSelector(".cc-cam");
await p.waitForFunction(() => document.querySelector(".cc-cam-video")?.videoWidth > 0);
await p.screenshot({ path: `${OUT}phone-360-17-camera.png` });
out["snap opens the in-app camera"] = !chooser;
out["shutter is 48px or more"] = await p.evaluate(() => document.querySelector(".cc-cam-shutter").getBoundingClientRect().width >= 48);
// Two shots without leaving the camera.
for (let i = 0; i < 2; i++) { await p.getByRole("button", { name: "Take the photo" }).click(); await p.waitForTimeout(500); }
out["camera stays open between shots"] = await p.locator(".cc-cam").count() === 1;
await p.waitForTimeout(600);
await p.screenshot({ path: `${OUT}phone-360-18-camera-reading.png` });
await p.getByRole("button", { name: "Done" }).click();
out["camera closes and releases the lens"] = await p.locator(".cc-cam").count() === 0;
// The fake camera's frame is not a page, so the on-device check may warn: accept each.
for (let i = 0; i < 4; i++) {
  const use = p.getByRole("button", { name: "Use anyway" }).first();
  if (await use.count()) { await use.click(); await p.waitForTimeout(300); } else break;
}
await p.waitForFunction(() => document.querySelector(".cc-paper-head")?.textContent.includes("5 pages"), null, { timeout: 15000 });
out["both shots became pages"] = true;
out["page never reloaded"] = await p.evaluate(() => performance.getEntriesByType("navigation").length === 1 && !!window.__paperLab);

// A reload in the middle of a trip to the phone's camera app.
await p.evaluate(() => sessionStorage.setItem("cc_paper_camera_trip", JSON.stringify({ at: Date.now(), starting: false })));
await p.reload(); await p.waitForSelector(".cc-paper-sheet");
await p.waitForSelector("text=Your phone reloaded the app");
await p.screenshot({ path: `${OUT}phone-360-19-reload-recovery.png` });
out["after a forced reload the desk says what happened"] = true;
out["the marker is used once"] = await p.evaluate(() => sessionStorage.getItem("cc_paper_camera_trip") === null);
out["no page errors"] = errors.length === 0;
console.log(JSON.stringify(out, null, 1), errors.join("\n"));
await b.close();
if (Object.values(out).some((v) => !v)) process.exit(1);
