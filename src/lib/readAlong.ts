/**
 * Read-along core: pure word/timing math for the Read tab's read-aloud with
 * per-word highlighting. No DOM, no audio — everything here is unit-tested.
 *
 * Pipeline: source text → `tokenizeWords` (char offsets into the source) →
 * `buildReadChunks` (sentence-packed chunks the TTS engine speaks one at a
 * time) → per chunk, word times from the provider (`alignTimings`, Inworld
 * WORD timestamps) or, when a provider gives none, `estimateTimings` spread
 * over the real audio duration → `wordAtTime` during playback.
 */

export interface SourceWord {
  /** Offset of the first char in the source text. */
  start: number;
  /** Offset one past the last char. */
  end: number;
  text: string;
}

export interface ReadChunk {
  /** Index into the words array of this chunk's first word. */
  first: number;
  /** One past the last word index. */
  last: number;
  /** Text sent to the TTS engine — the source slice covering the words. */
  text: string;
  /** Source offset where `text` begins (charIndex → source offset). */
  offset: number;
}

/** A timed token as a provider reports it (seconds from chunk audio start). */
export interface TimedToken {
  text: string;
  start: number;
  end: number;
}

/** [start, end] in seconds for each word of a chunk, in chunk order. */
export type WordTimes = Array<[number, number]>;

const WORDISH = /[\p{L}\p{N}]/u;

type SegmenterLike = { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };

function wordSegmenter(): SegmenterLike | null {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => SegmenterLike }).Segmenter;
  return Seg ? new Seg(undefined, { granularity: "word" }) : null;
}

/**
 * Words with their source offsets. Trailing punctuation and closing quotes are
 * folded into the preceding word ("world!" not "world") so the highlight pill
 * covers what a reader sees as the word, and hyphen/apostrophe joins stay one
 * word ("well-known", "don't").
 */
export function tokenizeWords(text: string): SourceWord[] {
  const raw: Array<{ start: number; end: number }> = [];
  const seg = wordSegmenter();
  if (seg) {
    for (const s of seg.segment(text)) {
      if (s.isWordLike || WORDISH.test(s.segment)) raw.push({ start: s.index, end: s.index + s.segment.length });
    }
  } else {
    const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
    for (let m = re.exec(text); m; m = re.exec(text)) raw.push({ start: m.index, end: m.index + m[0].length });
  }
  const out: SourceWord[] = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    const gap = prev ? text.slice(prev.end, r.start) : "";
    // Join across a bare hyphen/apostrophe with no whitespace ("well-known").
    if (prev && gap.length === 1 && /[-'’]/.test(gap)) {
      prev.end = r.end;
      continue;
    }
    out.push({ start: r.start, end: r.end, text: "" });
  }
  for (const w of out) {
    // Absorb trailing punctuation up to the next whitespace.
    let e = w.end;
    while (e < text.length && !/\s/.test(text[e]) && !WORDISH.test(text[e])) e++;
    w.end = e;
    w.text = text.slice(w.start, w.end);
  }
  return out;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/**
 * Pack words into sentence-aligned chunks of at most ~`max` chars. The first
 * chunk is kept short so audio starts quickly; a run-on sentence breaks at a
 * clause mark or, failing that, at the size limit.
 */
export function buildReadChunks(text: string, words: SourceWord[], from = 0, max = 240, firstMax = 120): ReadChunk[] {
  const chunks: ReadChunk[] = [];
  let first = from;
  const push = (lastExclusive: number) => {
    if (lastExclusive <= first) return;
    const offset = words[first].start;
    chunks.push({ first, last: lastExclusive, text: text.slice(offset, words[lastExclusive - 1].end), offset });
    first = lastExclusive;
  };
  let clauseBreak = -1;
  for (let i = from; i < words.length; i++) {
    const limit = chunks.length === 0 ? firstMax : max;
    const len = words[i].end - words[first].start;
    const w = words[i].text;
    if (len > limit && i > first) {
      push(clauseBreak > first ? clauseBreak : i);
      clauseBreak = -1;
      // Re-examine this word against the new chunk.
      i = first - 1;
      continue;
    }
    if (SENTENCE_END.test(w)) {
      // Close on a sentence end once there is a real clause to speak.
      if (words[i].end - words[first].start >= 40 || i === words.length - 1) push(i + 1);
      else clauseBreak = i + 1;
    } else if (/[,;:—–]$/.test(w)) {
      clauseBreak = i + 1;
    }
  }
  push(words.length);
  return chunks;
}

/** Lowercased letters/digits only — the comparison key for alignment. */
export function normalizeToken(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Map provider-timed tokens onto the chunk's source words. Providers drop
 * punctuation, split or merge tokens, and normalize numbers ("1984" →
 * "nineteen eighty four"), so matching is greedy with a small lookahead;
 * words that never match get times interpolated between their neighbours.
 * Returns null when too little matched to trust (caller estimates instead).
 */
export function alignTimings(words: SourceWord[], tokens: TimedToken[]): WordTimes | null {
  const toks = tokens
    .map((t) => ({ key: normalizeToken(t.text), start: t.start, end: t.end }))
    .filter((t) => t.key && Number.isFinite(t.start) && Number.isFinite(t.end));
  if (!words.length) return [];
  if (!toks.length) return null;
  const times: Array<[number, number] | null> = words.map(() => null);
  const LOOK = 4;
  let j = 0;
  let matched = 0;
  for (let i = 0; i < words.length && j < toks.length; i++) {
    const key = normalizeToken(words[i].text);
    if (!key) continue;
    let found = -1;
    for (let k = j; k < Math.min(toks.length, j + LOOK); k++) {
      if (toks[k].key === key) { found = k; break; }
    }
    if (found >= 0) {
      times[i] = [toks[found].start, toks[found].end];
      j = found + 1;
      matched++;
      continue;
    }
    // Provider split one source word into several tokens ("don't" → "don", "t").
    let acc = "";
    for (let k = j; k < Math.min(toks.length, j + LOOK); k++) {
      acc += toks[k].key;
      if (acc === key) { times[i] = [toks[j].start, toks[k].end]; j = k + 1; matched++; found = k; break; }
      if (!key.startsWith(acc)) break;
    }
  }
  if (matched < Math.max(1, Math.ceil(words.length * 0.5))) return null;
  // Interpolate unmatched words between known anchors.
  const lastEnd = toks[toks.length - 1].end;
  for (let i = 0; i < words.length; i++) {
    if (times[i]) continue;
    let a = i - 1;
    while (a >= 0 && !times[a]) a--;
    let b = i + 1;
    while (b < words.length && !times[b]) b++;
    const t0 = a >= 0 ? times[a]![1] : 0;
    const t1 = b < words.length ? times[b]![0] : Math.max(t0, lastEnd);
    const n = b - a - 1;
    const step = (t1 - t0) / Math.max(1, n);
    for (let k = a + 1; k < b; k++) {
      const idx = k - a - 1;
      times[k] = [t0 + step * idx, t0 + step * (idx + 1)];
    }
    i = b - 1;
  }
  return times as WordTimes;
}

/** Pause weight (in "letters") a word's trailing punctuation adds. */
function pauseWeight(w: string): number {
  if (/[.!?…]["'”’)\]]*$/.test(w)) return 6;
  if (/[,;:—–]["'”’)\]]*$/.test(w)) return 3;
  return 0;
}

/**
 * Estimated word times spread across `duration` seconds, weighted by letter
 * count (+1 for the inter-word gap) and punctuation pauses. Re-syncs at every
 * chunk boundary, so drift stays within a sentence or two.
 */
export function estimateTimings(words: SourceWord[], duration: number): WordTimes {
  if (!words.length) return [];
  const weights = words.map((w) => Math.max(1, normalizeToken(w.text).length) + 1 + pauseWeight(w.text));
  const total = weights.reduce((a, b) => a + b, 0);
  const d = Math.max(0.05, duration);
  const out: WordTimes = [];
  let t = 0;
  for (let i = 0; i < words.length; i++) {
    const span = (weights[i] / total) * d;
    // The pause belongs after the word is spoken, not inside its highlight.
    const pause = (pauseWeight(words[i].text) / total) * d;
    out.push([t, t + span - pause]);
    t += span;
  }
  return out;
}

/** Browser voices report no duration: a speaking-rate guess in seconds. */
export function estimateDuration(text: string, rate = 1): number {
  const CHARS_PER_SEC = 14.5;
  return text.length / (CHARS_PER_SEC * Math.max(0.25, rate));
}

/**
 * Index of the word being spoken at time `t` (the last word whose start is
 * ≤ t), or -1 before the first. `hint` (the previous result) makes the common
 * case O(1): playback only moves forward a word or two per frame.
 */
export function wordAtTime(times: WordTimes, t: number, hint = -1): number {
  const n = times.length;
  if (!n || t < times[0][0]) return -1;
  if (hint >= 0 && hint < n && times[hint][0] <= t) {
    let i = hint;
    while (i + 1 < n && times[i + 1][0] <= t) i++;
    if (i - hint < 4) return i;
  }
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Word index containing a source char offset (e.g. a boundary charIndex). */
export function wordAtOffset(words: SourceWord[], offset: number, from = 0, to = words.length): number {
  let lo = from;
  let hi = to - 1;
  if (hi < lo) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return words[lo].start <= offset ? lo : from;
}

// ── Gamification ─────────────────────────────────────────────────────────

export interface ReadAlongStats {
  xp: number;
  wordsHeard: number;
  pagesFinished: number;
  bestCombo: number;
  /** Consecutive days meeting the daily goal. */
  streak: number;
  /** YYYY-MM-DD (local) of the last day the goal was met. */
  lastGoalDay: string | null;
  /** YYYY-MM-DD (local) that `todayWords` counts. */
  day: string | null;
  todayWords: number;
}

export const DAILY_WORD_GOAL = 300;

export const EMPTY_STATS: ReadAlongStats = {
  xp: 0, wordsHeard: 0, pagesFinished: 0, bestCombo: 0, streak: 0, lastGoalDay: null, day: null, todayWords: 0,
};

/** Total XP needed to reach `level` (level 1 = 0 XP). Gently quadratic. */
export function xpForLevel(level: number): number {
  const n = Math.max(0, level - 1);
  return 50 * n * n + 150 * n;
}

export function levelInfo(xp: number): { level: number; into: number; span: number } {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  const base = xpForLevel(level);
  return { level, into: xp - base, span: xpForLevel(level + 1) - base };
}

/** Combo multiplier for an unbroken listening run of `combo` words. */
export function comboMultiplier(combo: number): number {
  if (combo >= 600) return 3;
  if (combo >= 250) return 2;
  if (combo >= 100) return 1.5;
  return 1;
}

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** The streak as it stands today: broken if the goal was last met before yesterday. */
export function liveStreak(stats: ReadAlongStats, today: string): number {
  if (!stats.lastGoalDay) return 0;
  return dayDiff(stats.lastGoalDay, today) <= 1 ? stats.streak : 0;
}

/**
 * Credit `words` newly heard words at combo `combo`. Pure: returns the next
 * stats plus what just happened, so the UI can celebrate level-ups and goals.
 */
export function creditWords(
  stats: ReadAlongStats,
  words: number,
  combo: number,
  today: string,
): { stats: ReadAlongStats; gainedXp: number; leveledUp: number | null; goalMet: boolean } {
  if (words <= 0) return { stats, gainedXp: 0, leveledUp: null, goalMet: false };
  const gainedXp = words * comboMultiplier(combo);
  const before = levelInfo(stats.xp).level;
  const todayWords = (stats.day === today ? stats.todayWords : 0) + words;
  let { streak, lastGoalDay } = stats;
  let goalMet = false;
  if (todayWords >= DAILY_WORD_GOAL && lastGoalDay !== today) {
    streak = lastGoalDay && dayDiff(lastGoalDay, today) === 1 ? streak + 1 : 1;
    lastGoalDay = today;
    goalMet = true;
  }
  const next: ReadAlongStats = {
    ...stats,
    xp: stats.xp + gainedXp,
    wordsHeard: stats.wordsHeard + words,
    bestCombo: Math.max(stats.bestCombo, combo),
    day: today,
    todayWords,
    streak,
    lastGoalDay,
  };
  const after = levelInfo(next.xp).level;
  return { stats: next, gainedXp, leveledUp: after > before ? after : null, goalMet };
}
