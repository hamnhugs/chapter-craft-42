import { describe, expect, it } from "vitest";
import { parseVoiceCommand, parseNumber } from "@/lib/voiceCommands";
import { labelScore } from "@/lib/voiceControl";
import { findPhrase, resolvePassage, type PageText } from "@/lib/voicePageText";

const p = parseVoiceCommand;

describe("sleep", () => {
  it.each([
    "bookworm go to sleep", "Bookworm, go to sleep.", "bookworm sleep", "Wormy sleep", "wormy, sleep!",
    "book worm go to sleep", "hey bookworm go to sleep please", "goodnight bookworm",
  ])("%s", (s) => expect(p(s)).toEqual({ kind: "sleep" }));

  it.each(["I should go to sleep", "go to sleep", "the worm went to sleep in chapter two", "why do I need sleep bookworm explain"])(
    "not: %s", (s) => expect(p(s)?.kind).not.toBe("sleep"),
  );
});

describe("tabs", () => {
  it.each([
    ["go to the read tab", "viewer"], ["Bookworm, go to the read tab.", "viewer"], ["open the reader", "viewer"],
    ["switch to counsel", "chat"], ["go to council", "chat"], ["take me to the vault", "library"],
    ["open settings", "settings"], ["show me the brain", "wikis"], ["go to the neuron tab", "wiki"],
    ["vault", "library"], ["read tab", "viewer"], ["can you go to the library please", "library"],
  ])("%s → %s", (s, tab) => expect(p(s)).toEqual({ kind: "tab", tab }));

  it("bare 'read' is left for the model", () => expect(p("read")).toBeNull());
});

describe("pages", () => {
  it.each([
    ["next page", { kind: "page", to: "next" }],
    ["turn the page", { kind: "page", to: "next" }],
    ["previous page", { kind: "page", to: "prev" }],
    ["go back a page", { kind: "page", to: "prev" }],
    ["go to page 42", { kind: "page", to: "number", n: 42 }],
    ["page twenty three", { kind: "page", to: "number", n: 23 }],
    ["turn to page one hundred and five", { kind: "page", to: "number", n: 105 }],
    ["skip ahead five pages", { kind: "pageBy", delta: 5 }],
    ["go back 3 pages", { kind: "pageBy", delta: -3 }],
    ["first page", { kind: "page", to: "first" }],
    ["go to the end of the book", { kind: "page", to: "last" }],
  ])("%s", (s, cmd) => expect(p(s)).toEqual(cmd));

  it("a question about a page goes to the model", () => {
    expect(p("what's on the next page")).toBeNull();
    expect(p("summarize page 4 for me")).toBeNull();
  });
});

describe("chapters", () => {
  it.each([
    ["next chapter", { kind: "chapter", to: "next" }],
    ["previous chapter", { kind: "chapter", to: "prev" }],
    ["go to chapter 3", { kind: "chapter", to: "number", n: 3 }],
    ["chapter seven", { kind: "chapter", to: "number", n: 7 }],
    ["go to the chapter called pricing strategy", { kind: "chapter", to: "name", name: "pricing strategy" }],
    ["last chapter", { kind: "chapter", to: "last" }],
    ["start of the chapter", { kind: "chapter", to: "current" }],
  ])("%s", (s, cmd) => expect(p(s)).toEqual(cmd));
});

describe("screenshots", () => {
  it.each([
    ["take a screenshot", { kind: "screenshot", target: "page" }],
    ["screenshot this page", { kind: "screenshot", target: "page" }],
    ["take a picture of the page", { kind: "screenshot", target: "page" }],
    ["screenshot the image", { kind: "screenshot", target: "image", which: null }],
    ["take a screenshot of the chart", { kind: "screenshot", target: "image", which: null }],
    ["save the second picture", { kind: "screenshot", target: "image", which: 2 }],
    ["screenshot the last image", { kind: "screenshot", target: "image", which: "last" }],
    ["screenshot all the images", { kind: "screenshot", target: "image", which: "all" }],
    ["grab image number three", { kind: "screenshot", target: "image", which: 3 }],
  ])("%s", (s, cmd) => expect(p(s)).toEqual(cmd));
});

describe("saving text", () => {
  it.each([
    ["save the paragraph that says markets reward patience", { kind: "save", unit: "paragraph", says: "markets reward patience", asCard: false }],
    ["highlight the sentence about loss aversion", { kind: "save", unit: "sentence", says: "loss aversion", asCard: false }],
    ["highlight the second paragraph", { kind: "save", unit: "paragraph", which: 2, asCard: false }],
    ["save the last sentence", { kind: "save", unit: "sentence", which: "last", asCard: false }],
    ["save paragraph three", { kind: "save", unit: "paragraph", which: 3, asCard: false }],
    ["save this page", { kind: "save", unit: "page", asCard: false }],
    ["highlight from the first rule to the customer", { kind: "save", unit: "phrase", from: "the first rule", to: "the customer", asCard: false }],
    ["highlight where it says price anchors", { kind: "save", unit: "phrase", says: "price anchors", asCard: false }],
    ["save the first paragraph as a card", { kind: "save", unit: "paragraph", which: 1, asCard: true }],
    ["save the sentence that says hello world to my neuron", { kind: "save", unit: "sentence", says: "hello world", asCard: true }],
  ])("%s", (s, cmd) => expect(p(s)).toEqual(cmd));
});

describe("generic controls", () => {
  it.each([
    ["click focus", { kind: "click", label: "focus" }],
    ["press the chapter isolation button", { kind: "click", label: "chapter isolation" }],
    ["tap start reading", { kind: "click", label: "start reading" }],
    ["scroll down", { kind: "scroll", dir: "down" }],
    ["scroll to the top", { kind: "scroll", dir: "top" }],
    ["zoom in", { kind: "zoom", to: "in" }],
    ["fit to width", { kind: "zoom", to: "fit" }],
    ["focus mode", { kind: "focus", on: true }],
    ["exit full screen", { kind: "focus", on: false }],
    ["press enter", { kind: "key", key: "Enter" }],
    ["close this", { kind: "key", key: "Escape" }],
    ["open the book called thinking fast and slow", { kind: "openBook", title: "thinking fast and slow" }],
    ["what page am I on", { kind: "where" }],
    ["what can I say", { kind: "help" }],
  ])("%s", (s, cmd) => expect(p(s)).toEqual(cmd));

  it("type keeps the user's words", () => {
    expect(p("Bookworm, type Hello World")).toEqual({ kind: "type", text: "Hello World" });
  });

  it("chains commands", () => {
    expect(p("go to the read tab and go to page five")).toEqual({
      kind: "multi",
      commands: [{ kind: "tab", tab: "viewer" }, { kind: "page", to: "number", n: 5 }],
    });
  });

  it("ordinary conversation is not a command", () => {
    for (const s of [
      "what do you think about chapter three's argument",
      "tell me a story about a bookworm",
      "how should I price my product",
      "I read that last night and loved it",
    ]) expect(p(s)).toBeNull();
  });
});

describe("helpers", () => {
  it("numbers", () => {
    expect(parseNumber("twenty one")).toBe(21);
    expect(parseNumber("a hundred")).toBe(100);
    expect(parseNumber("two thousand and twelve")).toBe(2012);
    expect(parseNumber("banana")).toBeNull();
  });
  it("label scores rank exact names first", () => {
    expect(labelScore("next page", "Next page")).toBe(100);
    expect(labelScore("focus", "Focus mode")).toBeGreaterThan(labelScore("focus", "Exit focus mode"));
    expect(labelScore("chapter isolation", "Zoom in")).toBe(0);
  });
});

function fakePage(paragraphs: string[]): PageText {
  let text = "";
  const paras: [number, number][] = [];
  for (const para of paragraphs) {
    if (text) text += " ";
    paras.push([text.length, text.length + para.length]);
    text += para;
  }
  const sentences: [number, number][] = [];
  for (const [s, e] of paras) {
    const re = /[^.!?]+[.!?]/g;
    const chunk = text.slice(s, e);
    for (let m = re.exec(chunk); m; m = re.exec(chunk)) {
      const lead = m[0].length - m[0].trimStart().length;
      sentences.push([s + m.index + lead, s + m.index + m[0].length]);
    }
  }
  return { doc: document, text, nodes: [], paragraphs: paras, sentences };
}

describe("finding passages", () => {
  const page = fakePage([
    "Pricing is the most powerful lever in marketing. A 1% price change moves profit more than volume does.",
    "Customers anchor on the first number they see. That is why menus list an expensive dish at the top.",
  ]);

  it("matches speech despite number words and small misses", () => {
    const hit = findPhrase(page, "a one percent price change moves profit");
    expect(hit).not.toBeNull();
    expect(page.text.slice(hit![0], hit![1])).toContain("price change moves profit");
  });

  it("expands to the sentence or paragraph", () => {
    const s = resolvePassage(page, { unit: "sentence", says: "anchor on the first number" });
    expect("range" in s && page.text.slice(...s.range)).toBe("Customers anchor on the first number they see.");
    const para = resolvePassage(page, { unit: "paragraph", says: "expensive dish" });
    expect("range" in para && page.text.slice(...para.range)).toMatch(/^Customers anchor.*at the top\.$/);
  });

  it("picks by position", () => {
    const r = resolvePassage(page, { unit: "paragraph", which: 2 });
    expect("range" in r && page.text.slice(...r.range)).toMatch(/^Customers/);
    const last = resolvePassage(page, { unit: "sentence", which: "last" });
    expect("range" in last && page.text.slice(...last.range)).toMatch(/^That is why/);
    expect(resolvePassage(page, { unit: "paragraph", which: 5 })).toEqual({ error: "This page only has 2 paragraphs." });
  });

  it("from … to …", () => {
    const r = resolvePassage(page, { unit: "phrase", from: "customers anchor", to: "they see" });
    expect("range" in r && page.text.slice(...r.range)).toBe("Customers anchor on the first number they see");
  });

  it("says so when it isn't there", () => {
    expect(resolvePassage(page, { unit: "sentence", says: "quantum chromodynamics" })).toHaveProperty("error");
  });
});
