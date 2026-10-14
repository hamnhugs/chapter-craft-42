import { describe, expect, it } from "vitest";
import { claimsUnmadeDesignEdit, touchedDesignCraft, unmadeDesignEditNote } from "@/lib/chatHistory";
import { selectionNote } from "@/lib/craftApps";
import { resolveSize, samePicture } from "../../scripts/local-ai/craft-bridge.mjs";

describe("what the user selected in DesignCraft", () => {
  it("becomes a note naming each item and the ids to act on", () => {
    const note = selectionNote({ items: [{ id: 11, kind: "text", role: "headline", text: "Plan to Win" }, { id: 8, kind: "image", role: "image" }] })!;
    expect(note).toMatch(/^\[Selected in DesignCraft/);
    expect(note).toMatch(/headline \(id 11\) "Plan to Win"; image \(id 8\)/);
    expect(note).toMatch(/ids \[11, 8\]/);
    expect(selectionNote({ items: [] })).toBeNull();
  });

  it("names highlighted words and plain shapes", () => {
    const note = selectionNote({ items: [{ id: 3, kind: "text", text: "Summer Book Fair" }], text_range: { text: "Summer" } })!;
    expect(note).toMatch(/the highlighted words "Summer" in text frame \(id 3\)/);
    expect(selectionNote({ items: [{ id: 5, kind: "shape", name: "Deco Accent rule" }] })).toMatch(/shape "Accent rule" \(id 5\)/);
  });

  it("reads sizes the way people say them", () => {
    expect(resolveSize("bigger", 40)).toBe(50);
    expect(resolveSize("smaller", 40)).toBe(32);
    expect(resolveSize("+20%", 40)).toBe(48);
    expect(resolveSize("-4", 40)).toBe(36);
    expect(resolveSize("28", 40)).toBe(28);
    expect(resolveSize("huge-ish", 40)).toBeNull();
    expect(samePicture("/ws/in/1791-image-b9fe2624.png", "/ws/in/1802-image-b9fe2624.png")).toBe(true);
    expect(samePicture("/ws/in/1791-image-b9fe2624.png", "/ws/in/1791-image-d45cdea5.png")).toBe(false);
  });
});

describe("a reply that says the page changed when nothing ran", () => {
  const sel = "make this red\n\n[Selected in DesignCraft — the user clicked this; …: headline (id 11). Change it with craft send, ids [11].]";
  it("is caught for a design edit", () => {
    expect(claimsUnmadeDesignEdit("The headline is now red.", sel)).toBe(true);
    expect(claimsUnmadeDesignEdit("A headline is missing — let me add one from the book:\n\n**Headline:** Plan to Win", "add a headline to the flyer")).toBe(true);
    expect(claimsUnmadeDesignEdit("I've moved the picture to the bottom.", "move the picture down", true)).toBe(true);
    expect(claimsUnmadeDesignEdit("", "save this design as a template called Movie Night", true)).toBe(true);
    expect(claimsUnmadeDesignEdit("", "what's the capital of France?", true)).toBe(false);
  });

  it("isn't, for a question back, for advice, or away from design", () => {
    expect(claimsUnmadeDesignEdit("Which one do you mean — the headline or the footer?", sel)).toBe(false);
    expect(claimsUnmadeDesignEdit("Here are 3 ideas I made for you: …", "give me 3 headline ideas for the flyer")).toBe(false);
    expect(claimsUnmadeDesignEdit("I've summarised chapter 3 below.", "summarise chapter 3")).toBe(false);
  });

  it("tells the model what to call, with the selection's ids", () => {
    expect(unmadeDesignEditNote([11])).toMatch(/ids \[11\]/);
    expect(unmadeDesignEditNote()).toMatch(/nothing changed in DesignCraft/);
    expect(touchedDesignCraft([{ name: "craft", summary: "Put the headline on the DesignCraft page" }])).toBe(true);
    expect(touchedDesignCraft([{ name: "craft", summary: "Ran 2 PhotoCraft commands" }])).toBe(false);
  });
});
