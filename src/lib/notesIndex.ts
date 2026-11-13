import { supabase } from "@/integrations/supabase/client";
import { parseLocators, type CardLocator } from "@/lib/cardLocators";

/**
 * The notes index — the always-loaded half of the memory design.
 *
 * Counsel gets one line per note in the open notebooks: a short ref, the
 * title, a one-line hook, and the page it points to. Bodies stay out of the
 * prompt; the model opens a note (search_wiki entry_id) or its book passage
 * (read_span) when it needs the detail. This is the pattern behind Claude
 * Code's MEMORY.md and Vercel's AGENTS.md index: the list of what exists is
 * always present (models skip optional lookups about half the time), the
 * detail is fetched on demand (long context degrades answers — Chroma's
 * "context rot" study).
 *
 * The index is part of the STABLE system prompt, so it is ordered by
 * creation time (newest first) — retrieval bumps must never reorder it, or
 * every turn would re-bill the prompt cache.
 */

export const HOOK_MAX = 160;

/** Characters of index per prompt. Voice skips it: a spoken turn wants the
 *  shortest prompt, and per-turn retrieval still covers it. */
export const NOTES_INDEX_CHAR_BUDGET = { chat: 8_000, deep: 16_000, voice: 0 } as const;

/** Most notes the index ever lists, before the character budget. */
const INDEX_ROW_CAP = 400;

export interface IndexNote {
  id: string;
  title: string;
  hook: string | null;
  /** Only filled for notes without a hook (fallback text). */
  content: string;
  entry_type: string;
  locators: CardLocator[];
  aliases: string[];
  wiki_id: string | null;
  created_at: string;
}

/** Normalize a hook from any writer: one line, trimmed, bounded. */
export function cleanHook(raw: unknown): string | null {
  const h = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'“]+|["'”]+$/g, "");
  if (h.length < 8) return null;
  return h.length > HOOK_MAX ? `${h.slice(0, HOOK_MAX - 1).trimEnd()}…` : h;
}

/** A hook-shaped line from a note's body, for notes still waiting on the
 *  Sleep Cycle to write a real one: the first sentence, bounded. */
export function fallbackHook(content: string, max = 140): string {
  const flat = String(content || "")
    .replace(/[#>*_`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  const sentence = flat.match(/^.{20,}?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Stable short ref for a note: the first 8 hex digits of its id. Cheap in
 *  tokens, unique in practice, and resolved back by resolveNoteRef. */
export function noteRef(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

// ── Cache ───────────────────────────────────────────────────────────────────
// One read per scope until notes change (any write dispatches
// "knowledge-entries-changed"), with a short TTL as a backstop for writes
// made in another tab.
const TTL_MS = 60_000;
let cache: { key: string; at: number; notes: IndexNote[] } | null = null;
/** ref → full id, across every index served this session. */
const refs = new Map<string, string>();

if (typeof window !== "undefined") {
  try { window.addEventListener("knowledge-entries-changed", () => { cache = null; }); } catch { /* non-browser */ }
}

/** A tool argument that may be a short ref → the full entry id. Full ids
 *  and unknown values pass through unchanged (the tool reports not-found). */
export function resolveNoteRef(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return /^[0-9a-f]{8}$/.test(v) ? refs.get(v) ?? value : value;
}

/**
 * Living notes in scope (null = every notebook), newest first. Self-built
 * tool/program cards are excluded — they have their own roster.
 */
export async function fetchNotesIndex(wikiIds: string[] | null): Promise<IndexNote[]> {
  const key = wikiIds ? [...wikiIds].sort().join(",") : "*";
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.notes;
  let q = supabase
    .from("knowledge_entries")
    .select("id, title, hook, entry_type, locators, aliases, wiki_id, created_at" as any)
    .is("superseded_by", null)
    .eq("archived", false)
    .not("entry_type", "in", "(tool,program)")
    .order("created_at", { ascending: false })
    .limit(INDEX_ROW_CAP);
  if (wikiIds && wikiIds.length > 0) q = q.in("wiki_id", wikiIds);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []) as any[];
  // Bodies only for notes still without a hook — usually none.
  const needBody = rows.filter((r) => !cleanHook(r.hook)).map((r) => r.id as string);
  const bodies = new Map<string, string>();
  if (needBody.length > 0) {
    const { data: b } = await supabase
      .from("knowledge_entries")
      .select("id, content")
      .in("id", needBody.slice(0, 200));
    for (const r of (b || []) as any[]) bodies.set(r.id, String(r.content || ""));
  }
  const notes: IndexNote[] = rows.map((r) => ({
    id: r.id,
    title: String(r.title || ""),
    hook: cleanHook(r.hook),
    content: bodies.get(r.id) || "",
    entry_type: String(r.entry_type || "fact"),
    locators: parseLocators(r.locators),
    aliases: Array.isArray(r.aliases) ? r.aliases.filter((a: unknown): a is string => typeof a === "string") : [],
    wiki_id: r.wiki_id ?? null,
    created_at: String(r.created_at || ""),
  }));
  for (const n of notes) refs.set(noteRef(n.id), n.id);
  cache = { key, at: Date.now(), notes };
  return notes;
}

/** Where a note points, as a reader would cite it: (Book, p. 214). */
export function noteAnchor(n: Pick<IndexNote, "locators">): string {
  const l = n.locators[0];
  if (!l) return "";
  const more = n.locators.length > 1 ? ` +${n.locators.length - 1}` : "";
  return `${l.book_title ? `${l.book_title}, ` : ""}p. ${l.page}${more}`;
}

/**
 * Render the index lines, newest first, until the budget is spent. `clean`
 * sanitizes untrusted text for the prompt (titles and hooks are user data).
 */
export function renderIndexLines(
  notes: IndexNote[],
  budget: number,
  clean: (text: string, max: number) => string,
): { lines: string[]; shown: number } {
  const lines: string[] = [];
  let used = 0;
  for (const n of notes) {
    const hook = n.hook || fallbackHook(n.content);
    const anchor = noteAnchor(n);
    const line = `- [${noteRef(n.id)}] ${clean(n.title, 90) || "(untitled)"}${hook ? ` — ${clean(hook, HOOK_MAX)}` : ""}${anchor ? ` (${clean(anchor, 80)})` : ""}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, shown: lines.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Notes the user named in their message (title or alias, whole words,
 * case-insensitive). Named notes are opened by the app, not left to the
 * model: "Never make the model decide whether memory exists" — when the
 * user says the name, the app already knows which note they mean.
 */
export function namedNotes(query: string | undefined, notes: IndexNote[], max = 2): IndexNote[] {
  const q = (query || "").toLowerCase();
  if (q.length < 4) return [];
  const hits: { n: IndexNote; len: number }[] = [];
  for (const n of notes) {
    const names = [n.title, ...n.aliases].map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 4);
    let best = 0;
    for (const name of names) {
      if (name.length > best && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, "u").test(q)) best = name.length;
    }
    if (best > 0) hits.push({ n, len: best });
  }
  // Longest name first: "Stoic dichotomy of control" beats "control".
  return hits.sort((a, b) => b.len - a.len).slice(0, max).map((h) => h.n);
}

/** Full text for a few notes (the ones the user named this turn). */
export async function fetchNoteBodies(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase.from("knowledge_entries").select("id, content").in("id", ids);
  if (error) throw error;
  for (const r of (data || []) as any[]) out.set(r.id, String(r.content || ""));
  return out;
}
