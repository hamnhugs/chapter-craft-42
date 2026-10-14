import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/imageGen", () => ({
  getSignedImageUrl: vi.fn(async () => "https://storage.local/img.png"),
  storeGeneratedImage: vi.fn(async (o: any) => ({ id: "new-img", storage_path: "u/new.png", prompt: o.prompt })),
}));

import { capResult, pdfPageCount, resolveAction, runCraftTool, CRAFT_TOOL_DEFINITION } from "@/lib/craftApps";
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
    await runCraftTool({ action: "send", app: "designcraft", role: "headline", options: { at: "bottom" } }, deps);
    expect(calls[0].url).toMatch(/\/compose$/);
    expect(calls[0].body).toMatchObject({ role: "headline", at: "bottom" });
    calls = [];
    await runCraftTool({ action: "send", app: "designcraft", chapter_id: "c1" }, deps);
    expect(calls[0].url).toMatch(/\/import$/);
  });

  it("reads an invented action carrying a role as a send", () => {
    expect(resolveAction({ action: "add_headline", app: "designcraft", role: "headline", text: "Hi" })).toBe("send");
  });
});

describe("DesignCraft new page", () => {
  it("opens a page size in one call", async () => {
    replies["/inspect"] = () => ({ json: { result: { settings: { pageWidth: 595.3, pageHeight: 841.9 } } } });
    const r = await runCraftTool({ action: "open", app: "designcraft", options: { preset: "A4" } }, deps);
    expect(r.event.ok).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/call"))!.body).toMatchObject({ tool: "new_document", arguments: { preset: "A4", facingPages: false } });
    expect(r.result.page).toEqual({ width_pt: 595, height_pt: 842 });
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
