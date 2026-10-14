import { describe, expect, it } from "vitest";
import { layoutDocument, parseMarkdownBlocks, type PdfSink } from "@/lib/markdownPdf";

const sink = (): PdfSink & { texts: string[] } => {
  let pages = 1;
  const texts: string[] = [];
  return {
    texts,
    addPage: () => { pages += 1; },
    setFont: () => {},
    setFontSize: () => {},
    text: (t: string) => { texts.push(t); },
    splitTextToSize: (t: string, w: number) => { const per = Math.max(4, Math.floor(w / 5)); const out: string[] = []; for (let i = 0; i < t.length; i += per) out.push(t.slice(i, i + per)); return out.length ? out : [""]; },
    getNumberOfPages: () => pages,
  };
};

describe("markdown pipe tables", () => {
  it("parse into a table block, inline markdown stripped, ragged rows padded", () => {
    const blocks = parseMarkdownBlocks("Intro\n\n| Name | **Price** |\n|---|:--:|\n| Weed eating | $50 |\n| Leaf blowing |\n\nAfter");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "table", "paragraph"]);
    expect(blocks[1]).toEqual({ type: "table", header: ["Name", "Price"], rows: [["Weed eating", "$50"], ["Leaf blowing", ""]] });
  });
  it("keeps a lone pipe line without a separator as a paragraph", () => {
    expect(parseMarkdownBlocks("a | b\nc").map((b) => b.type)).toEqual(["paragraph"]);
  });
  it("lays a narrow table out as cells and a wide one as records; both reach the chapter text", () => {
    const narrow = parseMarkdownBlocks("# T\n\n| A | B |\n|---|---|\n| one | two |");
    const s1 = sink();
    const r1 = layoutDocument("Doc", narrow, s1);
    expect(s1.texts).toEqual(expect.arrayContaining(["A", "B", "one", "two"]));
    expect(r1.chapters[0].textContent).toContain("A: one | B: two");
    const cols = Array.from({ length: 8 }, (_, i) => `H${i}`);
    const wide = parseMarkdownBlocks(`# T\n\n| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n| ${cols.map((_, i) => `v${i}`).join(" | ")} |`);
    const s2 = sink();
    layoutDocument("Doc", wide, s2);
    expect(s2.texts).toContain("v0");
    expect(s2.texts.join(" ")).toContain("H1: v1");
    expect(s2.texts.join(" ")).not.toContain("|");
  });
});
