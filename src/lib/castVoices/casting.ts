/**
 * Cast voices, step 3: which voice each character gets.
 *
 * A fixed catalog (the listener's Inworld voices), matched on the two things
 * a model reads reliably from a book — gender (F1 ≈ 0.99 in S-VoCAL, 2026)
 * and a coarse age band (≈ 0.8) — and nothing finer. Accent and origin are
 * deliberately NOT cast: extraction of origin is poor (≈ 0.4), and the
 * narrators' own guidance is that no accent beats a bad one.
 *
 * The rules, in order:
 *  1. A voice once given is kept. Casting only fills gaps, so a character
 *     sounds the same on page 300 as on page 3, and a voice the listener
 *     picked (`locked`) is never touched.
 *  2. The narrator's voice is not given to a character.
 *  3. Known gender is a hard preference; age is a soft one.
 *  4. A voice nobody else has beats one in use. When the catalog runs out,
 *     the voice shared is the one whose current owner speaks least.
 *  5. Ties break on a hash of the character's name — stable across devices
 *     and sessions, no randomness.
 */
import type { InworldVoice } from "@/lib/inworldTts";
import type { CastAge, CastGender, CastMember } from "@/lib/castVoices/attribute";

export interface VoiceTraits {
  gender: CastGender;
  age: CastAge;
}

const has = (hay: string, re: RegExp) => re.test(hay);

/** What a catalog voice sounds like, from whatever metadata it carries. */
export function voiceTraits(v: InworldVoice & { description?: string; age?: string; age_group?: string; ageGroup?: string }): VoiceTraits {
  // Inworld's voice list carries gender and an age group; older responses
  // only had tags and a description. Enum spellings ("AGE_GROUP_YOUNG_ADULT")
  // are flattened so the same words match.
  const hay = [v.gender, v.age, v.age_group, v.ageGroup, ...(Array.isArray(v.tags) ? v.tags : []), v.description]
    .filter((x) => typeof x === "string").join(" ").toLowerCase().replace(/_/g, " ");
  const gender: CastGender = has(hay, /\b(female|woman|girl|feminine)\b/) ? "female"
    : has(hay, /\b(male|man|boy|masculine)\b/) ? "male" : "unknown";
  // "middle-aged" is tested before "aged".
  const age: CastAge = has(hay, /\b(middle[- ]aged?)\b/) ? "adult"
    : has(hay, /\b(child|kid|boy|girl|childlike)\b/) ? "child"
      : has(hay, /\b(elder|elderly|old|older|senior|aged|grandfather|grandmother)\b/) ? "elder"
        : has(hay, /\b(young|youthful|teen|teenage|teenager)\b/) ? "young"
          : has(hay, /\b(adult|mature)\b/) ? "adult" : "unknown";
  return { gender, age };
}

/** Small stable string hash (FNV-1a) → [0, 1). */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const AGE_ORDER: CastAge[] = ["child", "young", "adult", "elder"];
function ageFit(want: CastAge, got: CastAge): number {
  if (want === "unknown" || got === "unknown") return 0;
  const d = Math.abs(AGE_ORDER.indexOf(want) - AGE_ORDER.indexOf(got));
  return d === 0 ? 12 : d === 1 ? 2 : -12;
}

export interface CastingOptions {
  /** The voice reading narration — never a character's. */
  narratorVoiceId: string;
  /** Two-letter language the cast must speak. Default: the narrator's own,
   *  else English. */
  language?: string;
}

/** Every language a catalog voice lists, as two-letter codes. Inworld has
 *  spelled this four ways across API versions (`languages[]`, `langCode`
 *  "EN_US", `languageCode` "en-US", `promptLanguages[]`). */
export function voiceLanguages(v: InworldVoice): string[] {
  const raw = v as unknown as Record<string, unknown>;
  const all = [raw.language_code, raw.languageCode, raw.langCode, raw.languages, raw.promptLanguages].flat();
  return [...new Set(all.filter((x): x is string => typeof x === "string" && x.length >= 2).map((x) => x.slice(0, 2).toLowerCase()))];
}

/**
 * Give a voice to every member who lacks one. Pure: returns a new cast,
 * leaving voices already assigned (and still in the catalog) exactly as they
 * were. A member whose voice has left the catalog is recast, unless locked.
 */
export function castVoices(cast: CastMember[], voices: InworldVoice[], opts: CastingOptions): CastMember[] {
  const narrator = voices.find((v) => v.voice_id === opts.narratorVoiceId);
  const lang = (opts.language || (narrator && voiceLanguages(narrator)[0]) || "en").slice(0, 2).toLowerCase();
  const eligible = voices.filter((v) => {
    if (!v.voice_id || v.voice_id === opts.narratorVoiceId) return false;
    const langs = voiceLanguages(v);
    return langs.length === 0 || langs.includes(lang);
  });
  if (eligible.length === 0) return cast;
  const inCatalog = new Set(voices.map((v) => v.voice_id));
  const traits = new Map(eligible.map((v) => [v.voice_id, voiceTraits(v)]));

  const next = cast.map((m) => ({ ...m }));
  // Lines spoken by everyone currently holding each voice.
  const load = new Map<string, number>();
  const holders = new Map<string, number>();
  for (const m of next) {
    if (m.voiceId && !m.locked && !inCatalog.has(m.voiceId)) delete m.voiceId;
    if (!m.voiceId) continue;
    load.set(m.voiceId, (load.get(m.voiceId) || 0) + m.lines);
    holders.set(m.voiceId, (holders.get(m.voiceId) || 0) + 1);
  }
  // Leads choose first.
  const waiting = next.filter((m) => !m.voiceId).sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1));
  for (const m of waiting) {
    let best: { id: string; score: number } | null = null;
    for (const v of eligible) {
      const t = traits.get(v.voice_id)!;
      let score = 0;
      if (m.gender !== "unknown" && t.gender !== "unknown") score += m.gender === t.gender ? 100 : -100;
      score += ageFit(m.age, t.age);
      const n = holders.get(v.voice_id) || 0;
      // Sharing costs more than an age mismatch but less than the wrong
      // gender; among shared voices, take the one whose owners speak least.
      if (n > 0) score -= 40 + 10 * n + Math.min(30, (load.get(v.voice_id) || 0) / 4);
      score += hash01(`${m.name}|${v.voice_id}`);
      if (!best || score > best.score) best = { id: v.voice_id, score };
    }
    if (!best) continue;
    m.voiceId = best.id;
    load.set(best.id, (load.get(best.id) || 0) + m.lines);
    holders.set(best.id, (holders.get(best.id) || 0) + 1);
  }
  return next;
}
