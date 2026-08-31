import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Card locators — the dual-mode client under Stage 2's laws
 * (docs/stage2-card-pointers.md): quote-keyed anchoring via the ONE shared
 * predicate, fail-closed resolution, first-read-is-the-probe schema cache,
 * and the merge/register helpers the executors lean on.
 */

// Controllable supabase fake: each test sets the next responses.
const dbState: {
  selectResult: { data: any; error: any };
  updateResult: { error: any };
  rpcResult: { data: any; error: any };
  updates: Array<{ table: string; payload: any }>;
  rpcCalls: Array<{ fn: string; args: any }>;
} = {
  selectResult: { data: null, error: null },
  updateResult: { error: null },
  rpcResult: { data: null, error: null },
  updates: [],
  rpcCalls: [],
};

vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const b: any = {
      _table: table,
      select: () => b,
      update: (payload: any) => {
        dbState.updates.push({ table, payload });
        return b;
      },
      eq: () => b,
      in: () => b,
      is: () => b,
      ilike: () => b,
      overlaps: () => b,
      limit: () => Promise.resolve(dbState.selectResult),
      maybeSingle: () => Promise.resolve(dbState.selectResult),
      then: (res: any, rej: any) => Promise.resolve(dbState.updateResult).then(res, rej),
    };
    return b;
  };
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: (fn: string, args: any) => {
        dbState.rpcCalls.push({ fn, args });
        return Promise.resolve(dbState.rpcResult);
      },
    },
  };
});

const {
  parseLocators, resolveLocatorInput, verifyStoredLocator, mergeLocators,
  normalizeAliases, registerKey, locatorKey,
  isCardSchemaMissing, cardSchemaKnownMissing, noteCardSchema, resetCardLocatorAvailability,
  writeCardFields, mergeLocatorsViaRpc, bumpVibrancy, cardSchemaKnownPresent,
  MAX_LOCATORS_PER_CARD, SPAN_MAX,
} = await import("@/lib/cardLocators");

beforeEach(() => {
  resetCardLocatorAvailability();
  dbState.selectResult = { data: null, error: null };
  dbState.updateResult = { error: null };
  dbState.rpcResult = { data: null, error: null };
  dbState.updates = [];
  dbState.rpcCalls = [];
});

const CHAPTER_TEXT =
  "It was the best of times, it was the worst\nof times. Most modem occultists agree on this. " +
  "The law of\nsines states that ratios hold across every triangle.";

const ctx = (text = CHAPTER_TEXT) => ({
  chapter: { id: "ch-1", startPage: 10, endPage: 19 },
  chapterName: "Opening",
  bookId: "book-1",
  bookTitle: "A Tale",
  text,
});

describe("resolveLocatorInput — quote-keyed, fail-closed", () => {
  it("anchors a quote (no offsets) and denormalizes provenance", () => {
    const r = resolveLocatorInput({ chapter_id: "ch-1", quote: "the worst of times" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.locator!.char_start).toBe(CHAPTER_TEXT.indexOf("the worst"));
    expect(CHAPTER_TEXT.slice(r.locator!.char_start, r.locator!.char_end)).toBe("the worst\nof times");
    expect(r.locator!.book_id).toBe("book-1");
    expect(r.locator!.book_title).toBe("A Tale");
    expect(r.locator!.chapter_name).toBe("Opening");
    expect(r.locator!.page).toBeGreaterThanOrEqual(10);
    expect(r.locator!.page).toBeLessThanOrEqual(19);
  });
  it("respects OCR reality — the misspelling anchors, the correction does not", () => {
    expect(resolveLocatorInput({ chapter_id: "ch-1", quote: "modem occultists agree" }, ctx()).ok).toBe(true);
    const r = resolveLocatorInput({ chapter_id: "ch-1", quote: "modern occultists agree" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("quote not found");
  });
  it("verifies caller offsets and rejects a quote outside its span", () => {
    const start = CHAPTER_TEXT.indexOf("Most modem");
    const ok = resolveLocatorInput(
      { chapter_id: "ch-1", quote: "modem occultists", char_start: start, char_end: start + 40 },
      ctx(),
    );
    expect(ok.ok).toBe(true);
    const bad = resolveLocatorInput(
      { chapter_id: "ch-1", quote: "law of sines", char_start: start, char_end: start + 40 },
      ctx(),
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("does not occur inside the given span");
  });
  it("caps spans and requires a real quote", () => {
    const big = resolveLocatorInput(
      { chapter_id: "ch-1", quote: "the worst of times", char_start: 0, char_end: SPAN_MAX + 1 },
      ctx("x".repeat(SPAN_MAX + 100)),
    );
    expect(big.ok).toBe(false);
    expect(big.error).toContain("span too large");
    expect(resolveLocatorInput({ chapter_id: "ch-1", quote: "short" }, ctx()).ok).toBe(false);
  });
  it("counts anchor ambiguity honestly", () => {
    const r = resolveLocatorInput({ chapter_id: "ch-1", quote: "it was the" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.occurrences).toBeGreaterThan(1);
  });
});

describe("verifyStoredLocator — read-time re-verification", () => {
  const loc = () => {
    const r = resolveLocatorInput({ chapter_id: "ch-1", quote: "the worst of times" }, ctx());
    return r.locator!;
  };
  it("verifies against the live text", () => {
    expect(verifyStoredLocator(loc(), CHAPTER_TEXT)).toEqual({ inBounds: true, verified: true });
  });
  it("fails honestly when the text at the span changed", () => {
    const l = { ...loc(), char_start: 0, char_end: 10 };
    const v = verifyStoredLocator(l, CHAPTER_TEXT);
    expect(v.inBounds).toBe(true);
    expect(v.verified).toBe(false);
  });
  it("reports out-of-bounds offsets", () => {
    const l = { ...loc(), char_start: 99999, char_end: 100010 };
    expect(verifyStoredLocator(l, CHAPTER_TEXT).inBounds).toBe(false);
  });
});

describe("parseLocators — defensive by design", () => {
  it("drops junk, keeps well-formed, caps at the per-card max", () => {
    const good = { chapter_id: "c", char_start: 0, char_end: 5, quote: "abcdefgh", page: 3 };
    const parsed = parseLocators([
      good,
      null,
      "nope",
      { chapter_id: "", char_start: 0, char_end: 5, quote: "x" },
      { chapter_id: "c", char_start: 9, char_end: 4, quote: "backwards" },
      ...Array.from({ length: 12 }, (_, i) => ({ ...good, char_start: i * 10, char_end: i * 10 + 5 })),
    ]);
    expect(parsed.length).toBe(MAX_LOCATORS_PER_CARD);
    expect(parsed[0]).toMatchObject({ chapter_id: "c", char_start: 0, char_end: 5 });
  });
  it("round-trips denormalized fields and clips hostile lengths", () => {
    const parsed = parseLocators([{
      chapter_id: "c", char_start: 0, char_end: 5, quote: "abcdefgh",
      book_title: "T".repeat(300), chapter_name: "N", stance: "supports-very-long-stance-text-here",
    }]);
    expect(parsed[0].book_title!.length).toBeLessThanOrEqual(80);
    expect(parsed[0].stance!.length).toBeLessThanOrEqual(24);
  });
  it("returns [] for non-arrays", () => {
    expect(parseLocators(null)).toEqual([]);
    expect(parseLocators({ chapter_id: "c" })).toEqual([]);
  });
});

describe("mergeLocators — dedupe key and cap", () => {
  const l = (start: number, stance?: string) => ({
    chapter_id: "c", char_start: start, char_end: start + 5, page: 1, quote: "abcdefgh", ...(stance ? { stance } : {}),
  });
  it("same span with a different stance keeps the FIRST (deterministic)", () => {
    const { merged, duplicates } = mergeLocators([l(0, "supports")], [l(0, "contradicts")]);
    expect(merged.length).toBe(1);
    expect(merged[0].stance).toBe("supports");
    expect(duplicates).toBe(1);
  });
  it("caps at 8 and counts overflow", () => {
    const existing = Array.from({ length: 7 }, (_, i) => l(i * 10));
    const { merged, added, overflow } = mergeLocators(existing, [l(100), l(110)]);
    expect(merged.length).toBe(8);
    expect(added).toBe(1);
    expect(overflow).toBe(1);
  });
  it("locatorKey ignores stance and display fields", () => {
    expect(locatorKey(l(0, "supports"))).toBe(locatorKey(l(0)));
  });
});

describe("register normalization", () => {
  it("registerKey and normalizeAliases share the same normal form", () => {
    expect(registerKey("  Desirable   Difficulty ")).toBe("desirable difficulty");
    expect(normalizeAliases(["  Desirable   Difficulty ", "DD", "dd", 42, "x"])).toEqual(["desirable difficulty", "dd"]);
  });
  it("caps aliases at 6", () => {
    expect(normalizeAliases(Array.from({ length: 10 }, (_, i) => `alias-${i}`)).length).toBe(6);
  });
});

describe("schema availability — first-read-is-the-probe", () => {
  it("only missing-schema codes cache the mode; transient errors stay re-probeable", () => {
    expect(cardSchemaKnownMissing()).toBe(false);
    noteCardSchema("missing");
    expect(cardSchemaKnownMissing()).toBe(true);
    noteCardSchema("present");
    expect(cardSchemaKnownMissing()).toBe(false);
  });
  it("classifies the real codes", () => {
    expect(isCardSchemaMissing({ code: "42703" })).toBe(true);
    expect(isCardSchemaMissing({ code: "PGRST204" })).toBe(true);
    expect(isCardSchemaMissing({ code: "PGRST202" })).toBe(true);
    expect(isCardSchemaMissing({ code: "42883" })).toBe(true);
    expect(isCardSchemaMissing({ message: "column knowledge_entries.locators does not exist" })).toBe(true);
    expect(isCardSchemaMissing({ code: "500", message: "network down" })).toBe(false);
  });
});

describe("writeCardFields — dual-mode attach", () => {
  const loc = { chapter_id: "c", char_start: 0, char_end: 8, page: 1, quote: "abcdefgh" };
  it("writes and notes the schema present", async () => {
    const r = await writeCardFields("e1", { locators: [loc], author: "assistant" });
    expect(r.written).toBe(true);
    expect(dbState.updates[0].payload.locators).toEqual([loc]);
    expect(dbState.updates[0].payload.author).toBe("assistant");
    expect(cardSchemaKnownMissing()).toBe(false);
  });
  it("caches missing on the schema signature and short-circuits after", async () => {
    dbState.updateResult = { error: { code: "PGRST204", message: "Could not find the 'locators' column" } };
    const r = await writeCardFields("e1", { locators: [loc] });
    expect(r.written).toBe(false);
    expect(r.missingSchema).toBe(true);
    dbState.updates = [];
    const r2 = await writeCardFields("e1", { locators: [loc] });
    expect(r2.missingSchema).toBe(true);
    expect(dbState.updates.length).toBe(0); // no query once known missing
  });
  it("treats a missing-code AFTER schema was seen present as retriable lag, not a mode flip", async () => {
    noteCardSchema("present");
    dbState.updateResult = { error: { code: "PGRST204", message: "Could not find the 'locators' column" } };
    const r = await writeCardFields("e1", { locators: [loc] });
    expect(r.written).toBe(false);
    expect(r.missingSchema).toBe(false);
    expect(r.error).toContain("retry");
    expect(cardSchemaKnownMissing()).toBe(false);
  });
});

describe("mergeLocatorsViaRpc — atomic server-side merge", () => {
  const loc = { chapter_id: "c", char_start: 0, char_end: 8, page: 1, quote: "abcdefgh" };
  it("calls the RPC and parses the merged result", async () => {
    dbState.rpcResult = { data: [loc, { ...loc, char_start: 10, char_end: 18 }], error: null };
    const r = await mergeLocatorsViaRpc("e1", [loc]);
    expect(r.ok).toBe(true);
    expect(r.locators!.length).toBe(2);
    expect(dbState.rpcCalls[0].fn).toBe("entry_locators_merge");
  });
  it("classifies a missing RPC as missing schema", async () => {
    dbState.rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function entry_locators_merge" } };
    const r = await mergeLocatorsViaRpc("e1", [loc]);
    expect(r.ok).toBe(false);
    expect(r.missingSchema).toBe(true);
    expect(cardSchemaKnownMissing()).toBe(true);
  });
});

describe("bumpVibrancy — isolated, best-effort", () => {
  it("bumps a numeric vibrancy and never exceeds 1", async () => {
    dbState.selectResult = { data: { vibrancy: 0.5 }, error: null };
    await bumpVibrancy("e1");
    expect(dbState.updates[0].payload.vibrancy).toBeCloseTo(0.54, 5);
    dbState.updates = [];
    dbState.selectResult = { data: { vibrancy: 0.99 }, error: null };
    await bumpVibrancy("e1");
    expect(dbState.updates[0].payload.vibrancy).toBe(1);
  });
  it("leaves null vibrancy alone and swallows every error", async () => {
    dbState.selectResult = { data: { vibrancy: null }, error: null };
    await bumpVibrancy("e1");
    expect(dbState.updates.length).toBe(0);
    dbState.selectResult = { data: null, error: { code: "42703", message: "no vibrancy column" } };
    await expect(bumpVibrancy("e1")).resolves.toBeUndefined();
  });
});

describe("review fixes: containment, honest merge counts, and the ilike probe", () => {
  it("clips chapter_id like every other stored field — it reaches the prompt too", () => {
    const parsed = parseLocators([{
      chapter_id: "c".repeat(500),
      char_start: 0, char_end: 5, quote: "abcdefgh",
    }]);
    expect(parsed[0].chapter_id.length).toBeLessThanOrEqual(64);
  });

  it("reports what LANDED, not what was supplied", async () => {
    const a = { chapter_id: "c", char_start: 0, char_end: 8, page: 1, quote: "abcdefgh" };
    const b = { chapter_id: "c", char_start: 10, char_end: 18, page: 1, quote: "ijklmnop" };
    // The card already holds `a`; the caller supplies both.
    dbState.rpcResult = { data: [a, b], error: null };
    const r = await mergeLocatorsViaRpc("e1", [a, b], [a]);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(r.capped).toBe(0);
  });

  it("counts a cap refusal instead of calling it added", async () => {
    const held = Array.from({ length: 8 }, (_, i) => ({ chapter_id: "c", char_start: i * 10, char_end: i * 10 + 8, page: 1, quote: "abcdefgh" }));
    const extra = { chapter_id: "c", char_start: 900, char_end: 908, page: 1, quote: "zzzzzzzz" };
    dbState.rpcResult = { data: held, error: null }; // server refused the 9th
    const r = await mergeLocatorsViaRpc("e1", [extra], held);
    expect(r.added).toBe(0);
    expect(r.capped).toBe(1);
  });

  it("without a known-before set, no count is claimed at all", async () => {
    const a = { chapter_id: "c", char_start: 0, char_end: 8, page: 1, quote: "abcdefgh" };
    dbState.rpcResult = { data: [a], error: null };
    const r = await mergeLocatorsViaRpc("e1", [a]);
    expect(r.ok).toBe(true);
    expect(r.added).toBeUndefined();
  });

  it("cardSchemaKnownPresent is FALSE until a real read answers — unknown is not present", () => {
    resetCardLocatorAvailability();
    expect(cardSchemaKnownPresent()).toBe(false);
    expect(cardSchemaKnownMissing()).toBe(false); // unknown is neither
    noteCardSchema("present");
    expect(cardSchemaKnownPresent()).toBe(true);
  });
});
