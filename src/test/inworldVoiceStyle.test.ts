import { describe, expect, it } from "vitest";
import { AUTO_DIRECTION, contextBefore, styleFields } from "@/lib/inworldTts";

describe("contextBefore", () => {
  const chunks = ["One.", "Two.", "Three.", "Four."];

  it("is empty for the first chunk", () => {
    expect(contextBefore(chunks, 0)).toEqual([]);
  });

  it("gives the last two chunks, oldest first", () => {
    expect(contextBefore(chunks, 3)).toEqual(["Two.", "Three."]);
    expect(contextBefore(chunks, 1)).toEqual(["One."]);
  });

  it("stops before the context grows past its budget", () => {
    const long = ["a".repeat(500), "b".repeat(500), "next"];
    expect(contextBefore(long, 2)).toEqual(["b".repeat(500)]);
  });
});

describe("styleFields", () => {
  it("defaults to the flagship model with nothing else", () => {
    expect(styleFields()).toEqual({ model: "inworld-tts-2" });
  });

  it("sends a written direction and the delivery", () => {
    expect(styleFields({ delivery: "STABLE", direction: " speak calmly " })).toEqual({
      model: "inworld-tts-2",
      delivery: "STABLE",
      direction: "speak calmly",
    });
  });

  it("turns the auto direction into reasoning with its scene", () => {
    expect(styleFields({ direction: AUTO_DIRECTION, scene: "A narrator reads." })).toEqual({
      model: "inworld-tts-2",
      reasoning: true,
      reasoning_context: "A narrator reads.",
    });
  });

  it("never sends direction to Flash, which ignores it", () => {
    const out = styleFields({ model: "inworld-tts-2-flash", direction: "speak calmly" });
    expect(out).toEqual({ model: "inworld-tts-2-flash" });
  });

  it("carries the preceding chunks", () => {
    expect(styleFields({}, { previous: ["Before."] }).previous).toEqual(["Before."]);
  });
});
