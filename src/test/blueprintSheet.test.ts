import { describe, it, expect } from "vitest";
import { renderBlueprintSheet, SHEET_WIDTH } from "@/lib/blueprint/sheet";
import { validateSheetSvg, countSheetNodes } from "@/lib/blueprint/sheetValidate";
import { BlueprintSchema, type Blueprint } from "@/lib/blueprint/schema";

const parseBlueprintDoc = ((v: unknown) => BlueprintSchema.parse(v)) as (v: unknown) => any;

function robot(over: Partial<Blueprint> = {}): Blueprint {
  return parseBlueprintDoc({
    kind: "character",
    form: "hard_surface",
    name: "Rustbucket",
    silhouette: "Stacked cylinders over a heavy base, no sharp corners.",
    heightHeads: 6,
    absoluteHeight: { value: 180, unit: "cm" },
    palette: [
      { role: "shell", hex: "#2f8f8f" },
      { role: "trim", hex: "#e8e8e8" },
      { role: "lens", hex: "#c8452d", note: "only the eye" },
    ],
    parts: [
      { id: "torso", name: "Torso", primitive: "box", size: { x: 2, y: 3, z: 1 }, swatch: "shell" },
      { id: "head", name: "Head", primitive: "sphere", size: { x: 1, y: 1, z: 1 }, parent: "torso", attach: "neck", offset: { x: 0, y: 0.5, z: 0 }, swatch: "trim" },
      { id: "arm", name: "Arm", primitive: "cylinder", size: { x: 0.4, y: 2, z: 0.4 }, parent: "torso", attach: "shoulder", offset: { x: 0, y: -1, z: 0 }, symmetry: "mirror_x", swatch: "shell" },
    ],
    attachPoints: [
      { id: "neck", name: "Neck", part: "torso", face: "top", u: 0.5, v: 0.5 },
      { id: "shoulder", name: "Shoulder", part: "torso", face: "right", u: 0.5, v: 0.9 },
    ],
    joints: [{ id: "shoulder_j", name: "Shoulder", part: "arm", at: "shoulder", axis: "x", range: [-90, 180] }],
    notes: ["Weld seams stay visible.", "Eye lens is the only warm colour on the figure."],
    negatives: ["extra limbs", "chrome finish"],
    ...over,
  });
}

function organic(): Blueprint {
  return robot({
    name: "Kira",
    form: "organic",
    landmarks: [
      { id: "eye", name: "Eye line", atHeads: 5.6 },
      { id: "chin", name: "Chin", atHeads: 5.0 },
      { id: "shoulder_l", name: "Shoulder", atHeads: 4.7 },
      { id: "waist", name: "Waist", atHeads: 3.4 },
      { id: "knee", name: "Knee", atHeads: 1.6 },
    ],
  });
}

describe("sheet rendering", () => {
  it("produces a single well-formed svg element", () => {
    const sheet = renderBlueprintSheet(robot());
    expect(sheet.svg.startsWith("<svg")).toBe(true);
    expect(sheet.svg.endsWith("</svg>")).toBe(true);
    expect(sheet.width).toBe(SHEET_WIDTH);
    expect(sheet.height).toBeGreaterThan(400);
  });

  it("passes its own validator", () => {
    const problems = validateSheetSvg(renderBlueprintSheet(robot()).svg);
    expect(problems).toEqual([]);
  });

  it("passes the validator for an organic subject too", () => {
    expect(validateSheetSvg(renderBlueprintSheet(organic()).svg)).toEqual([]);
  });

  it("passes for every view count from one to six", () => {
    for (const views of [
      ["front"], ["front", "back"], ["front", "three_quarter", "right"],
      ["front", "three_quarter", "right", "back"],
      ["front", "three_quarter", "right", "back", "left"],
      ["front", "three_quarter", "right", "back", "left", "top"],
    ] as const) {
      const sheet = renderBlueprintSheet(robot(), { views: [...views] as never });
      expect(validateSheetSvg(sheet.svg)).toEqual([]);
    }
  });

  // The anchor has to be the thing that never drifts, so the same blueprint
  // must produce byte-identical markup every time.
  it("is deterministic", () => {
    const a = renderBlueprintSheet(robot());
    const b = renderBlueprintSheet(robot());
    expect(a.svg).toBe(b.svg);
  });

  it("stays inside the node budget for a four-view turnaround", () => {
    const sheet = renderBlueprintSheet(robot());
    expect(countSheetNodes(sheet.svg)).toBeLessThan(1500);
  });

  it("uses defs and use rather than repeating glyphs", () => {
    const svg = renderBlueprintSheet(robot()).svg;
    expect(svg).toContain("<defs>");
    expect(svg).toContain('href="#bp-anchor"');
  });

  it("draws the palette as real swatches carrying the hex", () => {
    const svg = renderBlueprintSheet(robot()).svg;
    // The colour has to be in the pixels — a hex string in a prompt measures
    // under 10% adherence, the same colour shown as a swatch measured ΔE 0.90.
    expect(svg).toContain('fill="#2f8f8f"');
    expect(svg).toContain("#2F8F8F");
    expect(svg).toContain("shell");
  });

  it("labels the scale in head-units and absolute height", () => {
    expect(renderBlueprintSheet(robot()).svg).toContain("6 heads · 180cm");
  });

  it("prints the effectivity range when one is declared", () => {
    const svg = renderBlueprintSheet(robot({ validity: { fromChapter: 4, toChapter: 11 } })).svg;
    expect(svg).toContain("chapters 4–11");
  });

  it("draws solids for hard surface and a scaffold for organic", () => {
    expect(renderBlueprintSheet(robot()).svg).toContain("<polygon");
    const scaffold = renderBlueprintSheet(organic()).svg;
    expect(scaffold).not.toContain("<polygon");
    expect(scaffold).toContain("stroke-dasharray");
  });

  it("runs landmark lines across every panel at one height", () => {
    const svg = renderBlueprintSheet(organic()).svg;
    const dashed = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#6d97ba"/g)];
    expect(dashed.length).toBeGreaterThanOrEqual(5);
    // Group by y — each landmark should appear once per panel at an identical y.
    const byY = new Map<string, number>();
    for (const m of dashed) byY.set(m[2], (byY.get(m[2]) || 0) + 1);
    for (const count of byY.values()) expect(count).toBe(4); // the default four views
  });

  it("names what it could not draw instead of dropping it silently", () => {
    const bp = robot();
    bp.parts.push({ id: "ghost", name: "Ghost", primitive: "box", size: { x: 1, y: 1, z: 1 }, parent: "missing" });
    const sheet = renderBlueprintSheet(bp);
    expect(sheet.omitted.join(" ")).toContain("ghost");
  });

  it("escapes text that would otherwise break the markup", () => {
    const sheet = renderBlueprintSheet(robot({ name: 'Rusty <script>alert("x")</script> & Co' }));
    expect(sheet.svg).not.toContain("<script");
    expect(sheet.svg).toContain("&lt;script");
    expect(validateSheetSvg(sheet.svg)).toEqual([]);
  });

  it("gives the sheet a title and description for screen readers", () => {
    const svg = renderBlueprintSheet(robot()).svg;
    expect(svg).toContain('role="graphics-document"');
    expect(svg).toContain("<title");
    expect(svg).toContain("<desc>");
  });

  it("carries no width or height on the root, so it scales to its container", () => {
    const svg = renderBlueprintSheet(robot()).svg;
    const openTag = svg.slice(0, svg.indexOf(">"));
    expect(openTag).not.toMatch(/\swidth=/);
    expect(openTag).not.toMatch(/\sheight=/);
    expect(openTag).toContain("viewBox=");
  });

  it("survives a blueprint with nothing optional filled in", () => {
    const bare = parseBlueprintDoc({ kind: "prop", form: "hard_surface", name: "Crate", heightHeads: 1 });
    const sheet = renderBlueprintSheet(bare);
    expect(validateSheetSvg(sheet.svg)).toEqual([]);
  });

  it("respects the stroke width dial", () => {
    expect(renderBlueprintSheet(robot(), { strokeWidth: 3 }).svg).toContain('stroke-width="3"');
    // Clamped, so a nonsense value can't produce an invisible or blanket line.
    expect(renderBlueprintSheet(robot(), { strokeWidth: 900 }).svg).toContain('stroke-width="6"');
  });
});

describe("sheet validator", () => {
  const wrap = (inner: string, viewBox = "0 0 100 100") =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${inner}</svg>`;

  it("rejects markup that is not well-formed", () => {
    const problems = validateSheetSvg("<svg><rect></svg>");
    expect(problems.length).toBeGreaterThan(0);
  });

  it("rejects a non-svg root", () => {
    const problems = validateSheetSvg("<div xmlns=\"http://www.w3.org/1999/xhtml\"></div>");
    expect(problems[0].problem).toMatch(/expected <svg>/);
  });

  // A zero-extent viewBox disables rendering entirely — the sheet looks broken
  // rather than reporting that it is.
  it("rejects a zero-extent viewBox", () => {
    const problems = validateSheetSvg(wrap("", "0 0 100 0"));
    expect(problems.some((p) => p.where === "svg[viewBox]")).toBe(true);
  });

  it("rejects a missing viewBox", () => {
    const problems = validateSheetSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="2" height="2"/></svg>');
    expect(problems.some((p) => p.where === "svg[viewBox]")).toBe(true);
  });

  it("rejects width and height on the root", () => {
    const problems = validateSheetSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="500" height="500"/>');
    expect(problems.some((p) => p.where === "svg")).toBe(true);
  });

  it.each([
    ["script", "<script>alert(1)</script>"],
    ["foreignObject", '<foreignObject width="10" height="10"><b>hi</b></foreignObject>'],
    ["style", "<style>* { fill: red }</style>"],
    ["animate", '<animate attributeName="href" values="javascript:alert(1)"/>'],
    ["set", '<set attributeName="href" to="javascript:alert(1)"/>'],
    ["a", '<a href="https://example.com"><rect x="1" y="1" width="2" height="2"/></a>'],
  ])("refuses <%s>", (_name, markup) => {
    const problems = validateSheetSvg(wrap(markup));
    expect(problems.some((p) => /never allowed/.test(p.problem))).toBe(true);
  });

  it("refuses event handler attributes", () => {
    const problems = validateSheetSvg(wrap('<rect x="1" y="1" width="2" height="2" onload="alert(1)"/>'));
    expect(problems.some((p) => /event handler/.test(p.problem))).toBe(true);
  });

  it("refuses inline style", () => {
    const problems = validateSheetSvg(wrap('<rect x="1" y="1" width="2" height="2" style="fill:url(http://x)"/>'));
    expect(problems.some((p) => /inline style/.test(p.problem))).toBe(true);
  });

  it("refuses xlink attributes", () => {
    const problems = validateSheetSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<use xlink:href="#a"/></svg>',
    );
    expect(problems.some((p) => /xlink/.test(p.problem))).toBe(true);
  });

  it.each([
    "https://attacker.example/pixel.png",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "//evil.example/x.svg",
  ])("refuses the external href %s", (href) => {
    const problems = validateSheetSvg(wrap(`<image href="${href}" x="0" y="0" width="10" height="10"/>`));
    expect(problems.some((p) => /neither a same-document fragment/.test(p.problem))).toBe(true);
  });

  it("permits an inline data image, which is how rasterised panels embed", () => {
    const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const problems = validateSheetSvg(wrap(`<image href="${tiny}" x="0" y="0" width="10" height="10"/>`));
    expect(problems).toEqual([]);
  });

  it("catches a use that points at nothing", () => {
    const problems = validateSheetSvg(wrap('<use href="#nope" x="1" y="1"/>'));
    const p = problems.find((x) => /no element declares that id/.test(x.problem))!;
    expect(p).toBeTruthy();
  });

  it("accepts a use that resolves", () => {
    const problems = validateSheetSvg(wrap('<defs><g id="dot"><circle r="1"/></g></defs><use href="#dot" x="5" y="5"/>'));
    expect(problems).toEqual([]);
  });

  it("catches geometry drawn outside the sheet", () => {
    const problems = validateSheetSvg(wrap('<rect x="900" y="5" width="20" height="20"/>'));
    expect(problems.some((p) => /outside the sheet/.test(p.problem))).toBe(true);
  });

  it("catches a polygon vertex outside the sheet", () => {
    const problems = validateSheetSvg(wrap('<polygon points="1,1 5,5 -400,2"/>'));
    expect(problems.some((p) => /outside the sheet/.test(p.problem))).toBe(true);
  });

  it("catches a pinned label that runs off the edge", () => {
    const problems = validateSheetSvg(wrap('<text x="80" y="10" textLength="60">overlong</text>'));
    expect(problems.some((p) => /runs outside the sheet/.test(p.problem))).toBe(true);
  });

  it("respects text-anchor when checking a pinned label", () => {
    // Anchored at the right edge, extending left — this one does fit.
    const problems = validateSheetSvg(wrap('<text x="95" y="10" textLength="60" text-anchor="end">fits</text>'));
    expect(problems).toEqual([]);
  });

  it("rejects a non-positive textLength", () => {
    const problems = validateSheetSvg(wrap('<text x="10" y="10" textLength="0">x</text>'));
    expect(problems.some((p) => /textLength must be positive/.test(p.problem))).toBe(true);
  });

  it("refuses an unknown element", () => {
    const problems = validateSheetSvg(wrap("<blink/>"));
    const p = problems.find((x) => /not in the sheet vocabulary/.test(x.problem))!;
    expect(p.allowed?.length).toBeGreaterThan(0);
  });

  it("refuses an unknown attribute", () => {
    const problems = validateSheetSvg(wrap('<rect x="1" y="1" width="2" height="2" formaction="x"/>'));
    expect(problems.some((p) => /attribute "formaction"/.test(p.problem))).toBe(true);
  });

  it("enforces the node budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => `<circle cx="${i % 10}" cy="1" r="0.5"/>`).join("");
    const problems = validateSheetSvg(wrap(many), { maxNodes: 10 });
    expect(problems.some((p) => /node budget/.test(p.problem))).toBe(true);
  });

  it("reports every problem, not just the first", () => {
    const problems = validateSheetSvg(wrap('<rect x="900" y="1" width="2" height="2" onclick="x()"/><use href="#gone"/>'));
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
