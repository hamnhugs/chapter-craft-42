import { describe, it, expect } from "vitest";
import { extractMentions, buildMentionNote, findActiveMention, mentionTokenEnd } from "@/lib/mentions";

describe("extractMentions", () => {
  it("finds handles matching the master-name grammar", () => {
    expect(extractMentions("send @robby and @blast-er_9 out")).toEqual(["robby", "blast-er_9"]);
  });

  it("dedupes case-insensitively, keeping first-appearance order", () => {
    expect(extractMentions("@Robby then @ROBBY then @robby")).toEqual(["robby"]);
  });

  it("ignores emails and glued @s — the '@' must not follow a name char", () => {
    expect(extractMentions("mail me at foo@bar.com or x@@yy")).toEqual([]);
  });

  it("requires 2+ chars starting alphanumeric (NAME_RE grammar)", () => {
    expect(extractMentions("@a @-oops @ok")).toEqual(["ok"]);
  });

  it("accepts a mention at the very start and after punctuation", () => {
    expect(extractMentions("@robby, meet (@blaster)")).toEqual(["robby", "blaster"]);
  });

  it("handles empty/absent text", () => {
    expect(extractMentions("")).toEqual([]);
    expect(extractMentions("no mentions here")).toEqual([]);
  });
});

describe("buildMentionNote", () => {
  it("is null when there were no mentions", () => {
    expect(buildMentionNote([])).toBeNull();
  });

  it("lists found masters with id and blueprint flag", () => {
    const note = buildMentionNote([
      { handle: "robby", found: true, id: "id-1", name: "robby", hasBlueprint: true },
      { handle: "blaster", found: true, id: "id-2", name: "blaster" },
    ]);
    expect(note).toBe("[Master assets referenced: @robby (id id-1, has blueprint) · @blaster (id id-2)]");
  });

  it("appends unresolved handles as not found", () => {
    const note = buildMentionNote([
      { handle: "robby", found: true, id: "id-1", name: "robby" },
      { handle: "typo", found: false },
    ]);
    expect(note).toBe("[Master assets referenced: @robby (id id-1) — not found: @typo]");
  });

  it("still reports when nothing resolved", () => {
    expect(buildMentionNote([{ handle: "typo", found: false }]))
      .toBe("[Master assets referenced — not found: @typo]");
  });
});

describe("findActiveMention", () => {
  it("detects the token under the caret, lowercasing the query", () => {
    const v = "hey @Rob";
    expect(findActiveMention(v, v.length)).toEqual({ start: 4, query: "rob" });
  });

  it("supports a bare '@' (empty query) and start-of-text", () => {
    expect(findActiveMention("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("rejects an '@' glued to a word (emails)", () => {
    const v = "foo@bar";
    expect(findActiveMention(v, v.length)).toBeNull();
  });

  it("closes once the caret leaves the token", () => {
    const v = "@robby done";
    expect(findActiveMention(v, v.length)).toBeNull(); // caret past the space
    expect(findActiveMention(v, 3)).toEqual({ start: 0, query: "ro" }); // mid-token
  });

  it("tolerates out-of-range carets", () => {
    expect(findActiveMention("@ro", -1)).toBeNull();
    expect(findActiveMention("@ro", 99)).toBeNull();
  });
});

describe("mentionTokenEnd", () => {
  it("spans the whole token so mid-token completion replaces all of it", () => {
    const v = "see @robby now";
    expect(v.slice(4, mentionTokenEnd(v, 4))).toBe("@robby");
  });

  it("stops at end of string", () => {
    const v = "@robby";
    expect(mentionTokenEnd(v, 0)).toBe(v.length);
  });
});
