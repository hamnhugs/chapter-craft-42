import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/imageGen", () => ({
  getSignedImageUrl: vi.fn(async () => "https://storage.local/img.png"),
  storeGeneratedImage: vi.fn(async (o: any) => ({ id: "new-img", storage_path: "u/new.png", prompt: o.prompt })),
}));

import { askedOptions, capResult, emptyPagesNext, pageNote, partBatch, pagePartRestyle, pagesOptions, pdfPageCount, resolveAction, runCraftTool, CRAFT_TOOL_DEFINITION } from "@/lib/craftApps";
import { storeGeneratedImage } from "@/lib/imageGen";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
let calls: Call[];
type Reply = { status?: number; json?: any; raw?: string; mime?: string };
let replies: Record<string, (body: any) => Reply>;

beforeEach(() => {
  // jsdom has no AbortSignal.timeout; the browser does.
  if (typeof (AbortSignal as any).timeout !== "function") (AbortSignal as any).timeout = () => new AbortController().signal;
  calls = [];
  replies = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    const path = url.replace(/^\/local\/crafts/, "").split("?")[0];
    let body: any = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* raw */ } }
    calls.push({ url, method: init.method || "GET", body, headers: init.headers || {} });
    if (url.startsWith("https://storage.local")) return new Response(new Blob(["png"], { type: "image/png" }));
    const r: Reply = (replies[path] || (() => ({ json: {} })))(body);
    if (r.raw != null) return new Response(r.raw, { headers: { "Content-Type": r.mime || "application/octet-stream" } });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const deps = {
  books: [{ id: "b1", title: "Book", chapters: [{ id: "c1", name: "Chapter One", textContent: "It was a bright cold day." }] }] as any,
  fetchImage: async (id: string) => (id === "img1" ? { id, storage_path: "u/img1.png", prompt: "a fox" } : null),
};

describe("craft tool definition", () => {
  it("is one verb that reaches every app", () => {
    expect(CRAFT_TOOL_DEFINITION.function.name).toBe("craft");
    expect(CRAFT_TOOL_DEFINITION.function.parameters.properties.app.enum).toEqual(["photocraft", "designcraft", "filmcraft"]);
  });
});

describe("runCraftTool", () => {
  it("always sends the bridge header", async () => {
    replies["/status"] = () => ({ json: { apps: { photocraft: { installed: true } } } });
    const r = await runCraftTool({ action: "status" }, deps);
    expect(r.result).toEqual({ photocraft: { installed: true } });
    expect(calls[0].headers["X-Chapter-Craft"]).toBe("1");
  });

  it("sends a chapter's text, headed by its name", async () => {
    replies["/import"] = () => ({ json: { overset: false, pagesAdded: 0 } });
    const r = await runCraftTool({ action: "send", app: "designcraft", chapter_id: "c1" }, deps);
    expect(r.event.ok).toBe(true);
    expect(calls[0].body).toMatchObject({ app: "designcraft", text: "Chapter One\n\nIt was a bright cold day.", name: "Chapter One" });
  });

  it("uploads a library image to the workspace, then places it", async () => {
    replies["/files"] = () => ({ json: { path: "/ws/in/image.png" } });
    replies["/import"] = () => ({ json: { opened: true } });
    const r = await runCraftTool({ action: "send", app: "photocraft", image_id: "img1", options: { new_document: true } }, deps);
    expect(r.event.ok).toBe(true);
    const imp = calls.find((c) => c.url.endsWith("/import"))!;
    expect(imp.body).toEqual({ app: "photocraft", path: "/ws/in/image.png", new_document: true });
  });

  it("brings an exported picture back into the library and shows it", async () => {
    replies["/export"] = () => ({ json: { path: "/ws/out/a.png", name: "a.png", mime: "image/png", bytes: 3 } });
    replies["/files"] = () => ({ raw: "png", mime: "image/png" });
    const r = await runCraftTool({ action: "export", app: "photocraft", format: "png", title: "Cover" }, deps);
    expect(r.result.image_id).toBe("new-img");
    expect(r.result.__images).toHaveLength(1);
    expect(vi.mocked(storeGeneratedImage).mock.calls[0][0]).toMatchObject({ prompt: "Cover", model: "local:photocraft" });
  });

  it("puts an exported PDF on the bookshelf when asked", async () => {
    replies["/export"] = () => ({ json: { path: "/ws/out/a.pdf", name: "a.pdf", mime: "application/pdf", bytes: 10 } });
    replies["/files"] = () => ({ raw: "%PDF /Type /Pages /Type /Page /Type /Page", mime: "application/pdf" });
    const addBook = vi.fn(async () => "book-9");
    const r = await runCraftTool({ action: "export", app: "designcraft", format: "pdf", to_library: true, title: "Poster" }, { ...deps, addBook });
    expect(r.result.error, JSON.stringify(r.result)).toBeUndefined();
    expect(r.result.book_id).toBe("book-9");
    const [doc, file] = addBook.mock.calls[0] as any[];
    expect(doc).toMatchObject({ title: "Poster", pageCount: 2, source: "assistant" });
    expect(file.name).toBe("Poster.pdf");
  });

  it("explains a missing bridge instead of failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const r = await runCraftTool({ action: "status" }, deps);
    expect(r.event.ok).toBe(false);
    expect(r.result.error).toMatch(/craft bridge isn't running/);
  });

  it("refuses unknown apps, actions and empty sends with a usable message", async () => {
    expect((await runCraftTool({ action: "run", app: "gimp" }, deps)).result.error).toMatch(/photocraft, designcraft, filmcraft/);
    expect((await runCraftTool({ action: "fly", app: "photocraft" }, deps)).result.error).toMatch(/find_commands/);
    expect((await runCraftTool({ action: "send", app: "photocraft" }, deps)).result.error).toMatch(/image_id, chapter_id or text/);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveAction", () => {
  it("reads what a small model meant", () => {
    expect(resolveAction({ action: "run", query: "gaussian blur" })).toBe("find_commands");
    expect(resolveAction({ action: "create", text: "The End" })).toBe("send");
    expect(resolveAction({ action: "add_title", steps: [{ id: "x" }] })).toBe("run");
    expect(resolveAction({ action: "Export" })).toBe("export");
    expect(resolveAction({ action: "fly" })).toBe("fly");
  });

  it("opens with a chapter in one call", async () => {
    replies["/open"] = () => ({ json: { launched: true, window_open: true } });
    replies["/import"] = () => ({ json: { pagesAdded: 1 } });
    const r = await runCraftTool({ action: "open", app: "designcraft", chapter_id: "c1" }, deps);
    expect(r.event.summary).toBe("Opened DesignCraft with the chapter");
    expect(calls.map((c) => c.url)).toEqual(["/local/crafts/open", "/local/crafts/import"]);
  });
});

describe("helpers", () => {
  it("caps long results and says so", () => {
    const r: any = capResult("x".repeat(10_000), 100);
    expect(r).toMatchObject({ truncated: true, total_chars: 10_000 });
    expect(capResult({ a: 1 })).toEqual({ a: 1 });
  });

  it("counts PDF pages without counting the page tree", () => {
    expect(pdfPageCount(new TextEncoder().encode("/Type /Pages /Type /Page /Type/Page"))).toBe(2);
  });
});

describe("DesignCraft page parts", () => {
  it("lays out a picture and a headline by role, not by coordinates", async () => {
    replies["/files"] = () => ({ json: { path: "/ws/in/image-img1.png" } });
    replies["/compose"] = (b) => ({ json: { page: 0, items: [{ id: 9, role: b.role ?? "image" }] } });
    let r = await runCraftTool({ action: "send", app: "designcraft", image_id: "img1" }, deps);
    expect(r.event.ok).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/compose"))!.body).toMatchObject({ app: "designcraft", path: "/ws/in/image-img1.png" });
    calls = [];
    r = await runCraftTool({ action: "send", app: "designcraft", role: "headline", text: "Your Plan to Win", options: { color: "#B3261E" } }, deps);
    expect(calls[0].body).toMatchObject({ role: "headline", text: "Your Plan to Win", color: "#B3261E" });
    expect(r.result.note).toMatch(/issues/);
  });

  it("restyles a part with no new text, and still flows a chapter over pages", async () => {
    replies["/compose"] = () => ({ json: { page: 0, items: [] } });
    await runCraftTool({ action: "send", app: "designcraft", role: "headline", options: { color: "#E63946" } }, deps);
    expect(calls[0].url).toMatch(/\/compose$/);
    expect(calls[0].body).toMatchObject({ role: "headline", color: "#E63946" });
    calls = [];
    await runCraftTool({ action: "send", app: "designcraft", chapter_id: "c1" }, deps);
    expect(calls[0].url).toMatch(/\/import$/);
  });

  it("designs the whole page in a look, alone or with a part", async () => {
    replies["/compose"] = () => ({ json: { page: 0, look: "cinematic", items: [] } });
    await runCraftTool({ action: "send", app: "designcraft", look: "cinematic" }, deps);
    expect(calls[0].url).toMatch(/\/compose$/);
    expect(calls[0].body).toMatchObject({ app: "designcraft", look: "cinematic" });
    expect(calls[0].body.role).toBeUndefined();
    calls = [];
    // No action at all, just a look: still a send (small models drop the action).
    expect(resolveAction({ app: "designcraft", look: "bold" })).toBe("send");
    // A look with a stray page size restyles this page; it doesn't open a blank one.
    expect(resolveAction({ app: "designcraft", look: "bold", options: { preset: "A4" } })).toBe("send");
    await runCraftTool({ action: "send", app: "designcraft", role: "headline", text: "Plan to Win", options: { look: "bold" } }, deps);
    expect(calls[0].body).toMatchObject({ role: "headline", text: "Plan to Win", look: "bold" });
  });

  it("reads a run on a page part's name as restyling that part", async () => {
    replies["/compose"] = () => ({ json: { page: 0, look: "editorial", items: [{ id: 3, role: "headline" }] } });
    await runCraftTool({ action: "run", app: "designcraft", layer: "headline", steps: [{ id: "text.color", params: { color: "#FF0000" } }] }, deps);
    expect(calls[0].url).toMatch(/\/compose$/);
    expect(calls[0].body).toMatchObject({ role: "headline", color: "#FF0000" });
    // A real command on a real layer is left alone.
    expect(pagePartRestyle({ action: "run", app: "designcraft", steps: [{ id: "type.char", params: {} }] })).toBeNull();
  });

  it("reads an invented action carrying a role as a send", () => {
    expect(resolveAction({ action: "add_headline", app: "designcraft", role: "headline", text: "Hi" })).toBe("send");
  });
});

describe("DesignCraft templates", () => {
  it("saves the page as a template and shows its screenshot", async () => {
    replies["/template/save"] = (b) => ({ json: { saved: b.name, name: b.name, about: `${b.name}: 612×792 pt; parts headline, image`, thumb: "/ws/templates/x/thumb.png", replaced: false } });
    const r = await runCraftTool({ action: "save_template", app: "designcraft", title: "Summer Fair" }, deps);
    expect(r.event.ok).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/template/save"))!.body).toMatchObject({ name: "Summer Fair" });
    expect(r.result.template).toMatch(/Summer Fair/);
    expect((await runCraftTool({ action: "save_template", app: "designcraft" }, deps)).result.error).toMatch(/title/);
  });

  it("starts a new document from one, and lists them when none is named", async () => {
    replies["/template/use"] = () => ({ json: { template: "Summer Fair", items: [], placeholders: [{ role: "headline", id: 3, text: "Summer Book Fair" }] } });
    replies["/template/list"] = () => ({ json: { templates: [{ about: "Summer Fair: 612×792 pt; parts headline" }] } });
    const r = await runCraftTool({ action: "use_template", app: "designcraft", title: "summer fair" }, deps);
    expect(r.event.ok).toBe(true);
    expect(calls.map((c) => c.url.replace(/^.*\/local\/crafts/, ""))).toEqual(["/open", "/template/use"]);
    expect(r.result.next).toMatch(/role "headline"/);
    const l = await runCraftTool({ action: "use_template", app: "designcraft" }, deps);
    expect(l.result.templates).toEqual(["Summer Fair: 612×792 pt; parts headline"]);
  });

  it("reads invented template actions", () => {
    expect(resolveAction({ action: "create_template", app: "designcraft" })).toBe("save_template");
    expect(resolveAction({ action: "apply_template", app: "designcraft" })).toBe("use_template");
  });
});

describe("DesignCraft new page", () => {
  it("opens a page size in one call", async () => {
    replies["/pages"] = () => ({ json: { pages: [{ page: 0, side: "page 1", empty: true }], count: 1, two_sided: false, size: { width_pt: 595, height_pt: 842 }, bleed_pt: 0 } });
    const r = await runCraftTool({ action: "open", app: "designcraft", options: { preset: "A4" } }, deps);
    expect(r.event.ok).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/pages"))!.body).toMatchObject({ app: "designcraft", new: true, preset: "A4" });
    expect(r.result.page).toEqual({ width_pt: 595, height_pt: 842 });
  });

  it("opens a two-sided document: front and back", async () => {
    replies["/pages"] = () => ({ json: { pages: [{ page: 0, side: "front", empty: true }, { page: 1, side: "back", empty: true }], count: 2, two_sided: true, size: { width_pt: 612, height_pt: 792 }, bleed_pt: 9, note: "Page 0 is the front, page 1 the back." } });
    const r = await runCraftTool({ action: "open", app: "designcraft", options: { preset: "Letter", sides: 2 } }, deps);
    expect(calls.find((c) => c.url.endsWith("/pages"))!.body).toMatchObject({ new: true, sides: 2 });
    expect(r.event.summary).toMatch(/two-sided/);
    expect(r.result.note).toMatch(/page 1 the back/);
  });
});

describe("DesignCraft pages", () => {
  it("adds, deletes and duplicates pages through the bridge", async () => {
    replies["/pages"] = () => ({ json: { pages: [], count: 3, note: "added 1 page after page 1." } });
    const r = await runCraftTool({ action: "pages", app: "designcraft", options: { add: 1 } }, deps);
    expect(r.event.ok).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ app: "designcraft", add: 1 });
    expect(r.result.note).toMatch(/send \+ role \+ page/);
    await runCraftTool({ action: "pages", app: "designcraft", page: 2, options: { delete: true } }, deps);
    expect(calls.at(-1)!.body).toMatchObject({ delete: [2] });
  });

  it("reads the options loosely", () => {
    expect(pagesOptions({ page: 1, options: { duplicate: true } })).toEqual({ duplicate: 1 });
    expect(pagesOptions({ options: { add: "a back side" } })).toEqual({ sides: 2 });
    expect(pagesOptions({ options: { add: "2 pages" } })).toEqual({ add: 2 });
    expect(pagesOptions({ page: 3 })).toEqual({ page: 3 });
  });

  it("is for DesignCraft only", async () => {
    expect((await runCraftTool({ action: "pages", app: "photocraft", options: { add: 1 } }, deps)).result.error).toMatch(/DesignCraft/);
  });

  it("reads invented page actions", () => {
    expect(resolveAction({ action: "add_page", app: "designcraft" })).toBe("pages");
    expect(resolveAction({ action: "delete_pages", app: "designcraft", page: 2 })).toBe("pages");
  });

  it("exports a print PDF and says how to print it", async () => {
    replies["/export"] = () => ({ json: { path: "/ws/out/flyer.pdf", name: "flyer.pdf", mime: "application/pdf", bytes: 10, print_note: "Print double-sided, flip on the LONG edge." } });
    const r = await runCraftTool({ action: "export", app: "designcraft", options: { print: true } }, deps);
    expect(calls.at(-1)!.body).toMatchObject({ format: "pdf", print: true });
    expect(r.result.note).toMatch(/LONG edge/);
  });

  it("makes a document two-sided or numbered only when the user asked", async () => {
    const all = { preset: "A4", pages: 1, sides: 2, numbers: true };
    expect(askedOptions(all, "please open the appropriate page size to create a flyer")).toEqual({ preset: "A4", pages: 1 });
    expect(askedOptions(all, "a flyer printed on both sides, details on the back")).toEqual({ preset: "A4", pages: 1, sides: 2 });
    expect(askedOptions(all, "a 4-page newsletter with page numbers")).toEqual({ preset: "A4", pages: 1, numbers: true });
    expect(askedOptions(all, undefined)).toEqual(all);
    replies["/pages"] = () => ({ json: { pages: [], count: 1, size: {} } });
    await runCraftTool({ action: "open", app: "designcraft", options: all }, { ...deps, userText: "open a flyer-sized page" });
    expect(calls.at(-1)!.body).not.toHaveProperty("sides");
  });

  it("reads an export with no action", () => {
    expect(resolveAction({ app: "designcraft", format: "pdf", page: 1 })).toBe("export");
    expect(resolveAction({ app: "designcraft", options: { print: true } })).toBe("export");
    expect(resolveAction({ app: "photocraft", format: "png", to: "filmcraft" })).not.toBe("export");
  });

  it("spells out the next call while a page is empty or the front has no picture", () => {
    const two = (front: string[], back: string[]) => ({ pages: [{ page: 0, side: "front", ...(front.length ? { parts: front } : { empty: true }) }, { page: 1, side: "back", ...(back.length ? { parts: back } : { empty: true }) }] });
    expect(emptyPagesNext({ ...two(["headline"], []), page: 0, items: [{ role: "headline" }] })).toMatch(/^Now do it: the front \(page 0\) has no picture and the back \(page 1\) is empty/);
    // The front still needs its headline: that first, no talk of the back yet.
    expect(emptyPagesNext({ ...two(["image"], []), page: 0, items: [{ role: "image" }] })).toMatch(/no headline/);
    expect(emptyPagesNext({ ...two(["image"], []), page: 0, items: [{ role: "image" }] })).not.toMatch(/back/);
    // One page, picture only.
    expect(emptyPagesNext({ page: 0, items: [{ role: "image" }] })).toMatch(/role "headline"/);
    expect(emptyPagesNext({ page: 0, items: [{ role: "image" }, { role: "headline" }] })).toBeNull();
    expect(emptyPagesNext(two(["image", "headline"], []))).toMatch(/page 1, role "body"/);
    expect(emptyPagesNext(two(["image", "headline"], ["body"]))).toBeNull();
    expect(emptyPagesNext({ pages: [{ page: 0, side: "page 1", parts: ["headline"] }] })).toBeNull();
  });

  it("runs several parts sent in one call, picture first", async () => {
    const b = partBatch({ app: "designcraft", look: "bold", open: { preset: "A4", sides: 2 }, pages: [
      { page: 0, role: "headline", text: "Plan to Win", options: { color: "#2c3e50" } },
      { page: 0, role: "image", text: "", options: { image_id: "img1" } },
      { page: 1, role: "body", text: "Thursday 7pm" },
    ] });
    expect(b!.setup).toEqual({ preset: "A4", sides: 2 });
    expect(b!.parts[1]).toEqual({ action: "send", app: "designcraft", page: 0, role: "image", image_id: "img1" });
    expect(partBatch({ app: "designcraft", pages: [1, 2] })).toBeNull();
    replies["/files"] = () => ({ json: { path: "/ws/in/image-img1.png" } });
    replies["/compose"] = () => ({ json: { page: 0, items: [] } });
    replies["/pages"] = () => ({ json: { pages: [] } });
    const r = await runCraftTool({ app: "designcraft", look: "bold", open: { preset: "A4", sides: 2 }, pages: b!.parts.map(({ action: _a, app: _p, ...e }) => e) }, deps);
    expect(r.result.batch).toEqual(["image on page 0", "headline on page 0", "body on page 1"]);
    const sends = calls.filter((c) => c.url.endsWith("/compose")).map((c) => c.body);
    expect(sends[0]).toMatchObject({ role: "image", page: 0, look: "bold" });
    expect(sends.at(-1)).toMatchObject({ role: "body", page: 1, text: "Thursday 7pm" });
    expect(calls.find((c) => c.url.endsWith("/pages"))!.body).toMatchObject({ ensure: true, preset: "A4", sides: 2 });
  });

  it("names the side it worked on and the pages still empty", () => {
    const note = pageNote({ page: 0, side: "front", items: [{ role: "headline" }], pages: [{ page: 0, side: "front", parts: ["headline"] }, { page: 1, side: "back", empty: true }] });
    expect(note).toMatch(/That was the front \(page 0\)/);
    expect(note).toMatch(/Still empty: the back \(page 1\)/);
    // The back needs no headline nudge.
    expect(pageNote({ page: 1, side: "back", items: [{ role: "body" }], pages: [{ page: 0, side: "front" }, { page: 1, side: "back" }] })).not.toMatch(/No headline/);
  });
});

describe("small-model slips on a DesignCraft page", () => {
  it("reads a page size with no action as open", () => {
    expect(resolveAction({ app: "designcraft", options: { preset: "Letter" } })).toBe("open");
  });

  it("places a picture sent with a text role as the image", async () => {
    replies["/files"] = () => ({ json: { path: "/ws/in/image-img1.png" } });
    replies["/compose"] = () => ({ json: { page: 0, items: [] } });
    await runCraftTool({ action: "send", app: "designcraft", image_id: "img1", role: "headline" }, deps);
    expect(calls.find((c) => c.url.endsWith("/compose"))!.body).toMatchObject({ role: "image", path: "/ws/in/image-img1.png" });
  });
});

describe("a picture and a headline in one call", () => {
  it("places the picture, then the headline", async () => {
    replies["/files"] = () => ({ json: { path: "/ws/in/image-img1.png" } });
    replies["/compose"] = () => ({ json: { page: 0, items: [] } });
    const id = "b9fe2624-d08f-43bb-bd55-d4648d2e4302";
    await runCraftTool({ action: "send", app: "designcraft", layer: id, role: "headline", text: "Plan to Win" }, { ...deps, fetchImage: async (x: string) => (x === id ? { id, storage_path: "u/q.png" } : null) });
    const composes = calls.filter((c) => c.url.endsWith("/compose")).map((c) => c.body);
    expect(composes).toMatchObject([{ role: "image", path: "/ws/in/image-img1.png" }, { role: "headline", text: "Plan to Win" }]);
  });
});
