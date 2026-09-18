import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Counsel's composer — the bottom of the tab, and the rules it now lives by.
 *
 * WHAT THIS PROTECTS. The composer used to end in a thirteen-chip
 * `overflow-x-auto` scroller sitting directly beneath the send button. Two
 * separate defects came out of that one decision:
 *
 *   1. A horizontal scroller under the screen's highest-consequence control.
 *      Every flick toward a far chip began as a press on top of a live toggle,
 *      and the prompt switcher opened on the DOWN event, so it fired before the
 *      finger travelled (PromptSwitcher's own comment, and
 *      promptSwitcherTap.test.tsx, hold that half).
 *   2. Most of the row was off-screen with nothing saying so — hiding by
 *      scroll, which is the worst kind of hiding.
 *
 * The replacement: one "Tools" button opening a sheet, plus a strip that WRAPS
 * and only renders what is currently on. These are source assertions in the
 * style of workspaceIntegration.test.ts — the composer is 1700 lines of
 * context-dependent JSX, and the invariants worth guarding here are structural,
 * not behavioural.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/\\])\/\/[^\n]*/gm, "$1");

const CHAT_PANEL = stripComments(read("src/components/ChatPanel.tsx"));
const SHEET = stripComments(read("src/components/CounselToolsSheet.tsx"));
const INDEX = stripComments(read("src/pages/Index.tsx"));
const count = (h: string, n: string) => h.split(n).length - 1;

describe("the tool scroller is gone", () => {
  it("the composer has no horizontally scrolling chip row", () => {
    // The exact combination the old row used. `hide-scrollbar` alone is fine —
    // the transcript legitimately uses it on a VERTICAL scroller.
    expect(CHAT_PANEL).not.toContain("overflow-x-auto");
    expect(CHAT_PANEL).not.toContain("snap-x");
  });

  it("the status strip wraps instead", () => {
    expect(CHAT_PANEL).toContain("flex items-center gap-2 px-2 flex-wrap");
  });
});

describe("the tools sheet", () => {
  it("is mounted exactly once by ChatPanel", () => {
    expect(count(CHAT_PANEL, "<CounselToolsSheet")).toBe(1);
  });

  it("follows the Android no-programmatic-focus rule, like every other sheet here", () => {
    // Any programmatic focus pops the soft keyboard over the sheet.
    expect(SHEET).toContain("onOpenAutoFocus={(e) => e.preventDefault()}");
  });

  it("clears the home indicator", () => {
    expect(SHEET).toContain("env(safe-area-inset-bottom)");
  });

  it("carries the controls the chip row used to hold", () => {
    for (const label of ["Neurons", "Books", "Files", "Notes", "Deep Research", "Read Aloud", "Settings"]) {
      expect(SHEET).toContain(`label="${label}"`);
    }
    expect(SHEET).toContain("<PromptSwitcher");
  });

  it("has no Digest — it was removed at the user's request, not hidden in the sheet", () => {
    expect(SHEET).not.toMatch(/digest/i);
    expect(CHAT_PANEL).not.toMatch(/digest/i);
  });
});

describe("send", () => {
  it("is not rendered at all when there is nothing to send", () => {
    // A disabled button still occupies the corner the thumb reaches for. The
    // guard must be a render condition, not a `disabled` prop.
    expect(CHAT_PANEL).toContain("canSend ? (");
    expect(CHAT_PANEL).toMatch(/const canSend = !!input\.trim\(\) \|\| pendingImages\.length > 0/);
  });

  it("and mic share one row, so their 44px hit regions cannot overlap", () => {
    // The old `right-11` / `right-2` offsets left 6px between two ~30px
    // buttons; growing both to 44px targets would have made them intersect.
    expect(CHAT_PANEL).not.toContain("right-11");
    expect(CHAT_PANEL).toContain("absolute right-2 bottom-2 flex items-center gap-2");
    expect(count(CHAT_PANEL, "after:absolute after:-inset-[4px]")).toBe(3); // mic, stop, send
  });

  it("reserves textarea room that matches the buttons actually rendered", () => {
    expect(CHAT_PANEL).toContain("${composerPadRight}");
    expect(CHAT_PANEL).not.toContain("pl-4 pr-20");
  });
});

describe("the bottom nav no longer covers the composer", () => {
  it("clears the nav's full height, safe-area inset included", () => {
    // nav = h-16 (4rem) + env(safe-area-inset-bottom). A flat pb-20 covered
    // only the 4rem, so a home indicator ate the last ~18px of the tab.
    expect(INDEX).toMatch(/pb-\[calc\(5rem\+env\(safe-area-inset-bottom,0px\)\)\]/);
    expect(INDEX).toContain("h-16");
  });

  it("still switches the clearance off at md, where the nav is hidden", () => {
    expect(INDEX).toMatch(/className="flex-1 overflow-hidden pb-\S+ md:pb-0"/);
  });
});
