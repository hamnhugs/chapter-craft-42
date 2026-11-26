import { describe, it, expect } from "vitest";
import { findQuotes, numberQuotes } from "@/lib/castVoices/quotes";

const bodies = (t: string) => findQuotes(t).map((q) => q.text);

describe("findQuotes", () => {
  it("curly double quotes, with the tag left outside", () => {
    const t = "“I think,” she said, “that we should go.” He nodded.";
    expect(bodies(t)).toEqual(["I think,", "that we should go."]);
    const [a] = findQuotes(t);
    expect(t.slice(a.start, a.end)).toBe("“I think,”");
  });

  it("straight double quotes pair by what surrounds them", () => {
    expect(bodies('He said, "Come in." Then: "Sit down," and (quietly) "please."')).toEqual(["Come in.", "Sit down,", "please."]);
  });

  it("a nested quote stays inside its outer span", () => {
    expect(bodies("“He told me ‘never again’ and left,” said Ann.")).toEqual(["He told me ‘never again’ and left,"]);
  });

  it("apostrophes are not quotes", () => {
    expect(bodies("It's the boys’ room and I don’t care.")).toEqual([]);
  });

  it("British single quotes when they are the book's quotation mark", () => {
    const t = "‘Don’t be silly,’ said Ron. ‘It’s the twins’ idea.’ Harry laughed. ‘Fine.’";
    expect(bodies(t)).toEqual(["Don’t be silly,", "It’s the twins’ idea.", "Fine."]);
  });

  it("single quotes are ignored when doubles carry the dialogue", () => {
    expect(bodies("“Yes,” he said. The so-called ‘expert’ left. “No,” she said.")).toEqual(["Yes,", "No,"]);
  });

  it("a quotation continued over paragraphs becomes one span per paragraph", () => {
    const t = "“First paragraph of the speech.\n\n“Second paragraph, which ends it.”";
    expect(bodies(t)).toEqual(["First paragraph of the speech.", "Second paragraph, which ends it."]);
    const t2 = '"First paragraph of the speech.\n\n"Second paragraph, which ends it."';
    expect(bodies(t2)).toEqual(["First paragraph of the speech.", "Second paragraph, which ends it."]);
  });

  it("guillemets and German quotes", () => {
    expect(bodies("«Bonjour», dit-il. „Guten Tag“, sagte sie.")).toEqual(["Bonjour", "Guten Tag"]);
  });

  it("an unpaired mark yields nothing rather than a guess", () => {
    expect(bodies("She wrote 5\" by 7\" on the box. “Unclosed and then the page ends")).toEqual([]);
  });

  it("spans are ordered and never overlap", () => {
    const t = "“A.” x “B.” y \"C.\" z “D ‘e’ f.”";
    const qs = findQuotes(t);
    for (let i = 1; i < qs.length; i++) expect(qs[i].start).toBeGreaterThanOrEqual(qs[i - 1].end);
    expect(qs).toHaveLength(4);
  });
});

describe("numberQuotes", () => {
  it("marks each quote with its number and leaves the words alone", () => {
    const t = "“Hi,” said Al. “Bye.”";
    expect(numberQuotes(t, findQuotes(t))).toBe("⟦1⟧“Hi,” said Al. ⟦2⟧“Bye.”");
  });

  it("the page cannot forge a marker", () => {
    const t = "⟦9⟧ he typed. “Hi.”";
    expect(numberQuotes(t, findQuotes(t))).toBe("9 he typed. ⟦1⟧“Hi.”");
  });
});

import { buildReadChunks, buildVoicedChunks, tokenizeWords } from "@/lib/readAlong";

describe("buildVoicedChunks", () => {
  const t = "“I think,” she said, “that we should go now, before it gets dark.” He nodded slowly and picked up the lantern from the table. “Fine.”";
  const words = tokenizeWords(t);
  const qs = findQuotes(t);
  const spans = [
    { start: qs[0].start, end: qs[0].end, voice: "Ann" },
    { start: qs[1].start, end: qs[1].end, voice: "Ann" },
    { start: qs[2].start, end: qs[2].end, voice: "Bob", direction: "curtly" },
  ];

  it("no spans: identical to buildReadChunks", () => {
    expect(buildVoicedChunks(t, words, [])).toEqual(buildReadChunks(t, words));
  });

  it("cuts at every change of speaker and leaves the tag to the narrator", () => {
    const chunks = buildVoicedChunks(t, words, spans);
    expect(chunks.map((c) => [c.voice ?? "narrator", c.text])).toEqual([
      ["Ann", "I think,”"],
      ["narrator", "she said,"],
      ["Ann", "that we should go now, before it gets dark.”"],
      ["narrator", "He nodded slowly and picked up the lantern from the table."],
      ["Bob", "Fine.”"],
    ]);
    expect(chunks[4].direction).toBe("curtly");
  });

  it("covers every word exactly once, in order", () => {
    const chunks = buildVoicedChunks(t, words, spans, 3);
    expect(chunks[0].first).toBe(3);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].first).toBe(chunks[i - 1].last);
    expect(chunks[chunks.length - 1].last).toBe(words.length);
  });

  it("a quote the cast did not claim stays with the narrator", () => {
    const chunks = buildVoicedChunks(t, words, [spans[2]]);
    expect(chunks.filter((c) => c.voice).map((c) => c.voice)).toEqual(["Bob"]);
  });
});
