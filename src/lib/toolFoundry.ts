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
}

export const CAPABILITY_REGISTRY: CapabilityMeta[] = [
  {
    name: "memory_search",
    description: "Search the user's loaded neurons (title/content keyword match). Args: { query: string, limit?: number ≤ 20 }. Returns { results: [{ id, title, snippet }] }.",
    stub: { results: [{ id: "00000000-0000-0000-0000-000000000001", title: "Sample memory", snippet: "A canned fixture memory used during tool verification." }] },
  },
  {
    name: "memory_get",
    description: "Fetch one memory entry by id. Args: { entry_id: string }. Returns { id, title, entry_type, content } (content capped at 4000 chars).",
    stub: { id: "00000000-0000-0000-0000-000000000001", title: "Sample memory", entry_type: "concept", content: "Fixture content for verification runs." },
  },
  {
    name: "books_list",
    description: "List the user's books. Args: {}. Returns { books: [{ id, title, chapter_count }] }.",
    stub: { books: [{ id: "book-1", title: "Sample Book", chapter_count: 3 }] },
  },
  {
    name: "books_get_chapter_text",
    description: "Fetch one chapter's text. Args: { book_id: string, chapter_index: number }. Returns { title, text } (text capped at 12000 chars).",
    stub: { title: "Chapter One", text: "Fixture chapter text for verification runs." },
  },
  {
    name: "images_list",
    description: "List the user's library images. Args: { query?: string, limit?: number ≤ 20 }. Returns { images: [{ id, prompt, caption, created_at }] }.",
    stub: { images: [{ id: "00000000-0000-0000-0000-000000000002", prompt: "a sample image", caption: "", created_at: "2026-01-01T00:00:00Z" }] },
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
  manifest: { capabilities?: string[] };
  tests: Array<{ args: unknown; expect?: string }>;
  status: "draft" | "approved" | "disabled";
  version: number;
  superseded_by: string | null;
  entry_id: string | null;
  run_count: number;
  fail_count: number;
  last_run_at: string | null;
  created_at: string;
}

let foundryAvailableCache: boolean | null = null;

function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST202" || code === "42883";
}

/** One probe per session: do the Foundry tables exist yet? */
export async function foundryAvailable(): Promise<boolean> {
  if (foundryAvailableCache !== null) return foundryAvailableCache;
  try {
    const { error } = await (supabase.from("agent_tools" as any) as any).select("id", { head: true, count: "exact" }).limit(1);
    foundryAvailableCache = !error;
    if (error && !isMissingSchema(error)) foundryAvailableCache = null; // transient — re-probe later
    return !!foundryAvailableCache;
  } catch {
    return false;
  }
}

export async function listTools(opts: { status?: string } = {}): Promise<AgentToolRow[]> {
  let q: any = (supabase.from("agent_tools" as any) as any)
    .select("id, root_id, name, description, code, manifest, tests, status, version, superseded_by, entry_id, run_count, fail_count, last_run_at, created_at")
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
    .select("id, root_id, name, description, code, manifest, tests, status, version, superseded_by, entry_id, run_count, fail_count, last_run_at, created_at")
    .eq("name", name)
    .eq("status", "approved")
    .is("superseded_by", null);
  if (error) throw error;
  const rows = (data as AgentToolRow[]) || [];
  if (rows.length === 0) throw new Error(`no approved tool named '${name}' — it may be awaiting approval in Settings → Tool Foundry`);
  if (rows.length > 1) throw new Error(`tool '${name}' resolves ambiguously (${rows.length} approved rows) — refusing to guess; fix in Settings → Tool Foundry`);
  return rows[0];
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
