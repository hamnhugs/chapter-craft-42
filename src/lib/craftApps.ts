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
export const CRAFT_ACTIONS = ["status", "open", "find_commands", "run", "inspect", "preview", "send", "export", "transfer", "app_tools", "call"] as const;
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
      "Edit photos (crop, blur, sharpen, colours, retouch, text), lay out pages, posters and books (PDF, EPUB), and edit videos, slideshows, titles and trailers (MP4) in the user's apps PhotoCraft (like Photoshop), DesignCraft (like InDesign) and FilmCraft (like Premiere Pro); every feature is reachable. Act on sensible defaults; don't ask first. Actions: send (or open) puts image_id, chapter_id or text into the app; find_commands searches the app's menu commands, then run does one; export saves as `format` (pictures return to the library and show); transfer moves the app's work into `to`; open shows the window, where edits happen live; inspect / preview check it; status; app_tools / call.",
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
          description: "run: commands in order, each {id, params} with ids and params exactly as find_commands lists them.",
          items: { type: "object", properties: { id: { type: "string" }, params: { type: "object" } }, required: ["id"] },
        },
        image_id: { type: "string", description: "send/open: a library image to bring into the app." },
        chapter_id: { type: "string", description: "send/open: a chapter id from the book's chapter list; the app reads its text itself (DesignCraft adds pages as needed) — don't open or read the chapter first." },
        text: { type: "string", description: "send/open: text to put into the app (a text frame, a type layer, or a title in the video)." },
        to: { type: "string", enum: [...CRAFT_APPS], description: "transfer: the app that receives `app`'s work." },
        format: { type: "string", description: "export/transfer: png, jpg, webp, psd (PhotoCraft); png, pdf, epub, html, txt, idml (DesignCraft); png (one frame), mp4, gif, wav, srt (FilmCraft). Default png." },
        to_library: { type: "boolean", description: "export with format pdf or epub: also add it to the user's bookshelf as a book." },
        title: { type: "string", description: "export: a name for the result." },
        page: { type: "integer", description: "preview/export in DesignCraft: page index, 0 = first." },
        seconds: { type: "number", description: "preview/export in FilmCraft: the moment to show, in seconds." },
        tool: { type: "string", description: "call: the app tool's name, from app_tools." },
        arguments: { type: "object", description: "call: that tool's arguments." },
        options: { type: "object", description: "send: placement, e.g. {new_document:true} (PhotoCraft), {x, y, width} (DesignCraft, points), {seconds, track} (FilmCraft), {size} for text." },
      },
      required: ["action"],
    },
  },
} as const;

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
  const hasContent = !!(args?.image_id || args?.chapter_id || (typeof args?.text === "string" && args.text.trim()));
  if (action === "run" && !hasSteps && args?.query) return "find_commands";
  if ((CRAFT_ACTIONS as readonly string[]).includes(action)) return action;
  if (hasSteps) return "run";
  if (hasContent) return "send";
  if (args?.query) return "find_commands";
  return action;
}

export async function runCraftTool(args: any, deps: CraftDeps): Promise<Outcome> {
  const name = "craft";
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
        const img = args.image_id ? await libraryImageToWorkspace(String(args.image_id), deps) : null;
        const r = await bridge("/open", { app, path: img?.path });
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
            ? `Now do it: call craft with action "run", app "${app}", steps [{"id": "${best}", "params": {…}}] — the best match is first; fill params from its description and leave out optional ones. Run it rather than telling the user how.`
            : "Nothing matched. Try other words for the same thing.",
        }, `Searched ${L} commands for "${String(args.query || "").slice(0, 40)}"`);
      }
      case "run": {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const r = await bridge("/run", { app, steps });
        return { result: { ...r, result: capResult(r.result) }, event: { name, summary: r.ok ? `Ran ${steps.length} ${L} command${steps.length === 1 ? "" : "s"}` : `${L} command failed`, ok: !!r.ok } };
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
        if (args.image_id) {
          const img = await libraryImageToWorkspace(String(args.image_id), deps);
          r = await bridge("/import", { app, path: img.path, ...(args.options || {}) });
        } else if (args.chapter_id) {
          const ch = await chapterText(String(args.chapter_id), deps);
          r = await bridge("/import", { app, text: ch.text, name: ch.name, ...(args.options || {}) });
        } else if (typeof args.text === "string" && args.text.trim()) {
          r = await bridge("/import", { app, text: args.text, ...(args.options || {}) });
        } else {
          throw new CraftError("send needs image_id, chapter_id or text.");
        }
        return ok({ ok: true, result: capResult(r) }, `Sent ${args.image_id ? "an image" : args.chapter_id ? "a chapter" : "text"} to ${L}`);
      }
      case "export": {
        const file = await bridge("/export", { app, format: args.format || "png", page: args.page, seconds: args.seconds, name: args.title });
        const r = await bringBack(app, file, args, deps);
        return ok(r, `Exported ${String(args.format || "png").toUpperCase()} from ${L}`);
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
