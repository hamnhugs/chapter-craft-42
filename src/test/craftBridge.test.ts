import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRole, compactLayers, designPage, designSlot, desktopPids, docCount, findLayer, insertAt, inWorkspace, lookTarget, plainText, rankCommands, roleLines, roleSize, stackLayout, textBox } from "../../scripts/local-ai/craft-bridge.mjs";

describe("rankCommands", () => {
  const list = [
    { id: "filter.blur.gaussian", label: "Gaussian Blur…", menu: ["Filter", "Blur"], params: "{radius}", enabled: true },
    { id: "image.adjustments.levels", label: "Levels…", menu: ["Image", "Adjustments"], params: "{}", enabled: true },
    { id: "type.create", label: "New Type Layer", menu: ["Layer"], params: '{"text":str}', enabled: false, disabledReason: "no document" },
  ];

  it("puts the command whose id and label match first", () => {
    expect(rankCommands(list, "gaussian blur")[0].id).toBe("filter.blur.gaussian");
    expect(rankCommands(list, "add a text layer")[0].id).toBe("type.create");
  });

  it("drops non-matches and carries why a command is disabled", () => {
    const r = rankCommands(list, "type");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ enabled: false, disabled_reason: "no document" });
  });
});

describe("designSlot", () => {
  const page = { bounds: [0, 0, 612, 792], margins: { top: 36, bottom: 36, inside: 36, outside: 36 }, side: "right" };

  it("fills the margins of an empty page", () => {
    expect(designSlot({ spreads: [{ pages: [page], items: [] }] }, 72)).toEqual({ spread: 0, newPage: false, rect: [36, 36, 576, 756] });
  });

  it("goes below what's on the page, or asks for a new page when it's full", () => {
    const doc = (bottom: number) => ({ spreads: [{ pages: [page], items: [{ bounds: [36, 36, 576, bottom] }] }] });
    expect(designSlot(doc(300), 72).rect).toEqual([36, 312, 576, 756]);
    expect(designSlot(doc(720), 72).newPage).toBe(true);
  });
});

describe("plainText", () => {
  it("removes Markdown marks DesignCraft would print", () => {
    expect(plainText("# Title\n\nSome **bold** and _soft_ words.\n> quoted")).toBe("Title\n\nSome bold and soft words.\nquoted");
    expect(plainText("2*3*4 and snake_case_name")).toBe("2*3*4 and snake_case_name");
  });
});

describe("inWorkspace", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-ws-"));
  mkdirSync(join(root, "in"));
  writeFileSync(join(root, "in", "a.png"), "x");
  const outside = mkdtempSync(join(tmpdir(), "craft-out-"));
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync(join(outside, "secret.txt"), join(root, "in", "link.txt"));

  it("accepts files inside the workspace", () => {
    expect(inWorkspace("in/a.png", root)).toMatch(/in\/a\.png$/);
  });

  it("refuses traversal and symlinks that leave it", () => {
    expect(() => inWorkspace("../" + outside.split("/").pop() + "/secret.txt", root)).toThrow(/Only files/);
    expect(() => inWorkspace("in/link.txt", root)).toThrow(/Only files/);
    expect(() => inWorkspace("in/missing.png", root)).toThrow(/No such file/);
  });
});

// Shapes captured from the user's live PhotoCraft window, 2026-10-13: the purple
// cat with a headline above it (docs/local-ai/PHOTOCRAFT-AI-FINDINGS.md).
const catStack = {
  document: {
    layers: [
      { id: 21, name: "Headline", kind: "Type", bounds: [55, 23, 351, 44], selected: true, text: { text: "I came. I saw." } },
      { id: 20, name: "Layer 1", kind: "Pixel", bounds: [0, 0, 0, 0] },
      { id: 19, name: "Layer 0", kind: "Pixel", bounds: [0, 0, 512, 512] },
    ],
  },
};

describe("docCount", () => {
  it("counts documents headless and with the window open", () => {
    expect(docCount({ documents: [{}, {}] })).toBe(2);
    // Live: session_list is ui.inspect, with the list under session. Reading
    // only `documents` counted 0 and every picture opened as a new tab.
    expect(docCount({ document: {}, session: { active: 0, documents: [{ name: "cat" }] } })).toBe(1);
    expect(docCount(null)).toBe(0);
  });
});

describe("PhotoCraft layers", () => {
  const layers = compactLayers(catStack);

  it("compacts the stack top first and marks empty pixel layers", () => {
    expect(layers.map((l: any) => l.id)).toEqual([21, 20, 19]);
    expect(layers[1]).toMatchObject({ name: "Layer 1", empty: true });
    expect(layers[0]).toMatchObject({ selected: true, text: "I came. I saw.", box: { x: 55, y: 23, w: 351, h: 44 } });
  });

  it("finds a layer by id, name or a unique part of it, and lists choices otherwise", () => {
    expect(findLayer(layers, 19)).toBe(19);
    expect(findLayer(layers, "headline")).toBe(21);
    expect(findLayer(layers, "layer 0")).toBe(19);
    expect(() => findLayer(layers, "layer")).toThrow(/More than one layer.*Ask the user/);
    expect(() => findLayer(layers, "sky")).toThrow(/No layer is called "sky".*Headline/);
  });

  it("aims a colour fix at the photo when the text is active", () => {
    // The user's "make it look better" brightened the headline instead.
    expect(lookTarget(layers, [{ id: "layer.newAdjustmentLayer.brightnessContrast" }])).toBe(19);
    expect(lookTarget(layers, [{ id: "image.autoTone" }])).toBe(19);
    expect(lookTarget(layers, [{ id: "type.setStyle" }])).toBeNull();
    const photoActive = layers.map((l: any) => ({ ...l, selected: l.id === 19 }));
    expect(lookTarget(photoActive, [{ id: "filter.blur.gaussian" }])).toBeNull();
  });

  it("puts new text below the text already there", () => {
    const [, y] = textBox(layers, 512, 512, 31);
    expect(y).toBeGreaterThan(67);
    expect(textBox([], 512, 512, 31)[1]).toBe(31);
  });
});

describe("desktopPids", () => {
  it("finds a running window by its binary, not the CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "proc-"));
    const add = (pid: string, argv: string[]) => { mkdirSync(join(root, pid)); writeFileSync(join(root, pid, "cmdline"), argv.join("\0") + "\0"); };
    add("100", ["/x/crafts/photocraft/usr/bin/photocraft", "--control", "7878"]);
    add("101", ["/x/crafts/photocraft/usr/bin/photocraft-cli", "mcp"]);
    add("102", ["bash", "-c", "photocraft"]);
    mkdirSync(join(root, "self"));
    expect(desktopPids("photocraft", root)).toEqual([100]);
  });
});

// The user's flyer (2026-10-13): A4, 42 pt margins, the Cashflow Quadrant
// picture placed, then "add a headline to the top".
const a4 = (items: any[]) => ({
  spreads: [{ items, pages: [{ bounds: [0, 0, 595.3, 841.9], margins: { top: 42, bottom: 42, inside: 42, outside: 42 }, side: "single" }] }],
});
const content = { left: 42, right: 553.3, top: 42, bottom: 799.9 };

describe("DesignCraft pages by role", () => {
  it("reads the page's parts, top first, by name or by kind", () => {
    const page = designPage(a4([
      { id: 9, kind: "<text frame>", story: 10, name: "Headline", bounds: [42, 42, 553, 120] },
      { id: 8, kind: "<image>", asset: 7, name: "", bounds: [42, 300, 553, 811] },
      { id: 12, kind: "<text frame>", story: 13, name: "", bounds: [42, 200, 553, 260] },
      { id: 20, kind: "<image>", name: "", bounds: [700, 0, 900, 200] }, // on the pasteboard
    ]), undefined)!;
    expect(page.content).toEqual(content);
    expect(page.items.map((i: any) => [i.id, i.role])).toEqual([[9, "headline"], [12, "body"], [8, "image"]]);
  });

  it("puts a headline above a picture that is already there, and a footer last", () => {
    const items = [{ role: "image" }, { role: "body" }];
    expect(insertAt(items, "headline", undefined)).toBe(0);
    expect(insertAt(items, "footer", undefined)).toBe(2);
    expect(insertAt([{ role: "headline" }, { role: "image" }], "subhead", undefined)).toBe(1);
    expect(insertAt(items, "body", "top")).toBe(0);
  });

  it("names short text a headline, then a subhead; long text is body", () => {
    expect(autoRole([], "Your Plan to Win")).toBe("headline");
    expect(autoRole([{ role: "headline" }], "Why a plan")).toBe("subhead");
    expect(autoRole([], "x".repeat(200))).toBe("body");
  });

  it("sizes a headline to fill its lines and keeps it within them", () => {
    expect(roleLines("headline", "Your Plan to Win")).toBe(1);
    expect(roleLines("headline", "Plan to Win: Climb the Cashflow Quadrant")).toBe(2);
    expect(roleSize("headline", "Your Plan to Win", 511)).toBe(64);
    expect(roleSize("body", "anything", 511)).toBe(12);
  });

  it("stacks headline, picture and footer down the page without overlap", () => {
    const plan = stackLayout(content, [
      { id: 9, kind: "text", role: "headline", height: 100 },
      { id: 8, kind: "image", role: "image", aspect: 1 },
      { id: 11, kind: "text", role: "footer", height: 15 },
    ]);
    expect(plan.issues).toEqual([]);
    const [h, img, f] = plan.boxes;
    expect(h).toMatchObject({ id: 9, x: 42, y: 42, h: 100 });
    expect(img.y).toBeGreaterThanOrEqual(h.y + h.h);
    expect(img.w).toBeLessThanOrEqual(511.3);
    expect(img.y + img.h).toBeLessThanOrEqual(f.y);
    expect(f.y + f.h).toBeCloseTo(799.9);
  });

  it("shrinks a picture to make room for text, and says when there isn't any", () => {
    const fits = stackLayout(content, [{ id: 1, kind: "text", role: "headline", height: 300 }, { id: 2, kind: "image", role: "image", aspect: 1 }]);
    const img = fits.boxes[1];
    expect(img.h).toBeLessThanOrEqual(799.9 - 342 - 14 + 0.1);
    expect(img.x).toBeGreaterThan(42); // centred
    const full = stackLayout(content, [{ id: 1, kind: "text", role: "body", height: 720 }, { id: 2, kind: "image", role: "image", aspect: 1 }]);
    expect(full.issues[0]).toMatch(/Not enough room for the picture/);
  });
});
