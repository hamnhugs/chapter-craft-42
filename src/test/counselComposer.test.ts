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

describe("nothing stacks under the composer", () => {
  it("has no snapping tool-chip scroller", () => {
    // `overflow-x-auto` on its own is now legitimate — the pinned-files and
    // loaded-books strips use it to stay ONE line instead of wrapping. What
    // must not come back is the snapping row of tool controls.
    expect(CHAT_PANEL).not.toContain("snap-x");
    expect(CHAT_PANEL).not.toContain("snap-start");
  });

  it("wraps nothing: no flex-wrap survives anywhere in the composer", () => {
    // `flex-wrap` was the literal bug. On a 360px phone the well offers ~304px
    // of row and the old state chips measured ~480px together, so the strip
    // could only ever be two lines, three once a label grew.
    const composer = CHAT_PANEL.slice(CHAT_PANEL.indexOf("{/* Input Area */}"));
    expect(composer).not.toContain("flex-wrap");
  });

  it("keeps the context strips to a single scrolling line", () => {
    expect(count(CHAT_PANEL, "flex flex-nowrap overflow-x-auto hide-scrollbar items-center")).toBe(2);
  });

  it("defaults loaded books to collapsed, so the bar does not grow with context", () => {
    expect(CHAT_PANEL).toContain('localStorage.getItem("counsel_context_books_collapsed") !== "0"');
  });
});

describe("state disclosure — three signals, never a bare count", () => {
  // Count-only disclosure tests badly: people open the panel purely to find
  // out what the number meant. So the number never travels alone.
  it("counts on the + badge", () => {
    expect(CHAT_PANEL).toContain("activeModeCount > 0 && (");
  });

  it("names the modes in the empty field", () => {
    expect(CHAT_PANEL).toContain('activeModes.join(" · ")');
    expect(CHAT_PANEL).toContain("placeholder={composerPlaceholder}");
  });

  it("rings the well, which is the signal that survives typing", () => {
    expect(CHAT_PANEL).toContain("ring-1 ring-primary-container/30");
  });

  it("excludes hands-free from the count — it has its own lit button", () => {
    const block = CHAT_PANEL.slice(CHAT_PANEL.indexOf("const activeModes"), CHAT_PANEL.indexOf("const activeModeCount"));
    expect(block).not.toContain("handsFree");
  });
});

describe("the + is attach and tools together", () => {
  it("has no separate paperclip button", () => {
    // 44x50 outside the field: the most non-idiomatic thing in the old bar,
    // and 56px of a 320px row spent on one action.
    expect(CHAT_PANEL).not.toContain("attach_file");
  });

  it("still reaches the image picker, from inside the sheet", () => {
    expect(CHAT_PANEL).toContain("onAttachImage={() => fileInputRef.current?.click()}");
    expect(SHEET).toContain('label="Image"');
  });
});

describe("hands-free is quick-draw", () => {
  it("sits on the bar, not in the sheet", () => {
    expect(CHAT_PANEL).toContain("onClick={handsFree.toggle}");
    expect(SHEET).not.toContain("handsFree");
    expect(SHEET).not.toContain("Hands-free");
  });

  it("is visually distinct from the dictation mic", () => {
    // One is a ghost, the other fills and accents. Conflating them is a named
    // defect in Grok's composer.
    expect(CHAT_PANEL).toContain("record_voice_over");
    expect(CHAT_PANEL).toContain("graphic_eq");
  });

  it("is its own status display, so the status row above the field could go", () => {
    expect(CHAT_PANEL).not.toContain("Listening — just talk");
    expect(CHAT_PANEL).toContain("handsFreeStateLabel");
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

  it("shares one row with mic and hands-free, hit regions never overlapping", () => {
    // The old `right-11` / `right-2` offsets left 6px between two ~30px
    // buttons; growing both to 44px targets would have made them intersect.
    expect(CHAT_PANEL).not.toContain("right-11");
    expect(CHAT_PANEL).toContain("absolute right-2 bottom-2 flex items-center gap-1.5");
    // 36px visual + 4px pad = a 44px target on every icon button: the +, the
    // mic, hands-free, stop and send.
    expect(count(CHAT_PANEL, "after:absolute after:-inset-[4px]")).toBe(5);
  });

  it("reserves room for up to three trailing buttons, in literal classes", () => {
    // Tailwind reads source text, so an interpolated class never compiles.
    for (const cls of ["pr-[136px]", "pr-[94px]", "pr-[52px]"]) {
      expect(CHAT_PANEL).toContain(cls);
    }
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
