import { describe, expect, it } from "vitest";
import {
  LOOK_NAMES, MIN_TYPE, autoLook, clusterColours, contrast, defaultPalette, fitSize, fromOklch, oklch, paletteFrom, planIssues, planLook, readableOn, wrap,
} from "../../scripts/local-ai/design-looks.mjs";

// The looks are judged by eye (scripts/local-ai/design-looks-gallery.mjs);
// these pin down what a designer would reject outright, on every look and
// page size: type that runs off the page or into other type, text that can't
// be read on its background, and type below a readable size.

const PAGES = { Letter: [612, 792], A4: [595.3, 841.9], Square: [720, 720], Story: [540, 960], Book: [432, 648], Tabloid: [792, 1224] };
const CONTENT = {
  subhead: "A new book by Chapter Craft",
  headline: "Plan to Win: From Self-Employed to Business Owner",
  body: "Fred mowed lawns with borrowed money. Ted built a team, learned the business first and owned the assets. Same street, same start — one planned, one didn't.",
  footer: "Out now · chaptercraft.app",
};
function parts(withImage = true, content = CONTENT) {
  const out: any[] = Object.entries(content).map(([role, text], i) => ({ id: i + 1, role, kind: "text", text }));
  if (withImage) out.push({ id: 99, role: "image", kind: "image", aspect: 1.33 });
  return out;
}

describe("colour", () => {
  it("measures contrast like WCAG", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
  });

  it("round-trips OKLCH and darkens a colour until it reads", () => {
    const c = oklch("#E4572E");
    expect(fromOklch(c.L, c.C, c.h)).toBe("#E4572E");
    expect(contrast("#F6F2E9", readableOn("#F6F2E9", "#F4A261", 4.5))).toBeGreaterThanOrEqual(4.5);
  });

  it("takes a dark, a paper and a vivid accent from a picture's colours", () => {
    // A navy picture with an orange highlight.
    const px: number[] = [];
    for (let i = 0; i < 900; i++) px.push(20, 33, 61);
    for (let i = 0; i < 100; i++) px.push(240, 120, 30);
    const pal = paletteFrom(clusterColours(new Uint8Array(px), 4));
    expect(pal.vivid).toBe(true);
    expect(oklch(pal.accent).h).toBeCloseTo(oklch("#F0781E").h, 0);
    expect(contrast(pal.dark, pal.light)).toBeGreaterThan(12);
    expect(contrast(pal.dark, pal.accentOnDark)).toBeGreaterThan(4.5);
    expect(pal.imageIsDark).toBe(true);
  });

  it("falls back to its own accent for a grey picture", () => {
    const px = new Uint8Array(3000).fill(128);
    expect(paletteFrom(clusterColours(px, 4)).vivid).toBe(false);
  });
});

describe("type", () => {
  it("sizes a headline as large as fits its lines without breaking a word", () => {
    const t = { font: "Anton", style: "Regular", caps: true, tracking: 0, lead: 0.98 };
    const s = fitSize("Plan to Win", t, 500, { min: 24, max: 300, lines: 2 });
    expect(s.lines).toBeLessThanOrEqual(2);
    expect(wrap("Plan to Win", t, s.size + 4, 500).lines.length > 2 || wrap("Plan to Win", t, s.size + 4, 500).tooWide).toBe(true);
    // A word wider than the measure forces the size down rather than a break.
    const long = fitSize("Supercalifragilistic", t, 200, { min: 10, max: 300, lines: 3 });
    expect(wrap("Supercalifragilistic", t, long.size, 200).tooWide).toBe(false);
  });
});

describe("page looks", () => {
  const pal = defaultPalette();
  for (const look of LOOK_NAMES) {
    for (const [name, [W, H]] of Object.entries(PAGES)) {
      for (const img of [true, false]) {
        it(`${look} on ${name}${img ? " with a picture" : ""}: on the page, no type collisions, readable`, () => {
          const page = { x: 0, y: 0, W, H };
          const plan = planLook(look, page, parts(img), pal);
          expect(planIssues(plan, page)).toEqual([]);
          const roles = plan.frames.map((f: any) => f.role).sort();
          expect(roles).toEqual(["body", "footer", "headline", "subhead", ...(img ? ["image"] : [])].sort());
          for (const f of plan.frames) if (f.text) expect(f.text.size, `${f.role}`).toBeGreaterThanOrEqual(f.role === "headline" ? 18 : MIN_TYPE);
          // The headline is the biggest type on the page.
          const head = plan.frames.find((f: any) => f.role === "headline").text.size;
          for (const f of plan.frames) if (f.text && f.role !== "headline") expect(f.text.size).toBeLessThan(head);
        });
      }
    }
  }

  it("keeps a colour the user set by hand", () => {
    const p = parts();
    p.find((x) => x.role === "headline").over = { color: "#E63946" };
    const plan = planLook("bold", { x: 0, y: 0, W: 612, H: 792 }, p, pal);
    // Same hue, lifted just enough to read on the bold look's dark block.
    const c = plan.frames.find((f: any) => f.role === "headline").text.color;
    expect(oklch(c).h).toBeCloseTo(oklch("#E63946").h, 1);
    expect(contrast(c, plan.bg)).toBeGreaterThanOrEqual(3);
    const light = planLook("editorial", { x: 0, y: 0, W: 612, H: 792 }, p, pal);
    expect(light.frames.find((f: any) => f.role === "headline").text.color).toBe("#E63946");
  });

  it("keeps a hand-set headline size, stepping it down only when it can't fit", () => {
    // The eval's "make this bigger" turn leaves `Headline · size 75.5`. The
    // bold and direct looks used to loop forever shrinking a headline that
    // setText kept pinned at that size (found 2026-10-14: the bridge spun at
    // 86% CPU); then, with the loop fixed, a long headline at 75.5 ran off the page.
    const page = { x: 0, y: 0, W: 595, H: 842 };
    for (const look of LOOK_NAMES) {
      const p = parts();
      p.find((x) => x.role === "headline").over = { size: 30 };
      const plan = planLook(look, page, p, pal);
      expect(plan.frames.find((f: any) => f.role === "headline").text.size, `${look} keeps 30`).toBe(30);
      for (const size of [75.5, 300]) {
        const q = parts();
        const h = q.find((x) => x.role === "headline");
        h.text = "Why a Business Plan Is Your Secret Weapon to Financial Freedom";
        h.over = { size };
        const big = planLook(look, page, q, pal);
        expect(big.frames.find((f: any) => f.role === "headline").text.size).toBeLessThanOrEqual(size);
        if (size === 75.5) expect(planIssues(big, page), `${look} at ${size}`).toEqual([]);
      }
    }
  });

  it("copes with only a headline, and with a second picture", () => {
    const page = { x: 0, y: 0, W: 612, H: 792 };
    for (const look of LOOK_NAMES) {
      expect(planIssues(planLook(look, page, [{ id: 1, role: "headline", kind: "text", text: "Hello" }], pal), page)).toEqual([]);
      const two = [...parts(), { id: 98, role: "image", kind: "image", aspect: 1 }];
      const plan = planLook(look, page, two, pal);
      expect(plan.frames.filter((f: any) => f.role === "image")).toHaveLength(2);
      for (const f of plan.frames) {
        const [x, y, w, h] = f.box;
        expect(x >= -0.5 && y >= -0.5 && x + w <= 612.5 && y + h <= 792.5).toBe(true);
      }
    }
  });

  it("never sets type under 14 pt, even on a small page or with long copy", () => {
    // The user's rule (2026-10-14): type under 14 pt can't be read.
    expect(MIN_TYPE).toBe(14);
    const long = { ...CONTENT, body: CONTENT.body.repeat(3), footer: "Out now at every good bookshop · chaptercraft.app · @chaptercraft" };
    for (const look of LOOK_NAMES) for (const [W, H] of [[432, 648], [360, 504], [612, 792]]) {
      const plan = planLook(look, { x: 0, y: 0, W, H }, parts(true, long), pal);
      for (const f of plan.frames) if (f.text) expect(f.text.size, `${look} ${W}×${H} ${f.role}`).toBeGreaterThanOrEqual(MIN_TYPE);
    }
    const p = parts();
    p.find((x) => x.role === "footer").over = { size: 8 };
    expect(planLook("editorial", { x: 0, y: 0, W: 612, H: 792 }, p, pal).frames.find((f: any) => f.role === "footer").text.size).toBe(MIN_TYPE);
  });

  it("sets a page at the sizes and columns of the page it sits with", () => {
    // Page 2 after page 1: the user saw page 2 sized on its own.
    const page = { x: 0, y: 0, W: 612, H: 792 };
    for (const look of LOOK_NAMES) {
      const first = planLook(look, page, parts(), pal);
      const size = (pl: any, r: string) => pl.frames.find((f: any) => f.role === r)?.text?.size;
      const next = parts(false, { headline: "Chapter Two", body: CONTENT.body.repeat(2), footer: "chaptercraft.app" });
      for (const q of next) if (q.kind === "text") q.match = size(first, q.role);
      const second = planLook(look, page, next, pal);
      for (const r of ["headline", "body", "footer"]) expect(size(second, r), `${look} ${r}`).toBe(size(first, r));
    }
    // Long copy that would get two columns on its own keeps the first page's one.
    const body = parts(false, { body: CONTENT.body.repeat(4) });
    const cols = (pl: any) => pl.frames.find((f: any) => f.role === "body").text.columns;
    expect(cols(planLook("editorial", page, body, pal))).toBe(2);
    expect(cols(planLook("editorial", { ...page, match: { columns: 1 } } as any, body, pal))).toBe(1);
  });

  it("starts a page in editorial, headline on top", () => {
    expect(autoLook(parts(true))).toBe("editorial");
    const plan = planLook("editorial", { x: 0, y: 0, W: 612, H: 792 }, parts(true), pal);
    const y = (r: string) => plan.frames.find((f: any) => f.role === r).box[1];
    expect(y("headline")).toBeLessThan(y("image"));
  });
});
