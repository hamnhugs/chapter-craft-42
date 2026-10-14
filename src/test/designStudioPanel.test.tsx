import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * DesignStudioPanel — the chat's design UI for DesignCraft. Every button must
 * go through runCraftTool (the chat's own craft tool), with the same
 * arguments a model would send, so the panel and the AI can't drift apart.
 * Rendered with react-dom/client + act (see libraryShelves.test.tsx for why
 * not @testing-library/react).
 */

const runCraftTool = vi.fn(async (args: any) => ({ result: { ok: true }, event: { name: "craft", summary: `did ${args.action}`, ok: true } }));
const state = {
  installed: true, window_open: true, document: "Summer Fair.designcraft", pages: 1,
  page: {
    page: 0, template: "Summer Fair",
    items: [{ id: 8, role: "image" }, { id: 11, role: "headline", text: "Summer Book Fair" }, { id: 19, role: "footer", text: "chaptercraft.app/fair" }],
    placeholders: [{ role: "headline", id: 11, text: "Summer Book Fair" }],
  },
  preview: "data:image/png;base64,AAAA",
};
vi.mock("@/lib/craftApps", () => ({
  PAGE_LOOKS: ["bold", "cinematic", "editorial", "swiss", "classic", "minimal", "split", "pop"],
  runCraftTool: (args: any, deps: any) => runCraftTool(args, deps),
  designState: vi.fn(async () => state),
  designTemplates: vi.fn(async () => [{ name: "Summer Fair", slug: "summer-fair", about: "", width: 612, height: 792, parts: ["headline", "image"], created: "t1" }]),
  templateThumbUrl: vi.fn(async () => "blob:thumb"),
}));
vi.mock("@/lib/imageGen", () => ({ fetchImageById: vi.fn(), getSignedImageUrl: vi.fn(async () => "https://img"), searchImages: vi.fn(async () => [{ id: "img1", storage_path: "u/a.png", prompt: "a cat" }]) }));
vi.mock("@/context/AppContext", () => ({ useApp: () => ({ books: [], addBook: vi.fn(), loadChapterText: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import DesignStudioPanel from "@/components/DesignStudioPanel";

let container: HTMLDivElement;
let root: Root;
const onAsk = vi.fn();
const flush = async () => { for (let i = 0; i < 6; i++) await React.act(async () => { await Promise.resolve(); }); };
const button = (re: RegExp) => [...container.querySelectorAll("button")].find((b) => re.test(b.textContent || "") || re.test(b.title || "")) as HTMLButtonElement;
const click = async (el: Element) => { await React.act(async () => { (el as HTMLElement).click(); }); await flush(); };

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  runCraftTool.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await React.act(async () => { root.render(<DesignStudioPanel open onClose={() => {}} refreshKey="k" onAsk={onAsk} />); });
  await flush();
});
afterEach(() => { React.act(() => root.unmount()); container.remove(); });

describe("DesignStudioPanel", () => {
  it("shows the page, its template and what still holds the template's content", () => {
    expect(container.textContent).toMatch(/Summer Fair\.designcraft/);
    expect(container.textContent).toMatch(/Template: Summer Fair/);
    expect(container.textContent).toMatch(/1 part still show/);
    expect(container.querySelector('img[alt="The page as it is now"]')).toBeTruthy();
  });

  it("starts a document from a template with the template's screenshot", async () => {
    expect(container.querySelector('img[alt="Summer Fair template"]')?.getAttribute("src")).toBe("blob:thumb");
    await click(button(/^Use$/));
    expect(runCraftTool.mock.calls[0][0]).toMatchObject({ app: "designcraft", action: "use_template", title: "Summer Fair" });
  });

  it("saves the page as a template under the name typed", async () => {
    const input = container.querySelector('input[placeholder="Name this design…"]') as HTMLInputElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Readers Club");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(/^.*Save$/));
    expect(runCraftTool.mock.calls[0][0]).toMatchObject({ action: "save_template", title: "Readers Club" });
  });

  it("applies a look, edits a part and swaps the picture the chat's way", async () => {
    await click(button(/^looks$/i));
    await click(button(/cinematic/i));
    expect(runCraftTool.mock.calls.at(-1)![0]).toMatchObject({ action: "send", look: "cinematic" });
    await click(button(/^content$/i));
    const ta = container.querySelector("#ds-headline") as HTMLTextAreaElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "Plan to Win");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(/^Update$/));
    expect(runCraftTool.mock.calls.at(-1)![0]).toMatchObject({ action: "send", role: "headline", text: "Plan to Win" });
    await click(button(/from my images/));
    await click(container.querySelector('button[title="a cat"]')!);
    expect(runCraftTool.mock.calls.at(-1)![0]).toMatchObject({ action: "send", role: "image", image_id: "img1", options: { replace: true } });
  });

  it("asks Counsel in the chat", async () => {
    await click(button(/Make it look amazing/));
    expect(onAsk).toHaveBeenCalledWith(expect.stringMatching(/look amazing/));
  });
});
