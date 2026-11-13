import { describe, it, expect } from "vitest";
import { cleanFileTitle, headingFromRuns, isOpaqueFileName, isPlausibleTitle, resolveTitle } from "@/lib/bookIntake";

describe("cleanFileTitle", () => {
  it("strips the extension and separator characters", () => {
    expect(cleanFileTitle("thinking_fast_and_slow.pdf")).toBe("Thinking Fast and Slow");
    expect(cleanFileTitle("the.pragmatic.programmer.epub")).toBe("The Pragmatic Programmer");
    expect(cleanFileTitle("deep-work.pdf")).toBe("Deep Work");
  });

  it("removes download-site and format junk", () => {
    expect(cleanFileTitle("Atomic Habits (z-lib.org).pdf")).toBe("Atomic Habits");
    expect(cleanFileTitle("Dune [Retail EPUB].epub")).toBe("Dune");
    expect(cleanFileTitle("Sapiens - libgen.li.pdf")).toBe("Sapiens");
  });

  it("drops duplicate and export suffixes", () => {
    expect(cleanFileTitle("Meditations (1).pdf")).toBe("Meditations");
    expect(cleanFileTitle("Meditations copy.pdf")).toBe("Meditations");
    expect(cleanFileTitle("thesis_final_v2.pdf")).toBe("Thesis");
  });

  it("leaves a name that already has its own casing alone", () => {
    expect(cleanFileTitle("Gödel, Escher, Bach - An Eternal Golden Braid.pdf")).toBe("Gödel, Escher, Bach - An Eternal Golden Braid");
    expect(cleanFileTitle("iPhone Photography Vol. 2.pdf")).toBe("iPhone Photography Vol. 2");
  });

  it("re-cases an all-caps name", () => {
    expect(cleanFileTitle("THE ART OF WAR.pdf")).toBe("The Art of War");
  });

  it("never returns an empty title", () => {
    expect(cleanFileTitle("(z-lib.org).pdf").length).toBeGreaterThan(0);
    expect(cleanFileTitle("___.pdf").length).toBeGreaterThan(0);
  });
});

describe("isOpaqueFileName", () => {
  it("flags ids, scans and hashes", () => {
    for (const n of ["1707.03762v5.pdf", "scan0001.pdf", "document (3).pdf", "9780262033848.pdf", "a3f9c2e17b4d5a6f.pdf", "Untitled.pdf"]) {
      expect(isOpaqueFileName(n), n).toBe(true);
    }
  });
  it("accepts a real name", () => {
    for (const n of ["Atomic Habits.pdf", "deep-work.pdf", "1984.pdf".replace("1984", "Nineteen Eighty-Four")]) {
      expect(isOpaqueFileName(n), n).toBe(false);
    }
  });
});

describe("isPlausibleTitle", () => {
  it("rejects producer defaults", () => {
    for (const t of ["Microsoft Word - draft3.docx", "untitled", "Document1", "chapter1.indd", "", "  ", "C:\\Users\\me\\book.pdf", "Slide 1"]) {
      expect(isPlausibleTitle(t), t).toBe(false);
    }
  });
  it("accepts a real title", () => {
    expect(isPlausibleTitle("Attention Is All You Need")).toBe(true);
    expect(isPlausibleTitle("Gödel, Escher, Bach")).toBe(true);
  });
});

describe("resolveTitle", () => {
  it("prefers plausible metadata", () => {
    expect(resolveTitle({ fileName: "1707.03762v5.pdf", metadataTitle: "Attention Is All You Need", headingTitle: "x" }))
      .toBe("Attention Is All You Need");
  });
  it("falls back to the heading only for an opaque file name", () => {
    expect(resolveTitle({ fileName: "scan0001.pdf", metadataTitle: "Microsoft Word - a.docx", headingTitle: "A Mathematical Theory of Communication" }))
      .toBe("A Mathematical Theory of Communication");
    expect(resolveTitle({ fileName: "deep_work.pdf", metadataTitle: null, headingTitle: "Journal of Stuff" }))
      .toBe("Deep Work");
  });
  it("uses the cleaned file name when nothing inside is usable", () => {
    expect(resolveTitle({ fileName: "scan0001.pdf" })).toBe("Scan0001");
    expect(resolveTitle({ fileName: "atomic_habits (z-lib.org).pdf", metadataTitle: "untitled" })).toBe("Atomic Habits");
  });
  it("re-cases an all-caps metadata title", () => {
    expect(resolveTitle({ fileName: "x.pdf", metadataTitle: "THE ART OF WAR" })).toBe("The Art of War");
  });
});

describe("headingFromRuns", () => {
  it("joins the largest lines top to bottom", () => {
    const runs = [
      { str: "of Communication", size: 24, y: 660 },
      { str: "A Mathematical Theory", size: 24, y: 690 },
      { str: "By C. E. Shannon", size: 12, y: 620 },
      ...Array.from({ length: 30 }, (_, i) => ({ str: `body line ${i}`, size: 10, y: 580 - i * 12 })),
    ];
    expect(headingFromRuns(runs)).toBe("A Mathematical Theory of Communication");
  });
  it("returns null when the largest type is the body text", () => {
    const runs = Array.from({ length: 40 }, (_, i) => ({ str: `line ${i}`, size: 10, y: 700 - i * 12 }));
    expect(headingFromRuns(runs)).toBeNull();
  });
  it("returns null for an empty page", () => {
    expect(headingFromRuns([])).toBeNull();
  });
});
