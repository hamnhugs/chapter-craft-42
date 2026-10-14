import { describe, it, expect } from "vitest";
import { assignShelfSlots, markForSlot, markStripes } from "@/lib/shelfMarks";

const shelf = (id: string, created_at: string) => ({ id, created_at });

describe("shelf marks", () => {
  it("gives new shelves the lowest free slot in creation order", () => {
    const slots = assignShelfSlots([shelf("b", "2026-02"), shelf("a", "2026-01")], {});
    expect(slots).toEqual({ a: 0, b: 1 });
  });

  it("keeps saved slots, frees deleted ones, and reuses the gap", () => {
    const saved = { a: 0, b: 1, c: 2 };
    // b deleted, d created
    const slots = assignShelfSlots([shelf("a", "1"), shelf("c", "3"), shelf("d", "4")], saved);
    expect(slots).toEqual({ a: 0, c: 2, d: 1 });
  });

  it("ignores corrupt or duplicate saved slots", () => {
    const slots = assignShelfSlots([shelf("a", "1"), shelf("b", "2")], { a: 0, b: 0 } as Record<string, number>);
    expect(new Set(Object.values(slots)).size).toBe(2);
  });

  it("every mark is unique — no two shelves share a color+glyph", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const m = markForSlot(i);
      expect(m.color).toMatch(/^#[0-9a-f]{6}$/i);
      const key = `${m.color.toLowerCase()}|${m.glyph}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("the first twelve shelves get twelve different colors", () => {
    const colors = new Set(Array.from({ length: 12 }, (_, i) => markForSlot(i).color));
    expect(colors.size).toBe(12);
  });

  it("stripes one segment per shelf", () => {
    expect(markStripes(["#111111"])).toBe("#111111");
    expect(markStripes(["#111111", "#222222"])).toContain("#222222 50.00% 100.00%");
  });
});
