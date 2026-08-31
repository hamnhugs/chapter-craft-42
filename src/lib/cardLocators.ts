import { supabase } from "@/integrations/supabase/client";
import { anchorQuote, approxPage } from "@/lib/bookSearch";
import type { Chapter } from "@/types/library";

/**
 * Card locators — the dual-mode client for Card Catalog Stage 2
 * (docs/stage2-card-pointers.md; migration 20260831130000_card_locators.sql,
 * applied OUT-OF-BAND via Lovable, so every path here feature-detects).
 *
 * A locator is a VERIFIED pointer into the user's immutable chapters. The
 * quote is the key — models and the capture flow supply the QUOTE they read,
 * and the app anchors it to exact offsets (models cannot count characters;
 * the app can). Offsets are UTF-16 code units into chapters.text_content,
 * the unit get_chapter_text already slices with. Book/chapter names are
 * DENORMALIZED into the locator at write time so prompt rendering never
 * resolves liveness against client state (identical DB state ⇒ identical
 * prompt bytes on every device; read_span is the sole liveness authority).
 *
 * The poisoning defense lives in TWO places (design §2): writes are
 * validated fail-closed here, and read_span RE-VERIFIES every dereference
 * against the chapter text and serves the chapter's actual bytes — a bogus
 * locator can only ever produce real text or an honest failure, never fake
 * provenance.
 *
 * SCHEMA AVAILABILITY follows the shelf-membership law: the FIRST REAL
 * read/write is the probe. Only missing-schema codes (42703 read /
 * PGRST204 write / PGRST202+42883 RPC) may cache "missing" for the session;
 * transient errors stay re-probeable. Lovable can apply the migration
 * mid-session — the session stays degraded until reload (documented;
 * degraded results carry an honest note).
 */

export interface CardLocator {
  chapter_id: string;
  char_start: number;
  char_end: number;
  /** Approximate page, derived from the chapter's page range at write time.
   *  Display only. */
  page: number;
  /** 8..160 chars of the passage — UNTRUSTED (book/OCR/model supplied);
   *  every prompt/tool door sanitizes and fences it on read. */
  quote: string;
  /** Optional relation of the card's claim to this passage. ≤24 chars. */
  stance?: string;
  /** Denormalized display provenance, stamped at write. UNTRUSTED names. */
  book_id?: string;
  book_title?: string;
  chapter_name?: string;
}

/** What writers may hand in: quote required; offsets optional (verified when
 *  present, anchored by search when absent). */
export interface LocatorInput {
  chapter_id?: unknown;
  quote?: unknown;
  char_start?: unknown;
  char_end?: unknown;
  stance?: unknown;
}

export const MAX_LOCATORS_PER_CARD = 8; // NISO §9.1: no undifferentiated runs
export const QUOTE_MIN = 8;
export const QUOTE_MAX = 160;
export const SPAN_MAX = 6000;
export const MAX_ALIASES = 6;
export const ALIAS_MAX = 60;
const STANCE_MAX = 24;
const NAME_MAX = 80;

// ── Schema availability (first-read-is-the-probe) ───────────────────────────

/** Missing-column/RPC signatures, same convention as
 *  isMissingSupersessionSchema. */
export function isCardSchemaMissing(err: unknown): boolean {
  const code = (err as any)?.code || "";
  const msg = ((err as any)?.message || String(err || "")).toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST202" ||
    code === "42883" ||
    (/locators|aliases|author|entry_locators_merge/.test(msg) && /not exist|could not find|schema cache|unknown/.test(msg))
  );
}

/** null = unknown (no real read has answered yet) · true = columns live ·
 *  false = migration not applied (cached for the session). */
let cardSchemaState: boolean | null = null;

export function cardSchemaKnownMissing(): boolean {
  return cardSchemaState === false;
}

/** True only once a real read/write has CONFIRMED the columns exist. The
 *  difference from !cardSchemaKnownMissing() matters for anything that
 *  should stand down until it knows: before the first probe the state is
 *  UNKNOWN, and a teaching gate armed on unknown demands a locator the
 *  database may not be able to store (review finding). */
export function cardSchemaKnownPresent(): boolean {
  return cardSchemaState === true;
}

/** Callers report what their REAL read/write just learned. Only definitive
 *  outcomes change the cache; transient failures leave it re-probeable. */
export function noteCardSchema(outcome: "present" | "missing"): void {
  cardSchemaState = outcome === "present";
}

/** Tests only. */
export function resetCardLocatorAvailability(): void {
  cardSchemaState = null;
}

/** The honest note degraded write results carry. */
export const CARD_SCHEMA_MISSING_NOTE =
  "Locators are unavailable — the card-locators migration (20260831130000) is not applied to the database yet (or the app needs a reload after applying it).";

// ── Parsing / normalization ─────────────────────────────────────────────────

/** Defensive parse of a DB jsonb value into well-formed locators. Junk
 *  elements are dropped, never thrown on — the DB CHECK is loose by design. */
export function parseLocators(raw: unknown): CardLocator[] {
  if (!Array.isArray(raw)) return [];
  const out: CardLocator[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    // chapter_id is UNTRUSTED like every other stored field — it reaches the
    // prompt as a rendered locator line. It is clipped here (and sanitized at
    // every render site) so a hostile stored value cannot carry structure:
    // review finding, it was the one field that skipped containment.
    const chapterId = typeof o.chapter_id === "string" ? o.chapter_id.trim().slice(0, 64) : "";
    const start = typeof o.char_start === "number" && Number.isFinite(o.char_start) ? Math.floor(o.char_start) : -1;
    const end = typeof o.char_end === "number" && Number.isFinite(o.char_end) ? Math.floor(o.char_end) : -1;
    const quote = typeof o.quote === "string" ? o.quote : "";
    if (!chapterId || start < 0 || end <= start || !quote) continue;
    const str = (k: string, max: number): string | undefined => {
      const s = typeof o[k] === "string" ? (o[k] as string).trim().slice(0, max) : "";
      return s || undefined;
    };
    out.push({
      chapter_id: chapterId,
      char_start: start,
      char_end: end,
      page: typeof o.page === "number" && Number.isFinite(o.page) ? Math.floor(o.page) : 0,
      quote: quote.slice(0, QUOTE_MAX),
      ...(str("stance", STANCE_MAX) ? { stance: str("stance", STANCE_MAX) } : {}),
      ...(str("book_id", 64) ? { book_id: str("book_id", 64) } : {}),
      ...(str("book_title", NAME_MAX) ? { book_title: str("book_title", NAME_MAX) } : {}),
      ...(str("chapter_name", NAME_MAX) ? { chapter_name: str("chapter_name", NAME_MAX) } : {}),
    });
    if (out.length >= MAX_LOCATORS_PER_CARD) break;
  }
  return out;
}

/** Plain optional-field shape (this repo compiles strict:false, where
 *  boolean-discriminant unions do not narrow). ok:true ⇒ locator+occurrences
 *  set; ok:false ⇒ error set. */
export interface LocatorResolution {
  ok: boolean;
  locator?: CardLocator;
  occurrences?: number;
  error?: string;
}

export interface LocatorChapterCtx {
  chapter: Pick<Chapter, "id" | "startPage" | "endPage">;
  chapterName: string;
  bookId: string;
  bookTitle: string;
  /** The chapter's FULL text. The caller loads it through the STRICT channel
   *  and must handle load failures BEFORE calling — an empty string here
   *  means the chapter truly has no text. */
  text: string;
}

/**
 * Resolve one writer-supplied locator against the chapter's REAL text —
 * fail-closed. Offsets present ⇒ verified; absent ⇒ the quote is anchored by
 * the shared search predicate (find and verify can never disagree).
 */
export function resolveLocatorInput(input: LocatorInput, ctx: LocatorChapterCtx): LocatorResolution {
  const quoteRaw = typeof input.quote === "string" ? input.quote.trim() : "";
  if (quoteRaw.length < QUOTE_MIN) {
    return { ok: false, error: `quote is required (${QUOTE_MIN}..${QUOTE_MAX} chars of the passage's exact wording)` };
  }
  const quote = quoteRaw.slice(0, QUOTE_MAX);
  if (!ctx.text) {
    return { ok: false, error: "that chapter has no text to anchor into" };
  }

  const denorm = {
    book_id: ctx.bookId,
    book_title: (ctx.bookTitle || "Untitled").slice(0, NAME_MAX),
    chapter_name: (ctx.chapterName || "").slice(0, NAME_MAX),
  };

  const givenStart = typeof input.char_start === "number" && Number.isFinite(input.char_start) ? Math.floor(input.char_start) : null;
  const givenEnd = typeof input.char_end === "number" && Number.isFinite(input.char_end) ? Math.floor(input.char_end) : null;

  if (givenStart !== null || givenEnd !== null) {
    if (givenStart === null || givenEnd === null || givenStart < 0 || givenEnd <= givenStart || givenEnd > ctx.text.length) {
      return { ok: false, error: `char_start/char_end must satisfy 0 <= start < end <= ${ctx.text.length} (this chapter's length) — or omit them and the quote will be located automatically` };
    }
    if (givenEnd - givenStart > SPAN_MAX) {
      return { ok: false, error: `span too large (${givenEnd - givenStart} chars; max ${SPAN_MAX}) — a locator points at a passage, not a whole chapter` };
    }
    const hit = anchorQuote(ctx.text.slice(givenStart, givenEnd), quote);
    if (!hit) {
      return { ok: false, error: "the quote does not occur inside the given span — copy the wording exactly as the chapter has it, or omit char_start/char_end to locate the quote automatically" };
    }
    return {
      ok: true,
      // The real count inside the given span — reporting a hard 1 would hide
      // ambiguity the caller is entitled to hear about (design §2).
      occurrences: hit.occurrences,
      locator: {
        chapter_id: ctx.chapter.id,
        char_start: givenStart,
        char_end: givenEnd,
        page: approxPage(ctx.chapter, givenStart, ctx.text.length),
        quote,
        ...stanceOf(input),
        ...denorm,
      },
    };
  }

  const hit = anchorQuote(ctx.text, quote);
  if (!hit) {
    return { ok: false, error: "quote not found in that chapter — copy the wording exactly as the book has it (whitespace and quote-glyph differences are fine; spelling must match, including any OCR quirks)" };
  }
  return {
    ok: true,
    occurrences: hit.occurrences,
    locator: {
      chapter_id: ctx.chapter.id,
      char_start: hit.start,
      char_end: hit.end,
      page: approxPage(ctx.chapter, hit.start, ctx.text.length),
      quote,
      ...stanceOf(input),
      ...denorm,
    },
  };
}

function stanceOf(input: LocatorInput): { stance?: string } {
  const s = typeof input.stance === "string" ? input.stance.trim().slice(0, STANCE_MAX) : "";
  return s ? { stance: s } : {};
}

/** Read-time re-verification (read_span): does the card's quote still match
 *  the text at the stored span? The caller serves the span either way when
 *  verified, and re-anchors the quote when not (never the stored offsets'
 *  bytes — see design §3). */
export function verifyStoredLocator(loc: CardLocator, text: string): { inBounds: boolean; verified: boolean } {
  if (!text || loc.char_start < 0 || loc.char_end <= loc.char_start || loc.char_start >= text.length) {
    return { inBounds: false, verified: false };
  }
  const slice = text.slice(loc.char_start, Math.min(loc.char_end, text.length));
  return { inBounds: true, verified: anchorQuote(slice, loc.quote) !== null };
}

/** Dedupe key: same chapter + same span is the same pointer. Same span with
 *  a different stance keeps the FIRST (counted as duplicate, deterministic). */
export function locatorKey(l: CardLocator): string {
  return `${l.chapter_id}:${l.char_start}:${l.char_end}`;
}

/** Client-side append with dedupe under the per-card cap — used for FRESH
 *  entries (no concurrent writer can hold a just-minted id) and by tests.
 *  EXISTING entries merge server-side via entry_locators_merge instead. */
export function mergeLocators(
  existing: CardLocator[],
  additions: CardLocator[],
): { merged: CardLocator[]; added: number; duplicates: number; overflow: number } {
  const seen = new Set(existing.map(locatorKey));
  const merged = [...existing];
  let added = 0, duplicates = 0, overflow = 0;
  for (const l of additions) {
    const k = locatorKey(l);
    if (seen.has(k)) { duplicates++; continue; }
    if (merged.length >= MAX_LOCATORS_PER_CARD) { overflow++; continue; }
    seen.add(k);
    merged.push(l);
    added++;
  }
  return { merged, added, duplicates, overflow };
}

/** Normalize writer-supplied aliases into register terms. */
export function normalizeAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const a = v.trim().toLowerCase().replace(/\s+/g, " ").slice(0, ALIAS_MAX);
    if (a.length < 2 || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/** The register key for a label: the same normalization aliases get. */
export function registerKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── DB helpers (all feature-detecting; results carry honest state) ──────────

export interface WriteCardFieldsResult {
  written: boolean;
  missingSchema: boolean;
  error?: string;
}

/** PATCH the Stage 2 columns onto one entry (fresh entries / non-locator
 *  fields). Distinguishes "migration not applied" from a real failure — and
 *  a missing-schema code AFTER the schema was seen present this session is
 *  PostgREST schema-cache lag: retriable, never a mode flip. */
export async function writeCardFields(
  entryId: string,
  fields: { locators?: CardLocator[]; aliases?: string[]; author?: "user" | "assistant" },
): Promise<WriteCardFieldsResult> {
  if (cardSchemaKnownMissing()) return { written: false, missingSchema: true };
  const payload: Record<string, unknown> = {};
  if (fields.locators !== undefined) payload.locators = fields.locators;
  if (fields.aliases !== undefined) payload.aliases = fields.aliases;
  if (fields.author !== undefined) payload.author = fields.author;
  if (Object.keys(payload).length === 0) return { written: true, missingSchema: false };
  const { error } = await supabase
    .from("knowledge_entries")
    .update(payload as any)
    .eq("id", entryId);
  if (error) {
    if (isCardSchemaMissing(error)) {
      if (cardSchemaState === true) {
        return { written: false, missingSchema: false, error: "schema not ready yet (cache lag) — retry in a moment" };
      }
      noteCardSchema("missing");
      return { written: false, missingSchema: true };
    }
    return { written: false, missingSchema: false, error: error.message };
  }
  noteCardSchema("present");
  return { written: true, missingSchema: false };
}

export interface MergeViaRpcResult {
  ok: boolean;
  locators?: CardLocator[];
  /** How many of the supplied locators actually LANDED. The RPC dedupes by
   *  span and caps at 8, so the supplied count is not an outcome — reporting
   *  it as one told users "anchored to 3 passages" when zero were added
   *  (review finding). Computed by diffing span keys across the merge. */
  added?: number;
  /** Supplied locators already present on the card. */
  duplicates?: number;
  /** Supplied locators the per-card cap refused. */
  capped?: number;
  missingSchema?: boolean;
  error?: string;
}

/** Merge validated locators into an EXISTING entry atomically (server-side
 *  dedupe + cap under a row lock — concurrent adds commute). */
export async function mergeLocatorsViaRpc(
  entryId: string,
  additions: CardLocator[],
  /** The card's locators as the caller last saw them. Supplied where the
   *  caller already holds them, so the outcome can be reported honestly
   *  without a second read; omitted, `added` is simply not claimed. */
  knownBefore?: CardLocator[],
): Promise<MergeViaRpcResult> {
  if (cardSchemaKnownMissing()) return { ok: false, missingSchema: true, error: CARD_SCHEMA_MISSING_NOTE };
  const { data, error } = await supabase.rpc("entry_locators_merge" as any, {
    _id: entryId,
    _add: additions as any,
  });
  if (error) {
    if (isCardSchemaMissing(error)) {
      if (cardSchemaState === true) {
        return { ok: false, missingSchema: false, error: "schema not ready yet (cache lag) — retry in a moment" };
      }
      noteCardSchema("missing");
      return { ok: false, missingSchema: true, error: CARD_SCHEMA_MISSING_NOTE };
    }
    return { ok: false, missingSchema: false, error: error.message };
  }
  noteCardSchema("present");
  const merged = parseLocators(data);
  // Outcome by span-key diff against the merged truth the server returned:
  // present after and absent before = added; present before = duplicate;
  // absent after = the cap refused it.
  const after = new Set(merged.map(locatorKey));
  const before = new Set((knownBefore || []).map(locatorKey));
  let added = 0, duplicates = 0, capped = 0;
  for (const l of additions) {
    const k = locatorKey(l);
    if (before.has(k)) duplicates++;
    else if (after.has(k)) added++;
    else capped++;
  }
  return {
    ok: true,
    locators: merged,
    ...(knownBefore ? { added, duplicates, capped } : {}),
  };
}

export interface RegisterMatch {
  id: string;
  title: string;
  contentHead: string;
  author: string | null;
  locators: CardLocator[];
  aliases: string[];
  /** Which key matched: the normalized title or one of the aliases. */
  matchedOn: "title" | "alias";
}

/** ilike as a case-folding PROBE only — exactness is guaranteed client-side
 *  below, because escaping alone cannot deliver it: PostgREST maps `*` to
 *  `%` AFTER URL decoding and no escape survives that (`\*` becomes `\%`).
 *  So `*` is mapped to `_` (one position, matches the literal `*`) exactly
 *  as resolveScene does — this repo's settled convention for the identical
 *  bug (src/lib/scenesApi.ts). Without it a card titled `*` would ilike-match
 *  every card in the wiki, and the register would offer a merge into the
 *  wrong one. */
function escapeIlikeProbe(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1").replace(/\*/g, "_");
}

/**
 * Register lookup: does a card with this label (or these aliases) already
 * exist in the wiki? Server filters only NARROW; the authoritative gate is
 * the client-side normalized-exact comparison below — no fuzzy matching, no
 * wildcard risk. Returns [] on any error (lookup failure must not block a
 * create; the register is an optimization of card hygiene, not a
 * correctness gate).
 */
export async function findRegisterMatches(
  wikiId: string,
  title: string,
  aliases: string[],
): Promise<RegisterMatch[]> {
  const keys = new Set<string>();
  const titleKey = registerKey(title);
  if (titleKey) keys.add(titleKey);
  for (const a of aliases) keys.add(a);
  if (keys.size === 0) return [];

  const wantLocators = !cardSchemaKnownMissing();
  const baseCols = "id, title, content, entry_type";
  // superseded_by rides only with the Stage-2 columns: any DB that has them
  // also has the (older) bitemporal schema, while the fallback col set must
  // stay valid on the oldest schema this client can meet.
  const cols = wantLocators ? `${baseCols}, author, locators, aliases, superseded_by` : baseCols;

  const runTitleQuery = async (columns: string) => {
    let q: any = supabase
      .from("knowledge_entries")
      .select(columns)
      .eq("wiki_id", wikiId)
      .ilike("title", escapeIlikeProbe(titleKey))
      .limit(6);
    return q;
  };

  try {
    let usedCols = cols;
    let titleRes = await runTitleQuery(usedCols);
    if (titleRes.error && wantLocators && isCardSchemaMissing(titleRes.error)) {
      noteCardSchema("missing");
      usedCols = baseCols;
      titleRes = await runTitleQuery(usedCols);
    }
    if (titleRes.error) return [];
    if (usedCols === cols && wantLocators) noteCardSchema("present");

    let aliasRows: any[] = [];
    if (keys.size > 0 && usedCols !== baseCols) {
      // Builder-encoded overlap — never a hand-built array literal.
      const { data, error } = await supabase
        .from("knowledge_entries")
        .select(usedCols)
        .eq("wiki_id", wikiId)
        .overlaps("aliases", [...keys])
        .limit(6);
      if (!error && Array.isArray(data)) aliasRows = data;
    }

    const rows = [...(Array.isArray(titleRes.data) ? titleRes.data : []), ...aliasRows];
    const seen = new Set<string>();
    const out: RegisterMatch[] = [];
    for (const r of rows) {
      if (!r?.id || seen.has(r.id)) continue;
      // Living entries only — superseded rows belong to history (the field
      // rides with the Stage-2 col set; the legacy fallback can't filter and
      // surfacing a retired match there is harmless).
      if ((r as any).superseded_by) continue;
      seen.add(r.id);
      const rowAliases: string[] = Array.isArray(r.aliases) ? r.aliases.filter((a: unknown): a is string => typeof a === "string") : [];
      const titleMatches = registerKey(String(r.title || "")) === titleKey;
      const aliasMatches = rowAliases.some((a) => keys.has(a)) || keys.has(registerKey(String(r.title || "")));
      // AUTHORITATIVE exact check — server ilike/overlap only narrowed.
      if (!titleMatches && !aliasMatches) continue;
      out.push({
        id: r.id,
        title: String(r.title || ""),
        contentHead: String(r.content || "").slice(0, 200),
        author: typeof r.author === "string" ? r.author : null,
        locators: parseLocators(r.locators),
        aliases: rowAliases,
        matchedOn: titleMatches ? "title" : "alias",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Best-effort vibrancy bump on dereference (read_span): reading a card's
 *  spans is the "use" the ACT-R stats were always meant to measure, and
 *  knowledge-retrieve already boosts vibrancy on every retrieval — this
 *  mirrors that existing permissionless use-statistic semantic. Isolated
 *  from the main entry fetch (a DB without the brain-memory migrations
 *  42703s on the column — that must never fail the tool); swallows every
 *  error; a lost bump in a read-then-write race is accepted for a
 *  statistic. */
export async function bumpVibrancy(entryId: string): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("knowledge_entries")
      .select("vibrancy")
      .eq("id", entryId)
      .maybeSingle();
    if (error || !data) return;
    const v = (data as any).vibrancy;
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    const next = Math.min(1, Math.round((v + 0.04) * 1000) / 1000);
    if (next <= v) return;
    await supabase.from("knowledge_entries").update({ vibrancy: next } as any).eq("id", entryId);
  } catch {
    /* best effort */
  }
}
