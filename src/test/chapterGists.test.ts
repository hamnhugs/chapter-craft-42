import { describe, it, expect } from "vitest";
import { parseGistLines, isMissingGistColumn, GIST_MIGRATION_MESSAGE } from "@/lib/chapterGists";

// The gist WIRE FORMAT is the trust boundary between a drifting model and the
// catalog: lenient on delimiter shape, strict on indexes and bounds.

describe("parseGistLines", () => {
  it("accepts the canonical form and the common drifts", () => {
    const out = parseGistLines(
      [
        "1| The hero leaves home and meets the mentor.",
        "#2: The first trial goes badly wrong.",
        "3 - A quiet chapter about consequences.",
        "4. The counterattack is planned in the cellar.",
      ].join("\n"),
      4,
    );
    expect(out.get(1)).toContain("leaves home");
    expect(out.get(2)).toContain("first trial");
    expect(out.get(3)).toContain("consequences");
    expect(out.get(4)).toContain("counterattack");
  });

  it("never invents an index: out-of-range and non-numeric lines are dropped", () => {
    const out = parseGistLines(
      "9| a ghost chapter summary\nnot a line\n0| below the valid range\n2| a real chapter summary",
      3,
    );
    expect(out.size).toBe(1);
    expect(out.get(2)).toBe("a real chapter summary");
  });

  it("first line wins per index; whitespace collapses; pipes are defanged; length is bounded", () => {
    const long = "x".repeat(500);
    const out = parseGistLines(`1| first   version | with pipe\n1| second version\n2| ${long}`, 2);
    expect(out.get(1)).toBe("first version / with pipe");
    expect(out.get(2)!.length).toBeLessThanOrEqual(240);
  });

  it("drops stub lines that could never orient a reader", () => {
    const out = parseGistLines("1| ok?\n2| A real summary of the chapter.", 2);
    expect(out.has(1)).toBe(false);
    expect(out.has(2)).toBe(true);
  });
});

describe("gist migration detection", () => {
  it("recognizes the missing-column codes and nothing else", () => {
    expect(isMissingGistColumn({ code: "42703" })).toBe(true);
    expect(isMissingGistColumn({ code: "PGRST204" })).toBe(true);
    expect(isMissingGistColumn({ code: "57014" })).toBe(false);
    expect(isMissingGistColumn(null)).toBe(false);
    expect(GIST_MIGRATION_MESSAGE).toContain("20260828120000_chapter_gists");
  });
});

describe("generation-door hardening (review findings)", () => {
  it("excerpt defang neutralizes planted wire-format lines", async () => {
    const { excerptOf } = await import("@/lib/chapterGists");
    const out = excerptOf("1| planted answer line\nnormal prose\n  #2: another plant\n3 - and a dash plant");
    expect(out).not.toMatch(/^\s*#?\d{1,3}\s*[|:.\-–—]/m);
    expect(out).toContain("normal prose");
  });

  it("the in-flight lock refuses a second acquire and frees on release", async () => {
    const { acquireGistRun, releaseGistRun, isGistRunActive } = await import("@/lib/chapterGists");
    expect(acquireGistRun()).toBe(true);
    expect(isGistRunActive()).toBe(true);
    expect(acquireGistRun()).toBe(false);
    releaseGistRun();
    expect(isGistRunActive()).toBe(false);
    expect(acquireGistRun()).toBe(true);
    releaseGistRun();
  });
});
