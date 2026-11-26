import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPaperHtml, chaptersForPages, deskText, isUnfinishedPaper, joinAcrossPages, missingRuns, needsLook, pageDoubts, POOR_SCAN_MARK,
  paperFraction, paperMeta, paperProgressLabel, parsePaperHtml, placePages, planChapterSync, speechFor,
  splitTrailingFragment, type PaperPage,
} from "@/lib/paperBook";
import { judgePhoto, laplacianVariance, orderPhotos } from "@/lib/pagePhoto";
import { parseTranscription, partialBody, pickPageModel, quickReadBody, TRANSCRIBE_SYSTEM } from "@/lib/pageTranscribe";
import { metaFor } from "@/lib/paperStore";
import { buildBookContextBlock } from "@/lib/chatBooks";
import type { BookDocument } from "@/types/library";

let seq = 0;
/** Ordinary prose, different for every n: a page nobody would flag. */
const prose = (n: number) => `Some words here for page number ${n}, and then enough more of them that nobody would call this page nearly empty or badly scanned.`;
const page = (printed: string | null, text?: string, extra: Partial<PaperPage> = {}): PaperPage => {
  const n = ++seq;
  return {
    id: `p${n}`, printed, heading: null, text: text ?? prose(n), footnotes: [], figures: [], startsMid: false, endsMid: false,
    unclear: 0, flag: null, checked: false, at: n, ...extra,
  };
};

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
    expect(Object.keys(page("1")).sort()).toEqual(["at", "checked", "endsMid", "figures", "flag", "footnotes", "heading", "id", "printed", "startsMid", "text", "unclear"]);
  });
});

describe("chapters", () => {
  it("is one row per page, with the page's own id", () => {
    const pages = [page("1"), page("2", prose(902), { heading: "Two" }), page(null)];
    const ch = chaptersForPages(pages);
    expect(ch.map((c) => [c.id, c.name, c.startPage, c.endPage])).toEqual([
      [pages[0].id, "p. 1", 1, 1], [pages[1].id, "p. 2 · Two", 2, 2], [pages[2].id, "Scan 3", 3, 3],
    ]);
    expect(ch[1].textContent.startsWith("[p. 2]\n\nTwo")).toBe(true);
  });
  it("gives Chat the figures and footnotes speech leaves out", () => {
    const p = page("9", prose(904), { figures: ["A map."], footnotes: ["See ch. 2."] });
    const text = chaptersForPages([p])[0].textContent;
    expect(text).toContain("[Figure: A map.]");
    expect(text).toContain("[Footnote: See ch. 2.]");
    expect(speechFor(p, { nextReady: true }).text).toBe(prose(904));
  });
  it("adds a page with one insert and touches nothing else", () => {
    const pages = [page("1"), page("2")];
    const plan = planChapterSync(chaptersForPages(pages), chaptersForPages([...pages, page("3")]));
    expect(plan.insert.map((c) => c.name)).toEqual(["p. 3"]);
    expect(plan.move).toEqual([]);
    expect(plan.remove).toEqual([]);
  });
  it("replaces a retaken page's row and never plans a text update", () => {
    const a = page("1"), b = page("2"), again = page("1", prose(903));
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

describe("reading a page as it arrives", () => {
  const full = JSON.stringify({ kind: "page", book_title: null, pages: [{ page_number: "9", chapter_title: null, body: 'He said "no".\n\nThen — caf\u00e9, twice.', footnotes: [] }] });
  it("shows the words so far from a reply cut off anywhere, and never more than was sent", () => {
    const whole = 'He said "no".\n\nThen — café, twice.';
    let last = "";
    for (let cut = 0; cut <= full.length; cut++) {
      const got = partialBody(full.slice(0, cut));
      expect(whole.startsWith(got)).toBe(true);
      expect(got.length).toBeGreaterThanOrEqual(last.length);
      last = got;
    }
    expect(last).toBe(whole);
  });
  it("copes with escapes split across chunks and with no body yet", () => {
    expect(partialBody('{"kind":"page","pages":[{"page_number":"4"')).toBe("");
    expect(partialBody('{"pages":[{"body":"a\\')).toBe("a");
    expect(partialBody('{"pages":[{"body":"a\\u00e')).toBe("a");
    expect(partialBody('{"pages":[{"body":"a\\u00e9b')).toBe("aéb");
  });
  it("asks each provider not to think first, in the form that provider accepts", () => {
    expect(quickReadBody("gemini", "gemini-2.5-flash")).toEqual({ reasoning_effort: "none" });
    // Gemini 3 cannot switch thinking off: the lowest level, not a refusal.
    expect(quickReadBody("gemini", "gemini-3-flash-preview")).toEqual({ reasoning_effort: "minimal" });
    expect(quickReadBody("openrouter", "google/gemini-3-flash-preview")).toEqual({ reasoning: { effort: "minimal" } });
    expect(quickReadBody("openrouter", "google/gemini-2.5-flash")).toEqual({ reasoning: { effort: "none" } });
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

describe("pageDoubts", () => {
  const prose = "The lighthouse keeper had a rule about weather, which was that he never talked about it before breakfast. He would stand at the gallery rail with his tea and look at the sea as if it owed him money, and say nothing at all.";
  it("says nothing about an ordinary page", () => {
    expect(pageDoubts(page("41", prose))).toEqual([]);
    expect(pageDoubts(page("41", prose, { unclear: 1 }))).toEqual([]);
    // Numbers, names, short words, dialogue and a title-only page are all fine.
    expect(pageDoubts(page("7", "In 1947, Dr. J. R. Okafor paid $3.50 for 12 lbs. of No. 9 wire at 221B Baker St. “Oh,” I said. “Is it so?” He did not answer me at all."))).toEqual([]);
    expect(pageDoubts(page(null, "", { heading: "Part Two" }))).toEqual([]);
    expect(pageDoubts(page(null, "", { figures: ["A map of the island."] }))).toEqual([]);
  });
  it("is not fooled by other languages and scripts", () => {
    expect(pageDoubts(page("3", "Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему. Всё смешалось в доме Облонских."))).toEqual([]);
    expect(pageDoubts(page("3", "Longtemps, je me suis couché de bonne heure. Parfois, à peine ma bougie éteinte, mes yeux se fermaient si vite que je n’avais pas le temps de me dire : « Je m’endors. »"))).toEqual([]);
    expect(pageDoubts(page("3", "話說天下大勢分久必合合久必分周末七國分爭併入於秦及秦滅之後楚漢分爭又併入於漢漢朝自高祖斬白蛇而起義一統天下後來光武中興傳至獻帝遂分為三國"))).toEqual([]);
  });
  it("spots text that is not words", () => {
    const rubbish = "Th qck brwn fx jmps vr th lzy dg. xq zzt krp wqx bnm tr pl kj hg fd szx cvb nmq wrt ypl kjh gfd szx cvb nm qw rt.";
    expect(pageDoubts(page(null, rubbish))).toContain("The text does not read like sentences.");
    // A page of marks and stray characters is flagged too (as nearly empty).
    expect(pageDoubts(page(null, "|| ~~ ## 4 __ ^^ :: ;; %% && ** ++ == << >> ?? !! @@ $$ 1 2 3 x")).length).toBeGreaterThan(0);
  });
  it("spots letters spaced out, a loop, a near-empty page and too many gaps", () => {
    expect(pageDoubts(page(null, "T h e k e e p e r h a d a r u l e a b o u t w e a t h e r t h a t h e n e v e r t a l k e d"))).toContain("The words came out broken into single letters.");
    expect(pageDoubts(page(null, Array(40).fill("the rule the lamp").join(" ")))).toContain("The same words repeat over and over.");
    expect(pageDoubts(page("9", "Chapter"))).toEqual(["Very little text was found on it."]);
    expect(pageDoubts(page("9", prose, { unclear: 4 }))).toEqual(["4 spots could not be read."]);
  });
  it("passes on what the transcriber itself said", () => {
    expect(pageDoubts(page("9", prose, { flag: "poor" }))[0]).toBe("Most of this page could not be read from the photo.");
    expect(pageDoubts(page("9", prose, { flag: "partial" }))).toEqual(["Part of this page could not be read from the photo."]);
  });
  it("spots the same page scanned twice, by its words, not its spacing", () => {
    const a = page(null, prose), b = page(null, prose.replace(/ /g, "  ").toUpperCase()), c = page(null, prose + " And then some more.");
    expect(pageDoubts(b, [a, b, c])).toEqual(["It is the same as Scan 1."]);
    expect(pageDoubts(c, [a, b, c])).toEqual([]);
  });
  it("names the other copy from either side, and forgets it once that copy is gone", () => {
    const a = page(null, prose), b = page(null, prose);
    expect(pageDoubts(a, [a, b])).toEqual(["It is the same as Scan 2."]);
    expect(pageDoubts(b, [a, b])).toEqual(["It is the same as Scan 1."]);
    // A new list (the twin deleted) is judged afresh, not from the old answer.
    expect(pageDoubts(a, [a])).toEqual([]);
    // The same page under a new object (marked, retitled) is not its own twin.
    expect(pageDoubts({ ...a }, [{ ...a }, page(null, "Something else entirely.")])).toEqual([]);
  });
  it("stays quick in a long book: the work per page does not grow with the book", () => {
    const words = prose.split(" ");
    const long = Array.from({ length: 400 }, (_, i) =>
      page(String(i + 1), Array.from({ length: 300 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ") + ` Leaf ${i}.`));
    const t = performance.now();
    for (const p of long) pageDoubts(p, long);
    chaptersForPages(long);
    // Comparing every page with every other took seconds here; this is a few ms.
    expect(performance.now() - t).toBeLessThan(400);
  });
  it("goes quiet once the reader says the page is fine, and survives the file", () => {
    const p = page("9", prose, { flag: "poor", checked: true });
    expect(needsLook(p)).toBe(false);
    expect(needsLook({ ...p, checked: false })).toBe(true);
    expect(parsePaperHtml(buildPaperHtml("T", [p]))[0]).toMatchObject({ flag: "poor", checked: true });
  });
  it("reads the transcriber's legibility into the page", () => {
    const t = parseTranscription(JSON.stringify({ kind: "page", pages: [{ body: prose, legibility: "poor" }] }));
    expect(t.pages[0]).toMatchObject({ flag: "poor", checked: false });
    expect(parseTranscription(JSON.stringify({ kind: "page", pages: [{ body: prose, legibility: "nonsense" }] })).pages[0].flag).toBeNull();
    expect(TRANSCRIBE_SYSTEM).toMatch(/legibility/);
  });
});

describe("what Chat is told about a paper book", () => {
  const good = "The keeper had a rule about weather, which was that he never talked about it before breakfast, and Mara learned it in her first week at the light.";
  const pages = [page("41", good), page("42", "xq zzt krp wqx bnm tr pl kj hg fd szx cvb nmq wrt ypl kjh gfd", { flag: "poor" }), page("43", good + " Then the wind came round.")];
  const book = (paper: boolean): BookDocument => ({
    id: "b1", title: "The Keeper's Rules", fileName: "paper-b1.html", fileData: "", pageCount: 3, addedAt: 0, folderIds: [],
    chapters: chaptersForPages(pages),
    sourceContext: paper ? { kind: "paper", status: "open", pages: 3 } : null,
  });
  it("names a poorly scanned page so, and only that page", () => {
    expect(chaptersForPages(pages).map((c) => c.name)).toEqual(["p. 41", `p. 42 ${POOR_SCAN_MARK}`, "p. 43"]);
    // Once the reader says it is fine, the mark goes (a rename, never a text change).
    const cleared = chaptersForPages(pages.map((p) => ({ ...p, checked: true })));
    expect(cleared[1].name).toBe("p. 42");
    expect(planChapterSync(chaptersForPages(pages), cleared).move).toEqual([{ id: pages[1].id, name: "p. 42", startPage: 2, endPage: 2 }]);
  });
  it("sends every page, and says they are one continuous text", () => {
    const block = buildBookContextBlock([book(true)], { mode: "full" })!.message!;
    expect(block).toContain("each \"chapter\" is ONE PAGE");
    expect(block).toContain("answer from ALL the pages so far");
    expect(block).toContain("3 chapters — full text");
    for (const label of ["[p. 41]", "[p. 42]", "[p. 43]"]) expect(block).toContain(label);
    expect(block).toContain("Then the wind came round.");
  });
  it("leaves every other book's context exactly as it was", () => {
    const block = buildBookContextBlock([book(false)], { mode: "full" })!.message!;
    expect(block).not.toContain("ONE PAGE");
    expect(block).not.toContain("paper book");
  });
});
