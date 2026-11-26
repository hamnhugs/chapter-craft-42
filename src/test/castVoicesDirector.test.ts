import { describe, it, expect, beforeEach, vi } from "vitest";
import { CastDirector, castBookStore, emptyCastBook, planWindows, speechLike, textHash, type DirectorDeps } from "@/lib/castVoices/director";
import { findQuotes } from "@/lib/castVoices/quotes";
import type { InworldVoice } from "@/lib/inworldTts";

const VOICES: InworldVoice[] = [
  { voice_id: "Narr", name: "Narr", tags: ["male"] },
  { voice_id: "Olivia", name: "Olivia", tags: ["female", "adult"] },
  { voice_id: "Mark", name: "Mark", tags: ["male", "adult"] },
];

const PAGE = "Ann looked up. “Where have you been?” she asked. “Out,” said Bob. The so-called “expert” shrugged. “That is no answer at all.”";

function deps(over: Partial<DirectorDeps> = {}): DirectorDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages[1].content);
      return JSON.stringify({
        cast: [{ name: "Ann", gender: "female", age: "adult" }, { name: "Bob", gender: "male", age: "adult" }],
        quotes: [{ q: 1, who: "Ann" }, { q: 2, who: "Bob", how: "curtly" }, { q: 3, who: null }],
      });
    },
    voices: async () => VOICES,
    narratorVoiceId: "Narr",
    bookTitle: "Test",
    book: emptyCastBook(),
    save: () => {},
    ...over,
  };
}

describe("planning", () => {
  it("a quoted word mid-sentence is not speech", () => {
    const qs = findQuotes(PAGE);
    expect(qs.map(speechLike)).toEqual([true, true, false, true]);
  });

  it("windows cover every quote once and end between quotes", () => {
    const long = Array.from({ length: 60 }, (_, i) => `“Line number ${i} of the talk.” Some narration follows here to fill the page out a little.`).join(" ");
    const qs = findQuotes(long);
    const ws = planWindows(long, qs);
    expect(ws.length).toBeGreaterThan(1);
    expect(ws[0].first).toBe(0);
    for (let i = 1; i < ws.length; i++) {
      expect(ws[i].first).toBe(ws[i - 1].last);
      expect(ws[i].from).toBe(ws[i - 1].to);
    }
    expect(ws[ws.length - 1].last).toBe(qs.length);
    expect(ws[ws.length - 1].to).toBe(long.length);
  });

  it("the hash is stable and tells texts apart", () => {
    expect(textHash("abc")).toBe(textHash("abc"));
    expect(textHash("abc")).not.toBe(textHash("abd"));
  });
});

describe("CastDirector", () => {
  it("resolves each quote to its character's voice, with one model call", async () => {
    const d = deps();
    const dir = new CastDirector(PAGE, d);
    expect(dir.spans).toHaveLength(3);
    dir.warm(0);
    const [a, b, c] = await Promise.all(dir.spans.map((s) => dir.resolve(s.voice)));
    expect(a).toEqual({ voiceId: "Olivia", name: "Ann" });
    expect(b).toEqual({ voiceId: "Mark", name: "Bob", direction: "curtly" });
    expect(c).toBeNull();
    expect(d.calls).toHaveLength(1);
    // The model saw numbers in front of the quotes, and the book's own words.
    expect(d.calls[0]).toContain("⟦1⟧“Where have you been?”");
    expect(d.calls[0]).toContain("⟦3⟧“That is no answer at all.”");
    expect(d.calls[0]).not.toContain("⟦4⟧");
  });

  it("a page heard before costs nothing and sounds the same", async () => {
    const d = deps();
    await new CastDirector(PAGE, d).resolve("0");
    const again = new CastDirector(PAGE, d);
    expect(await again.resolve("1")).toEqual({ voiceId: "Mark", name: "Bob", direction: "curtly" });
    expect(d.calls).toHaveLength(1);
  });

  it("a failed or unreadable answer means the narrator, and it stops asking", async () => {
    const complete = vi.fn(async () => { throw new Error("no key"); });
    const dir = new CastDirector(PAGE, deps({ complete }));
    expect(await dir.resolve("0")).toBeNull();
    expect(await dir.resolve("1")).toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
    const garbage = new CastDirector(PAGE, deps({ complete: async () => "I cannot help with that." }));
    expect(await garbage.resolve("0")).toBeNull();
  });

  it("an answer that does not arrive in time is the narrator's line", async () => {
    vi.useFakeTimers();
    try {
      const dir = new CastDirector(PAGE, deps({ complete: () => new Promise(() => {}) }));
      const p = dir.resolve("0");
      await vi.advanceTimersByTimeAsync(8000);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the next page who was just talking", async () => {
    const d = deps();
    const dir = new CastDirector(PAGE, d);
    await dir.resolve("0");
    const carry = dir.carryOut();
    expect(carry.recent.map((r) => r.speaker)).toEqual(["Ann", "Bob"]);
    const next = deps({ book: d.book, carry });
    await new CastDirector("“And you?” he said. “Fine, thank you.”", next).resolve("0");
    expect(next.calls[0]).toContain("Who spoke just before this passage:");
    expect(next.calls[0]).toContain("- Ann — female, adult");
  });
});

describe("late catalog", () => {
  it("a character met before the voices loaded is cast as soon as they are", async () => {
    let catalog: InworldVoice[] = [];
    const d = deps({ voices: async () => catalog });
    const dir = new CastDirector(PAGE, d);
    expect(await dir.resolve("0")).toBeNull();
    catalog = VOICES;
    expect(await dir.resolve("0")).toEqual({ voiceId: "Olivia", name: "Ann" });
    expect(d.calls).toHaveLength(1);
  });
});

describe("castBookStore", () => {
  beforeEach(() => localStorage.clear());
  it("round-trips per user and book, and survives junk", () => {
    const book = emptyCastBook();
    book.cast.push({ id: "a", name: "Ann", aliases: [], gender: "female", age: "adult", note: "", lines: 2, voiceId: "Olivia" });
    castBookStore.save("u1", "b1", book);
    expect(castBookStore.load("u1", "b1").cast[0].voiceId).toBe("Olivia");
    expect(castBookStore.load("u1", "b2").cast).toEqual([]);
    localStorage.setItem("bw_cast_u1_b1", "{nope");
    expect(castBookStore.load("u1", "b1")).toEqual(emptyCastBook());
  });
});
