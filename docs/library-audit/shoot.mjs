// Screenshots of the Library tab after the deck rework, through the
// dev-only lab route. Start `npx vite --port 8093 --strictPort`, then:
//   OUT=docs/library-audit/shots/after node docs/library-audit/shoot.mjs [size-filter]
import { spawn } from "node:child_process";
import fs from "node:fs";
const OUT = process.env.OUT;
const BASE = "http://localhost:8093/#/arena-lab?library";
const port = 9334;
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=${process.env.PROFILE || "/tmp/library-audit-chrome"}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 20 && !targets; i++) { await sleep(700); targets = await fetch(`http://localhost:${port}/json`).then((r) => r.json(), () => null); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description?.slice(0, 300) ?? d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); };
const click = async (expr) => {
  const p = await ev(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`);
  if (!p) return false;
  const [x, y] = JSON.parse(p);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return true;
};
const esc = async () => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); };
const byLabel = (label) => `[...document.querySelectorAll('button,[role=radio],[role=tab]')].find(b => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).includes(${JSON.stringify(label)}))`;
// What is on the first screen: every control you could press without scrolling,
// how many are under 44px, and how far down the first book starts.
const MEASURE = `(() => { const vis = (e) => { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return b.width > 0 && b.bottom > 0 && b.top < innerHeight && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
  const main = document.querySelector('main'); const ctl = [...(main || document).querySelectorAll('button,a,input,select,[role=radio]')].filter(vis);
  const first = document.querySelector('[data-deck-card], .book-grid > *, [data-book-card]');
  return JSON.stringify({ vw: innerWidth, vh: innerHeight, controls: ctl.length,
    small: ctl.filter(e => { const b = e.getBoundingClientRect(); return Math.min(b.width, b.height) < 44; }).length,
    iconOnly: ctl.filter(e => e.tagName === 'BUTTON' && !(e.innerText || '').replace(/[a-z_]{3,}/g, m => document.fonts && e.querySelector('.material-symbols-outlined')?.textContent?.trim() === m ? '' : m).trim()).length,
    firstBookTop: first ? Math.round(first.getBoundingClientRect().top + (document.querySelector('.h-full.flex.flex-col.overflow-auto')?.scrollTop || 0)) : null,
    header: document.querySelector('[data-app-header]')?.getBoundingClientRect().height, dock: document.querySelector('[data-mobile-nav]')?.getBoundingClientRect().height,
    overflowX: document.documentElement.scrollWidth > innerWidth }); })()`;
const VIEWS = [
  { n: "phone-360", w: 360, h: 740, touch: true, dpr: 2 },
  { n: "desk-956", w: 956, h: 506, touch: false, dpr: 1 },
  { n: "desk-476", w: 476, h: 506, touch: false, dpr: 1 },
  { n: "desk-1440", w: 1440, h: 900, touch: false, dpr: 1 },
];
const only = process.argv[2];
const metrics = {};
for (const v of VIEWS) {
  if (only && !v.n.includes(only)) continue;
  await send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: v.dpr, mobile: v.touch });
  await send("Emulation.setTouchEmulationEnabled", { enabled: v.touch });
  const load = async () => { await send("Page.navigate", { url: "about:blank" }); await send("Page.navigate", { url: BASE }); await sleep(2500); };
  const snap = async (k) => { await sleep(500); metrics[`${v.n}-${k}`] = JSON.parse(await ev(MEASURE)); await shot(`${v.n}-${k}`); };
  await load();
  await ev(`['vault_view_mode','vault_deck_tab','vault_deck_sort'].forEach(k => localStorage.removeItem(k)); sessionStorage.clear()`);
  await load();
  await snap("1-deck");
  await click(byLabel("Stoics")); await snap("2-shelf");
  await click(`document.querySelector('section[aria-label=Collection] [data-deck-card]')`); await snap("3-card-menu");
  await click(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Add to'))`); await snap("4-added");
  await click(`document.querySelector('section[aria-label=Shelves] [data-deck-card]')`); await snap("5-slot-menu");
  await click(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Info'))`); await snap("6-info"); await esc(); await sleep(300);
  await click(`document.querySelector('[aria-label^="More for shelf"]')`); await snap("7a-shelf-menu"); await esc(); await sleep(300);
  await click(byLabel("New shelf")); await send("Input.insertText", { text: "Physics" }); await snap("7b-new-shelf");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await snap("7c-empty-shelf");
  await click(`document.querySelector('.cc-notebook-slot')`); await snap("7d-notebook-picker"); await esc(); await sleep(300);
  await click(`document.querySelector('input[type=search]')`); await send("Input.insertText", { text: "the" }); await snap("7e-search");
  await ev(`(() => { const i = document.querySelector('input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click(`document.querySelector('[aria-label="More library actions"]')`); await snap("7f-more-menu");
  await click(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('View as a list'))`); await snap("7g-list");
  await click(byLabel("Cards")); await sleep(300);
  await click(byLabel("Design")); await snap("7-shelf-design");
  await click(byLabel("Ask Counsel")); await snap("8-counsel");
}
fs.writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 1));
if (errors.length) console.log("page errors:", [...new Set(errors)].slice(0, 8));
console.log(Object.entries(metrics).map(([k, m]) => `${k}: ${m.controls} controls, ${m.small} <44px, first book at ${m.firstBookTop}px`).join("\n"));
ws.close(); chrome.kill();
