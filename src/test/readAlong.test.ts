import { describe, it, expect } from "vitest";
import {
  tokenizeWords,
  buildReadChunks,
  alignTimings,
  estimateTimings,
  wordAtTime,
  wordAtOffset,
  levelInfo,
  xpForLevel,
  creditWords,
  liveStreak,
  EMPTY_STATS,
  DAILY_WORD_GOAL,
  sentenceStartOf,
  chunkIndexForWord,
  nextSentenceStart,
  prevSentenceStart,
} from "@/lib/readAlong";

describe("tokenizeWords", () => {
  it("keeps offsets into the source and folds trailing punctuation into the word", () => {
    const text = "Hello,  world! It's “well-known”.";
    const words = tokenizeWords(text);
    expect(words.map((w) => w.text)).toEqual(["Hello,", "world!", "It's", "well-known”."]);
    for (const w of words) expect(text.slice(w.start, w.end)).toBe(w.text);
  });

  it("returns nothing for punctuation-only text", () => {
    expect(tokenizeWords(" — … ")).toEqual([]);
  });
});

describe("buildReadChunks", () => {
  const sentence = "The quick brown fox jumps over the lazy dog again. ";
  const text = sentence.repeat(12).trim();
  const words = tokenizeWords(text);

  it("covers every word exactly once, in order, within the size limit", () => {
    const chunks = buildReadChunks(text, words);
    expect(chunks[0].first).toBe(0);
    expect(chunks[chunks.length - 1].last).toBe(words.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].first).toBe(chunks[i - 1].last);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(240);
      expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
      expect(c.text.endsWith(".")).toBe(true);
    }
    expect(chunks[0].text.length).toBeLessThanOrEqual(120);
  });

  it("starts from a given word and splits a run-on with no punctuation", () => {
    const runOn = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const w = tokenizeWords(runOn);
    const chunks = buildReadChunks(runOn, w, 10);
    expect(chunks[0].first).toBe(10);
    expect(chunks[chunks.length - 1].last).toBe(w.length);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(240);
  });
});

describe("alignTimings", () => {
  it("matches provider tokens, skipping punctuation tokens and whitespace", () => {
    const words = tokenizeWords("Hello, world! Bye.");
    const times = alignTimings(words, [
      { text: "Hello", start: 0, end: 0.4 },
      { text: ",", start: 0.4, end: 0.4 },
      { text: " ", start: 0.4, end: 0.5 },
      { text: "world", start: 0.5, end: 0.9 },
      { text: "!", start: 0.9, end: 0.9 },
      { text: "Bye", start: 1.2, end: 1.5 },
    ]);
    expect(times).toEqual([[0, 0.4], [0.5, 0.9], [1.2, 1.5]]);
  });

  it("interpolates a word the provider normalized differently", () => {
    const words = tokenizeWords("It was 1984 then");
    const times = alignTimings(words, [
      { text: "It", start: 0, end: 0.2 },
      { text: "was", start: 0.2, end: 0.4 },
      { text: "nineteen", start: 0.4, end: 0.8 },
      { text: "eighty", start: 0.8, end: 1.1 },
      { text: "four", start: 1.1, end: 1.4 },
      { text: "then", start: 1.5, end: 1.8 },
    ])!;
    expect(times[3]).toEqual([1.5, 1.8]);
    expect(times[2][0]).toBeCloseTo(0.4);
    expect(times[2][1]).toBeCloseTo(1.5);
  });

  it("joins a word the provider split in two", () => {
    const words = tokenizeWords("don't stop");
    const times = alignTimings(words, [
      { text: "don", start: 0, end: 0.2 },
      { text: "'t", start: 0.2, end: 0.3 },
      { text: "stop", start: 0.35, end: 0.7 },
    ]);
    expect(times).toEqual([[0, 0.3], [0.35, 0.7]]);
  });

  it("gives up (null) when the tokens are for different text", () => {
    const words = tokenizeWords("alpha beta gamma delta");
    expect(alignTimings(words, [{ text: "zebra", start: 0, end: 1 }])).toBeNull();
    expect(alignTimings(words, [])).toBeNull();
  });
});

describe("estimateTimings / wordAtTime", () => {
  const words = tokenizeWords("A tiny test. Then a much longer sentence follows here.");

  it("spreads words monotonically across the whole duration", () => {
    const times = estimateTimings(words, 5);
    expect(times).toHaveLength(words.length);
    expect(times[0][0]).toBe(0);
    for (let i = 1; i < times.length; i++) expect(times[i][0]).toBeGreaterThanOrEqual(times[i - 1][1]);
    expect(times[times.length - 1][1]).toBeLessThanOrEqual(5.0001);
    // Longer words get longer spans.
    const span = (i: number) => times[i][1] - times[i][0];
    expect(span(words.findIndex((w) => w.text === "sentence"))).toBeGreaterThan(span(0));
  });

  it("finds the word at a time, with or without a hint", () => {
    const times = estimateTimings(words, 5);
    expect(wordAtTime(times, -1)).toBe(-1);
    for (let i = 0; i < times.length; i++) {
      const mid = (times[i][0] + times[i][1]) / 2;
      expect(wordAtTime(times, mid)).toBe(i);
      expect(wordAtTime(times, mid, Math.max(0, i - 1))).toBe(i);
      expect(wordAtTime(times, mid, 0)).toBe(i);
    }
    expect(wordAtTime(times, 99)).toBe(times.length - 1);
  });

  it("maps a char offset to its word", () => {
    const text = "one two three";
    const w = tokenizeWords(text);
    expect(wordAtOffset(w, 0)).toBe(0);
    expect(wordAtOffset(w, 5)).toBe(1);
    expect(wordAtOffset(w, 8)).toBe(2);
  });
});

describe("gamification", () => {
  it("levels up on the XP curve", () => {
    expect(levelInfo(0)).toEqual({ level: 1, into: 0, span: xpForLevel(2) });
    expect(levelInfo(xpForLevel(3)).level).toBe(3);
    expect(levelInfo(xpForLevel(3) - 1).level).toBe(2);
  });

  it("applies the combo multiplier and reports a level-up", () => {
    const r = creditWords(EMPTY_STATS, 100, 300, "2026-09-16");
    expect(r.gainedXp).toBe(200);
    expect(r.leveledUp).toBe(2);
    expect(r.stats.bestCombo).toBe(300);
  });

  it("builds a daily streak and breaks it after a missed day", () => {
    let s = creditWords(EMPTY_STATS, DAILY_WORD_GOAL, 1, "2026-09-14");
    expect(s.goalMet).toBe(true);
    expect(s.stats.streak).toBe(1);
    // Same day again: no double count.
    s = creditWords(s.stats, 50, 1, "2026-09-14");
    expect(s.goalMet).toBe(false);
    s = creditWords(s.stats, DAILY_WORD_GOAL, 1, "2026-09-15");
    expect(s.stats.streak).toBe(2);
    // Today's words reset each day.
    expect(s.stats.todayWords).toBe(DAILY_WORD_GOAL);
    expect(liveStreak(s.stats, "2026-09-16")).toBe(2);
    expect(liveStreak(s.stats, "2026-09-17")).toBe(0);
    s = creditWords(s.stats, DAILY_WORD_GOAL, 1, "2026-09-18");
    expect(s.stats.streak).toBe(1);
  });
});

describe("sentence navigation", () => {
  const text = "Dr. Smith came home. He sat down! Then he read “the book.” The end";
  const words = tokenizeWords(text);
  const idx = (w: string) => words.findIndex((x) => x.text === w);

  it("finds sentence starts, not fooled by abbreviations", () => {
    expect(sentenceStartOf(words, idx("home."))).toBe(0);
    expect(sentenceStartOf(words, idx("down!"))).toBe(idx("He"));
    expect(sentenceStartOf(words, idx("book.”"))).toBe(idx("Then"));
  });

  it("skips forward to the next sentence, or -1 in the last", () => {
    expect(nextSentenceStart(words, idx("Smith"))).toBe(idx("He"));
    expect(nextSentenceStart(words, idx("read"))).toBe(idx("The"));
    expect(nextSentenceStart(words, idx("end"))).toBe(-1);
  });

  it("skips back to this sentence's start, or the previous one if just begun", () => {
    expect(prevSentenceStart(words, idx("down!"))).toBe(idx("He"));
    expect(prevSentenceStart(words, idx("He"))).toBe(0);
    expect(prevSentenceStart(words, 0)).toBe(0);
  });
});

describe("page-anchored chunks (saved-audio reuse)", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} is here, with a few more words to read.`).join(" ");
  const words = tokenizeWords(text);
  const chunks = buildReadChunks(text, words, 0, 240, 120);

  it("finds the chunk holding any word", () => {
    for (const [ci, c] of chunks.entries()) {
      expect(chunkIndexForWord(chunks, c.first)).toBe(ci);
      expect(chunkIndexForWord(chunks, c.last - 1)).toBe(ci);
    }
    expect(chunkIndexForWord(chunks, words.length + 5)).toBe(chunks.length - 1);
    expect(chunkIndexForWord([], 3)).toBe(0);
  });

  it("cuts the same clips every time, so repeats hit the cache", () => {
    const again = buildReadChunks(text, tokenizeWords(text), 0, 240, 120);
    expect(again.map((c) => c.text)).toEqual(chunks.map((c) => c.text));
  });
});
