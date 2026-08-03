import { listMasterAssets, resolveMaster, type MasterAssetRow } from "@/lib/masterAssets";

// @mention support for the chat composer. Typing "@robby" used to be literal
// text — the model only learned the master existed if it happened to pass the
// handle into a tool param. These helpers (a) find/complete handles while the
// user types and (b) pre-resolve them at send time so the outgoing message
// carries the real ids and the model never needs a list_master_assets
// round-trip just to discover them.

/** Token grammar mirrors NAME_RE in masterAssets.ts (2-40 chars, alnum start).
 *  The leading guard rejects an "@" glued to a word ("foo@bar.com" is an email,
 *  "@@x" is noise) — only start-of-text or a non-name character may precede. */
const MENTION_SCAN_RE = /(^|[^a-z0-9_@-])@([a-z0-9][a-z0-9_-]{1,39})/gi;

/** Characters that may appear after the "@" in a handle. */
const NAME_CHAR_RE = /[a-z0-9_-]/i;

/** All @handles in `text`, lowercased (master names are stored lowercase) and
 *  deduped case-insensitively, in first-appearance order. */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const src = String(text || "");
  MENTION_SCAN_RE.lastIndex = 0; // the regex is module-level and sticky via /g
  let m: RegExpExecArray | null;
  while ((m = MENTION_SCAN_RE.exec(src))) {
    const handle = m[2].toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

export interface ResolvedMention {
  handle: string;
  found: boolean;
  id?: string;
  name?: string;
  hasBlueprint?: boolean;
}

/** Resolve every @handle in `text` against the master_assets table. A lookup
 *  failure degrades to found:false — the note this feeds is advisory, so a
 *  flaky network must never make it throw. */
export async function resolveMentions(text: string): Promise<ResolvedMention[]> {
  const handles = extractMentions(text);
  return Promise.all(
    handles.map(async (handle): Promise<ResolvedMention> => {
      try {
        const row = await resolveMaster(handle);
        return row
          ? { handle, found: true, id: row.id, name: row.name, hasBlueprint: !!row.blueprint }
          : { handle, found: false };
      } catch {
        return { handle, found: false };
      }
    }),
  );
}

/** Compact bracketed context line appended to the outgoing message, e.g.
 *  "[Master assets referenced: @robby (id …, has blueprint) — not found: @typo]".
 *  Null when there were no mentions at all. */
export function buildMentionNote(resolved: ResolvedMention[]): string | null {
  if (!resolved.length) return null;
  const found = resolved.filter((r) => r.found);
  const missing = resolved.filter((r) => !r.found);
  const foundPart = found
    .map((r) => `@${r.name || r.handle} (id ${r.id}${r.hasBlueprint ? ", has blueprint" : ""})`)
    .join(" · ");
  const missingPart = missing.map((r) => `@${r.handle}`).join(", ");
  if (!found.length) return `[Master assets referenced — not found: ${missingPart}]`;
  if (!missing.length) return `[Master assets referenced: ${foundPart}]`;
  return `[Master assets referenced: ${foundPart} — not found: ${missingPart}]`;
}

// ---------------------------------------------------------------------------
// Composer autocomplete helpers (pure caret math, testable without a DOM).
// ---------------------------------------------------------------------------

export interface ActiveMention {
  /** Index of the "@" in the value. */
  start: number;
  /** Lowercased chars typed between "@" and the caret (may be empty). */
  query: string;
}

/** The @-token the caret currently sits in, or null. The "@" must be at the
 *  start of the value or preceded by whitespace, and every char between it and
 *  the caret must be a legal name char — otherwise the caret has left the
 *  token and the popup should close. */
export function findActiveMention(value: string, caret: number): ActiveMention | null {
  if (caret == null || caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const typed = before.slice(at + 1);
  if (typed.length > 40) return null; // longer than any legal handle
  for (const ch of typed) {
    if (!NAME_CHAR_RE.test(ch)) return null;
  }
  return { start: at, query: typed.toLowerCase() };
}

/** End index (exclusive) of the @-token starting at `start` — scans forward
 *  over name chars so accepting a completion mid-token replaces the WHOLE
 *  token, not just the part left of the caret. */
export function mentionTokenEnd(value: string, start: number): number {
  let end = start + 1;
  while (end < value.length && NAME_CHAR_RE.test(value[end])) end++;
  return end;
}

// ---------------------------------------------------------------------------
// Session cache of the master list for the popup. Module-level so it survives
// ChatPanel unmounts (every tab switch) — the popup renders the cached list
// instantly and each open kicks a background refresh.
// ---------------------------------------------------------------------------

let mastersCache: MasterAssetRow[] | null = null;

export function getCachedMasters(): MasterAssetRow[] | null {
  return mastersCache;
}

export async function refreshMastersCache(): Promise<MasterAssetRow[]> {
  try {
    mastersCache = await listMasterAssets();
  } catch {
    // Keep whatever we had — an empty popup is worse than a slightly stale one.
    mastersCache = mastersCache || [];
  }
  return mastersCache;
}
