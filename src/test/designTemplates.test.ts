import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  deleteTemplate, describeTemplate, findTemplate, guessSlots, listTemplates, slugify, storyType, writeTemplate, zipEntry,
} from "../../scripts/local-ai/design-templates.mjs";

/** A minimal zip (deflated entries), as a .designcraft file is. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const DOC = {
  styles: { paragraph: [{ name: "[Basic Paragraph]", chars: {} }] },
  stories: {
    "1": { text: "Quarterly Readers Club", paras: [{ style: "[Basic Paragraph]" }], chars: [{ len: 22, over: { fontFamily: "Fraunces", fontStyle: "Black", size: 44 } }] },
    "2": { text: "Autumn picks and author nights", paras: [{ style: "[Basic Paragraph]" }], chars: [{ len: 30, over: { fontStyle: "Italic", size: 20 } }] },
    "3": { text: "We read one novel a month and meet at the library on the first Thursday. New members are always welcome; no need to have finished the book. This season: three debut novels.", paras: [{ style: "[Basic Paragraph]" }], chars: [{ len: 10 }] },
    "4": { text: "readersclub.example · Free entry", paras: [{ style: "[Basic Paragraph]" }], chars: [{ len: 10 }] },
    "5": { text: "The library reading room", paras: [{ style: "[Basic Paragraph]" }], chars: [{ len: 10, over: { fontStyle: "Italic", size: 9 } }] },
  },
};
const page = { bounds: [0, 0, 595, 842] };
const items = [
  { id: 10, kind: "text", story: 1, bounds: [40, 40, 555, 140] },
  { id: 11, kind: "text", story: 2, bounds: [40, 150, 555, 180] },
  { id: 12, kind: "image", bounds: [40, 200, 340, 500] },
  { id: 13, kind: "text", story: 5, bounds: [40, 505, 340, 520] },
  { id: 14, kind: "text", story: 3, bounds: [360, 200, 555, 560] },
  { id: 15, kind: "text", story: 4, bounds: [40, 780, 555, 800] },
];

describe("design templates", () => {
  it("reads DesignCraft's zipped document", () => {
    const buf = zip({ mimetype: "application/vnd.designcraft+zip", "document.json": JSON.stringify(DOC) });
    expect(JSON.parse(zipEntry(buf, "document.json")!.toString()).stories["1"].text).toBe("Quarterly Readers Club");
    expect(zipEntry(buf, "missing.json")).toBeNull();
  });

  it("reads how a story is set", () => {
    expect(storyType(DOC, 1)).toMatchObject({ size: 44, font: "Fraunces", italic: false });
    expect(storyType(DOC, 3)).toMatchObject({ size: 12 });
  });

  it("tells headline, subhead, caption, body and footer apart on a hand-made page", () => {
    const slots = guessSlots(items, page, DOC);
    const role = (id: number) => slots.find((s: any) => s.id === id).role;
    expect([role(10), role(11), role(12), role(13), role(14), role(15)]).toEqual(["headline", "subhead", "image", "caption", "body", "footer"]);
    expect(slots.find((s: any) => s.id === 10).size).toBe(44);
  });

  it("keeps the role a frame is already named with", () => {
    const named = items.map((i) => (i.id === 11 ? { ...i, named: true, role: "footer" } : i));
    expect(guessSlots(named, page, DOC).find((s: any) => s.id === 11).role).toBe("footer");
  });

  it("saves, finds by the words people use, lists and deletes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tpl-"));
    const slots = guessSlots(items, page, DOC);
    writeTemplate(dir, { name: "Summer Book Fair", slug: slugify("Summer Book Fair"), created: "2026-10-14T01:00:00Z", page: 0, width: 612, height: 792, slots }, Buffer.from("x"), Buffer.from("png"));
    writeTemplate(dir, { name: "Readers Club", slug: slugify("Readers Club"), created: "2026-10-14T02:00:00Z", page: 0, width: 595, height: 842, slots }, Buffer.from("x"), null);
    expect(slugify("Summer Book Fair!")).toBe("summer-book-fair");
    expect(listTemplates(dir).map((t: any) => t.name)).toEqual(["Readers Club", "Summer Book Fair"]);
    expect(findTemplate(dir, "summer book fair")?.slug).toBe("summer-book-fair");
    expect(findTemplate(dir, "the fair template")?.slug).toBe("summer-book-fair");
    expect(findTemplate(dir, "nope")).toBeNull();
    expect(describeTemplate(findTemplate(dir, "readers club"))).toMatch(/595×842 pt; parts headline, subhead, image, caption, body, footer|parts .*headline/);
    expect(deleteTemplate(dir, "readers-club")).toBe(true);
    expect(listTemplates(dir)).toHaveLength(1);
  });
});
