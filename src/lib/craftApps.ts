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
export const PAGE_LOOKS = ["bold", "cinematic", "editorial", "swiss", "classic", "minimal", "split", "pop"] as const;
/** Page sizes beyond DesignCraft's own presets, in points: an 18×24 in
 *  poster, a square and a 9:16 social post, a 6×9 in book cover. */
export const EXTRA_PRESETS: Record<string, [number, number]> = { poster: [1296, 1728], square: [720, 720], story: [540, 960], book: [432, 648], "book cover": [432, 648], cover: [432, 648], instagram: [720, 900] };
export const CRAFT_ACTIONS = ["status", "open", "find_commands", "run", "inspect", "preview", "send", "export", "transfer", "save_template", "use_template", "app_tools", "call"] as const;
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
      "Edit photos (layers, text, colour), design flyers, posters, covers and books and edit video in the user's apps PhotoCraft (like Photoshop), DesignCraft (like InDesign) and FilmCraft (like Premiere Pro). A clear, undoable ask: just do it, writing any wording yourself from the book in context. Ask ONE short question with 2-4 choices when it's unclear which layer or item is meant; always ask before merge, flatten or delete. Keep the user's layers. Actions: send/open puts image_id, chapter_id or text in (DesignCraft: `role`; `look` designs the page); save_template/use_template (title; none = list); find_commands, then run (with `layer`); export; transfer; inspect/preview; status; app_tools/call.",
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
        look: { type: "string", enum: [...PAGE_LOOKS], description: "DesignCraft page design, done like a pro: bold (event flyer), cinematic (book cover, movie poster), editorial (magazine), swiss (modern), classic (elegant), minimal, split, pop (fun). Alone: restyles the page." },
        layer: { type: "string", description: "PhotoCraft run/send: the layer to act on, by name or id (e.g. the photo for a colour fix). New layers go just above it; nothing above it changes." },
        to: { type: "string", enum: [...CRAFT_APPS], description: "transfer: the app that receives `app`'s work." },
        format: { type: "string", description: "export/transfer: png, jpg, webp, psd (PhotoCraft); png, pdf, epub, html, txt, idml (DesignCraft); png (one frame), mp4, gif, wav, srt (FilmCraft). Default png." },
        to_library: { type: "boolean", description: "export with format pdf or epub: also add it to the user's bookshelf as a book." },
        title: { type: "string", description: "export: a name for the result. save_template/use_template: the template's name (DesignCraft)." },
        page: { type: "integer", description: "preview/export in DesignCraft: page index, 0 = first." },
        seconds: { type: "number", description: "preview/export in FilmCraft: the moment to show, in seconds." },
        tool: { type: "string", description: "call: the app tool's name, from app_tools." },
        arguments: { type: "object", description: "call: that tool's arguments." },
        options: { type: "object", description: "DesignCraft send with role: {color:'#hex', size, font, align}; open: {preset:'Letter'|'A4'|'Tabloid'|'Poster'|'Square'|'Story'|'Book'} = new page. PhotoCraft send {new_document:true}. FilmCraft {seconds, track}." },
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
  return `${has("headline") ? "" : "No headline on the page yet. "}${AFTER_PAGE}`;
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
  books: BookDocument[];
  loadChapterText?: (chapterId: string) => Promise<string>;
  addBook?: (book: BookDocument, sourceFile?: File, opts?: any) => Promise<string>;
  currentModel?: string;
  fetchImage?: (imageId: string) => Promise<{ id: string; storage_path: string; prompt?: string } | null>;
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
  if ((CRAFT_ACTIONS as readonly string[]).includes(action)) return action;
  // No action, content and a page size: the content wins. "Make it look
  // amazing" came as {look:"bold", options:{preset:"A4"}} and opened a new,
  // empty page over the user's work (Qwen3-4B, 2026-10-14).
  if (hasContent && !hasSteps) return "send";
  // No action and a page size: "open a flyer-sized page" (Qwen3-4B, 2026-10-13).
  if (args?.options?.preset || (args?.options?.width && args?.options?.height)) return "open";
  if (hasSteps) return "run";
  if (hasContent) return "send";
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

export async function runCraftTool(args: any, deps: CraftDeps): Promise<Outcome> {
  const name = "craft";
  args = pagePartRestyle(args) || args;
  const action = resolveAction(args) as CraftAction;
  const app = args?.app;
  const ok = (result: any, summary: string): Outcome => ({ result, event: { name, summary, ok: true } });
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
        const newPage = app === "designcraft" && (o.preset || (o.width && o.height));
        if (newPage) {
          await bridge("/open", { app });
          const extra = o.preset ? EXTRA_PRESETS[String(o.preset).toLowerCase()] : null;
          const size = extra ? { width: extra[0], height: extra[1] } : o.preset ? { preset: String(o.preset) } : { width: Number(o.width), height: Number(o.height) };
          await bridge("/call", { app, tool: "new_document", arguments: { ...size, facingPages: false, ...(o.margins != null ? { margins: o.margins } : {}), ...(args.title ? { title: String(args.title) } : {}) } });
          const doc = await bridge("/inspect", { app });
          const st = doc.result?.settings || {};
          if (!isPagePart({ ...args, options: {} })) {
            return ok({ ok: true, page: { width_pt: Math.round(st.pageWidth), height_pt: Math.round(st.pageHeight) }, note: `A new ${o.preset || "custom"} page is open in ${L}. Put things on it with send and a role.` }, `Opened a new ${o.preset || ""} page in ${L}`.replace("  ", " "));
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
        return ok({ document: capResult(r.result) }, `Inspected the ${L} document`);
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
          return ok({ ok: true, ...r, note: pageNote(r) }, `Put ${r.items?.length ? `the ${args.role || (args.image_id ? "image" : "text")}` : "it"} on the ${L} page`);
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
      case "export": {
        const file = await bridge("/export", { app, format: args.format || "png", page: args.page, seconds: args.seconds, name: args.title });
        const r = await bringBack(app, file, args, deps);
        return ok(r, `Exported ${String(args.format || "png").toUpperCase()} from ${L}`);
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
          return ok({ templates: r.templates.map((t: any) => t.about), note: r.templates.length ? "Ask which one, or use the one the user named: use_template with its title." : "No templates yet. Design a page, then save_template with a name." }, "Listed DesignCraft templates");
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
        return ok({
          ok: true,
          next: first
            ? `Now do it: the page still shows the template's old words. Call craft with action "send", app "designcraft", role "${first.role}", text = the new ${first.role} for what the user asked. Then the same for each other part in \`placeholders\` (${(r.placeholders || []).map((x: any) => x.role).join(", ")}), with image_id for a picture if the user gave one. Write the words yourself; don't ask.`
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
          result: { ok: r.ok, result: capResult(r.result), ...(vision ? { note: "A picture came back; it is attached as vision input in the next message.", __vision: vision } : {}) },
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

