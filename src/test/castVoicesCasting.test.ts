import { describe, it, expect } from "vitest";
import { castVoices, rankVoices, voiceTraits } from "@/lib/castVoices/casting";
import type { CastMember } from "@/lib/castVoices/attribute";
import type { InworldVoice } from "@/lib/inworldTts";

const m = (name: string, over: Partial<CastMember> = {}): CastMember => ({
  id: name.toLowerCase(), name, aliases: [], gender: "unknown", age: "unknown", note: "", lines: 1, ...over,
});
const v = (id: string, tags: string[], lang = "en"): InworldVoice => ({ voice_id: id, name: id, tags, language_code: lang });

const VOICES = [
  v("Narr", ["male", "adult"]),
  v("Ashley", ["female", "young"]),
  v("Olivia", ["female", "adult"]),
  v("Edna", ["female", "elderly"]),
  v("Mark", ["male", "adult"]),
  v("Timmy", ["male", "child"]),
  v("Hans", ["male", "adult"], "de"),
];
const opts = { narratorVoiceId: "Narr" };
const voiceOf = (cast: CastMember[], name: string) => cast.find((c) => c.name === name)?.voiceId;

describe("voiceTraits", () => {
  it("reads gender and age from tags, gender field or description", () => {
    expect(voiceTraits(v("a", ["Female", "Middle-aged"]))).toEqual({ gender: "female", age: "adult" });
    expect(voiceTraits({ voice_id: "b", name: "b", gender: "MALE" })).toEqual({ gender: "male", age: "unknown" });
    expect(voiceTraits({ voice_id: "c", name: "c", description: "A warm elderly woman" } as InworldVoice)).toEqual({ gender: "female", age: "elder" });
    // "female" must not read as "male".
    expect(voiceTraits(v("d", ["female"])).gender).toBe("female");
  });
});

describe("castVoices", () => {
  it("matches gender, prefers the right age, and never hands out the narrator or another language", () => {
    const cast = castVoices([
      m("Gran", { gender: "female", age: "elder", lines: 9 }),
      m("Tom", { gender: "male", age: "child", lines: 5 }),
      m("Dad", { gender: "male", age: "adult", lines: 4 }),
    ], VOICES, opts);
    expect(voiceOf(cast, "Gran")).toBe("Edna");
    expect(voiceOf(cast, "Tom")).toBe("Timmy");
    expect(voiceOf(cast, "Dad")).toBe("Mark");
    expect(cast.some((c) => c.voiceId === "Narr" || c.voiceId === "Hans")).toBe(false);
  });

  it("reads the language however the catalog spells it, and follows the narrator's", () => {
    const cat = [
      { voice_id: "Narr", name: "Narr", languages: ["es"], tags: ["male"] },
      { voice_id: "Lupe", name: "Lupe", langCode: "ES_ES", gender: "female", ageGroup: "middle_aged" },
      { voice_id: "Amy", name: "Amy", languageCode: "en-US", gender: "female" },
    ] as unknown as InworldVoice[];
    expect(voiceOf(castVoices([m("Ana", { gender: "female" })], cat, opts), "Ana")).toBe("Lupe");
    expect(voiceTraits(cat[1])).toEqual({ gender: "female", age: "adult" });
  });

  it("gives everyone a different voice while the catalog lasts", () => {
    const cast = castVoices([
      m("A", { gender: "female", lines: 3 }), m("B", { gender: "female", lines: 2 }), m("C", { gender: "female", lines: 1 }),
    ], VOICES, opts);
    expect(new Set(cast.map((c) => c.voiceId)).size).toBe(3);
  });

  it("keeps a voice once given, across later casting rounds", () => {
    const first = castVoices([m("Ann", { gender: "female", lines: 1 })], VOICES, opts);
    const annVoice = voiceOf(first, "Ann");
    const later = castVoices([...first.map((c) => ({ ...c, lines: 50 })), m("Bea", { gender: "female", lines: 80 })], VOICES, opts);
    expect(voiceOf(later, "Ann")).toBe(annVoice);
    expect(voiceOf(later, "Bea")).not.toBe(annVoice);
  });

  it("is the same on every run — no randomness", () => {
    const cast = [m("Ann", { gender: "female" }), m("Bob", { gender: "male" }), m("Someone")];
    expect(castVoices(cast, VOICES, opts)).toEqual(castVoices(cast, [...VOICES].reverse(), opts));
  });

  it("when voices run out, shares within the gender, with the quietest owner", () => {
    const three = [v("Narr", ["male"]), v("F1", ["female"]), v("M1", ["male"])];
    const cast = castVoices([
      m("Lead", { gender: "female", lines: 40 }), m("Maid", { gender: "female", lines: 2 }), m("Man", { gender: "male", lines: 9 }),
    ], three, opts);
    expect(voiceOf(cast, "Lead")).toBe("F1");
    expect(voiceOf(cast, "Maid")).toBe("F1");
    expect(voiceOf(cast, "Man")).toBe("M1");
  });

  it("never touches a locked voice, and recasts one that left the catalog", () => {
    const cast = castVoices([
      m("Ann", { gender: "female", voiceId: "Gone", locked: true }),
      m("Bea", { gender: "female", voiceId: "AlsoGone" }),
    ], VOICES, opts);
    expect(voiceOf(cast, "Ann")).toBe("Gone");
    expect(["Ashley", "Olivia", "Edna"]).toContain(voiceOf(cast, "Bea"));
  });

  it("no usable voices: the cast comes back unchanged", () => {
    const cast = [m("Ann")];
    expect(castVoices(cast, [v("Narr", ["male"])], opts)).toBe(cast);
  });
});

describe("rankVoices", () => {
  it("offers the suggested voice first, then the right gender and age, never the narrator or another language", () => {
    const ids = rankVoices(m("Gran", { gender: "female", age: "elder", voiceId: "Olivia" }), VOICES, opts).map((x) => x.voice_id);
    expect(ids.slice(0, 3)).toEqual(["Olivia", "Edna", "Ashley"]);
    expect(ids).not.toContain("Narr");
    expect(ids).not.toContain("Hans");
    expect(ids.indexOf("Mark")).toBeGreaterThan(ids.indexOf("Ashley"));
  });
});
