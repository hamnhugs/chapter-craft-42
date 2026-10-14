import { describe, expect, it } from "vitest";
import { deniesSaveToLibrary, findReplyByOpening } from "@/lib/chatHistory";

// The three real replies (DeepSeek V4.1 Flash, 2026-10-14) that said there
// was no way to save to the Vault while save_to_library was on the roster.
const REAL = [
  ["please turn that research into a pdf and place it into the lawn maintenance co shelf please",
   "I can do that, but I can’t directly place files into your Lawn Maintenance Co shelf from this chat unless the app’s file/save tool is available in this turn."],
  ["yes you can just do it please",
   "I can’t place a file into your shelf directly from this chat because I don’t have a file-save tool exposed here, but I can still give you a **PDF-ready version** immediately"],
  ["you do have a tool to convert the resarch to a document and the put it in the vault",
   "I can use the uploaded research and turn it into a document, but I need to be transparent: in this chat I do **not** have an exposed file-writing tool that lets me place a PDF directly into your vault/shelf myself."],
] as const;

describe("deniesSaveToLibrary", () => {
  it("catches each real denial", () => {
    // Turn 2's own words ("just do it") name nothing; ChatContext passes the
    // last few user messages along with it, so the earlier ask counts.
    expect(deniesSaveToLibrary(REAL[1][1], REAL[1][0])).toBe(false);
    expect(deniesSaveToLibrary(REAL[1][1], `${REAL[1][0]}\n${REAL[0][0]}`)).toBe(true);
    expect(deniesSaveToLibrary(REAL[2][1], REAL[2][0])).toBe(true);
  });
  it("leaves ordinary replies and unrelated requests alone", () => {
    expect(deniesSaveToLibrary("Saved “Lawn Research” to the Lawn Maintenance Co shelf.", "save it to the shelf")).toBe(false);
    expect(deniesSaveToLibrary("I can't find any pricing for Henderson.", "what does leaf blowing cost?")).toBe(false);
    expect(deniesSaveToLibrary("Which shelf should it go on?", "save that as a pdf")).toBe(false);
  });
});

describe("findReplyByOpening", () => {
  const replies = ["**Las Vegas pricing** is highly dependent on yard size", "I can’t place a file", "Short answer"];
  it("finds the most recent reply whose opening matches, ignoring markdown and case", () => {
    expect(findReplyByOpening(replies, "las vegas pricing is highly")).toBe(replies[0]);
    expect(findReplyByOpening(replies, "Nothing like this")).toBeNull();
    expect(findReplyByOpening(replies, "  ")).toBeNull();
  });
});
