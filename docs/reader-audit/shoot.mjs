// Screenshots of the Read tab at phone, tablet and desktop sizes, through the
// dev-only lab route. Start `npx vite --port 8093 --strictPort`, then:
//   OUT=docs/reader-audit/shots/after node docs/reader-audit/shoot.mjs [size-filter]
import { spawn } from "node:child_process";
import fs from "node:fs";
const OUT = process.env.OUT;
const BASE = "http://localhost:8093/#/arena-lab?reader";
const port = 9333;
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=${process.env.TMPDIR || "/tmp"}/reader-audit-chrome`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description?.slice(0, 300) ?? d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); };
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
/** Click the centre of the element an expression evaluates to. */
const click = async (expr) => {
  const p = await ev(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`);
  if (!p) return false;
  const [x, y] = JSON.parse(p);
  await clickAt(x, y);
  return true;
};
const key = async (k, code = k, vk = 0) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
};
const esc = () => key("Escape", "Escape", 27);
const btn = (label) => `[...document.querySelectorAll('[data-reader-bar] button')].find(b => (b.getAttribute('aria-label') || b.textContent || '').startsWith(${JSON.stringify(label)}))`;
const MEASURE = `(() => { const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width), shown: cs.opacity !== '0' && b.bottom > 0 && b.top < innerHeight }; };
  const bar = document.querySelector('[data-reader-bar]'); const row = bar && [...bar.querySelectorAll('div')].find(d => d.className.includes('items-center') && d.offsetParent);
  return JSON.stringify({ vw: innerWidth, vh: innerHeight, header: r(document.querySelector('[data-app-header]')), bar: r(bar), barRowScrollW: row?.scrollWidth, barRowClientW: row?.clientWidth,
    barControls: bar ? [...bar.querySelectorAll('button')].filter(b => b.offsetParent).map(b => ({ t: (b.textContent || '').replace(/[a-z_]+(?=[A-Z0-9])/, '').trim().slice(0, 22), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })) : null,
    scroller: r(document.querySelector('.overscroll-contain')), page: r(document.querySelector('.react-pdf__Page')), dock: r(document.querySelector('[data-mobile-nav]')),
    pageNo: /Page (\\d+) of|(\\d+) \\/ \\d+/.exec(bar?.textContent || '')?.slice(1).find(Boolean), overflowX: document.documentElement.scrollWidth > innerWidth }); })()`;
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
const measure = async (k) => { metrics[k] = JSON.parse(await ev(MEASURE)); };
for (const v of VIEWS) {
  if (only && !v.n.includes(only)) continue;
  const phone = v.touch && (v.w < 640 || v.h <= 500);
  await send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: v.dpr, mobile: v.touch });
  await send("Emulation.setTouchEmulationEnabled", { enabled: v.touch });
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: BASE });
  await sleep(1500);
  await ev(`localStorage.removeItem('cc_reader_tap_hint'); localStorage.removeItem('cc_reader_zoom'); localStorage.removeItem('cc_reader_auto_highlight'); localStorage.setItem('cc_reader_page_lab-reader-book', '2')`);
  await send("Page.reload");
  await sleep(4500);
  if (phone) {
    await shot(`${v.n}-0-first-time-hint`);
    await clickAt(v.w / 2, v.h / 2);
    await sleep(700);
    await measure(`${v.n}-reading`);
    await shot(`${v.n}-1-reading`);
    // side taps turn the page; the middle brings the controls back
    await clickAt(v.w * 0.9, v.h / 2); await sleep(900);
    metrics[`${v.n}-reading`].afterRightTap = await ev(`document.querySelector('[data-reader-bar]').textContent.match(/(\\d+) \\/ /)?.[1]`);
    await clickAt(v.w * 0.1, v.h / 2); await sleep(900);
    metrics[`${v.n}-reading`].afterLeftTap = await ev(`document.querySelector('[data-reader-bar]').textContent.match(/(\\d+) \\/ /)?.[1]`);
    await clickAt(v.w / 2, v.h / 2); await sleep(700);
  }
  await measure(v.n);
  await shot(`${v.n}-2-controls`);
  if (await click(btn("Contents"))) { await sleep(900); await shot(`${v.n}-3-contents`); await esc(); await sleep(500); }
  if (await click(btn("Page"))) {
    await sleep(600); await shot(`${v.n}-4-page-menu`);
    // type a page number into the menu's field
    await click(`document.querySelector('[role="menu"] input')`); await sleep(150);
    await send("Input.insertText", { text: "4" });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(900);
    metrics[v.n].afterTyping4 = await ev(`(document.querySelector('[data-reader-bar]').textContent.match(/Page (\\d+) of|(\\d+) \\/ /) || []).slice(1).find(Boolean)`);
    await esc(); await sleep(400);
  }
  if (await click(btn("View"))) { await sleep(600); await shot(`${v.n}-5-view-menu`); await esc(); await sleep(400); }
  if (await click(btn("More"))) { await sleep(600); await shot(`${v.n}-6-more-menu`); await esc(); await sleep(400); }
  // a selection, and its one menu
  await ev(`(() => { const spans = [...document.querySelectorAll('.react-pdf__Page__textContent span')].filter(s => s.textContent.trim().length > 20); const s = spans[3] || spans[0]; if (!s) return; const r = document.createRange(); r.selectNodeContents(s); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); })()`);
  await sleep(900); await shot(`${v.n}-7-selection-menu`);
  metrics[v.n].selectionMenu = await ev(`[...document.querySelectorAll('[data-reader-menu] button')].map(b => b.textContent.replace(/^[a-z_]+/, '')).join(' | ')`);
  await ev(`getSelection().removeAllRanges(); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
  await sleep(400);
  if (!phone) {
    // keyboard: Space reads on to the foot, then over to the next page
    await ev(`document.activeElement?.blur()`);
    const before = await ev(`(document.querySelector('[data-reader-bar]').textContent.match(/Page (\\d+) of|(\\d+) \\/ /) || []).slice(1).find(Boolean)`);
    for (let i = 0; i < 8; i++) { await key(" ", "Space", 32); await sleep(250); }
    await sleep(600);
    metrics[v.n].spaceFrom = before;
    metrics[v.n].spaceTo = await ev(`(document.querySelector('[data-reader-bar]').textContent.match(/Page (\\d+) of|(\\d+) \\/ /) || []).slice(1).find(Boolean)`);
    await ev(`document.querySelector('.overscroll-contain').scrollTop = 99999`); await sleep(300);
    await shot(`${v.n}-8-page-foot`);
  }
  // listening: the bar becomes the player. Headless Chromium has no voice, so
  // a silent stand-in keeps the session "speaking" for the picture.
  await ev(`Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak() {}, cancel() {}, pause() {}, resume() {}, getVoices() { return []; }, speaking: true, pending: false, paused: false, addEventListener() {}, removeEventListener() {} } })`);
  if (phone) { if (!(await ev(`!!(${btn("Listen")})?.offsetParent`))) { await clickAt(v.w / 2, v.h / 2); await sleep(600); } }
  await click(btn("Listen")); await sleep(900);
  await measure(`${v.n}-listening`);
  await shot(`${v.n}-9-listening`);
  if (await click(btn("Voice, sleep timer"))) { await sleep(600); await shot(`${v.n}-9b-listening-more`); await esc(); await sleep(300); }
  await click(btn("Stop listening")); await sleep(500);
  metrics[`${v.n}-listening`].backToBar = await ev(`!!(${btn("Listen")})?.offsetParent`);
}
metrics.errors = [...new Set(errors)];
fs.writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 1));
ws.close(); chrome.kill();
