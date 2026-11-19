import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPaperHtml, chaptersForPages, deskText, isUnfinishedPaper, joinAcrossPages, missingRuns,
  paperFraction, paperMeta, paperProgressLabel, parsePaperHtml, placePages, planChapterSync, speechFor,
  splitTrailingFragment, type PaperPage,
} from "@/lib/paperBook";
import { judgePhoto, laplacianVariance, orderPhotos } from "@/lib/pagePhoto";
import { parseTranscription, pickPageModel, TRANSCRIBE_SYSTEM } from "@/lib/pageTranscribe";
import { metaFor } from "@/lib/paperStore";

let seq = 0;
const page = (printed: string | null, text = "Some words here.", extra: Partial<PaperPage> = {}): PaperPage => ({
  id: `p${++seq}`, printed, heading: null, text, footnotes: [], figures: [], startsMid: false, endsMid: false, unclear: 0, at: seq, ...extra,
});

describe("placePages", () => {
  it("appends in capture order by default", () => {
    const a = page("10"), b = page("11"), c = page(null);
    const out = placePages([a], [b, c]);
    expect(out.pages.map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(out.firstIndex).toBe(1);
    expect(out.replaced).toEqual([]);
  });
  it("treats the same printed number as a retake and replaces in place", () => {
    const a = page("10"), b = page("11"), again = page("10", "Sharper now.");
    const out = placePages([a, b], [again]);
    expect(out.pages.map((p) => p.id)).toEqual([again.id, b.id]);
    expect(out.replaced).toEqual([a.id]);
    expect(out.firstIndex).toBe(0);
  });
  it("files a page scanned out of order before the first later page", () => {
    const a = page("10"), c = page("12"), b = page("11");
    expect(placePages([a, c], [b]).pages.map((p) => p.printed)).toEqual(["10", "11", "12"]);
  });
  it("never moves anything for a page without an arabic number", () => {
    const a = page("10"), r = page("xii"), n = page(null);
    expect(placePages([a], [r, n]).pages.map((p) => p.id)).toEqual([a.id, r.id, n.id]);
  });
});

describe("missingRuns", () => {
  it("reports small holes between numbered neighbours only", () => {
    expect(missingRuns([page("40"), page("41"), page("44"), page(null), page("46")])).toEqual([[42, 43]]);
    expect(missingRuns([page("10"), page("90")])).toEqual([]);
  });
});

describe("the book file", () => {
  it("round-trips every field through HTML, escaping what needs it", () => {
    const pages = [
      page("41", "A <b>bold</b> claim & a “quote”.\n\nSecond paragraph.", { heading: "Chapter 4: Q&A", footnotes: ["Note <1>."], figures: ["A chart."], endsMid: true, unclear: 2 }),
      page(null, "Carried on.", { startsMid: true }),
    ];
    const html = buildPaperHtml('The "Title" <x>', pages);
    expect(html).toContain('id="section-1"');
    expect(html).toContain('id="section-2"');
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toMatch(/data:image|<img/);
    const back = parsePaperHtml(html);
    expect(back).toEqual(pages);
  });
  it("yields nothing, without throwing, for a file that is not a paper book", () => {
    expect(parsePaperHtml("<html><body><h2 id='section-1'>Hi</h2></body></html>")).toEqual([]);
    expect(parsePaperHtml("")).toEqual([]);
  });
  it("has no field that could hold a photo", () => {
    expect(Object.keys(page("1")).sort()).toEqual(["at", "endsMid", "figures", "footnotes", "heading", "id", "printed", "startsMid", "text", "unclear"]);
  });
});

describe("chapters", () => {
  it("is one row per page, with the page's own id", () => {
    const pages = [page("1"), page("2", "x", { heading: "Two" }), page(null)];
    const ch = chaptersForPages(pages);
    expect(ch.map((c) => [c.id, c.name, c.startPage, c.endPage])).toEqual([
      [pages[0].id, "p. 1", 1, 1], [pages[1].id, "p. 2 · Two", 2, 2], [pages[2].id, "Scan 3", 3, 3],
    ]);
    expect(ch[1].textContent.startsWith("[p. 2]\n\nTwo")).toBe(true);
  });
  it("gives Counsel the figures and footnotes speech leaves out", () => {
    const p = page("9", "Body.", { figures: ["A map."], footnotes: ["See ch. 2."] });
    const text = chaptersForPages([p])[0].textContent;
    expect(text).toContain("[Figure: A map.]");
    expect(text).toContain("[Footnote: See ch. 2.]");
    expect(speechFor(p, { nextReady: true }).text).toBe("Body.");
  });
  it("adds a page with one insert and touches nothing else", () => {
    const pages = [page("1"), page("2")];
    const plan = planChapterSync(chaptersForPages(pages), chaptersForPages([...pages, page("3")]));
    expect(plan.insert.map((c) => c.name)).toEqual(["p. 3"]);
    expect(plan.move).toEqual([]);
    expect(plan.remove).toEqual([]);
  });
  it("replaces a retaken page's row and never plans a text update", () => {
    const a = page("1"), b = page("2"), again = page("1", "Sharper.");
    const placed = placePages([a, b], [again]);
    const plan = planChapterSync(chaptersForPages([a, b]), chaptersForPages(placed.pages));
    expect(plan.remove).toEqual([a.id]);
    expect(plan.insert.map((c) => c.id)).toEqual([again.id]);
    expect(plan.move).toEqual([]);
    expect(Object.keys(plan)).toEqual(["insert", "move", "remove"]);
    for (const m of plan.move) expect(m).not.toHaveProperty("textContent");
  });
  it("only renumbers the rows after a page filed out of order", () => {
    const a = page("10"), c = page("12"), b = page("11");
    const plan = planChapterSync(chaptersForPages([a, c]), chaptersForPages(placePages([a, c], [b]).pages));
    expect(plan.insert.map((x) => x.id)).toEqual([b.id]);
    expect(plan.move).toEqual([{ id: c.id, name: "p. 12", startPage: 3, endPage: 3 }]);
  });
});

describe("speech across the page turn", () => {
  it("splits off an unfinished last sentence", () => {
    expect(splitTrailingFragment("One. Two and")).toEqual({ spoken: "One.", fragment: "Two and" });
    expect(splitTrailingFragment("All done.”")).toEqual({ spoken: "All done.”", fragment: "" });
    expect(splitTrailingFragment("no stop at all")).toEqual({ spoken: "", fragment: "no stop at all" });
  });
  it("closes up a hyphen-broken word and spaces anything else", () => {
    expect(joinAcrossPages("under-", "standing it")).toBe("understanding it");
    expect(joinAcrossPages("he had", "never")).toBe("he had never");
  });
  it("holds the fragment until the next page exists, then says the sentence whole, once", () => {
    const a = page("1", "First. He said that he had", { endsMid: true });
    const b = page("2", "never seen it. Next.", { startsMid: true });
    const alone = speechFor(a, { nextReady: false });
    expect(alone.text).toBe("First.");
    expect(alone.held).toBe("He said that he had");
    const next = speechFor(b, { carry: alone.held, nextReady: false });
    expect(next.text).toBe("He said that he had never seen it. Next.");
    // The highlight offset: what follows the lead is the page's own text.
    expect(next.text.slice(next.lead)).toBe(deskText(b));
    // With the next page already scanned nothing is held back.
    expect(speechFor(a, { nextReady: true })).toMatchObject({ text: "First. He said that he had", held: "" });
  });
  it("keeps offsets aligned when a hyphenated word spans the turn", () => {
    const b = page("2", "standing came later.");
    const sp = speechFor(b, { carry: "Under-", nextReady: true });
    expect(sp.text).toBe("Understanding came later.");
    expect(sp.text.slice(sp.lead)).toBe(deskText(b));
  });
  it("does not read [unclear] aloud, and keeps offsets", () => {
    const p = page("1", "A [unclear] word.");
    const sp = speechFor(p, { nextReady: true });
    expect(sp.text).not.toMatch(/unclear/);
    expect(sp.text.length).toBe(deskText(p).length);
  });
  it("reads a chapter title before the body", () => {
    expect(speechFor(page("1", "Body.", { heading: "The Start" }), { nextReady: true }).text).toBe("The Start\n\nBody.");
  });
});

describe("unfinished state", () => {
  it("is read from sourceContext and nowhere else", () => {
    expect(isUnfinishedPaper({ sourceContext: { kind: "paper", status: "open", pages: 2 } })).toBe(true);
    expect(isUnfinishedPaper({ sourceContext: { kind: "paper", status: "done", pages: 2 } })).toBe(false);
    expect(isUnfinishedPaper({ sourceContext: { kind: "youtube" } })).toBe(false);
    expect(paperMeta({ sourceContext: null })).toBeNull();
  });
  it("shows a count and the last page, and a fraction only when the length is known", () => {
    const pages = [page("56"), page("57")];
    const meta = metaFor(pages, null);
    expect(paperProgressLabel(meta)).toBe("2 pages · last p. 57");
    expect(paperFraction(meta)).toBeNull();
    expect(paperFraction(metaFor(pages, meta, { total_pages: 228 }))).toBeCloseTo(0.25);
    expect(metaFor(pages, { ...meta, status: "done" }).status).toBe("done");
  });
});

describe("parseTranscription", () => {
  const one = { page_number: "47", chapter_title: null, body: "Line one.\n\nLine two [unclear].", footnotes: ["n"], figures: [], starts_mid_sentence: true, ends_mid_sentence: false };
  it("reads a page", () => {
    const t = parseTranscription(JSON.stringify({ kind: "page", book_title: "T", author: null, problem: null, pages: [one] }));
    expect(t.kind).toBe("page");
    expect(t.bookTitle).toBe("T");
    expect(t.pages[0]).toMatchObject({ printed: "47", text: one.body, startsMid: true, endsMid: false, unclear: 1, footnotes: ["n"] });
  });
  it("accepts a fenced or chatty reply, and a spread", () => {
    const raw = "Here you go:\n```json\n" + JSON.stringify({ kind: "page", pages: [one, { ...one, page_number: "p. 48" }] }) + "\n```";
    const t = parseTranscription(raw);
    expect(t.kind).toBe("spread");
    expect(t.pages.map((p) => p.printed)).toEqual(["47", "48"]);
  });
  it("turns prose into a problem, never into a page", () => {
    const t = parseTranscription("I'm sorry, I can't read this image clearly, but it seems to be about ships.");
    expect(t.pages).toEqual([]);
    expect(t.problem).toBe("no_text");
  });
  it("keeps a cover's title and no pages", () => {
    const t = parseTranscription(JSON.stringify({ kind: "cover", book_title: "Dune", author: "Frank Herbert", pages: [] }));
    expect(t).toMatchObject({ kind: "cover", bookTitle: "Dune", author: "Frank Herbert", problem: null, pages: [] });
  });
  it("drops fields of the wrong type instead of guessing", () => {
    const t = parseTranscription(JSON.stringify({ kind: "nonsense", problem: 7, pages: [{ body: 12, page_number: 5 }, { body: "ok", footnotes: "x", starts_mid_sentence: "yes" }] }));
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0]).toMatchObject({ text: "ok", footnotes: [], startsMid: false });
  });
  it("asks for verbatim text with named exceptions", () => {
    expect(TRANSCRIBE_SYSTEM).toMatch(/verbatim, character for character/);
    expect(TRANSCRIBE_SYSTEM).toMatch(/\[unclear\]/);
    expect(TRANSCRIBE_SYSTEM).toMatch(/Never guess/);
  });
});

describe("pickPageModel", () => {
  it("prefers the reader's picture model, then Gemini, then OpenRouter", () => {
    expect(pickPageModel({ visionModel: "x/vision", keys: { apiKey: "k" } })).toBe("x/vision");
    expect(pickPageModel({ visionModel: "x/vision", keys: { geminiApiKey: "g" } })).toMatch(/^gemini:/);
    expect(pickPageModel({ keys: { apiKey: "k" } })).toBe("google/gemini-3-flash-preview");
    expect(pickPageModel({ keys: {} })).toBeNull();
  });
});

describe("photo checks", () => {
  const W = 64, H = 64;
  const text = () => { const g = new Uint8Array(W * H).fill(230); for (let y = 4; y < H; y += 6) for (let x = 2; x < W - 2; x++) if ((x >> 1) % 2) g[y * W + x] = 30; return g; };
  it("scores sharp text far above a flat frame", () => {
    expect(laplacianVariance(text(), W, H)).toBeGreaterThan(1000);
    expect(laplacianVariance(new Uint8Array(W * H).fill(200), W, H)).toBe(0);
  });
  it("names dark, glare and blur, and passes a good page", () => {
    expect(judgePhoto(text(), W, H).problem).toBeNull();
    expect(judgePhoto(new Uint8Array(W * H).fill(20), W, H).problem).toBe("dark");
    expect(judgePhoto(new Uint8Array(W * H).fill(255), W, H).problem).toBe("glare");
    expect(judgePhoto(new Uint8Array(W * H).fill(190), W, H).problem).toBe("blurry");
  });
});

describe("photos are never stored", () => {
  // A source-level guard, like chapterImmutability.test: the promise made to
  // the reader ("each photo is read once and thrown away") must not be broken
  // by a later edit that quietly starts keeping them.
  const src = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");
  it("the scanning engine has no way to persist anything", () => {
    const engine = src("hooks/usePaperScan.ts");
    const photo = src("lib/pagePhoto.ts");
    for (const file of [engine, photo]) {
      const code = file.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/supabase\.|localStorage|sessionStorage|indexedDB|caches\.open|fetch\(\s*["'`]http/);
    }
  });
  it("the save layer uploads the book's text and nothing else", () => {
    const store = src("lib/paperStore.ts");
    const uploads = store.match(/\.upload\(/g) || [];
    expect(uploads).toHaveLength(1);
    expect(store).toMatch(/\.upload\(filePath\(bookId\), blob, \{ contentType: "text\/html"/);
    expect(store).not.toMatch(/image\/(jpeg|png|webp)/);
  });
  it("every way a shot ends lets go of its photo", () => {
    const engine = src("hooks/usePaperScan.ts");
    // committed, cover made, unreadable, unreadable-by-error, discarded, unmounted
    expect((engine.match(/dispose\((shotId|id|job\.id)\)/g) || []).length).toBeGreaterThanOrEqual(6);
    expect(engine).toMatch(/held\.clear\(\)/);
    // Photos waiting in line are file handles, and those are let go too.
    expect(engine).toMatch(/files\.current\.clear\(\)/);
  });
});

describe("orderPhotos", () => {
  const f = (name: string, lastModified: number) => ({ name, lastModified });
  it("puts a scrambled pick back in the order the photos were taken", () => {
    const picked = [f("c.jpg", 3000), f("a.jpg", 1000), f("b.jpg", 2000)];
    expect(orderPhotos(picked).map((x) => x.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(picked[0].name).toBe("c.jpg"); // the caller's array is left alone
  });
  it("falls back to the name, counting numbers as numbers", () => {
    const picked = [f("IMG_10.jpg", 5), f("IMG_9.jpg", 5), f("IMG_100.jpg", 5)];
    expect(orderPhotos(picked).map((x) => x.name)).toEqual(["IMG_9.jpg", "IMG_10.jpg", "IMG_100.jpg"]);
  });
});
