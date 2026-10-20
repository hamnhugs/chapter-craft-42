// Carries out hands-free voice commands (parsed by lib/voiceCommands.ts).
//
// Hands-free (hooks/useHandsFree) hands every utterance to runVoiceUtterance
// first; a non-null result is the spoken confirmation and the model never
// sees the utterance. Anything that isn't a command goes to the model as
// before.
//
// Targets register themselves while mounted:
//   • the app shell (pages/Index) — tabs and books;
//   • the reader (components/PdfViewer via hooks/useReaderVoice) — pages,
//     chapters, zoom, focus, highlights, screenshots.
// Reader commands said from another tab switch to Read first and wait for
// the reader to mount.
//
// "click X" works on ANY visible button, tab, menu item, checkbox or
// dropdown option by its label, so whatever can be done by hand can be
// said even when there's no dedicated command for it.

import { normalizeSpeech, parseVoiceCommand, type VoiceCommand, type VoiceTab } from "@/lib/voiceCommands";

export interface VoiceResult {
  /** Spoken back to the user (short). */
  reply: string;
  /** End the hands-free session after speaking the reply. */
  endSession?: boolean;
}

export interface VoiceAppTarget {
  activeTab: () => string;
  setTab: (tab: VoiceTab) => void;
  books: () => { id: string; title: string }[];
  openBook: (id: string) => void;
  hasActiveBook: () => boolean;
}

export type ReaderCommand = Extract<VoiceCommand, { kind: "page" | "pageBy" | "chapter" | "zoom" | "focus" | "screenshot" | "save" | "where" }>;

export interface VoiceReaderTarget {
  run: (cmd: ReaderCommand) => Promise<string>;
}

let app: VoiceAppTarget | null = null;
let reader: VoiceReaderTarget | null = null;

export function registerVoiceApp(t: VoiceAppTarget): () => void {
  app = t;
  return () => { if (app === t) app = null; };
}

export function registerVoiceReader(t: VoiceReaderTarget): () => void {
  reader = t;
  return () => { if (reader === t) reader = null; };
}

const TAB_NAMES: Record<VoiceTab, string> = {
  library: "Vault", viewer: "Read", chat: "Counsel", wiki: "Notebook", wikis: "Notebooks", settings: "Settings", admin: "Admin",
};

const HELP =
  "You can say: go to the read tab, next page, page 40, next chapter, chapter 3, zoom in, focus mode, " +
  "screenshot the image, screenshot the page, save the paragraph that says something, highlight the second sentence, " +
  "click any button by its name, scroll down, type something, open book and a title, or bookworm go to sleep.";

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

async function waitFor<T>(get: () => T | null | undefined, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(100);
  }
}

// ── Fuzzy name matching ───────────────────────────────────────────────────
function words(s: string): string[] {
  return normalizeSpeech(s).split(" ").filter(Boolean);
}

/** 0–100: how well a spoken label names an on-screen thing. */
export function labelScore(spoken: string, name: string): number {
  const a = normalizeSpeech(spoken);
  const b = normalizeSpeech(name);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.startsWith(a + " ") || b.endsWith(" " + a)) return 85;
  if (` ${b} `.includes(` ${a} `)) return 75;
  if (` ${a} `.includes(` ${b} `) && b.length >= 3) return 60;
  const aw = words(a);
  const bw = new Set(words(b));
  const hit = aw.filter((w) => bw.has(w) || [...bw].some((x) => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))).length;
  if (hit === 0) return 0;
  return Math.round((hit / Math.max(aw.length, bw.size)) * 55);
}

// ── DOM helpers for click / scroll / type / keys ─────────────────────────
function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.getClientRects().length === 0) return false;
  if (el.closest("[aria-hidden='true'], [inert]")) return false;
  const st = getComputedStyle(el);
  if (st.visibility === "hidden" || st.pointerEvents === "none" || Number(st.opacity) === 0) return false;
  return !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";
}

/** Text a sighted user reads on the control — icon ligatures excluded. */
function visibleText(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out += ` ${n.textContent || ""}`; return; }
    if (!(n instanceof Element)) return;
    if (n.matches(".material-symbols-outlined, .material-symbols-rounded, .material-icons, [aria-hidden='true'], svg, style, script")) return;
    n.childNodes.forEach(walk);
  };
  walk(el);
  return out.replace(/\s+/g, " ").trim();
}

function accessibleNames(el: Element): string[] {
  const names: string[] = [];
  const aria = el.getAttribute("aria-label");
  if (aria) names.push(aria);
  const by = el.getAttribute("aria-labelledby");
  if (by) by.split(/\s+/).forEach((id) => { const t = document.getElementById(id)?.textContent; if (t) names.push(t); });
  const title = el.getAttribute("title");
  if (title) names.push(title);
  const text = visibleText(el);
  if (text && text.length <= 80) names.push(text);
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const lab = el.labels?.[0]?.textContent;
    if (lab) names.push(lab);
  }
  return names;
}

const CLICKABLE =
  "button, a[href], [role='button'], [role='tab'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], " +
  "[role='option'], [role='switch'], [role='checkbox'], [role='radio'], [role='link'], input[type='checkbox'], input[type='radio'], summary";

/** The topmost open dialog/menu owns the screen — search it first. */
function searchRoot(): ParentNode {
  const layers = Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']"))
    .filter(isVisible);
  return layers.length ? layers[layers.length - 1] : document;
}

function pressElement(el: HTMLElement) {
  el.scrollIntoView?.({ block: "nearest" });
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  // Radix triggers (menus, selects, tabs) open on pointerdown, not click.
  try { el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse", isPrimary: true })); } catch { /* old engine */ }
  el.dispatchEvent(new MouseEvent("mousedown", init));
  try { el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse", isPrimary: true })); } catch { /* old engine */ }
  el.dispatchEvent(new MouseEvent("mouseup", init));
  el.click();
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function clickByLabel(label: string): string | null {
  const root = searchRoot();
  let best: { score: number; act: () => void; name: string } | null = null;
  const consider = (score: number, name: string, act: () => void) => {
    if (score > (best?.score ?? 0)) best = { score, act, name };
  };
  for (const el of Array.from(root.querySelectorAll(CLICKABLE))) {
    if (!isVisible(el)) continue;
    for (const n of accessibleNames(el)) consider(labelScore(label, n), n, () => pressElement(el as HTMLElement));
  }
  // Native <select> dropdowns (e.g. the reader's "Jump to chapter…"): pick the option.
  for (const sel of Array.from(root.querySelectorAll("select"))) {
    if (!isVisible(sel)) continue;
    for (const opt of Array.from(sel.options)) {
      if (!opt.value) continue;
      consider(labelScore(label, opt.text) - 5, opt.text, () => setNativeValue(sel, opt.value));
    }
  }
  const b = best as { score: number; act: () => void; name: string } | null;
  if (!b || b.score < 40) return null;
  b.act();
  return b.name.replace(/\s+/g, " ").trim().slice(0, 60);
}

function mainScroller(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = 0;
  const root = searchRoot();
  const all = root === document ? Array.from(document.querySelectorAll<HTMLElement>("main, div, section, ul, ol")) : Array.from((root as Element).querySelectorAll<HTMLElement>("*"));
  for (const el of all) {
    if (el.scrollHeight <= el.clientHeight + 20) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { best = el; bestArea = area; }
  }
  return best;
}

function scroll(dir: "up" | "down" | "top" | "bottom"): string {
  const el = mainScroller();
  const target: HTMLElement | Window = el ?? window;
  const h = el ? el.clientHeight : window.innerHeight;
  if (dir === "top") target.scrollTo({ top: 0, behavior: "smooth" });
  else if (dir === "bottom") target.scrollTo({ top: el ? el.scrollHeight : document.body.scrollHeight, behavior: "smooth" });
  else target.scrollBy({ top: (dir === "down" ? 1 : -1) * h * 0.8, behavior: "smooth" });
  return dir === "top" ? "Top." : dir === "bottom" ? "Bottom." : `Scrolled ${dir}.`;
}

function typeText(text: string): string {
  const isField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
    !!el && isVisible(el) && (el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && /^(?:text|search|email|url|number|tel|password|)$/.test(el.type)));
  let field: HTMLInputElement | HTMLTextAreaElement | null = isField(document.activeElement) ? document.activeElement : null;
  if (!field) {
    const root = searchRoot();
    field = (Array.from(root.querySelectorAll("textarea, input")).find(isField) as HTMLInputElement | HTMLTextAreaElement | undefined) ?? null;
  }
  if (!field) return "There's no text box on screen to type into.";
  const cur = field.value;
  setNativeValue(field, cur && !/\s$/.test(cur) ? `${cur} ${text}` : `${cur}${text}`);
  try { field.focus({ preventScroll: true }); } catch { /* no-op */ }
  return "Typed.";
}

function pressKey(key: "Enter" | "Escape"): string {
  const target = (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body) as HTMLElement;
  const init = { key, code: key, bubbles: true, cancelable: true, keyCode: key === "Enter" ? 13 : 27 } as KeyboardEventInit;
  const notCancelled = target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  if (key === "Enter" && notCancelled) {
    const form = target.closest?.("form");
    if (form) { try { form.requestSubmit(); } catch { /* no-op */ } }
  }
  return key === "Enter" ? "Entered." : "Closed.";
}

// ── Books ─────────────────────────────────────────────────────────────────
function findBook(title: string): { id: string; title: string } | null {
  if (!app) return null;
  let best: { id: string; title: string } | null = null;
  let bestScore = 0;
  for (const b of app.books()) {
    const s = labelScore(title, b.title || "");
    if (s > bestScore) { best = b; bestScore = s; }
  }
  return bestScore >= 45 ? best : null;
}

// ── Running ───────────────────────────────────────────────────────────────
async function runReader(cmd: ReaderCommand): Promise<string> {
  if (!app) return "The reader isn't available right now.";
  if (cmd.kind === "where" && app.activeTab() !== "viewer") {
    return `You're on the ${TAB_NAMES[app.activeTab() as VoiceTab] ?? app.activeTab()} tab.`;
  }
  if (!app.hasActiveBook()) {
    app.setTab("library");
    return "No book is open. Say open book, then its title — or pick one in the Vault.";
  }
  if (app.activeTab() !== "viewer") app.setTab("viewer");
  const r = await waitFor(() => reader, 5000);
  if (!r) return "The reader didn't open in time — try again.";
  return r.run(cmd);
}

async function runOne(cmd: VoiceCommand): Promise<VoiceResult | null> {
  switch (cmd.kind) {
    case "sleep":
      return { reply: "Going to sleep. Tap the mic when you need me.", endSession: true };
    case "help":
      return { reply: HELP };
    case "tab":
      if (!app) return null;
      app.setTab(cmd.tab);
      return { reply: `${TAB_NAMES[cmd.tab]}.` };
    case "back":
      if (app?.activeTab() === "viewer") return { reply: await runReader({ kind: "page", to: "prev" }) };
      return null; // "go back" elsewhere is ambiguous — let the model answer
    case "openBook": {
      const book = findBook(cmd.title);
      if (book && app) {
        app.openBook(book.id);
        return { reply: `Opening ${book.title}.` };
      }
      // "open settings menu", "show me the next page" — maybe a control on screen.
      const clicked = clickByLabel(cmd.title);
      return clicked ? { reply: `${clicked}.` } : null;
    }
    case "click": {
      const clicked = clickByLabel(cmd.label);
      if (clicked) return { reply: `${clicked}.` };
      const tab = parseVoiceCommand(`go to ${cmd.label}`);
      if (tab?.kind === "tab") return runOne(tab);
      return { reply: `I can't find ${cmd.label} on screen.` };
    }
    case "scroll":
      return { reply: scroll(cmd.dir) };
    case "type":
      return { reply: typeText(cmd.text) };
    case "key":
      return { reply: pressKey(cmd.key) };
    case "multi": {
      const replies: string[] = [];
      let end = false;
      for (const c of cmd.commands) {
        const res = await runOne(c);
        if (!res) break;
        replies.push(res.reply);
        if (res.endSession) { end = true; break; }
        await sleep(250); // let React render between steps (e.g. tab, then page)
      }
      return replies.length ? { reply: replies.join(" "), endSession: end } : null;
    }
    default:
      return { reply: await runReader(cmd) };
  }
}

/** Run `text` as a voice command. null → not a command (send to the model). */
export async function runVoiceUtterance(text: string): Promise<VoiceResult | null> {
  const cmd = parseVoiceCommand(text);
  if (!cmd) return null;
  try {
    return await runOne(cmd);
  } catch (e) {
    console.warn("Voice command failed:", e);
    return { reply: "That didn't work — try saying it another way." };
  }
}
