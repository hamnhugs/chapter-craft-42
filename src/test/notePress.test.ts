import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { classifyNotePress, NOTE_PRESS, type NotePressSample } from "@/lib/notePress";

/**
 * Locks out the bug the user hit: holding a chat bubble for half a second —
 * the pause a thumb makes before it starts scrolling — silently saved a note
 * and threw the notes panel over the transcript. Two things made that bad:
 * the threshold matched the OS long-press (so it fired when your thumb had
 * been trained to expect nothing), and the misfire was expensive to undo.
 *
 * These tests fail if the hold drops back toward OS long-press territory, if
 * the gesture stops rejecting scrolls/pinches/selections, if the save starts
 * opening the panel again, or if the undo affordance disappears.
 */

const held: NotePressSample = {
  movedPx: 2,
  maxPointers: 1,
  selecting: false,
  scrolled: false,
  heldMs: NOTE_PRESS.holdMs,
};

describe("classifyNotePress", () => {
  it("saves on a long, still, single-finger hold", () => {
    expect(classifyNotePress(held)).toBe("save");
  });

  it("ignores the half-second hold that used to fire (the reported bug)", () => {
    expect(classifyNotePress({ ...held, heldMs: 500 })).toBeNull();
    expect(classifyNotePress({ ...held, heldMs: NOTE_PRESS.holdMs - 1 })).toBeNull();
  });

  it("stays clear of the OS long-press so a press never means two things", () => {
    // Android and iOS both fire their own long-press around 500ms.
    expect(NOTE_PRESS.holdMs).toBeGreaterThanOrEqual(800);
  });

  it("ignores a finger that is on its way to a scroll", () => {
    expect(classifyNotePress({ ...held, movedPx: NOTE_PRESS.slopPx + 1 })).toBeNull();
    expect(classifyNotePress({ ...held, scrolled: true })).toBeNull();
  });

  it("lets a still finger be still — jitter is not a drag", () => {
    // Browsers emit touchmove for sub-pixel jitter. Cancelling on *any* move
    // failed deliberate presses while a resting thumb still fired: backwards.
    expect(NOTE_PRESS.slopPx).toBeGreaterThan(0);
    expect(classifyNotePress({ ...held, movedPx: NOTE_PRESS.slopPx })).toBe("save");
  });

  it("ignores pinch and leaves selections to the selection toolbar", () => {
    expect(classifyNotePress({ ...held, maxPointers: 2 })).toBeNull();
    expect(classifyNotePress({ ...held, selecting: true })).toBeNull();
  });
});

const CHAT = readFileSync("src/components/ChatPanel.tsx", "utf8");
const block = CHAT.slice(
  CHAT.indexOf("// ----- Long-press a bubble to save it as a note"),
  CHAT.indexOf("const saveBubbleToNotes")
);

describe("ChatPanel long-press wiring", () => {
  it("has a non-empty block to assert against", () => {
    expect(block.length).toBeGreaterThan(400);
  });

  it("classifies at fire time, not at arm time", () => {
    // The finger has the whole hold to drift or add a second touch.
    expect(block).toContain("classifyNotePress(");
    expect(block).toContain("selecting: hasSelection()");
  });

  it("no longer buries the transcript under the notes panel on a save", () => {
    expect(block).not.toContain("setNotesPanelOpen(true)");
  });

  it("offers an undo, so a misfire costs one tap", () => {
    expect(block).toContain("deleteVoiceNote(note.id)");
    expect(block).toContain('label: "Undo"');
  });

  it("cancels the press when the transcript scrolls", () => {
    expect(CHAT).toContain("onScroll={() => { cancelLongPress();");
  });

  it("tracks movement instead of cancelling on any touchmove", () => {
    expect(CHAT).toContain("onTouchMove={trackLongPress}");
  });
});
