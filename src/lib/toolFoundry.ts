import { parse } from "acorn";
import { full as walkFull } from "acorn-walk";
import { supabase } from "@/integrations/supabase/client";

/**
 * Tool Foundry — lifecycle plumbing for AI-authored tools.
 *
 * A tool is a package: code + description + capability manifest + tests,
 * stored in agent_tools, mirrored as an entry (a neuron) in the Toolshed
 * wiki so the assistant finds its own tools by meaning. Trust rules:
 *   • the capability list shown on the approval card is DERIVED from the code
 *     by the AST gate below — a declared-manifest mismatch is a rejection,
 *     not a warning (a tool whose card says "pure math" must be pure math);
 *   • drafts verify against STUB capabilities (canned fixtures) — live data
 *     binds only after the user approves;
 *   • approval integrity lives in the DB (tool_approvals + approve_tool RPC
 *     + immutability trigger), not in anything the client stores.
 */

// ── capability registry (v1: read-only + pure compute) ───────────────────────
export interface CapabilityMeta {
  name: string;
  description: string;
  /** Canned fixture returned during draft verification — shaped like the real
   *  thing so tests exercise parsing without touching live data. */
  stub: unknown;
  /**
   * HELD-OUT variants. `stub`'s exact shape is spelled out in `description`,
   * which the model reads before it writes a line of code — so a tool can pass
   * its author's own tests while only ever handling that one shape (measured:
   * 96.8% of self-authored tools score zero on held-out inputs while their
   * in-session verifier stays green, arXiv:2604.00392).
   *
   * These variants are APP-OWNED and deliberately never described to the
   * model. Every one of them is LEGAL under the documented contract — same
   * keys, same types — and differs only in the ways real data differs:
   * nothing found, blank strings, zero counts, a null optional, unicode, and
   * bulk. A tool that indexes [0] blindly, divides by a count, or assumes
   * ASCII fails here rather than in front of the user.
   *
   * Index meaning is stable across capabilities (see HELD_OUT_VARIANT_LABELS)
   * so a multi-capability tool sees a coherent world in each pass.
   */
  heldOut: ReadonlyArray<{ label: string; value: unknown }>;
}

/** What each held-out index means, in the same order for every capability. */
export const HELD_OUT_VARIANT_LABELS = [
  "nothing found (empty result sets)",
  "sparse values (blank strings, zero counts, a null optional field)",
  "bulk + unicode (many items, long text, non-ASCII)",
] as const;

export const HELD_OUT_VARIANT_COUNT = HELD_OUT_VARIANT_LABELS.length;

const LONG_TEXT = "Ils entrèrent dans la salle. ".repeat(120);

export const CAPABILITY_REGISTRY: CapabilityMeta[] = [
  {
    name: "memory_search",
    description: "Search the user's loaded neurons (title/content keyword match). Args: { query: string, limit?: number ≤ 20 }. Returns { results: [{ id, title, snippet }] }.",
    stub: { results: [{ id: "00000000-0000-0000-0000-000000000001", title: "Sample memory", snippet: "A canned fixture memory used during tool verification." }] },
    heldOut: [
      { label: "no matches", value: { results: [] } },
      { label: "one match, blank snippet", value: { results: [{ id: "00000000-0000-0000-0000-0000000000aa", title: "", snippet: "" }] } },
      {
        label: "seven matches, unicode titles, one very long snippet",
        value: {
          results: [
            { id: "00000000-0000-0000-0000-0000000000b1", title: "「日記」— 第一章", snippet: "夜が明ける前に、彼女は出発した。" },
            { id: "00000000-0000-0000-0000-0000000000b2", title: "Résumé — Ch. Ⅻ", snippet: LONG_TEXT },
            { id: "00000000-0000-0000-0000-0000000000b3", title: "notes on ✦ structure", snippet: "beat sheet, three acts" },
            { id: "00000000-0000-0000-0000-0000000000b4", title: "Ωmega draft", snippet: "cut the prologue" },
            { id: "00000000-0000-0000-0000-0000000000b5", title: "𝑀irror scene", snippet: "she does not look away" },
            { id: "00000000-0000-0000-0000-0000000000b6", title: "timeline", snippet: "1847 → 1852" },
            { id: "00000000-0000-0000-0000-0000000000b7", title: "voice", snippet: "close third, past tense" },
          ],
        },
      },
    ],
  },
  {
    name: "memory_get",
    description: "Fetch one memory entry by id. Args: { entry_id: string }. Returns { id, title, entry_type, content } (content capped at 4000 chars).",
    stub: { id: "00000000-0000-0000-0000-000000000001", title: "Sample memory", entry_type: "concept", content: "Fixture content for verification runs." },
    heldOut: [
      { label: "empty entry", value: { id: "00000000-0000-0000-0000-0000000000c1", title: "", entry_type: "note", content: "" } },
      { label: "single-word content", value: { id: "00000000-0000-0000-0000-0000000000c2", title: "x", entry_type: "fact", content: "y" } },
      { label: "long unicode content", value: { id: "00000000-0000-0000-0000-0000000000c3", title: "Ωmega — «notes»", entry_type: "concept", content: LONG_TEXT } },
    ],
  },
  {
    name: "books_list",
    description: "List the user's books. Args: {}. Returns { books: [{ id, title, chapter_count }] }.",
    stub: { books: [{ id: "book-1", title: "Sample Book", chapter_count: 3 }] },
    heldOut: [
      { label: "no books", value: { books: [] } },
      { label: "one book with zero chapters and a blank title", value: { books: [{ id: "book-empty", title: "", chapter_count: 0 }] } },
      {
        label: "five books, unicode titles, uneven chapter counts",
        value: {
          books: [
            { id: "book-a", title: "Étranger", chapter_count: 41 },
            { id: "book-b", title: "무제", chapter_count: 1 },
            { id: "book-c", title: "", chapter_count: 0 },
            { id: "book-d", title: "A Very Long Title That Keeps Going ".repeat(8), chapter_count: 7 },
            { id: "book-e", title: "𝔊othic", chapter_count: 12 },
          ],
        },
      },
    ],
  },
  {
    name: "books_get_chapter_text",
    description: "Fetch one chapter's text. Args: { book_id: string, chapter_index: number }. Returns { title, text } (text capped at 12000 chars).",
    stub: { title: "Chapter One", text: "Fixture chapter text for verification runs." },
    heldOut: [
      { label: "untitled, empty chapter", value: { title: "", text: "" } },
      { label: "one-sentence chapter", value: { title: "1", text: "It rained." } },
      { label: "long unicode chapter", value: { title: "Chapitre Ⅻ — «Le Miroir»", text: LONG_TEXT } },
    ],
  },
  {
    name: "images_list",
    description: "List the user's library images. Args: { query?: string, limit?: number ≤ 20 }. Returns { images: [{ id, prompt, caption, created_at }] }.",
    stub: { images: [{ id: "00000000-0000-0000-0000-000000000002", prompt: "a sample image", caption: "", created_at: "2026-01-01T00:00:00Z" }] },
    heldOut: [
      { label: "no images", value: { images: [] } },
      // caption is nullable in the real table — the stub's "" hides that.
      { label: "one image, null caption, empty prompt", value: { images: [{ id: "00000000-0000-0000-0000-0000000000d1", prompt: "", caption: null, created_at: "1970-01-01T00:00:00Z" }] } },
      {
        label: "four images, mixed captions, unicode prompts",
        value: {
          images: [
            { id: "00000000-0000-0000-0000-0000000000d2", prompt: "un phare dans la brume", caption: "phare", created_at: "2026-02-11T09:30:00Z" },
            { id: "00000000-0000-0000-0000-0000000000d3", prompt: "灯台", caption: null, created_at: "2026-02-12T09:30:00Z" },
            { id: "00000000-0000-0000-0000-0000000000d4", prompt: "", caption: "", created_at: "2026-02-13T09:30:00Z" },
            { id: "00000000-0000-0000-0000-0000000000d5", prompt: "a ".repeat(400), caption: "long", created_at: "2026-02-14T09:30:00Z" },
          ],
        },
      },
    ],
  },
];

export const CAPABILITY_NAMES = new Set(CAPABILITY_REGISTRY.map((c) => c.name));

export function stubCapabilityHandler(): (cap: string, args: unknown) => Promise<unknown> {
  return async (cap) => {
    const meta = CAPABILITY_REGISTRY.find((c) => c.name === cap);
    if (!meta) throw new Error(`unknown capability '${cap}'`);
    return meta.stub;
  };
}

/**
 * Capability handler serving held-out variant `variant` for EVERY capability,
 * so a run sees one internally consistent world (all empty, all sparse, all
 * bulk) rather than a chimera. Falls back to `stub` for any capability that
 * somehow has no variants, which keeps this a superset of the stub handler.
 */
export function heldOutCapabilityHandler(variant: number): (cap: string, args: unknown) => Promise<unknown> {
  return async (cap) => {
    const meta = CAPABILITY_REGISTRY.find((c) => c.name === cap);
    if (!meta) throw new Error(`unknown capability '${cap}'`);
    const variants = meta.heldOut;
    if (!variants || variants.length === 0) return meta.stub;
    const i = ((Math.trunc(variant) % variants.length) + variants.length) % variants.length;
    return variants[i].value;
  };
}

/** Human-readable label for one held-out pass over a given capability set. */
export function heldOutVariantLabel(variant: number, capabilities: string[]): string {
  const i = ((Math.trunc(variant) % HELD_OUT_VARIANT_COUNT) + HELD_OUT_VARIANT_COUNT) % HELD_OUT_VARIANT_COUNT;
  const base = HELD_OUT_VARIANT_LABELS[i];
  const detail = capabilities
    .map((c) => CAPABILITY_REGISTRY.find((m) => m.name === c)?.heldOut?.[i]?.label)
    .filter((d): d is string => !!d)
    .join("; ");
  return detail ? `${base} — ${detail}` : base;
}

// ── AST gate ─────────────────────────────────────────────────────────────────
export interface AstGateResult {
  ok: boolean;
  errors: string[];
  /** Capability names the code ACTUALLY references (caps.<name> / caps["<name>"]). */
  capabilities: string[];
}

const FORBIDDEN_IDENTIFIERS = new Set([
  "eval", "Function", "globalThis", "self", "window", "document",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker",
  "importScripts", "postMessage", "SharedArrayBuffer", "Atomics",
  "__cap", "__argsJson",
]);

/** Parse + police tool code, deriving the true capability set. Fails closed. */
export function analyzeToolCode(code: string): AstGateResult {
  const errors: string[] = [];
  const caps = new Set<string>();
  let ast: unknown;
  try {
    ast = parse(code, { ecmaVersion: 2020, sourceType: "script" });
  } catch (e) {
    return { ok: false, errors: [`parse error: ${String((e as Error)?.message || e).slice(0, 200)}`], capabilities: [] };
  }

  let hasRun = false;
  walkFull(ast as never, (node: any) => {
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id?.name === "run") hasRun = true;
        break;
      case "WithStatement":
        errors.push("`with` statements are not allowed");
        break;
      case "ImportExpression":
        errors.push("dynamic import() is not allowed");
        break;
      case "MetaProperty":
        errors.push("`import.meta` / `new.target` are not allowed");
        break;
      case "Identifier":
        if (FORBIDDEN_IDENTIFIERS.has(node.name)) {
          errors.push(`forbidden identifier: ${node.name}`);
        }
        break;
      case "MemberExpression": {
        const obj = node.object;
        if (obj?.type === "Identifier" && obj.name === "caps") {
          if (!node.computed && node.property?.type === "Identifier") {
            caps.add(node.property.name);
          } else if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") {
            caps.add(node.property.value);
          } else {
            errors.push("capability access must be a literal (caps.name or caps[\"name\"]) — dynamic capability names defeat the approval card");
          }
        }
        break;
      }
      default:
        break;
    }
  });

  if (!hasRun) errors.push('tool code must define `async function run(args, caps)` at top level');
  for (const c of caps) {
    if (!CAPABILITY_NAMES.has(c)) errors.push(`unknown capability: caps.${c}`);
  }
  // Deduplicate error spam (an identifier used in a loop reports once).
  const unique = Array.from(new Set(errors));
  return { ok: unique.length === 0, errors: unique, capabilities: Array.from(caps).sort() };
}

// ── model-authored text sanitization (prompt-injection fencing) ─────────────
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

/** Descriptions land in the system prompt: single line, no markdown headers,
 *  capped — a tool blurb must never be able to masquerade as instructions. */
export function sanitizeToolDescription(text: string): string {
  return (text || "")
    .replace(/\s+/g, " ")
    .replace(/^[#>\-\s]+/, "")
    .slice(0, 240)
    .trim();
}

// ── storage / availability ───────────────────────────────────────────────────
export interface AgentToolRow {
  id: string;
  root_id: string | null;
  name: string;
  description: string;
  code: string;
  /** `description_sha256` pins the DESCRIPTION into the approval hash: the
   *  server fingerprint covers `manifest::text`, so putting the hash here puts
   *  the wording the model reads inside what the user actually approved.
   *  Absent on rows forged before that change — see toolConformance. */
  manifest: { capabilities?: string[]; description_sha256?: string };
  tests: Array<{ args: unknown; expect?: string }>;
  status: "draft" | "approved" | "disabled";
  /** True only when the USER disabled it (distinct from the 'disabled' status
   *  approve_tool assigns to superseded versions). */
  disabled_by_user?: boolean;
  version: number;
  superseded_by: string | null;
  entry_id: string | null;
  run_count: number;
  fail_count: number;
  last_run_at: string | null;
  created_at: string;
}

let foundryAvailableCache: boolean | null = null;
/** In-flight probe, so a burst of callers issues ONE query. Cleared on settle
 *  precisely so a transient failure stays re-probeable (a cached rejected /
 *  false promise would pin the outage for the whole session). */
let foundryProbe: Promise<boolean> | null = null;

function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST202" || code === "42883";
}

/**
 * One probe per session: do the Foundry tables exist yet?
 *
 * Caching semantics, which the callers depend on:
 *   • success            → cache true  (never probed again)
 *   • missing schema     → cache false (never probed again — the migration is
 *                          a user-gated action; hammering it helps nobody)
 *   • ANY other failure  → cache stays null and this returns false for now,
 *                          so the next call genuinely re-probes. Network
 *                          blips and 401s must not brick the Foundry for the
 *                          rest of the session.
 */
export async function foundryAvailable(): Promise<boolean> {
  if (foundryAvailableCache !== null) return foundryAvailableCache;
  if (foundryProbe) return foundryProbe;
  foundryProbe = (async () => {
    try {
      // Supabase builders resolve { data, error } — they do not throw.
      const { error } = await (supabase.from("agent_tools" as any) as any).select("id", { head: true, count: "exact" }).limit(1);
      if (!error) { foundryAvailableCache = true; return true; }
      if (isMissingSchema(error)) { foundryAvailableCache = false; return false; }
      foundryAvailableCache = null; // transient — re-probe on the next call
      return false;
    } catch {
      foundryAvailableCache = null; // e.g. offline — also transient
      return false;
    } finally {
      foundryProbe = null;
    }
  })();
  return foundryProbe;
}

/** Drop the availability cache (used after a migration lands, and by tests). */
export function resetFoundryAvailability(): void {
  foundryAvailableCache = null;
  foundryProbe = null;
}

export async function listTools(opts: { status?: string } = {}): Promise<AgentToolRow[]> {
  let q: any = (supabase.from("agent_tools" as any) as any)
    .select("id, root_id, name, description, code, manifest, tests, status, disabled_by_user, version, superseded_by, entry_id, run_count, fail_count, last_run_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) throw error;
  return (data as AgentToolRow[]) || [];
}

/** The single approved, non-superseded row for a name — or a precise error. */
export async function resolveApprovedTool(name: string): Promise<AgentToolRow> {
  const { data, error } = await (supabase.from("agent_tools" as any) as any)
    .select("id, root_id, name, description, code, manifest, tests, status, disabled_by_user, version, superseded_by, entry_id, run_count, fail_count, last_run_at, created_at")
    .eq("name", name)
    .eq("status", "approved")
    .is("superseded_by", null);
  if (error) throw error;
  const rows = (data as AgentToolRow[]) || [];
  if (rows.length === 0) throw new Error(`no approved tool named '${name}' — it may be awaiting approval in Settings → Tool Foundry`);
  if (rows.length > 1) throw new Error(`tool '${name}' resolves ambiguously (${rows.length} approved rows) — refusing to guess; fix in Settings → Tool Foundry`);
  return rows[0];
}

/**
 * Resolve ONE row for a name across every status — the read path behind
 * `read_tool`, which exists so the assistant can inspect drafts it cannot run.
 * Preference order: the live approved version, else the newest draft, else the
 * newest row of any kind. Returns null when the name is unknown.
 */
export async function resolveToolByName(name: string): Promise<AgentToolRow | null> {
  const { data, error } = await (supabase.from("agent_tools" as any) as any)
    .select("id, root_id, name, description, code, manifest, tests, status, disabled_by_user, version, superseded_by, entry_id, run_count, fail_count, last_run_at, created_at")
    .eq("name", name)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = (data as AgentToolRow[]) || [];
  if (rows.length === 0) return null;
  return rows.find((r) => r.status === "approved" && !r.superseded_by)
    ?? rows.find((r) => r.status === "draft")
    ?? rows[0];
}

/** One row of the append-only run audit. */
export interface ToolRunRow {
  id: string;
  status: "pending" | "ok" | "error" | "killed";
  error: string | null;
  ms: number | null;
  capability_calls: unknown[];
  created_at: string;
}

/**
 * Most recent audited run for a tool — the "why did it fail" that neither the
 * assistant nor the Settings UI could see before. `failedOnly` narrows to the
 * last run that did NOT succeed, which is what a repair loop actually wants.
 *
 * NOTE for callers: `error` is sandbox/tool-authored text. It is UNTRUSTED —
 * fence it before it re-enters model context.
 */
export async function latestToolRun(toolId: string, opts: { failedOnly?: boolean } = {}): Promise<ToolRunRow | null> {
  let q: any = (supabase.from("tool_runs" as any) as any)
    .select("id, status, error, ms, capability_calls, created_at")
    .eq("tool_id", toolId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (opts.failedOnly) q = q.in("status", ["error", "killed"]);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data as ToolRunRow[]) || [];
  return rows.length > 0 ? rows[0] : null;
}

/** Server-computed fingerprint of exactly what would run (code + manifest). */
export async function toolFingerprint(toolId: string): Promise<string> {
  const { data, error } = await (supabase.rpc as any)("tool_fingerprint", { p_tool_id: toolId });
  if (error) throw error;
  return String(data);
}

export async function approveTool(toolId: string, expectedSha256: string): Promise<void> {
  const { error } = await (supabase.rpc as any)("approve_tool", { p_tool_id: toolId, p_expected_sha256: expectedSha256 });
  if (error) throw error;
}

/** Latest approval pin for a tool (null = never approved). */
export async function latestApprovalSha(toolId: string): Promise<string | null> {
  const { data, error } = await (supabase.from("tool_approvals" as any) as any)
    .select("sha256, approved_at")
    .eq("tool_id", toolId)
    .order("approved_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = (data as Array<{ sha256: string }>) || [];
  return rows.length > 0 ? rows[0].sha256 : null;
}

// ── audit ────────────────────────────────────────────────────────────────────
export async function auditRunStart(toolId: string, sha256: string): Promise<string | null> {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) return null;
    const id = crypto.randomUUID();
    const { error } = await (supabase.from("tool_runs" as any) as any)
      .insert({ id, user_id: uid, tool_id: toolId, sha256, status: "pending" });
    return error ? null : id;
  } catch {
    return null;
  }
}

export async function auditRunSettle(
  runId: string | null,
  outcome: { status: "ok" | "error" | "killed"; ms: number; capabilityCalls: unknown[]; error?: string },
): Promise<void> {
  if (!runId) return;
  try {
    await (supabase.from("tool_runs" as any) as any)
      .update({
        status: outcome.status,
        ms: Math.round(outcome.ms),
        capability_calls: outcome.capabilityCalls.slice(0, 50),
        error: outcome.error ? outcome.error.slice(0, 500) : null,
      })
      .eq("id", runId);
  } catch { /* audit is best-effort */ }
}
