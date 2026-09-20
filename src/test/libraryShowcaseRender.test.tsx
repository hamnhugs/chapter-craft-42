import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BookDocument } from "@/types/library";

/**
 * LibraryShowcase, actually mounted.
 *
 * The rest of the Showcase coverage is pure functions and source assertions,
 * and neither of those can tell you the component renders at all. This one
 * puts it in a DOM: the profile on the stage, every book on the rail, and the
 * controls doing what their labels say.
 *
 * It also pins the thing the user actually lost: the Showcase used to reset to
 * the top of the library every time they switched away and back. The selected
 * book is now remembered, and that is only checkable by mounting it twice.
 *
 * The canvas is stubbed below rather than left to jsdom, which has no 2D
 * context and reports one jsdomError per call. SeasonAmbience already handles
 * that correctly — a refused context means it draws nothing — but a passing
 * suite should not print twenty errors that are not errors.
 *
 * Rendering goes through react-dom/client + React.act directly rather than
 * @testing-library/react, matching libraryShelves.test.tsx: RTL v16 is present
 * but its required peer @testing-library/dom is not declared.
 */

vi.mock("@/hooks/useReaderPrefs", () => ({
  loadLastPage: (id: string) => (id === "b2" ? 150 : 0),
}));

import LibraryShowcase from "@/components/LibraryShowcase";
import { ThemeProvider } from "@/context/ThemeContext";

const act = React.act as unknown as (cb: () => void | Promise<void>) => Promise<void>;

const book = (id: string, title: string, over: Partial<BookDocument> = {}): BookDocument => ({
  id, title, fileName: `${title}.pdf`, fileData: "", pageCount: 600,
  chapters: [], addedAt: Date.parse("2026-09-01T00:00:00Z"), folderIds: [], ...over,
});

const BOOKS = [
  book("b1", "The Master and His Emissary", {
    category: "philosophy", tags: ["mind"], summary: "A case about attention.",
    summaryModel: "claude-opus-5",
    chapters: [{ id: "c1", name: "Asymmetry", startPage: 1, endPage: 40, textContent: "", gist: "Why two hemispheres." }],
    folderIds: ["s1"],
  }),
  book("b2", "Seeing Like a State"),
  book("b3", "The Order of Time"),
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  // jsdom implements neither of these; the component uses both and would
  // otherwise fail for reasons that have nothing to do with the component.
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom has no 2D context and logs a jsdomError for every attempt. The
  // ambience handles the refusal fine; this just keeps the output readable.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as HTMLCanvasElement["getContext"];
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
});

const mount = async (books: BookDocument[] = BOOKS, onOpen = vi.fn()) => {
  await act(async () => {
    root.render(
      <ThemeProvider>
        <LibraryShowcase books={books} shelves={[{ id: "s1", name: "Reading now" }]} onOpenBook={onOpen} />
      </ThemeProvider>,
    );
  });
  return onOpen;
};

const text = () => host.textContent ?? "";
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

describe("LibraryShowcase, mounted", () => {
  it("puts a whole profile on the stage", async () => {
    await mount();
    expect(text()).toContain("The Master and His Emissary");
    expect(text()).toContain("A case about attention.");
    expect(text()).toContain("claude-opus-5");       // summary attribution
    expect(text()).toContain("philosophy");           // category chip
    expect(text()).toContain("Reading now");          // shelf chip
    expect(text()).toContain("Asymmetry");            // chapter highlight
    expect(text()).toContain("Why two hemispheres."); // its gist
    expect(text()).toContain("#mind");                // topic tag
    expect(text()).toContain("600");                  // pages
  });

  it("lists every book on the rail, not just the one on stage", async () => {
    await mount();
    const rail = host.querySelectorAll("[data-active]");
    expect(rail.length).toBe(3);
    expect(text()).toContain("Seeing Like a State");
    expect(text()).toContain("The Order of Time");
  });

  it("shows a reading position the device remembers", async () => {
    await mount();
    // b2 is on page 150 of 600 and appears on the rail.
    expect(text()).toContain("25% read");
  });

  it("steps forward and back with the controls", async () => {
    await mount();
    await act(async () => { button("Next book")!.click(); });
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain("Seeing Like a State");
    await act(async () => { button("Previous book")!.click(); });
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain("The Master and His Emissary");
  });

  it("wraps around rather than running off either end", async () => {
    await mount();
    await act(async () => { button("Previous book")!.click(); });
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain("The Order of Time");
  });

  it("jumps to a book clicked on the rail", async () => {
    await mount();
    const rows = host.querySelectorAll<HTMLButtonElement>("[data-active]");
    await act(async () => { rows[2].click(); });
    expect(rows[2].getAttribute("data-active")).toBe("true");
    expect(text()).toContain("The Order of Time");
  });

  it("opens the book on the stage", async () => {
    const onOpen = await mount();
    const open = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Open");
    await act(async () => { open!.click(); });
    expect(onOpen).toHaveBeenCalledWith("b1");
  });

  it("offers nothing that plays, because nothing plays any more", async () => {
    await mount();
    expect(button("Pause the showcase")).toBeNull();
    expect(button("Play the showcase")).toBeNull();
  });

  it("does not move on its own", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const before = host.querySelector('[data-active="true"]')?.textContent;
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(host.querySelector('[data-active="true"]')?.textContent).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("comes back to the book it was left on, not to the top", async () => {
    // The reported bug: switching to another view and back reset the whole
    // thing to the first book every time.
    await mount();
    const rows = host.querySelectorAll<HTMLButtonElement>("[data-active]");
    await act(async () => { rows[2].click(); });
    expect(text()).toContain("The Order of Time");

    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount();
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain("The Order of Time");
  });

  it("falls back to the first book when the remembered one is gone", async () => {
    localStorage.setItem("vault_showcase_book", "deleted-book-id");
    await mount();
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain("The Master and His Emissary");
  });

  it("says where the year is and where you are in the library", async () => {
    await mount();
    expect(text()).toMatch(/winter|spring|summer|autumn/);
    expect(text()).toMatch(/1 of 3/);
  });

  it("renders nothing at all for an empty library", async () => {
    await mount([]);
    expect(host.textContent).toBe("");
  });

  it("still works with a single book", async () => {
    await mount([BOOKS[0]]);
    expect(text()).toContain("1 of 1");
    // Still mounted and still controllable — just not self-advancing.
    expect(button("Next book")).toBeTruthy();
  });

  it("survives a book with nothing filled in", async () => {
    await mount([book("bare", "Untitled", { pageCount: 0, summary: null, category: undefined, tags: [] })]);
    expect(text()).toContain("Untitled");
    expect(text()).toContain("No summary yet");
  });
});
