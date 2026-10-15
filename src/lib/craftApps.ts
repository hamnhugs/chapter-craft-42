// The creative apps — PhotoCraft (Photoshop-style), DesignCraft (InDesign-
// style) and FilmCraft (Premiere-style) from github.com/storytold — driven from
// the chat through the craft bridge (scripts/local-ai/craft-bridge.mjs), which
// speaks each app's own MCP server and reaches the open window when there is
// one. Reached same-origin at /local/crafts; the header is what the bridge
// checks, and a cross-origin page can't send it.
//
// ONE tool, `craft`, with an action — not ten. The roster is at its budget
// (toolRosterBudget.test.ts) and a 4B local model reads one card more reliably
// than a family of near-synonyms. Every menu command of every app is still in
// reach: find_commands searches the app's catalog (~700-900 commands each) and
// run executes any of them; call reaches the app's raw MCP tools (pointer,
// dialogs, screenshots) for whatever the commands don't cover.

import { getSignedImageUrl, storeGeneratedImage, type ChatImageRef } from "@/lib/imageGen";
import type { BookDocument, Chapter } from "@/types/library";

export const CRAFT_APPS = ["photocraft", "designcraft", "filmcraft"] as const;
export type CraftApp = (typeof CRAFT_APPS)[number];
const LABEL: Record<CraftApp, string> = { photocraft: "PhotoCraft", designcraft: "DesignCraft", filmcraft: "FilmCraft" };
/** DesignCraft page looks (scripts/local-ai/design-looks.mjs LOOK_NAMES). */
export const PAGE_LOOKS = ["bold", "cinematic", "editorial", "swiss", "classic", "minimal", "split", "pop", "direct"] as const;
export const CRAFT_ACTIONS = ["status", "open", "find_commands", "run", "inspect", "preview", "send", "pages", "export", "transfer", "save_template", "use_template", "app_tools", "call"] as const;
type CraftAction = (typeof CRAFT_ACTIONS)[number];

const BASE = "/local/crafts";
const HEADERS = { "X-Chapter-Craft": "1" };
/** Long enough for a FilmCraft movie export; the bridge has its own limits. */
const TIMEOUT_MS = 31 * 60_000;
const RESULT_CAP = 6_000;

export const CRAFT_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "craft",
    // Kept under the local roster's 700-character clip (localRoster.ts
    // slimToolDef) with the action guide inside it: parameter descriptions are
    // clipped to 200, which cut the guide off after four actions.
    description:
      "Edit photos (layers, text, colour), design flyers, posters, covers and books, edit video in the user's apps PhotoCraft (like Photoshop), DesignCraft (like InDesign) and FilmCraft (like Premiere Pro). A clear, undoable ask: just do it, writing any wording yourself from the book in context. Ask ONE short question with 2-4 choices when it's unclear which layer or item is meant; always ask before merge, flatten or delete. Keep the user's layers. Actions: send/open puts image_id, chapter_id or text in (DesignCraft: `role`, `page`; `look` designs it); pages (add, front+back, size); save_template/use_template; find_commands, then run; export; transfer; inspect/preview; status; app_tools/call.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...CRAFT_ACTIONS],
          description: "What to do; each action is described in the tool description.",
        },
        app: { type: "string", enum: [...CRAFT_APPS], description: "Which app. Not needed for status." },
        query: { type: "string", description: "find_commands: what you want to do, in plain words, e.g. 'gaussian blur', 'add text layer', 'export pdf', 'add transition'." },
        steps: {
          type: "array",
          description: "run: [{id, params}] as find_commands lists them. PhotoCraft: layer.new.layer, type.create, type.setStyle, layer.newAdjustmentLayer.brightnessContrast / vibrance / curves, image.autoTone",
          items: { type: "object", properties: { id: { type: "string" }, params: { type: "object" } }, required: ["id"] },
        },
        image_id: { type: "string", description: "send/open: a library image to bring into the app." },
        chapter_id: { type: "string", description: "send/open: a chapter id from the book's chapter list; the app reads its text itself (DesignCraft adds pages as needed) — don't open or read the chapter first." },
        text: { type: "string", description: "send/open: text to put into the app (a text frame, a type layer, or a title in the video)." },
        role: { type: "string", enum: ["headline", "subhead", "image", "body", "caption", "footer"], description: "DesignCraft send: the page part — headline (write a punchy one from the book) on top, footer at the bottom; laid out and checked for you. Same role + options restyles its text." },
        look: { type: "string", enum: [...PAGE_LOOKS], description: "DesignCraft page design, done like a pro: bold (event flyer), cinematic (book cover, movie poster), editorial (magazine), swiss (modern), classic (elegant), minimal, split, pop (fun), direct (Ogilvy-style ad that sells). Alone: restyles the page." },
        layer: { type: "string", description: "PhotoCraft run/send: the layer to act on, by name or id (e.g. the photo for a colour fix). New layers go just above it; nothing above it changes." },
        to: { type: "string", enum: [...CRAFT_APPS], description: "transfer: the app that receives `app`'s work." },
        format: { type: "string", description: "export/transfer: png, jpg, webp, psd (PhotoCraft); png, pdf, epub, html, txt, idml (DesignCraft); png (one frame), mp4, gif, wav, srt (FilmCraft). Default png." },
        to_library: { type: "boolean", description: "export with format pdf or epub: also add it to the user's bookshelf as a book." },
        title: { type: "string", description: "export: a name for the result. save_template/use_template: the template's name (DesignCraft)." },
        page: { type: "integer", description: "DesignCraft: which page, 0 = first/front, 1 = second/back (send, preview, export, pages). Leave out for the page in use." },
        seconds: { type: "number", description: "preview/export in FilmCraft: the moment to show, in seconds." },
        tool: { type: "string", description: "call: the app tool's name, from app_tools." },
        arguments: { type: "object", description: "call: that tool's arguments." },
        options: { type: "object", description: "DesignCraft send with role: {color:'#hex', size, font, align}; open: {preset:'Letter'|'A4'|'Poster'|'Postcard'|'Book'…, pages:n, numbers:true, sides:2 only if asked to print both sides} = new document. pages: {add, delete, move:{from,to}, duplicate, sides, preset, landscape, bleed, margins, columns, numbers}. export pdf: {print (bleed + crop marks), booklet, pages}. PhotoCraft send {new_document:true}. FilmCraft {seconds, track}." },
      },
      required: ["action"],
    },
  },
} as const;

/** Rides on every successful edit: the stack the bridge returns shows where
 *  things landed, so no extra inspect round is needed, and the reply ends the
 *  way the user asked for — what changed, where, and what could come next. */
const AFTER_EDIT =
  "Done. `layers` (top first) shows where it landed — if it sits on or affects the wrong layer, fix that now. Tell the user in a line what changed and on which layer, then offer 1-2 short next ideas.";
/** The same for a DesignCraft page, whose parts the bridge has laid out and
 *  checked (cut-off text, off the page) already. */
const AFTER_PAGE =
  "Done — the page is laid out in its `look`. `items` lists it top first. Fix anything in `issues` now (shorter text). Tell the user in a line what's on the page, then offer 1-2 short next ideas (a subhead, another look from `looks`, export to PDF).";

/** The note after a page edit, leading with what the page still lacks: with
 *  only the picture placed, Qwen3-4B replied about the picture and dropped the
 *  headline the user had asked for in the same breath (2026-10-14). */
export function pageNote(r: any): string {
  const has = (role: string) => (r?.items || []).some((i: any) => i.role === role);
  // Several pages (a two-sided flyer, a newsletter): which one this was, and
  // which are still empty — "front and back" asked in one breath otherwise
  // ends with the back never designed.
  const pages: any[] = Array.isArray(r?.pages) ? r.pages : [];
  const empty = pages.filter((p) => p.empty).map((p) => `the ${p.side} (page ${p.page})`);
  const where = pages.length > 1
    ? `That was the ${r.side} (page ${r.page}).${empty.length ? ` Still empty: ${empty.join(", ")}. If the user asked for it, fill it now: send with role, text and page.` : ""} `
    : "";
  const noHeadline = !has("headline") && !(pages.length > 1 && r?.page > 0);
  // The user's change (bigger, another font) ran a part into another one. The
  // bridge changed only what was asked and moved nothing else (the user's rule,
  // 2026-10-14), so the reply must say so and ask, never "fix" it by moving
  // things: Qwen3-4B answered "now larger and blue" and left the overlap unsaid.
  const crowd: string[] = (r?.issues || []).filter((i: string) => /nothing else was moved/.test(i));
  if (crowd.length) {
    const what = crowd.map((i) => i.replace(/; nothing else was moved\..*$/, ".")).join(" ");
    return `${where}Only what the user asked was changed, but now: ${what} Say this plainly in your reply and ask whether to make room (laying the page out again) or leave it. Don't move or resize anything else yourself.`;
  }
  return `${where}${noHeadline ? "No headline on the page yet. " : ""}${AFTER_PAGE}`;
}

/** A page edit that left other pages empty (the back of a two-sided flyer),
 *  as a spelled-out call: Qwen3-4B described the back it meant to make and
 *  stopped, reading past the note (2026-10-14). ChatContext gives a `next`
 *  starting "Now do it" one more round when the reply stops without calling. */
export function emptyPagesNext(r: any): string | null {
  const pages: any[] = Array.isArray(r?.pages) ? r.pages : [];
  if (pages.length < 2) return headlineNext(r);
  // Not while the page just edited still lacks its headline: "the image and a
  // headline at the top" put the headline on the empty back (Qwen3-4B,
  // 2026-10-14). That page's own note asks for its headline first.
  const here = (r?.items || []).map((i: any) => i.role);
  if (r?.page === 0 && !here.includes("headline")) return headlineNext(r);
  const empty = pages.filter((p) => p.empty);
  // The front with no picture: "the image and a headline on the front" came
  // back headline-only, the picture never sent (Qwen3-4B, 2026-10-14).
  const bare = pages[0] && !pages[0].empty && !(pages[0].parts || []).includes("image");
  if (!empty.length && !bare) return null;
  const steps: string[] = [];
  if (bare) steps.push(`for a picture the user asked for: send with app "designcraft", page 0, role "image", image_id = that picture's id`);
  for (const e of empty.slice(0, 2)) steps.push(`for what the user wanted on the ${e.side}: send with app "designcraft", page ${e.page}, role "body" (or "headline"), text = that content, written from what the user said`);
  const what = [bare ? `the ${pages[0].side} (page 0) has no picture` : null, ...empty.slice(0, 2).map((e) => `the ${e.side} (page ${e.page}) is empty`)].filter(Boolean).join(" and ");
  return `Now do it: ${what}. Make the calls the user's request needs — ${steps.join("; ")}. If they asked for none of it, just say what's done.`;
}

/** A first page with a picture and no headline, as a spelled-out call:
 *  "place the image and add a headline to the top" ended picture-only in 2 of
 *  3 sessions once the card grew (2026-10-14); the plain note was read past. */
export function headlineNext(r: any): string | null {
  const roles = (r?.items || []).map((i: any) => i.role);
  if ((r?.page ?? 0) !== 0 || !roles.includes("image") || roles.includes("headline")) return null;
  return `Now do it: the page has the picture but no headline. If the user asked for a headline (or a title), call craft with action "send", app "designcraft", role "headline", text = the headline, written yourself from the book. If they didn't, just say what's done.`;
}

/** Longer than this, text sent to DesignCraft is a story that flows across
 *  pages, not a part of one page. */
const PAGE_PART_MAX = 1200;

/** DesignCraft sends that are parts of a page (a picture, a headline, a
 *  paragraph) rather than a chapter flowing over pages, and not placed by hand. */
export function isPagePart(args: any): boolean {
  if (args?.app !== "designcraft" || args?.chapter_id) return false;
  const o = args?.options || {};
  if (o.x != null || o.y != null || o.frame != null) return false;
  if (args?.role || args?.look || o.look || (Array.isArray(args?.ids) && args.ids.length)) return true;
  if (pageImageId(args)) return true;
  return typeof args?.text === "string" && args.text.trim().length > 0 && args.text.length <= PAGE_PART_MAX;
}

const LIBRARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The library picture a DesignCraft send carries. `layer` means nothing on a
 *  page; Qwen3-4B put the image id there (2026-10-13). */
function pageImageId(args: any): string | null {
  if (args?.image_id) return String(args.image_id);
  return args?.app === "designcraft" && LIBRARY_ID.test(String(args?.layer || "")) ? String(args.layer) : null;
}

async function composePart(args: any, deps: CraftDeps): Promise<any> {
  // "headline,footer" or ["headline","footer"]: the same change on each part
  // (Qwen3-4B sent "make these red" that way, 2026-10-14).
  const roles = Array.isArray(args.role) ? args.role : typeof args.role === "string" && args.role.includes(",") ? args.role.split(",") : null;
  if (roles) {
    let last: any = null;
    for (const r of roles.map((x: any) => String(x).trim().toLowerCase()).filter(Boolean)) last = await composePart({ ...args, role: r }, deps);
    return last;
  }
  const imageId = pageImageId(args);
  const img = imageId ? await libraryImageToWorkspace(imageId, deps) : null;
  const o = args.options || {};
  // "Printed on both sides", or a size, in the same send: the document is set
  // up first (only made two-sided when one is already open).
  if (o.sides || o.two_sided || o.preset || (o.width && o.height) || o.pages > 1 || o.numbers) {
    await bridge("/pages", { app: "designcraft", ensure: true, ...Object.fromEntries(["sides", "two_sided", "preset", "width", "height", "landscape", "orientation", "pages", "numbers", "bleed"].filter((k) => o[k] != null).map((k) => [k, o[k]])) });
  }
  const look = args.look || o.look;
  // With a look in the call, the look sets the type; a size or font the model
  // adds alongside ("48pt Impact") would undo it. Colour still goes through.
  const style = { ...(look ? {} : { size: o.size, font: o.font, align: o.align }), color: o.color, add: o.add, page: args.page, look, ...(Array.isArray(args.ids) && args.ids.length ? { ids: args.ids } : {}) };
  const text = typeof args.text === "string" && args.text.trim() ? args.text : undefined;
  // The part named in `layer` (PhotoCraft's word) when there's no role.
  const layerRole = PAGE_ROLES.includes(String(args.layer || "").toLowerCase()) ? String(args.layer).toLowerCase() : undefined;
  args = { ...args, role: args.role || layerRole };
  if (!img) return bridge("/compose", { app: "designcraft", role: args.role, text, ...style, replace: o.replace });
  // A picture is the image part. With text in the same call ("place the image
  // and add a headline"), the text goes on as its own part after it.
  // A picture for selected frames goes into them.
  if (Array.isArray(args.ids) && args.ids.length) return bridge("/compose", { app: "designcraft", path: img.path, ids: args.ids, page: args.page, ...(text ? { text } : {}) });
  const placed = await bridge("/compose", { app: "designcraft", role: "image", path: img.path, page: args.page, replace: o.replace, look });
  // A text role with a picture but no words: Qwen3-4B's way of leaving out
  // the headline it meant to write (2 of 5 sessions, 2026-10-14). Say so as an
  // error, which it does act on, rather than as a hint, which it reads past.
  if (!text && args.role && args.role !== "image" && !(placed.items || []).some((i: any) => i.role === args.role)) {
    return { ...placed, ok: false, error: `Placed the picture, but the ${args.role} had no text, so it isn't on the page. Call craft again now: action "send", app "designcraft", role "${args.role}", text = the ${args.role} itself (write it from the book).` };
  }
  if (!text) return placed;
  return bridge("/compose", { app: "designcraft", role: args.role === "image" ? undefined : args.role, text, ...style });
}

export interface CraftDeps {
  /** The user's message this turn, when known (askedOptions). */
  userText?: string;
  books: BookDocument[];
  loadChapterText?: (chapterId: string) => Promise<string>;
  addBook?: (book: BookDocument, sourceFile?: File, opts?: any) => Promise<string>;
  currentModel?: string;
  fetchImage?: (imageId: string) => Promise<{ id: string; storage_path: string; prompt?: string } | null>;
  /** An auto-continue continuation run: refuse calls that throw away earlier
   *  runs' work (destructiveCraftCall). */
  protectWork?: boolean;
}

// Command ids that throw work away whatever they're given, and ones that do
// when they reach more than one item.
const WIPES = /(?:pages?\.delete|delete_?pages?|new_?document|(?:file|document)\.(?:new|close|revert)|flatten|merge)/i;
const REMOVES = /(?:delete|clear|remove|erase)/i;
const manyIds = (p: any) => !Array.isArray(p?.ids) || p.ids.length !== 1;

/** What a craft call would throw away, said plainly, or null when it keeps
 *  the work. On 2026-10-15 an auto-continue run inspected a back page it had
 *  built over three runs, disliked it, and deleted the page; the next run
 *  rebuilt it. Continuation runs must change parts in place instead. */
export function destructiveCraftCall(args: any, action: string): string | null {
  const o = args?.options || {};
  if (action === "pages" && pagesOptions(args, String(args?.action || "")).delete != null && pagesOptions(args, String(args?.action || "")).delete !== false) return "delete pages";
  if ((action === "open" || action === "send") && (o.new_document || (args?.app === "designcraft" && action === "open" && (o.preset || (o.width && o.height) || o.sides || o.pages > 1)))) return "start a new document";
  if (action === "run") {
    for (const st of Array.isArray(args?.steps) ? args.steps : []) {
      const id = String(st?.id || "");
      if (WIPES.test(id)) return `run ${id}`;
      if (REMOVES.test(id) && manyIds(st?.params)) return `run ${id} on more than one item`;
    }
  }
  if (action === "call") {
    const tool = String(args?.tool || "");
    if (WIPES.test(tool)) return `call ${tool}`;
    if (REMOVES.test(tool) && manyIds(args?.arguments)) return `call ${tool} on more than one item`;
  }
  return null;
}

type Outcome = { result: any; event: { name: string; summary: string; ok: boolean } };

class CraftError extends Error {}

async function bridge(path: string, body?: unknown, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: body === undefined && !init?.body ? "GET" : "POST",
      headers: { ...HEADERS, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : init?.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CraftError("The creative apps aren't reachable — the craft bridge isn't running. Starting Chapter Craft from the app menu starts it; install the apps with scripts/local-ai/install-crafts.sh.");
  }
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    // No JSON at all: the proxy answered because the bridge didn't.
    if (!data) throw new CraftError("The craft bridge isn't running. Start Chapter Craft from the app menu (it starts the bridge), or run scripts/local-up.sh.");
    throw new CraftError(data?.error || `craft bridge: HTTP ${res.status}`);
  }
  return data;
}

/** A saved DesignCraft template, as the chat's template picker shows it. */
export interface DesignTemplate { name: string; slug: string; about: string; width: number; height: number; parts: string[]; created: string; pages?: number; twoSided?: boolean }

/** The saved templates, newest first (the template picker card). */
export async function listDesignTemplates(): Promise<DesignTemplate[]> {
  const r = await bridge("/template/list", {});
  const all: DesignTemplate[] = (r.templates || []).map((t: any) => ({ name: t.name, slug: t.slug, about: t.about, width: t.width, height: t.height, parts: t.parts || [], created: t.created || "", pages: Number(t.pages) || 1, twoSided: !!t.two_sided }));
  return all.sort((a, b) => b.created.localeCompare(a.created));
}

/** A template's screenshot as an object URL (the bridge wants its header, so
 *  an <img src> can't fetch it directly). The caller revokes it. */
export async function designTemplateThumb(slug: string): Promise<string> {
  const res = await fetch(`${BASE}/template/thumb?slug=${encodeURIComponent(slug)}`, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new CraftError("no screenshot");
  return URL.createObjectURL(await res.blob());
}

export async function deleteDesignTemplate(name: string): Promise<void> {
  await bridge("/template/delete", { name });
}

async function uploadBlob(blob: Blob, name: string): Promise<string> {
  const r = await bridge(`/files?name=${encodeURIComponent(name)}`, undefined, { body: blob });
  return r.path;
}

async function fileBlob(path: string): Promise<Blob> {
  const res = await fetch(`${BASE}/files?path=${encodeURIComponent(path)}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new CraftError(`Couldn't read ${path} from the craft workspace`);
  return res.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

/** JSON for the model, capped — inspect replies can run to hundreds of KB. */
export function capResult(value: unknown, cap = RESULT_CAP): unknown {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s || s.length <= cap) return value;
  return { truncated: true, total_chars: s.length, head: s.slice(0, cap), note: "Cut to fit. Ask for less (a narrower command, one layer or page) to see the rest." };
}

/** Pages in a PDF, read from its page objects — enough for the bookshelf's
 *  page count without loading pdf.js here. */
export function pdfPageCount(bytes: Uint8Array): number {
  const s = new TextDecoder("latin1").decode(bytes);
  return (s.match(/\/Type\s*\/Page(?![a-z])/g) || []).length;
}

const isApp = (v: unknown): v is CraftApp => (CRAFT_APPS as readonly string[]).includes(String(v));

async function libraryImageToWorkspace(imageId: string, deps: CraftDeps): Promise<{ path: string; prompt?: string }> {
  const row = await deps.fetchImage?.(imageId);
  if (!row) throw new CraftError(`No library image has the id "${imageId.slice(0, 60)}". list_images finds ids.`);
  const url = await getSignedImageUrl(row.storage_path);
  if (!url) throw new CraftError("That image couldn't be loaded from storage.");
  const blob = await (await fetch(url, { signal: AbortSignal.timeout(120_000) })).blob();
  const ext = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
  return { path: await uploadBlob(blob, `image-${row.id.slice(0, 8)}.${ext}`), prompt: row.prompt };
}

async function chapterText(chapterId: string, deps: CraftDeps): Promise<{ text: string; name: string }> {
  for (const b of deps.books) {
    const c: Chapter | undefined = b.chapters.find((ch) => ch.id === chapterId);
    if (c) {
      const text = c.textContent || (deps.loadChapterText ? await deps.loadChapterText(c.id) : "");
      if (!text.trim()) throw new CraftError(`Chapter "${c.name}" has no text to send.`);
      return { text: c.name && !text.trimStart().startsWith(c.name) ? `${c.name}\n\n${text}` : text, name: c.name || "chapter" };
    }
  }
  throw new CraftError(`No chapter has the id "${chapterId.slice(0, 60)}". get_book lists chapter ids.`);
}

/** An exported file → what the chat gets: pictures stored in the library and
 *  shown, text inline, a PDF/EPUB optionally on the bookshelf, anything else
 *  left in the workspace with its path. */
async function bringBack(app: CraftApp, file: any, args: any, deps: CraftDeps): Promise<any> {
  const out: any = { file: file.name, path: file.path, mime: file.mime, bytes: file.bytes };
  if (String(file.mime).startsWith("image/") && file.mime !== "image/vnd.adobe.photoshop" && file.mime !== "image/tiff") {
    const blob = await fileBlob(file.path);
    const dataUrl = await blobToDataUrl(blob);
    const title = String(args.title || `${LABEL[app]} export`).slice(0, 200);
    const ref: ChatImageRef = await storeGeneratedImage({ prompt: title, caption: `Exported from ${LABEL[app]}`, model: `local:${app}`, dataUrl, mime: file.mime });
    return { ...out, image_id: ref.id, note: "Saved to the image library and shown to the user.", __images: [ref] };
  }
  if (file.text != null) return { ...out, text: capResult(file.text) };
  if (args.to_library && (file.mime === "application/pdf" || file.mime === "application/epub+zip")) {
    if (!deps.addBook) return { ...out, note: "Saved in the craft workspace; the bookshelf isn't available in this session." };
    const blob = await fileBlob(file.path);
    const bytes = await blobBytes(blob);
    const title = String(args.title || `${LABEL[app]} document`).replace(/\s+/g, " ").trim().slice(0, 300);
    const fileName = `${title.replace(/[^\w.-]+/g, "-").slice(0, 80) || "document"}.${file.mime === "application/pdf" ? "pdf" : "epub"}`;
    const doc: BookDocument = {
      id: crypto.randomUUID(), title, fileName, fileData: "", pageCount: file.mime === "application/pdf" ? pdfPageCount(bytes) : 0,
      chapters: [], addedAt: Date.now(), folderIds: [], source: "assistant",
    } as BookDocument;
    const bookId = await deps.addBook(doc, new File([bytes], fileName, { type: file.mime }), { createOnly: true, source: "assistant", sourceModel: deps.currentModel });
    return { ...out, book_id: bookId, note: `Added to the bookshelf as "${title}".` };
  }
  return { ...out, note: `Saved in the craft workspace at ${file.path}.` };
}

/** What a small model meant when the action and the arguments disagree:
 *  run with a query and no steps is a search, and an invented action ("create",
 *  "add_title") carrying content is a send. Measured on Qwen3-4B, 2026-10-13. */
export function resolveAction(args: any): string {
  const action = String(args?.action || "").trim().toLowerCase();
  const hasSteps = Array.isArray(args?.steps) && args.steps.length > 0;
  const hasContent = !!(args?.image_id || args?.chapter_id || args?.role || args?.look || (Array.isArray(args?.ids) && args.ids.length) || (typeof args?.text === "string" && args.text.trim()));
  if (action === "run" && !hasSteps && args?.query) return "find_commands";
  // "create_template", "apply template", "load_template"…
  if (/templ/.test(action)) return /save|creat|make|store|new/.test(action) ? "save_template" : "use_template";
  // "add_page", "delete_pages", "duplicate_page", "new_page" (not preview/export of a page).
  if (/pages?\b|pages?_|_pages?/.test(action) && /add|insert|new|delete|remove|dup|copy|move|reorder|setup|size|number|side/.test(action)) return "pages";
  if ((CRAFT_ACTIONS as readonly string[]).includes(action)) return action;
  // No action, content and a page size: the content wins. "Make it look
  // amazing" came as {look:"bold", options:{preset:"A4"}} and opened a new,
  // empty page over the user's work (Qwen3-4B, 2026-10-14).
  if (hasContent && !hasSteps) return "send";
  // No action and a page size: "open a flyer-sized page" (Qwen3-4B, 2026-10-13).
  if (args?.options?.preset || (args?.options?.width && args?.options?.height)) return "open";
  if (hasSteps) return "run";
  if (hasContent) return "send";
  // {format:"pdf"} with no action: an export (Qwen3-4B, 2026-10-14).
  if ((args?.format || args?.options?.print || args?.options?.booklet) && !args?.to) return "export";
  if (args?.query) return "find_commands";
  return action;
}

/** A DesignCraft `run` aimed at a page part by name ("layer": "headline")
 *  with a colour, size, font or alignment in its steps is a restyle of that
 *  part. Qwen3-4B guessed eight command ids for "make the headline red" this
 *  way (2026-10-14); the part's send does it in one call. */
export function pagePartRestyle(args: any): any | null {
  if (args?.app !== "designcraft" || String(args?.action || "") !== "run") return null;
  const role = String(args?.layer || args?.role || "").toLowerCase();
  if (!PAGE_ROLES.includes(role)) return null;
  const p: any = Object.assign({}, ...(Array.isArray(args.steps) ? args.steps : []).map((st: any) => st?.params || {}));
  const options = {
    color: p.color ?? p.fill ?? p.fillColor ?? p.textColor,
    size: p.size ?? p.fontSize ?? p.pointSize,
    font: p.font ?? p.fontFamily,
    align: p.align ?? p.alignment,
  };
  if (!Object.values(options).some((v) => v != null)) return null;
  return { action: "send", app: "designcraft", role, options: Object.fromEntries(Object.entries(options).filter(([, v]) => v != null)) };
}
const PAGE_ROLES = ["headline", "subhead", "body", "caption", "footer"];

/** `sides` and `numbers` count only when the user asked for them: Qwen3-4B
 *  fills in every key the options description shows, so "open the right
 *  page size for a flyer" came as {pages:1, sides:2, numbers:true} (3 of 3,
 *  2026-10-14) — the same call it makes when both sides WERE asked for. With
 *  no user text (tests, other callers) the options stand. */
const ASKS_TWO_SIDED = /\b(both sides|two[- ]sided|double[- ]sided|duplex|front and back|front ?& ?back|front\/back|back ?side|on the back|the back|reverse side|two sides|flip ?side)\b/i;
const ASKS_NUMBERS = /page numbers?|number(ed)? (the |its |all )?pages|numbered|paginat/i;
export function askedOptions(o: any, userText?: string): any {
  if (!o || typeof o !== "object" || userText == null) return o;
  const out = { ...o };
  if ((out.sides != null || out.two_sided != null) && !ASKS_TWO_SIDED.test(userText)) { delete out.sides; delete out.two_sided; }
  if (out.numbers && !ASKS_NUMBERS.test(userText)) delete out.numbers;
  return out;
}

/** After a page structure change: how the model reaches each page. */
const PAGES_NOTE = "`pages` lists every page (0 = first). Put parts on one with send + role + page; tell the user in a line what changed.";

/** The pages action's options, read loosely: `page` names the page for a
 *  delete/duplicate given as `true` ("delete this page"), and a bare number
 *  or word for add ("add 2 pages", "add a back"). */
export function pagesOptions(args: any, action = ""): Record<string, unknown> {
  const o = { ...(args?.options || {}) };
  const ops = ["add", "delete", "duplicate", "move", "sides", "numbers", "preset", "width", "facing", "bleed", "margins", "columns"];
  if (!ops.some((k) => o[k] != null)) {
    if (/add|insert|new/.test(action)) o.add = 1;
    else if (/delete|remove/.test(action)) o.delete = true;
    else if (/dup|copy/.test(action)) o.duplicate = true;
  }
  if (args?.page != null) {
    if (o.delete === true) o.delete = [args.page];
    else if (o.duplicate === true) o.duplicate = args.page;
    else if (o.add == null && o.move == null && o.delete == null && o.duplicate == null) o.page = args.page;
  }
  if (typeof o.add === "string") {
    if (/back|side/i.test(o.add)) { o.sides = 2; delete o.add; } else o.add = parseInt(o.add, 10) || 1;
  }
  if (o.add === true) o.add = 1;
  return o;
}

/** Several page parts in one call, the way Qwen3-4B planned a two-sided flyer
 *  (2026-10-14): `pages: [{page, role, text, options:{image_id}}…]`, often
 *  with the document's setup as `open: {preset, sides, pages}`. → the setup
 *  as options, and one send per part. Null when the call isn't that. */
export function partBatch(args: any): { setup: Record<string, unknown> | null; parts: any[] } | null {
  if (args?.app !== "designcraft") return null;
  const list = Array.isArray(args?.pages) ? args.pages : Array.isArray(args?.parts) ? args.parts : null;
  if (!list || !list.some((e: any) => e && typeof e === "object" && (e.role || e.text || e.image_id || e.options?.image_id))) return null;
  const setup = args.open && typeof args.open === "object" ? args.open : args.options && (args.options.sides || args.options.preset || args.options.pages) ? args.options : null;
  const parts = list.filter((e: any) => e && typeof e === "object").map((e: any) => {
    const { image_id, ...o } = e.options || {};
    return { action: "send", app: "designcraft", page: e.page, role: e.role, ...(e.text ? { text: e.text } : {}), ...(e.image_id || image_id ? { image_id: e.image_id || image_id } : {}), ...(Object.keys(o).length ? { options: o } : {}) };
  });
  return { setup, parts };
}

export async function runCraftTool(args: any, deps: CraftDeps): Promise<Outcome> {
  const name = "craft";
  if (args?.app === "designcraft" && args?.options) args = { ...args, options: askedOptions(args.options, deps.userText) };
  if (args?.app === "designcraft" && args?.open && typeof args.open === "object") args = { ...args, open: askedOptions(args.open, deps.userText) };
  const batch = partBatch(args);
  if (batch) {
    // The picture first, so text lays out around it; then the rest in order.
    const order = [...batch.parts.filter((p) => p.image_id), ...batch.parts.filter((p) => !p.image_id)];
    let last: Outcome | null = null;
    const done: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const part = { ...order[i], ...(i === 0 && args.look ? { look: args.look } : {}) };
      if (i === 0 && batch.setup) part.options = { ...batch.setup, ...(part.options || {}) };
      last = await runCraftTool(part, deps);
      done.push(`${part.role || (part.image_id ? "image" : "text")}${part.page != null ? ` on page ${part.page}` : ""}${last.event.ok ? "" : " (failed)"}`);
      if (!last.event.ok && /isn't running|aren't reachable|isn't installed/.test(String(last.result?.error || ""))) break;
    }
    if (!last) throw new Error("empty batch");
    return { result: { ...last.result, batch: done }, event: { ...last.event, summary: `Put ${done.length} parts on the DesignCraft pages` } };
  }
  args = pagePartRestyle(args) || args;
  const action = resolveAction(args) as CraftAction;
  const app = args?.app;
  const ok = (result: any, summary: string): Outcome => ({ result, event: { name, summary, ok: true } });
  const wipe = deps.protectWork ? destructiveCraftCall(args, action) : null;
  if (wipe) {
    return {
      result: { ok: false, error: `Not run: auto-continue keeps what earlier runs made, so this run can't ${wipe}. Fix the part that's wrong in place — send the same role again to replace it, or change one item. If starting over is really needed, call finish_task with status needs_user and ask the user.` },
      event: { name, summary: `Kept earlier work: didn't ${wipe}`, ok: false },
    };
  }
  try {
    if (!(CRAFT_ACTIONS as readonly string[]).includes(action)) throw new CraftError(`action must be one of: ${CRAFT_ACTIONS.join(", ")}`);
    if (action === "status") {
      const s = await bridge("/status");
      return ok(s.apps, "Checked the creative apps");
    }
    if (!isApp(app)) throw new CraftError(`app must be one of: ${CRAFT_APPS.join(", ")}`);
    const L = LABEL[app];
    switch (action) {
      case "open": {
        // Takes the same content as send: "lay out this chapter in DesignCraft"
        // reaches for open, so open with a chapter_id does the whole job.
        // "Open a flyer-sized page": a new document in one call, not a command search.
        const o = args.options || {};
        const newPage = app === "designcraft" && (o.preset || (o.width && o.height) || o.sides || o.pages > 1);
        if (newPage) {
          await bridge("/open", { app });
          const r = await bridge("/pages", { app, ...o, new: true, ...(args.title ? { title: String(args.title) } : {}) });
          if (!isPagePart({ ...args, options: {} })) {
            const what = r.two_sided ? "two-sided (front and back)" : r.count > 1 ? `${r.count}-page` : o.preset || "custom";
            return ok({ ok: true, page: { width_pt: r.size?.width_pt, height_pt: r.size?.height_pt }, pages: r.pages, bleed_pt: r.bleed_pt, note: `A new ${what} document is open in ${L}. ${r.note || "Put things on it with send and a role."}` }, `Opened a new ${what} document in ${L}`);
          }
        }
        if (isPagePart(args)) {
          const r = await bridge("/open", { app });
          const part = await composePart(args, deps);
          if (part.ok === false) return { result: { ...r, ...part }, event: { name, summary: `Put the picture on the ${L} page; the ${args.role} had no text`, ok: false } };
          return ok({ ...r, ...part, note: `${L} is open on the user's screen. ${pageNote(part)}` }, `Opened ${L} and put it on the page`);
        }
        const img = args.image_id ? await libraryImageToWorkspace(String(args.image_id), deps) : null;
        const r = await bridge("/open", { app, path: img?.path, ...(args.options || {}), ...(args.layer != null ? { layer: args.layer } : {}) });
        let placed: unknown;
        if (!img && (args.chapter_id || (typeof args.text === "string" && args.text.trim()))) {
          const content = args.chapter_id ? await chapterText(String(args.chapter_id), deps) : { text: String(args.text), name: "text" };
          placed = capResult(await bridge("/import", { app, text: content.text, name: content.name, ...(args.options || {}) }));
        }
        return ok({
          ...r, ...(placed ? { placed } : {}),
          note: `${L} is open on the user's screen; what you do in it now happens live.${img || placed ? "" : " To put something in, use send with image_id, chapter_id or text."}`,
        }, `Opened ${L}${img ? " with the image" : placed ? (args.chapter_id ? " with the chapter" : " with the text") : ""}`);
      }
      case "find_commands": {
        const r = await bridge("/commands", { app, query: String(args.query || ""), limit: 12 });
        const best = r.commands?.[0]?.id;
        return ok({
          ...r,
          next: best
            ? `Now do it: call craft with action "run", app "${app}", steps [{"id": "${best}", "params": {…}}] — the best match is first; fill params from its description and leave out optional ones${app === "photocraft" ? ', and pass `layer` (name or id) for the layer it is meant for' : ""}. Run it rather than telling the user how.`
            : "Nothing matched. Try other words for the same thing.",
        }, `Searched ${L} commands for "${String(args.query || "").slice(0, 40)}"`);
      }
      case "run": {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const r = await bridge("/run", { app, steps, ...(args.layer != null ? { layer: args.layer } : {}), ...(args.options?.bake ? { bake: true } : {}) });
        return { result: { ...r, result: capResult(r.result), ...(r.ok ? { note: [r.note, AFTER_EDIT].filter(Boolean).join(" ") } : {}) }, event: { name, summary: r.ok ? `Ran ${steps.length} ${L} command${steps.length === 1 ? "" : "s"}` : `${L} command failed`, ok: !!r.ok } };
      }
      case "inspect": {
        const r = await bridge("/inspect", { app });
        // Guides first: a long document is cut to fit, the page sizes mustn't be.
        return ok({ ...(r.page_guides ? { page_guides: r.page_guides, layout_rules: r.layout_rules } : {}), document: capResult(r.result) }, `Inspected the ${L} document`);
      }
      case "preview": {
        const r = await bridge("/preview", { app, page: args.page, seconds: args.seconds });
        const dataUrl = await blobToDataUrl(await fileBlob(r.path));
        return ok({ ok: true, note: "The picture is attached as vision input in the next message — look at it there. To show it to the user, export it.", __vision: dataUrl }, `Looked at ${L}`);
      }
      case "send": {
        let r: any;
        if (isPagePart(args)) {
          r = await composePart(args, deps);
          if (r.ok === false) return { result: r, event: { name, summary: `Put the picture on the ${L} page; the ${args.role} had no text`, ok: false } };
          const next = emptyPagesNext(r);
          return ok({ ok: true, ...r, note: pageNote(r), ...(next ? { next } : {}) }, `Put ${r.items?.length ? `the ${args.role || (args.image_id ? "image" : "text")}` : "it"} on the ${L} ${r.side && r.pages?.length > 1 ? r.side : "page"}`);
        }
        if (args.image_id) {
          const img = await libraryImageToWorkspace(String(args.image_id), deps);
          r = await bridge("/import", { app, path: img.path, ...(args.options || {}), ...(args.layer != null ? { layer: args.layer } : {}) });
        } else if (args.chapter_id) {
          const ch = await chapterText(String(args.chapter_id), deps);
          r = await bridge("/import", { app, text: ch.text, name: ch.name, ...(args.options || {}) });
        } else if (typeof args.text === "string" && args.text.trim()) {
          r = await bridge("/import", { app, text: args.text, ...(args.options || {}), ...(args.layer != null ? { layer: args.layer } : {}) });
        } else {
          throw new CraftError(app === "designcraft" ? "send needs image_id, chapter_id or text (or a role to restyle or move that part)." : "send needs image_id, chapter_id or text.");
        }
        return ok({ ok: true, result: capResult(r), note: AFTER_EDIT }, `Sent ${args.image_id ? "an image" : args.chapter_id ? "a chapter" : "text"} to ${L}`);
      }
      case "pages": {
        if (app !== "designcraft") throw new CraftError("pages is for DesignCraft documents. In PhotoCraft and FilmCraft use find_commands.");
        const r = await bridge("/pages", { app, ...pagesOptions(args, String(args.action || "")) });
        return ok({ ok: true, ...r, note: [r.note, PAGES_NOTE].filter(Boolean).join(" ") }, r.note ? `${L}: ${String(r.note).replace(/\.$/, "")}` : `Listed the ${L} pages`);
      }
      case "export": {
        const o = args.options || {};
        const print = app === "designcraft" ? { print: o.print ?? args.print, booklet: o.booklet ?? args.booklet, pages: o.pages, marks: o.marks, bleed: o.bleed } : {};
        const file = await bridge("/export", { app, format: args.format || (print.print || print.booklet ? "pdf" : "png"), page: args.page, seconds: args.seconds, name: args.title, ...print });
        const r = await bringBack(app, file, args, deps);
        return ok({ ...r, ...(file.print_note ? { print_note: file.print_note, note: `${r.note || ""} Tell the user how to print it: ${file.print_note}`.trim() } : {}) }, `Exported ${String(args.format || (print.print || print.booklet ? "pdf" : "png")).toUpperCase()} from ${L}`);
      }
      case "save_template": {
        if (app !== "designcraft") throw new CraftError("Templates are for DesignCraft pages.");
        const name = String(args.title || args.text || "").trim();
        if (!name) throw new CraftError("save_template needs a title: the template's name (ask the user if they didn't give one).");
        const r = await bridge("/template/save", { app, name, page: args.page });
        // The screenshot, so the user sees what was kept.
        let shown: any = {};
        try {
          const dataUrl = await blobToDataUrl(await fileBlob(r.thumb));
          const ref: ChatImageRef = await storeGeneratedImage({ prompt: `Template: ${r.name}`, caption: `DesignCraft template "${r.name}"`, model: "local:designcraft", dataUrl, mime: "image/png" });
          shown = { __images: [ref] };
        } catch { /* the template is saved either way */ }
        return ok({ ok: true, template: r.about, replaced: r.replaced, note: `Saved${r.replaced ? " (replacing the old one)" : ""} with a screenshot, shown to the user. Later: use_template with title "${r.name}" starts a new document from it, then send the new parts by role.`, ...shown }, `Saved the "${r.name}" template`);
      }
      case "use_template": {
        if (app !== "designcraft") throw new CraftError("Templates are for DesignCraft pages.");
        const name = String(args.title || args.text || "").trim();
        if (!name || args.options?.list) {
          const r = await bridge("/template/list", {});
          // The user picks from a card in the chat (TemplatePickerCard); picking
          // one sends 'Use my "<name>" template.' as their next message.
          return ok({
            templates: r.templates.map((t: any) => t.about),
            note: r.templates.length
              ? "The user now sees these templates as pictures in the chat to pick from. If they already named one, use_template with its title; otherwise say in one short line to pick one there, and stop."
              : "No templates yet. Tell the user: in DesignCraft's Pages panel, click the bookmark beside a page to save it as a template (or ask you to save the page).",
            __templatePicker: true,
          }, "Listed DesignCraft templates");
        }
        if (args.options?.delete) {
          const r = await bridge("/template/delete", { name });
          return ok({ ok: true, deleted: r.deleted }, `Deleted the "${r.deleted}" template`);
        }
        await bridge("/open", { app });
        const r = await bridge("/template/use", { app, name });
        // What to do next, as a call: Qwen3-4B stopped after opening the
        // template and left its old words in place (4/4, 2026-10-14); it
        // follows a spelled-out next call (find_commands' `next` works the same).
        const first = (r.placeholders || []).find((x: any) => x.role !== "image") || (r.placeholders || [])[0];
        const at = (x: any) => (x.page != null ? ` on page ${x.page}` : "");
        return ok({
          ok: true,
          next: first
            ? `Now do it: the page still shows the template's old words. Call craft with action "send", app "designcraft", role "${first.role}"${first.page != null ? `, page ${first.page}` : ""}, text = the new ${first.role} for what the user asked. Then the same for each other part in \`placeholders\` (${(r.placeholders || []).map((x: any) => `${x.role}${at(x)}`).join(", ")}), with image_id for a picture if the user gave one. Write the words yourself; don't ask.`
            : "The template is open. Put the user's content in with send + role.",
          ...r,
        }, `Started a new page from the "${r.template}" template`);
      }
      case "transfer": {
        if (!isApp(args.to)) throw new CraftError(`to must be one of: ${CRAFT_APPS.join(", ")}`);
        const r = await bridge("/transfer", { from: app, to: args.to, format: args.format, page: args.page, seconds: args.seconds, ...(args.options || {}) });
        return ok({ ok: true, exported: r.exported?.name, placed: capResult(r.imported) }, `Moved ${L}'s work into ${LABEL[args.to as CraftApp]}`);
      }
      case "app_tools": {
        const r = await bridge("/tools", { app });
        return ok({ mode: r.mode, tools: r.tools.map((t: any) => ({ name: t.name, description: String(t.description || "").slice(0, 200), arguments: Object.keys(t.input || {}) })) }, `Listed ${L}'s tools`);
      }
      case "call": {
        const tool = String(args.tool || "");
        if (!/^[a-z][a-z0-9_]*$/.test(tool)) throw new CraftError("tool: a tool name from app_tools.");
        const r = await bridge("/call", { app, tool, arguments: args.arguments || {} });
        const vision = r.images?.[0] ? await blobToDataUrl(await fileBlob(r.images[0].path)) : undefined;
        return {
          result: { ok: r.ok, ...(r.page_guides ? { page_guides: r.page_guides } : {}), ...(r.layout ? { layout: r.layout } : {}), ...(r.layout_rules ? { layout_rules: r.layout_rules } : {}), result: capResult(r.result), ...(vision ? { note: "A picture came back; it is attached as vision input in the next message.", __vision: vision } : {}) },
          event: { name, summary: r.ok ? `${L}: ${tool}` : `${L}: ${tool} failed`, ok: !!r.ok },
        };
      }
    }
    throw new CraftError("unknown action");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { result: { error: message, ...(e instanceof CraftError ? {} : { retriable: false }) }, event: { name, summary: message.slice(0, 120), ok: false } };
  }
}

/** What the user has selected in the DesignCraft window, as a line for
 *  their message — visibly appended, like an @mention's note, so the
 *  transcript shows what the model was told. Null when the window is closed,
 *  nothing is selected or the bridge is down; never holds a send for long. */
export async function designSelectionNote(timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/design/selection`, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return selectionNote(await res.json());
  } catch { return null; }
}

export function selectionNote(sel: any): string | null {
  const items: any[] = sel?.items || [];
  if (!items.length) return null;
  const say = (i: any) => {
    const what = i.role || (i.kind === "image" ? "picture" : i.kind === "text" ? "text frame" : `shape${i.name ? ` "${String(i.name).replace(/^Deco (tpl )?/, "")}"` : ""}`);
    return `${what} (id ${i.id})${i.text ? ` "${String(i.text).slice(0, 60)}${String(i.text).length > 60 ? "…" : ""}"` : ""}`;
  };
  const range = sel.text_range ? `the highlighted words "${String(sel.text_range.text).slice(0, 60)}" in ` : "";
  const ids = items.map((i) => i.id);
  return `[Selected in DesignCraft — the user clicked ${items.length > 1 ? "these" : "this"}; "this/these/it" means ${items.length > 1 ? "them" : "it"}: ${range}${items.map(say).join("; ")}. To change ${items.length > 1 ? "them" : "it"}: craft send with ids [${ids.join(", ")}] and text, image_id or options (color, size 'bigger'/'smaller'/'+20%', font, align).]`;
}

