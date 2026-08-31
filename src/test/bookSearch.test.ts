import { describe, it, expect } from "vitest";
import {
  foldGlyphs,
  normalizeSearchQuery,
  buildSearchPattern,
  prefilterToken,
  escapeIlike,
  searchChapterText,
  searchChaptersInMemory,
  excerptAround,
  approxPage,
  anchorQuote,
  MATCHES_PER_CHAPTER_FIRST_PASS,
  MATCHES_TOTAL,
} from "@/lib/bookSearch";

/**
 * The E2 quote gap, unit-sized: catalog mode lost exact-quote retrieval 6/11
 * vs 8/11 and every loss was "find one sentence deep in a big book". These
 * tests pin the machinery that closes it — the whitespace flexibility PDF
 * extraction makes load-bearing, the 1:1 glyph fold that keeps the finder as
 * forgiving as the E3 verifier, and the caps that stay honest.
 */

describe("foldGlyphs — 1:1 by construction", () => {
  it("folds curly quotes, dashes and odd spaces without changing length", () => {
    const s = "‘won’t’ — “quoted”  and more";
    const folded = foldGlyphs(s);
    expect(folded).toBe("'won't' - \"quoted\"  and more");
    expect(folded.length).toBe(s.length);
  });
  it("never touches ASCII alphanumerics", () => {
    const s = "Modem occultists 42";
    expect(foldGlyphs(s)).toBe(s);
  });
});

describe("normalizeSearchQuery", () => {
  it("collapses whitespace runs and trims", () => {
    expect(normalizeSearchQuery("  the   law\nof \t sines ")).toBe("the law of sines");
  });
  it("folds glyphs so the query side matches the text side", () => {
    expect(normalizeSearchQuery("won’t stop")).toBe("won't stop");
  });
  it("strips control chars without joining words", () => {
    expect(normalizeSearchQuery("law\x00of\x07sines")).toBe("law of sines");
  });
  it("rejects too-short and empty queries", () => {
    expect(normalizeSearchQuery("ab")).toBeNull();
    expect(normalizeSearchQuery("   ")).toBeNull();
    expect(normalizeSearchQuery(undefined)).toBeNull();
  });
  it("caps at the max length", () => {
    expect(normalizeSearchQuery("x".repeat(500))!.length).toBe(200);
  });
});

describe("the shared predicate — whitespace-flexible, glyph-folded, case-insensitive", () => {
  const match = (query: string, text: string): boolean => {
    const n = normalizeSearchQuery(query);
    if (!n) return false;
    return searchChapterText(text, buildSearchPattern(n)).matches.length > 0;
  };
  it("matches across a PDF hard line wrap", () => {
    expect(match("the law of sines", "…states that the law of\nsines applies…")).toBe(true);
  });
  it("matches across the page seam (double newline)", () => {
    expect(match("modem occultists agree", "most modem\n\noccultists   agree on this")).toBe(true);
  });
  it("matches straight-quote queries against curly-quote text (the E3-verifier parity law)", () => {
    expect(match("won't stop believing", "she won’t stop\nbelieving")).toBe(true);
  });
  it("matches hyphen queries against em-dash text and NBSP gaps", () => {
    expect(match('half - remembered', "a half — remembered dream")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(match("Desirable Difficulty", "…embrace desirable difficulty when…")).toBe(true);
  });
  it("does NOT smooth typos — a search that corrects the text mints fake anchors", () => {
    expect(match("modern occultists", "most modem occultists agree")).toBe(false);
  });
  it("does NOT cross hyphenated line breaks (v1, documented)", () => {
    expect(match("difficulties", "embrace diffi- culties daily")).toBe(false);
  });
  it("escapes regex metacharacters in the query", () => {
    expect(match("f(x) = x^2 + 1", "we define f(x) = x^2 + 1 for all x")).toBe(true);
    expect(match("f(x) = x^2 + 1", "we define fx  x2  1 nothing")).toBe(false);
  });
});

describe("prefilterToken — the provable-superset server prefilter", () => {
  it("picks the longest ASCII-alphanumeric run, lowercased", () => {
    expect(prefilterToken("the law of sines")).toBe("sines");
    expect(prefilterToken("Modem occultists agree")).toBe("occultists");
  });
  it("returns null when no usable token exists (degrade to fetch-all)", () => {
    expect(prefilterToken("… — •")).toBeNull();
    expect(prefilterToken("ab cd")).toBeNull();
  });
  it("escapes ilike wildcards (belt-and-braces)", () => {
    expect(escapeIlike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  // THE SUPERSET PROPERTY (review-HIGH): any text the JS predicate matches
  // must contain the prefilter token case-insensitively — over adversarial
  // whitespace, glyphs, and case. ilike '%token%' on the server is exactly
  // lowercase-containment for [a-z0-9] tokens, so this property IS the
  // guarantee that the prefilter can never drop a chapter the authority
  // would match.
  it("GENERATED property: JS-match(text) ⇒ lower(text) contains token, over 600 perturbed pairs", () => {
    // A real differential property, not a hand-authored table: every pair is
    // built by perturbing a seeded phrase along the axes that actually
    // diverge between the two engines — fold-affected glyphs, whitespace runs
    // and newlines, case, and regex metacharacters. Deterministic PRNG, so a
    // failure is reproducible from the seed.
    let seed = 0x2f6e2b1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = (xs: any[]) => xs[Math.floor(rnd() * xs.length) % xs.length];
    const WORDS = ["law", "sines", "modem", "occultists", "difficulty", "won't", "half-life", "f(x)", "x^2", "ratio", "wave"];
    const SPACES = [" ", "\n", "\n\n", "\t", "  ", " ", " "];
    const CURLY: Record<string, string[]> = {
      "'": ["'", "’", "ʼ"],
      '"': ['"', "“", "”"],
      "-": ["-", "‐", "–", "—"],
    };
    const twist = (s: string) => s.replace(/['"-]/g, (c) => pick(CURLY[c] || [c]));
    const flipCase = (s: string) =>
      [...s].map((c) => (rnd() < 0.3 ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c)).join("");

    let checked = 0;
    let hits = 0;
    for (let i = 0; i < 600; i++) {
      const n = 2 + Math.floor(rnd() * 3);
      const words = Array.from({ length: n }, () => pick(WORDS));
      const query = words.join(" ");
      const normalized = normalizeSearchQuery(query);
      if (!normalized) continue;
      const token = prefilterToken(normalized);
      // A no-token query degrades to reading every unloaded chapter, which is
      // a superset by construction — its contract is pinned separately below.
      if (!token) continue;
      const shouldMatch = rnd() < 0.6;
      const body = shouldMatch
        ? "prefix " + flipCase(twist(words.join(pick(SPACES)))) + " suffix"
        : "nothing relevant " + pick(WORDS) + " here at all";
      checked++;
      const js = buildSearchPattern(normalized);
      if (searchChapterText(body, js).matches.length > 0) {
        hits++;
        // THE GUARANTEE: the server prefilter (ilike '%token%' — plain
        // case-insensitive containment) can never exclude a chapter the JS
        // authority would match.
        expect(
          body.toLowerCase().includes(token),
          `pair ${i}: token "${token}" for query "${query}" missing from ${JSON.stringify(body)}`,
        ).toBe(true);
      }
    }
    // The property must not pass vacuously.
    expect(checked).toBeGreaterThan(300);
    expect(hits).toBeGreaterThan(50);
  });

  it("a no-token query is the documented fetch-everything degradation, not a silent miss", () => {
    // The class the old fixed table skipped with `continue`: queries whose
    // ASCII runs are all under 3 chars. The contract is that prefilterToken
    // returns null so the caller reads every unloaded chapter AND says it
    // could not narrow — never that the query quietly matches nothing.
    for (const q of ["。。 、、 ——", "a b c"]) {
      const n = normalizeSearchQuery(q);
      if (!n) continue;
      expect(prefilterToken(n)).toBeNull();
    }
  });
});

describe("searchChapterText", () => {
  const js = buildSearchPattern("the tide");
  it("finds occurrences with offsets valid in the RAW text", () => {
    const text = "First the tide rises. Later the tide falls.";
    const { matches } = searchChapterText(text, js);
    expect(matches.length).toBe(2);
    expect(text.slice(matches[1].start, matches[1].end)).toBe("the tide");
    // Fold is 1:1 — the NBSP match's raw slice is the original glyphs.
    expect(text.slice(matches[0].start, matches[0].end)).toBe("the tide");
  });
  it("bounds the tail count on pathological repetition", () => {
    const { more } = searchChapterText("the tide ".repeat(5000), js);
    expect(more).toBeLessThanOrEqual(201);
  });
  it("stays fast on a 384k-char chapter (the E2 book scale)", () => {
    const text = ("lorem ipsum dolor sit amet ".repeat(200) + "the tide turns here ").repeat(70);
    const t0 = performance.now();
    searchChapterText(text, buildSearchPattern("the tide turns"));
    expect(performance.now() - t0).toBeLessThan(300);
  });
});

describe("searchChaptersInMemory — spread caps, honest cuts", () => {
  it("pass 1 caps per chapter so early chapters cannot starve a deep target", () => {
    const noisy = { id: "early", textContent: "hit here. hit here. hit here. hit here. hit here. hit here." };
    const deep = { id: "deep", textContent: "the one hit here that matters" };
    const { js } = { js: buildSearchPattern("hit here") };
    const { results } = searchChaptersInMemory([noisy, deep], js);
    const byId = new Map(results.map((r) => [r.chapterId, r]));
    // The deep chapter's match survives even though the early chapter alone
    // could have filled the total cap.
    expect(byId.get("deep")!.matches.length).toBe(1);
    expect(byId.get("early")!.matches.length).toBeGreaterThanOrEqual(MATCHES_PER_CHAPTER_FIRST_PASS);
  });
  it("fills to the total cap in pass 2 and counts every cut", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      textContent: "found here. found here. found here.",
    }));
    const { total, moreTotal } = searchChaptersInMemory(many, buildSearchPattern("found here"));
    expect(total).toBe(MATCHES_TOTAL);
    expect(moreTotal).toBe(8 * 3 - MATCHES_TOTAL);
  });
  it("skips textless chapters silently — they are the caller's fetch problem", () => {
    const { results } = searchChaptersInMemory(
      [{ id: "a", textContent: "" }, { id: "b", textContent: "beta gamma" }],
      buildSearchPattern("beta gamma"),
    );
    expect(results.map((r) => r.chapterId)).toEqual(["b"]);
  });
});

describe("excerptAround — purity law", () => {
  it("serves a verbatim raw substring, clamped", () => {
    expect(excerptAround("abcdef", 0, 3)).toEqual({ excerpt: "abcdef", excerptStart: 0 });
  });
  it("every excerpt is a plain substring of the chapter (no decorations, ever)", () => {
    const text = "x".repeat(1000) + "NEEDLE with ‘curly’ glyphs" + "y".repeat(1000);
    const { excerpt, excerptStart } = excerptAround(text, 1000, 1006);
    expect(text.slice(excerptStart, excerptStart + excerpt.length)).toBe(excerpt);
    expect(excerpt).toContain("‘curly’"); // raw glyphs, never folded output
  });
});

describe("approxPage", () => {
  const ch = { startPage: 100, endPage: 109 };
  it("maps offset 0 to the first page and the tail to the last", () => {
    expect(approxPage(ch, 0, 10_000)).toBe(100);
    expect(approxPage(ch, 9_999, 10_000)).toBe(109);
  });
  it("never exceeds the chapter's page range", () => {
    expect(approxPage(ch, 20_000, 10_000)).toBe(109);
    expect(approxPage(ch, 0, 0)).toBe(100);
  });
});

describe("anchorQuote — the write-side locator resolver", () => {
  const text = "It was the best of times, it was the worst\nof times, it was the age of wisdom.";
  it("anchors a quote across a line wrap and returns exact raw offsets", () => {
    const hit = anchorQuote(text, "the worst of times");
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe("the worst\nof times");
    expect(hit!.occurrences).toBe(1);
  });
  it("anchors a curly-quoted selection against straight-quote text and back", () => {
    const t = "she said “no more” and left";
    const hit = anchorQuote(t, 'said "no more" and');
    expect(hit).not.toBeNull();
    expect(t.slice(hit!.start, hit!.end)).toBe("said “no more” and");
  });
  it("counts ambiguity instead of hiding it", () => {
    const hit = anchorQuote(text, "it was the");
    expect(hit!.occurrences).toBe(3);
    expect(hit!.start).toBe(0);
  });
  it("returns null for text it cannot find — never a fake anchor", () => {
    expect(anchorQuote(text, "the blurst of times")).toBeNull();
    expect(anchorQuote(text, "xy")).toBeNull();
    expect(anchorQuote("", "the worst")).toBeNull();
  });
});
