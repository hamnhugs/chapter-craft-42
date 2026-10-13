import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designSlot, inWorkspace, plainText, rankCommands } from "../../scripts/local-ai/craft-bridge.mjs";

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
