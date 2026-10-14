import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTemplateMessage, wantsTemplatePicker } from "@/lib/templatePicker";
import { drainTemplateInbox } from "../../scripts/local-ai/craft-bridge.mjs";

describe("wantsTemplatePicker", () => {
  it("shows the picker when the user asks for their saved templates", () => {
    for (const t of [
      "show me my templates",
      "make a flyer for the book club using one of my templates",
      "can I use one of my saved templates for this poster?",
      "which layout templates do I have",
      "design this in DesignCraft from a template",
      "use a template I saved",
    ]) expect(wantsTemplatePicker(t), t).toBe(true);
  });

  it("leaves saving, named templates and other kinds of template alone", () => {
    for (const t of [
      "save this page as a template called Movie Night",
      "turn page 2 into a template",
      useTemplateMessage("Movie Night"),
      'use the "Spring Sale" template',
      "write me a query letter template",
      "give me a template for a chapter outline",
      "make a poster for the book club",
    ]) expect(wantsTemplatePicker(t), t).toBe(false);
  });
});

describe("drainTemplateInbox", () => {
  it("saves each request from the DesignCraft window and answers it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tpl-inbox-"));
    writeFileSync(join(dir, "1700-p2.json"), JSON.stringify({ page: 2, name: "Movie night", document: "Poster" }));
    writeFileSync(join(dir, "1701-p0.json"), JSON.stringify({ page: 0, name: "Empty" }));
    writeFileSync(join(dir, "1702-p0.json.tmp"), "{"); // still being written
    const calls: any[] = [];
    const n = await drainTemplateInbox(dir, async (b: any) => {
      calls.push(b);
      if (b.name === "Empty") throw new Error("That page is empty — design something first.");
      return { saved: b.name, replaced: true };
    });
    expect(n).toBe(2);
    expect(calls).toEqual([
      { app: "designcraft", name: "Movie night", page: 2 },
      { app: "designcraft", name: "Empty", page: 0 },
    ]);
    expect(readdirSync(dir).sort()).toEqual(["1700-p2.result.json", "1701-p0.result.json", "1702-p0.json.tmp"]);
    expect(JSON.parse(readFileSync(join(dir, "1700-p2.result.json"), "utf8"))).toEqual({ ok: true, name: "Movie night", replaced: true });
    expect(JSON.parse(readFileSync(join(dir, "1701-p0.result.json"), "utf8"))).toEqual({ ok: false, error: "That page is empty — design something first." });
  });

  it("answers a request it can't read instead of dropping it silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tpl-inbox-"));
    writeFileSync(join(dir, "9-p1.json"), "not json");
    await drainTemplateInbox(dir, async () => { throw new Error("should not save"); });
    expect(JSON.parse(readFileSync(join(dir, "9-p1.result.json"), "utf8")).ok).toBe(false);
  });

  it("is a no-op when the folder doesn't exist", async () => {
    expect(await drainTemplateInbox(join(tmpdir(), "no-such-inbox-xyz"), async () => ({}))).toBe(0);
  });
});
