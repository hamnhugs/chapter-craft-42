// Local tool roster — which tools a model running on THIS machine is offered.
//
// WHY THIS EXISTS. The full roster is 80 tools ≈ 23K tokens of schema
// (measured: docs/local-ai/PLAN.md §1). A hosted model reads that in a
// second; a 4B model on a 6 GiB laptop GPU reads it in ~3-5 minutes. Two
// measurements decide the shape (docs/local-ai/results/):
//   - offered the 8 tools nearest the request by embedding, qwen3.5:4b picked
//     a correct first tool 13/14 with zero invented names, and the right tool
//     was in the 8 every time;
//   - Ollama reuses its KV cache for a byte-identical prefix: against an
//     unchanged 22K-token prefix, follow-up calls took ~10 s instead of 290 s.
//
// Retrieving a fresh 8 every turn would satisfy the first fact and destroy
// the second (tools render near the top of the chat template, so a changed
// roster re-reads everything after it). So the roster is APPEND-ONLY per
// conversation: core tools, plus whatever the conversation has needed so
// far. It grows when a request strongly matches a tool not yet offered, or
// when the model calls `find_tools`. It only shrinks on a new conversation,
// or when it passes ROSTER_CAP, where it is rebuilt once.
//
// It never GRANTS anything. Every name it returns is drawn from the pool the
// turn's gates already allowed (toolAvailability.ts) — permissions, Lean
// Mode, Foundry opt-ins all still apply because the pool is their output.

import { LOCAL_EMBED_MODEL, embedPrefix, ollamaBaseUrl, rosterAutoAddFloor, rosterAutoAddMargin } from "@/lib/providers/ollamaConfig";

/** Always offered (when the gates allow them). Chosen as the tools a reading
 *  conversation reaches for first; everything else is one find_tools away. */
export const LOCAL_CORE_TOOLS = [
  "list_books",
  "get_book",
  "get_chapter_text",
  "search_book_text",
  "set_active_book",
  "search_wiki",
  "create_memory_entry",
  "read_span",
  "web_search",
  "save_file",
] as const;

/** A tool the user named outright joins the roster on any turn, whatever the
 *  embedder scores it: "open the fox in Photoshop" scored craft 0.20 against
 *  a 0.45 floor (eval 2026-10-13), and a request that names the app leaves
 *  no doubt which tool it wants. */
export const LOCAL_NAMED_TOOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:photo|design|film)\s?craft\b|\bphoto\s?shop\b|\bin\s?design\b|\bpremiere\b/i, "craft"],
];

export const FIND_TOOLS_NAME = "find_tools";
/** Matches added per turn from the user's message, at most. */
const PER_TURN_ADDS = 4;
/** Cosine floor for an automatic add — per embedding model, see
 *  rosterAutoAddFloor. Below it the model can still ask. */
const AUTO_ADD_MIN_SCORE = rosterAutoAddFloor(LOCAL_EMBED_MODEL);
/** ...or when the best match clearly leads the rest — see rosterAutoAddMargin. */
const AUTO_ADD_MIN_LEAD = rosterAutoAddMargin(LOCAL_EMBED_MODEL);
/** Past this the roster is rebuilt from core + the current request. */
export const ROSTER_CAP = 24;

export const FIND_TOOLS_DEFINITION = {
  type: "function",
  function: {
    name: FIND_TOOLS_NAME,
    description:
      "Find more of your tools. You only see some of your tools at a time; call this when the user asks for something none of your current tools can do (images, video, wikis, shelves, scenes, programs, deleting things, and more). Describe the action in plain words. The matching tools become available immediately — call them next.",
    parameters: {
      type: "object",
      properties: {
        need: { type: "string", description: "What you need to do, e.g. 'make an image' or 'delete a chapter'." },
      },
      required: ["need"],
    },
  },
} as const;

type ToolDef = { function: { name: string; description?: string; parameters?: any } };

// ---------------------------------------------------------------------------
// Persistence: one roster per user conversation (the app has one running
// chat per user; clearChat starts a new one).
// ---------------------------------------------------------------------------

const key = (userId: string | null) => `localRoster:${userId || "anon"}`;

export function readRoster(userId: string | null): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(userId)) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeRoster(userId: string | null, names: string[]): void {
  try { localStorage.setItem(key(userId), JSON.stringify(names)); } catch { /* storage full/blocked */ }
}

export function resetRoster(userId: string | null): void {
  try { localStorage.removeItem(key(userId)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Ranking: embeddings when the local embedder is up, words when it isn't.
// ---------------------------------------------------------------------------

/** What a tool is matched on: its name in words plus the first part of its
 *  description (the Toolshed finding — function description and when-to-use
 *  carry the signal; examples hurt dense retrieval). */
export function toolCard(def: ToolDef): string {
  const name = def.function.name.replace(/_/g, " ");
  return `${name}: ${(def.function.description || "").slice(0, 400)}`;
}

const cardVectors = new Map<string, number[]>();

async function embed(texts: string[], kind: "query" | "document", signal?: AbortSignal): Promise<number[][] | null> {
  try {
    const res = await fetch(`${ollamaBaseUrl()}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // CPU, so the chat model keeps the whole GPU — same setting as the edge
      // functions (supabase/functions/_shared/ai-local.ts localEmbed).
      body: JSON.stringify({ model: LOCAL_EMBED_MODEL, input: texts.map((t) => embedPrefix(LOCAL_EMBED_MODEL, kind) + t), keep_alive: "30m", options: { num_gpu: 0 } }),
      signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j?.embeddings) && j.embeddings.length === texts.length ? j.embeddings : null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

const STOP = new Set("a an the to of in on for and or my me i you it this that is are be with from at by as do can please".split(" "));
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 1 && !STOP.has(w)) ?? [];
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");

/** Word-overlap score in [0,1], used when the embedder is unavailable. */
export function lexicalScore(query: string, card: string): number {
  const q = new Set(words(query).map(stem));
  if (q.size === 0) return 0;
  const c = new Set(words(card).map(stem));
  let hit = 0;
  for (const w of q) if (c.has(w)) hit++;
  return hit / q.size;
}

export interface RankedTool { name: string; score: number }

/** Rank candidate tools against a request. Never throws. */
export async function rankTools(query: string, candidates: ToolDef[], signal?: AbortSignal): Promise<{ ranked: RankedTool[]; semantic: boolean }> {
  if (!query.trim() || candidates.length === 0) return { ranked: [], semantic: false };
  const cards = candidates.map(toolCard);
  const missing = cards.filter((c) => !cardVectors.has(c));
  if (missing.length) {
    const vecs = await embed(missing, "document", signal);
    if (vecs) missing.forEach((c, i) => cardVectors.set(c, vecs[i]));
  }
  const qv = cards.every((c) => cardVectors.has(c)) ? (await embed([query.slice(0, 2000)], "query", signal))?.[0] : null;
  if (qv) {
    const ranked = candidates.map((d, i) => ({ name: d.function.name, score: cosine(qv, cardVectors.get(cards[i])!) }));
    return { ranked: ranked.sort((a, b) => b.score - a.score), semantic: true };
  }
  const ranked = candidates.map((d, i) => ({ name: d.function.name, score: lexicalScore(query, cards[i]) }));
  return { ranked: ranked.sort((a, b) => b.score - a.score), semantic: false };
}

// ---------------------------------------------------------------------------
// The per-turn decision
// ---------------------------------------------------------------------------

/** Decide this turn's roster. `pool` is everything the gates allow, in the
 *  canonical definition order. Returns names in OFFER order: previous roster
 *  first, unchanged, then this turn's additions — so an unchanged roster is
 *  byte-identical on the wire. */
export async function planLocalRoster(input: {
  userId: string | null;
  query: string;
  pool: ToolDef[];
  signal?: AbortSignal;
}): Promise<{ names: string[]; added: string[]; rebuilt: boolean }> {
  const allowed = new Set(input.pool.map((d) => d.function.name));
  const prior = readRoster(input.userId).filter((n) => allowed.has(n));
  const core = LOCAL_CORE_TOOLS.filter((n) => allowed.has(n));
  let names = prior.length ? prior : [...core];
  for (const n of core) if (!names.includes(n)) names.push(n);

  const { ranked, semantic } = await rankTools(input.query, input.pool.filter((d) => !names.includes(d.function.name)), input.signal);
  // Lexical scores live on a different scale; only a strong overlap counts.
  const floor = semantic ? AUTO_ADD_MIN_SCORE : 0.6;
  const isFirstTurn = prior.length === 0;
  // The first turn seeds generously (the 13/14 configuration offered the top
  // 8 outright); later turns add only confident matches.
  let take = isFirstTurn ? ranked.slice(0, PER_TURN_ADDS) : ranked.filter((r) => r.score >= floor).slice(0, PER_TURN_ADDS);
  if (!isFirstTurn && !take.length && semantic && ranked.length > 1 && ranked[0].score - ranked[1].score >= AUTO_ADD_MIN_LEAD) {
    take = [ranked[0]];
  }
  const added = take.map((r) => r.name);
  for (const [named, tool] of LOCAL_NAMED_TOOLS) {
    if (named.test(input.query) && allowed.has(tool) && !names.includes(tool) && !added.includes(tool)) added.push(tool);
  }

  let rebuilt = false;
  if (names.length + added.length > ROSTER_CAP) {
    names = [...core];
    rebuilt = true;
  }
  names = [...names, ...added.filter((n) => !names.includes(n))];
  writeRoster(input.userId, names);
  return { names, added, rebuilt };
}

/** Execute find_tools: rank the pool minus what's already offered and add the
 *  best few. Returns the model-visible result and the names to append. */
export async function findTools(input: {
  userId: string | null;
  need: string;
  pool: ToolDef[];
  offered: Set<string>;
  signal?: AbortSignal;
}): Promise<{ result: Record<string, unknown>; added: string[] }> {
  const need = String(input.need || "").trim();
  if (!need) return { result: { error: "Say what you need to do in `need`." }, added: [] };
  const byName = new Map(input.pool.map((d) => [d.function.name, d]));
  // A model that reaches for find_tools while already holding the right tool
  // ("add a gaussian blur in PhotoCraft" with craft offered, eval 2026-10-13)
  // must hear that, not get handed the best of the REST — which here was
  // edit_image, a 3-minute diffusion redraw instead of a filter.
  const named = LOCAL_NAMED_TOOLS.find(([re, tool]) => re.test(need) && input.offered.has(tool))?.[1];
  let have = named;
  if (!have) {
    const { ranked: overall } = await rankTools(need, input.pool.filter((d) => d.function.name !== FIND_TOOLS_NAME), input.signal);
    if (overall[0] && input.offered.has(overall[0].name)) have = overall[0].name;
  }
  const already = have
    ? {
        already_available: { name: have, does: (byName.get(have)?.function.description || "").slice(0, 200) },
        note: `${have}, which you already have, fits this best — call it now.`,
      }
    : null;
  const candidates = input.pool.filter((d) => !input.offered.has(d.function.name) && d.function.name !== FIND_TOOLS_NAME);
  const { ranked } = await rankTools(need, candidates, input.signal);
  const top = already ? [] : ranked.slice(0, 3);
  if (top.length === 0) {
    return { result: already ?? { found: [], note: "Every tool you can use is already available to you." }, added: [] };
  }
  const roster = readRoster(input.userId);
  const added = top.map((t) => t.name);
  writeRoster(input.userId, [...roster, ...added.filter((n) => !roster.includes(n))]);
  return {
    result: {
      found: top.map((t) => ({ name: t.name, does: (byName.get(t.name)?.function.description || "").slice(0, 200) })),
      note: "These tools are now available. Call the one that fits.",
    },
    added,
  };
}

// ---------------------------------------------------------------------------
// Slim schemas
// ---------------------------------------------------------------------------

const DESC_MAX = 700;
const PARAM_DESC_MAX = 200;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd() + "…");
}

function slimSchema(node: any): any {
  if (Array.isArray(node)) return node.map(slimSchema);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string") out[k] = clip(v, PARAM_DESC_MAX);
    else if (k === "examples") continue;
    else out[k] = slimSchema(v);
  }
  return out;
}

/** A shorter copy of a tool definition for small local models: the long
 *  descriptions written for frontier models become noise at 4B, and the
 *  three largest alone are ~20K characters. Names, types, enums and
 *  required lists are untouched, so every call it allows is a call the full
 *  schema allows. Deterministic, so the wire bytes stay cache-stable. */
export function slimToolDef<T extends ToolDef>(def: T): T {
  const fn = def.function;
  return {
    ...def,
    function: {
      ...fn,
      description: clip(fn.description || "", DESC_MAX),
      ...(fn.parameters ? { parameters: slimSchema(fn.parameters) } : {}),
    },
  };
}
