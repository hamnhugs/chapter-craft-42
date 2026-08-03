import { describe, it, expect } from "vitest";
import { sanitizeIlike } from "@/lib/sanitize";

// PostgREST treats `%`, `,`, `(` and `)` as filter syntax, so any text that
// lands inside an .or()/.ilike() must come through sanitizeIlike. Four files
// carried private copies of the regex and a fifth had none — which is exactly
// how an injectable OR shipped. These tests pin the one shared behavior.

describe("sanitizeIlike", () => {
  it("strips the PostgREST syntax characters", () => {
    const out = sanitizeIlike("name.ilike.%evil%,or(id.eq.1)");
    expect(out).not.toContain("%");
    expect(out).not.toContain(",");
    expect(out).not.toContain("(");
    expect(out).not.toContain(")");
  });

  it("replaces syntax characters with spaces rather than gluing words together", () => {
    // "a,b" must not become the different search term "ab".
    expect(sanitizeIlike("a,b")).toBe("a b");
    expect(sanitizeIlike("a%b")).toBe("a b");
  });

  // `_` is deliberately PRESERVED: in ilike it is only a single-character
  // wildcard, which is harmless in fuzzy search — and stripping it would break
  // queries for names like "robot_master", which must stay searchable exactly
  // as written.
  it("preserves underscores", () => {
    expect(sanitizeIlike("robot_master")).toBe("robot_master");
    expect(sanitizeIlike("the_forge_scene")).toBe("the_forge_scene");
  });

  it("collapses runs of whitespace to a single space", () => {
    expect(sanitizeIlike("smith   the\t\tforger")).toBe("smith the forger");
    // Stripping adjacent syntax characters must not leave a double gap behind.
    expect(sanitizeIlike("a%(b")).toBe("a b");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeIlike("  anvil  ")).toBe("anvil");
    // A value that was ALL syntax collapses to the empty string, not " ".
    expect(sanitizeIlike("%,()")).toBe("");
  });

  it("leaves ordinary search text alone", () => {
    expect(sanitizeIlike("Smith works the bar")).toBe("Smith works the bar");
  });
});
