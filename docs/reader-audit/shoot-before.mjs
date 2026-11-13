// Drives headless Chromium over CDP: node shoot.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
const OUT = process.env.OUT;
const BASE = "http://localhost:8093/#/arena-lab?reader";
const port = 9333;
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=${process.env.TMPDIR || "/tmp"}/reader-audit-chrome`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); };
const MEASURE = `(() => { const r = (el) => el ? (({top,bottom,left,right,height,width}) => ({top:Math.round(top),bottom:Math.round(bottom),h:Math.round(height),w:Math.round(width),l:Math.round(left),r:Math.round(right)}))(el.getBoundingClientRect()) : null;
  const tb = [...document.querySelectorAll('.bg-surface-container-low, .bg-surface-container-high')].filter(e => e.closest('.cc-dock-clearance') && e.parentElement.classList.contains('flex-col'));
  const sec = tb.find(e => e.className.includes('overflow-x-auto'));
  return JSON.stringify({ vw: innerWidth, vh: innerHeight, header: r(document.querySelector('[data-app-header]')), pager: r(tb.find(e => e !== sec)), secondary: r(sec), secondaryScrollW: sec?.scrollWidth, secondaryClientW: sec?.clientWidth,
    secondaryItems: sec ? [...sec.children].map(c => ({t: (c.getAttribute('aria-label') || c.textContent || '').trim().slice(0,28), ...r(c)})) : null,
    scroller: r(document.querySelector('.overscroll-contain')), page: r(document.querySelector('.react-pdf__Page')), dock: r(document.querySelector('[data-mobile-nav]')),
    coarse: matchMedia('(pointer:coarse)').matches }); })()`;
const VIEWS = [
  { n: "phone-360", w: 360, h: 740, touch: true, dpr: 3 },
  { n: "phone-412", w: 412, h: 915, touch: true, dpr: 2.6 },
  { n: "phone-land", w: 740, h: 360, touch: true, dpr: 3 },
  { n: "tablet-port", w: 800, h: 1280, touch: true, dpr: 2 },
  { n: "tablet-land", w: 1280, h: 800, touch: true, dpr: 2 },
  { n: "desk-956", w: 956, h: 506, touch: false, dpr: 2 },
  { n: "desk-476", w: 476, h: 506, touch: false, dpr: 2 },
  { n: "desk-1440", w: 1440, h: 900, touch: false, dpr: 1 },
];
const only = process.argv[2];
const metrics = {};
const click = (sel) => ev(`(() => { const e = ${sel}; if (!e) return false; e.click(); return true; })()`);
for (const v of VIEWS) {
  if (only && !v.n.includes(only)) continue;
  await send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: v.dpr, mobile: v.touch });
  await send("Emulation.setTouchEmulationEnabled", { enabled: v.touch });
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: BASE });
  await sleep(5000);
  metrics[v.n] = JSON.parse(await ev(MEASURE));
  await shot(`${v.n}-1-default`);
  // options menu
  const down = `(e) => { e.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0, pointerType:'mouse'})); }`;
  await ev(`(() => { const e = document.querySelector('[aria-label="Reading options"]'); e.scrollIntoView({inline:'center'}); (${down})(e); })()`);
  await sleep(500); await shot(`${v.n}-2-options`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  // toolbar scrolled to its end (touch) 
  await ev(`(() => { const s = document.querySelector('.overflow-x-auto.hide-scrollbar'); if (s) s.scrollLeft = 9999; })()`);
  await sleep(200); await shot(`${v.n}-3-toolbar-end`);
  await ev(`(() => { const s = document.querySelector('.overflow-x-auto.hide-scrollbar'); if (s) s.scrollLeft = 0; })()`);
  // chapter isolation started + chapter picked
  await click(`document.querySelector('[title="Mark this page as the start of a chapter"]')`);
  await ev(`(() => { const s = document.querySelector('select[aria-label="Jump to chapter"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s, s.options[2].value); s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(1500); metrics[v.n + "-iso"] = JSON.parse(await ev(MEASURE)); await shot(`${v.n}-4-isolating-chapter-chip`);
  // read along started
  await click(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Read Along'))`);
  await sleep(1500); await shot(`${v.n}-5-read-along`);
  // select text while read-along dock + chip are up
  await ev(`(() => { const spans = [...document.querySelectorAll('.react-pdf__Page__textContent span')].filter(s => s.textContent.trim().length > 20); const s = spans[3] || spans[0]; if (!s) return; const r = document.createRange(); r.selectNodeContents(s); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.querySelector('.overscroll-contain').dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); })()`);
  await sleep(1200); await shot(`${v.n}-6-selection`);
  await ev(`getSelection().removeAllRanges()`);
  // focus mode
  await click(`document.querySelector('[aria-label="Focus mode"]')`);
  await sleep(1200); await shot(`${v.n}-7-focus`);
}
fs.writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 1));
ws.close(); chrome.kill();
