import { describe, it, expect, vi } from "vitest";

// The index reads through the supabase client; these tests cover the pure
// parts (rendering, naming, refs), so the client is a stub.
const rows: any[] = [];
vi.mock("@/integrations/supabase/client", () => {
  const q: any = {
    select: () => q, is: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q, in: () => q,
    then: (res: (v: { data: any[]; error: null }) => unknown) => res({ data: rows, error: null }),
  };
  return { supabase: { from: () => q } };
});

import {
  cleanHook, fallbackHook, noteRef, renderIndexLines, namedNotes, resolveNoteRef, fetchNotesIndex, type IndexNote,
} from "@/lib/notesIndex";

const note = (over: Partial<IndexNote>): IndexNote => ({
  id: "1b2c3d4e-0000-4000-8000-000000000001",
  title: "Pasteboard masks",
  hook: "Ahab's speech on fate vs will; your thesis",
  content: "",
  entry_type: "concept",
  locators: [{ chapter_id: "c36", char_start: 0, char_end: 40, page: 214, quote: "All visible objects, man, are but as pasteboard masks", book_title: "Moby-Dick" }],
  aliases: [],
  wiki_id: "w1",
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});
const clean = (t: string, max: number) => t.slice(0, max);

describe("hooks", () => {
  it("cleanHook collapses whitespace, strips quotes, bounds length, rejects scraps", () => {
    expect(cleanHook('  "A  claim\nthat matters"  ')).toBe("A claim that matters");
    expect(cleanHook("tiny")).toBeNull();
    expect(cleanHook("x".repeat(400))!.length).toBe(160);
  });

  it("fallbackHook takes the first sentence of the body", () => {
    expect(fallbackHook("## Heading\nSpring tides follow new and full moons. Neap tides fall between.")).toBe(
      "Heading Spring tides follow new and full moons.",
    );
    expect(fallbackHook("")).toBe("");
    expect(fallbackHook("y".repeat(300)).length).toBeLessThanOrEqual(140);
  });
});

describe("renderIndexLines", () => {
  it("prints ref, title, hook and anchor on one line", () => {
    const { lines } = renderIndexLines([note({})], 1000, clean);
    expect(lines).toEqual([`- [1b2c3d4e] Pasteboard masks — Ahab's speech on fate vs will; your thesis (Moby-Dick, p. 214)`]);
  });

  it("falls back to the body when a note has no hook yet", () => {
    const { lines } = renderIndexLines([note({ hook: null, content: "Whiteness terrifies Ishmael more than any colour. More text." })], 1000, clean);
    expect(lines[0]).toContain("— Whiteness terrifies Ishmael more than any colour.");
  });

  it("stops at the character budget instead of cutting a line", () => {
    const many = Array.from({ length: 50 }, (_, i) => note({ id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000` }));
    const { lines, shown } = renderIndexLines(many, 500, clean);
    expect(shown).toBe(lines.length);
    expect(shown).toBeLessThan(50);
    expect(lines.join("\n").length).toBeLessThanOrEqual(500);
  });
});

describe("namedNotes", () => {
  const notes = [
    note({ id: "a", title: "Control" }),
    note({ id: "b", title: "Stoic dichotomy of control", aliases: ["dichotomy"] }),
    note({ id: "c", title: "Kelp" }),
  ];

  it("matches whole names, longest first", () => {
    expect(namedNotes("what did I save about the Stoic dichotomy of control?", notes).map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("matches aliases and ignores partial words and short names", () => {
    expect(namedNotes("explain the dichotomy again", notes).map((n) => n.id)).toEqual(["b"]);
    expect(namedNotes("uncontrollable kelpie", notes)).toEqual([]);
    expect(namedNotes("kelp", [note({ id: "k", title: "Kel" })])).toEqual([]);
  });
});

describe("short refs", () => {
  it("resolves refs the index has served, and passes everything else through", async () => {
    rows.splice(0, rows.length, { id: "9f8e7d6c-1111-4000-8000-000000000009", title: "T", hook: "A hook long enough", entry_type: "fact", locators: [], aliases: [], wiki_id: "w", created_at: "" });
    await fetchNotesIndex(["w"]);
    expect(noteRef("9f8e7d6c-1111-4000-8000-000000000009")).toBe("9f8e7d6c");
    expect(resolveNoteRef("9f8e7d6c")).toBe("9f8e7d6c-1111-4000-8000-000000000009");
    expect(resolveNoteRef("[9f8e7d6c]")).toBe("9f8e7d6c-1111-4000-8000-000000000009");
    expect(resolveNoteRef("deadbeef")).toBe("deadbeef");
    expect(resolveNoteRef("e1")).toBe("e1");
    expect(resolveNoteRef(42)).toBe(42);
  });
});
