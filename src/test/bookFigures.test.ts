import { describe, it, expect } from "vitest";
import {
  labelFromPrompt, chapterIndexForPage, figuresInChapter, figureCountsByChapter, searchFigures,
  figuresNearPage, figureHandle, splitFigureMarkers, stripFigureMarkers, MAX_FIGURES_PER_REPLY,
  type BookFigure,
} from "@/lib/bookFigures";
import { clusterPathRects, pickVectorFigures } from "@/lib/figureExtraction";

const fig = (id: string, page: number, label: string, caption = ""): BookFigure => ({
  id, bookId: "b1", page, label, caption, storagePath: `u/figures/b1/${id}.jpg`,
});
const chapters = [
  { id: "c1", name: "Intro", startPage: 1, endPage: 10 },
  { id: "c2", name: "The Heart", startPage: 11, endPage: 30 },
];
const figures = [
  fig("aaaaaaaa-0000-4000-8000-000000000001", 4, "Map of the trade routes"),
  fig("bbbbbbbb-0000-4000-8000-000000000002", 12, "Cross-section of the heart", "Labelled diagram showing the four chambers and the mitral valve."),
  fig("cccccccc-0000-4000-8000-000000000003", 20, "Blood pressure chart", "Line chart of systolic pressure by age."),
  fig("dddddddd-0000-4000-8000-000000000004", 44, "Appendix photo"),
];

describe("book figures: provenance and chapter placement", () => {
  it("recovers the label from the stored provenance line", () => {
    expect(labelFromPrompt('Fig. p. 12 (The Heart) of "Anatomy" — Cross-section of the heart')).toBe("Cross-section of the heart");
    expect(labelFromPrompt("A hand-made row — with a dash")).toBe("A hand-made row — with a dash");
    expect(labelFromPrompt("")).toBe("Figure");
  });

  it("derives a figure's chapter from its page, so a re-detect cannot strand it", () => {
    expect(chapterIndexForPage(chapters, 12)).toBe(1);
    expect(chapterIndexForPage(chapters, 44)).toBe(-1);
    expect(figuresInChapter(figures, chapters, "c2").map((f) => f.page)).toEqual([12, 20]);
    const renumbered = [{ id: "new", name: "All", startPage: 1, endPage: 50 }];
    expect(figuresInChapter(figures, renumbered, "new")).toHaveLength(4);
    const counts = figureCountsByChapter(figures, chapters);
    expect(counts.get("c1")).toBe(1);
    expect(counts.get("c2")).toBe(2);
    expect(counts.size).toBe(2);
  });

  it("finds figures on a page", () => {
    expect(figuresNearPage(figures, 12, 0).map((f) => f.page)).toEqual([12]);
    expect(figuresNearPage(figures, 19, 1).map((f) => f.page)).toEqual([20]);
  });
});

describe("book figures: caption search", () => {
  it("matches a paraphrased request by keyword, label hits first", () => {
    const hits = searchFigures(figures, "show me the diagram of the heart valves");
    expect(hits[0].figure.page).toBe(12);
  });
  it("returns nothing for a query that is only filler", () => {
    expect(searchFigures(figures, "show me the picture")).toEqual([]);
  });
  it("requires at least half the query's words", () => {
    expect(searchFigures(figures, "heart kidney liver spleen")).toEqual([]);
  });
});

describe("book figures: reply markers", () => {
  const A = figures[0].id, B = figures[1].id;
  const h = figureHandle;
  it("splits prose and figures in place", () => {
    const segs = splitFigureMarkers(`The heart has four chambers.\n\n[[fig:${h(B)}]]\n\nBlood enters on the right.`);
    expect(segs.map((s) => s.kind)).toEqual(["text", "figure", "text"]);
    expect(segs[1]).toEqual({ kind: "figure", ref: h(B) });
  });
  it("tolerates spacing, case, 'figure' and a full id", () => {
    expect(splitFigureMarkers(`[[ Figure : ${h(B).toUpperCase()} ]]`)).toEqual([{ kind: "figure", ref: h(B) }]);
    expect(splitFigureMarkers(`[[fig:${B}]]`)).toEqual([{ kind: "figure", ref: B }]);
  });
  it("shows each figure once and never one already shown this turn", () => {
    const segs = splitFigureMarkers(`a [[fig:${h(A)}]] b [[fig:${h(A)}]] c [[fig:${B}]]`, { alreadyShown: new Set([B]) });
    expect(segs.filter((s) => s.kind === "figure")).toEqual([{ kind: "figure", ref: h(A) }]);
    expect(segs.some((s) => s.kind === "text" && s.text.includes("[["))).toBe(false);
  });
  it("caps figures per reply", () => {
    const many = Array.from({ length: 6 }, (_, i) => `[[fig:0000000${i}]]`).join(" text ");
    expect(splitFigureMarkers(many).filter((s) => s.kind === "figure")).toHaveLength(MAX_FIGURES_PER_REPLY);
  });
  it("hides a half-streamed marker", () => {
    const segs = splitFigureMarkers("See below.\n\n[[fig:3fa8", { streaming: true });
    expect(segs).toEqual([{ kind: "text", text: "See below.\n\n" }]);
    expect(splitFigureMarkers("A list [1] and a bracket [", { streaming: true })[0]).toEqual({ kind: "text", text: "A list [1] and a bracket [" });
  });
  it("leaves ordinary brackets and non-hex ids alone", () => {
    expect(splitFigureMarkers("[[fig:not-a-handle]] and [[wiki link]]")).toEqual([{ kind: "text", text: "[[fig:not-a-handle]] and [[wiki link]]" }]);
  });
  it("strips markers for speech and copy", () => {
    expect(stripFigureMarkers(`One.\n\n[[fig:${h(B)}]]\n\nTwo.`)).toBe("One.\n\nTwo.");
  });
});

describe("figure extraction: vector drawings", () => {
  const W = 1200, H = 1553, S = W / 612; // a letter page at the extractor's render scale
  const pt = (x0: number, y0: number, x1: number, y1: number) => ({ x0: x0 * S, y0: y0 * S, x1: x1 * S, y1: y1 * S });
  const bars = Array.from({ length: 14 }, (_, i) => pt(150 + i * 22, 300, 166 + i * 22, 300 + 40 + i * 8));

  it("clusters touching paths and keeps separate drawings separate", () => {
    const other = Array.from({ length: 14 }, (_, i) => pt(150 + i * 22, 600, 166 + i * 22, 700));
    const clusters = clusterPathRects([...bars, ...other], W, H, 6 * S);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.paths)).toEqual([14, 14]);
  });

  it("ignores a page-sized background so it cannot weld the page together", () => {
    const clusters = clusterPathRects([pt(0, 0, 612, 792), ...bars], W, H, 6 * S);
    expect(clusters).toHaveLength(1);
  });

  it("keeps a dense drawing, a captioned sparse one — and not rules or text boxes", () => {
    const body = [{ str: "Ordinary body text well away from the drawing.", x: 72 * S, y: 100 * S }];
    const dense = clusterPathRects(bars, W, H, 6 * S);
    expect(pickVectorFigures(dense, body, W, H, S)).toHaveLength(1);

    const rule = clusterPathRects([pt(72, 50, 540, 50.5)], W, H, 6 * S);
    expect(pickVectorFigures(rule, body, W, H, S)).toHaveLength(0);

    const sparse = [{ rect: pt(150, 300, 400, 450), paths: 4 }];
    expect(pickVectorFigures(sparse, body, W, H, S)).toHaveLength(0);
    const caption = [{ str: "Figure 2.3 The sales funnel", x: 150 * S, y: 465 * S }];
    expect(pickVectorFigures(sparse, caption, W, H, S)).toHaveLength(1);

    const sidebar = [{ rect: pt(72, 100, 540, 340), paths: 20 }];
    const wordy = Array.from({ length: 12 }, (_, i) => ({ str: "A boxed sidebar paragraph line with plenty of words in it.", x: 84 * S, y: (120 + i * 14) * S }));
    expect(pickVectorFigures(sidebar, wordy, W, H, S)).toHaveLength(0);
  });

  it("pulls a drawing's short labels into the crop", () => {
    const labels = [
      { str: "Q1", x: 150 * S, y: 296 * S, w: 10 * S, h: 8 * S },
      { str: "Body text far away from everything else on the page.", x: 72 * S, y: 700 * S, w: 300 * S, h: 10 * S },
    ];
    const [r] = pickVectorFigures(clusterPathRects(bars, W, H, 6 * S), labels, W, H, S);
    expect(r.y0).toBeLessThanOrEqual(288 * S + 1);
  });
});
