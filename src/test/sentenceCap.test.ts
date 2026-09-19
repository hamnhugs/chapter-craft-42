import { describe, it, expect } from "vitest";
import { countSentences, findSentenceCapIndex, truncateAtSentenceCap } from "@/lib/sentenceCap";

describe("countSentences", () => {
  it("counts plain sentences", () => {
    expect(countSentences("One. Two! Three?")).toBe(3);
  });

  it("never splits decimals or lowercase abbreviation continuations", () => {
    // Guaranteed on every engine: no split inside "1.5", no split after
    // "e.g." when lowercase text follows. Abbreviations before capitalized
    // names ("Dr. Smith") are engine-dependent (ICU suppression data varies) —
    // an over-count there only cuts one sentence earlier, still on a boundary.
    expect(countSentences("The dose was 1.5 mg per day.")).toBe(1);
    expect(countSentences("Use commas e.g. like this, then stop.")).toBe(1);
    const drSmith = countSentences("Dr. Smith arrived. He left.");
    expect(drSmith).toBeGreaterThanOrEqual(2);
    expect(drSmith).toBeLessThanOrEqual(3);
  });

  it("ignores code fences entirely", () => {
    const text = "Here is the fix.\n```js\nconst a = 1. No. Not. Sentences.\nreturn a;\n```\nDone now.";
    expect(countSentences(text)).toBe(2);
  });

  it("counts each list item as one sentence", () => {
    const text = "Two points follow.\n- First point, with commas, no period\n- Second point. It has two clauses.\n";
    expect(countSentences(text)).toBe(3);
  });

  it("counts headings as zero", () => {
    expect(countSentences("## A Heading\nOne real sentence.")).toBe(1);
  });

  it("counts a trailing fragment normally when not streaming", () => {
    expect(countSentences("Complete sentence. And a trailing fragment")).toBe(2);
  });

  it("skips the growing tail while streaming", () => {
    expect(countSentences("Complete sentence. And a trailing fragm", { streaming: true })).toBe(1);
    expect(countSentences("Complete sentence. Second complete one!", { streaming: true })).toBe(2);
  });

  it("does not count an unterminated streaming list item", () => {
    expect(countSentences("Intro line.\n- still being typ", { streaming: true })).toBe(1);
  });

  it("never treats a colon tail as a complete sentence while streaming", () => {
    // A mid-sentence colon at a delta boundary must not trigger the cap —
    // "My verdict:" is still growing ("My verdict: the chapter works.").
    expect(countSentences("One sentence done. My verdict:", { streaming: true })).toBe(1);
    // The colon lead-in is counted once its newline flushes the run.
    expect(countSentences("Here are the options:\n- first\n", { streaming: true })).toBe(2);
  });

  it("counts CJK sentence terminals, streaming and final", () => {
    expect(countSentences("你好世界。这是第二句。", { streaming: true })).toBe(2);
    expect(countSentences("你好世界。这是第二句。")).toBe(2);
  });
});

describe("findSentenceCapIndex / truncateAtSentenceCap", () => {
  it("returns null under the cap", () => {
    expect(findSentenceCapIndex("Only one here.", 3)).toBeNull();
    expect(truncateAtSentenceCap("Only one here.", 3)).toBe("Only one here.");
  });

  it("cuts exactly at the Nth sentence boundary", () => {
    const text = "First. Second. Third. Fourth.";
    expect(truncateAtSentenceCap(text, 2)).toBe("First. Second.");
  });

  it("never cuts inside a code fence", () => {
    const text = "One. Two.\n```\nfake. sentences. here.\n```\nThree.";
    const cut = truncateAtSentenceCap(text, 3);
    expect(cut.endsWith("Three.")).toBe(true);
  });

  it("cuts at the end of a list item when the cap lands on one", () => {
    const text = "Intro sentence.\n- first item without period\n- second item\n";
    expect(truncateAtSentenceCap(text, 2)).toBe("Intro sentence.\n- first item without period");
  });

  it("streaming truncation drops the partial tail past the cap", () => {
    const text = "One. Two. And then a partial thi";
    expect(truncateAtSentenceCap(text, 2, { streaming: true })).toBe("One. Two.");
  });

  it("final pass counts a trailing fragment as a sentence (stricter than streaming)", () => {
    const text = "One. Two. Trailing fragment with no period";
    expect(truncateAtSentenceCap(text, 2)).toBe("One. Two.");
    expect(countSentences(text)).toBe(3);
  });

  it("handles markdown bold terminators", () => {
    expect(countSentences("This is **bold.** Another one.")).toBe(2);
  });

  it("handles empty and whitespace-only input", () => {
    expect(countSentences("")).toBe(0);
    expect(countSentences("   \n\n  ")).toBe(0);
    expect(findSentenceCapIndex("", 2)).toBeNull();
  });
});
