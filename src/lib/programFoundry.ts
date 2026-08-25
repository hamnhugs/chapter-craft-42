import { supabase } from "@/integrations/supabase/client";
import { buildProgramCard } from "@/lib/toolshed";

/**
 * Program Foundry — lifecycle plumbing for AI-authored PROGRAMS.
 *
 * A program is the VPS-executed sibling of a Tool Foundry tool. Where a tool is
 * a pure `run(args, caps)` JS function AST-gated to a read-only capability set
 * and run in a browser QuickJS sandbox, a program is ARBITRARY bash/python/node
 * that runs in a hardened gVisor container on the user's own connected VPS. That
 * is a categorically larger capability, so the trust chain is heavier:
 *
 *   • drafts are INSERT-ONLY (agent_programs has no client UPDATE policy) — a
 *     draft cannot be mutated between verification and approval;
 *   • the isolated-verifier verdict is written ONLY by the program-verify edge
 *     function (service role) and is bound to the exact code by fingerprint;
 *   • approval integrity lives entirely in the DB (program_approvals +
 *     approve_program RPC + the immutability guard + the program_disables ban
 *     ledger), never in anything the client stores;
 *   • the runner NEVER injects secrets or opens egress for a VERIFY job, so an
 *     unapproved draft can only ever run hermetically.
 *
 * This module owns the read-side helpers, the RPC wrappers, and the client-side
 * validation forge_program applies before it inserts a draft. The actual
 * execution and verification cross an edge function (see programRunner.ts).
 */

// ── shapes ───────────────────────────────────────────────────────────────────
export const PROGRAM_LANGUAGES = ["bash", "python", "node"] as const;
export type ProgramLanguage = (typeof PROGRAM_LANGUAGES)[number];
export const PROGRAM_NETWORK_MODES = ["none", "allowlist"] as const;
export type ProgramNetworkMode = (typeof PROGRAM_NETWORK_MODES)[number];

export const PROGRAM_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
/** Secret / host names the model may declare. Hosts are validated separately. */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const MAX_PROGRAM_CODE_BYTES = 65_536;
export const MAX_PROGRAM_TIMEOUT_MS = 60_000;
export const MIN_PROGRAM_TIMEOUT_MS = 1_000;
export const MAX_ALLOWED_HOSTS = 20;
export const MAX_DECLARED_SECRETS = 20;
export const MAX_IO_EXAMPLES = 12;

export interface ProgramManifest {
  network: ProgramNetworkMode;
  /** Only meaningful when network === "allowlist". */
  allowed_hosts: string[];
  timeout_ms: number;
  /** Secret NAMES only — values live on the runner, never here or in context. */
  secrets: string[];
  /** Folds the model-read description into the approval hash (see forge_program). */
  description_sha256?: string;
}

export interface ProgramIoSpec {
  /** Free-form typed hint for the verifier ("args: { path: string }"). */
  input_schema?: string;
  /** Concrete oracle pairs the verifier checks against — the independent oracle. */
  examples?: Array<{ args: unknown; expect?: string }>;
  /** Named invariants the verifier asserts ("output is valid JSON"). */
  invariants?: string[];
}

export type ProgramVerdict = "passed" | "failed" | "inconclusive";

export interface ProgramVerifierReport {
  verdict: ProgramVerdict;
  checks: Array<{ id: string; passed: boolean }>;
  /** The fingerprint this report was produced for — approve_program binds on it. */
  fingerprint?: string;
}

export interface AgentProgramRow {
  id: string;
  root_id: string | null;
  name: string;
  description: string;
  language: ProgramLanguage;
  code: string;
  manifest: ProgramManifest;
  io_spec: ProgramIoSpec;
  status: "draft" | "approved" | "disabled";
  version: number;
  superseded_by: string | null;
  verified_at: string | null;
  verifier_fingerprint: string | null;
  verifier_report: ProgramVerifierReport | null;
  run_count: number;
  fail_count: number;
  last_run_at: string | null;
  created_at: string;
}

const ROW_COLUMNS =
  "id, root_id, name, description, language, code, manifest, io_spec, status, version, " +
  "superseded_by, verified_at, verifier_fingerprint, verifier_report, run_count, fail_count, last_run_at, created_at";

// ── validation (forge_program applies these before inserting a draft) ─────────
export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  manifest: ProgramManifest;
}

/** Validate + normalize a model-declared execution profile. Fails closed: an
 *  unparseable field collapses to the safest value (network 'none', no hosts,
 *  no secrets) and is reported, never silently widened. */
export function validateProgramManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  let network: ProgramNetworkMode = "none";
  if (r.network !== undefined) {
    if (r.network === "allowlist") network = "allowlist";
    else if (r.network !== "none") errors.push(`network must be 'none' or 'allowlist' (got ${JSON.stringify(r.network).slice(0, 40)})`);
  }

  const hostsRaw = Array.isArray(r.allowed_hosts) ? r.allowed_hosts : [];
  const allowed_hosts: string[] = [];
  for (const h of hostsRaw.slice(0, MAX_ALLOWED_HOSTS + 1)) {
    const host = String(h || "").trim().toLowerCase();
    if (!host) continue;
    if (!HOST_RE.test(host)) { errors.push(`invalid host: ${JSON.stringify(host).slice(0, 60)}`); continue; }
    if (!allowed_hosts.includes(host)) allowed_hosts.push(host);
  }
  if (allowed_hosts.length > MAX_ALLOWED_HOSTS) errors.push(`too many allowed_hosts (max ${MAX_ALLOWED_HOSTS})`);
  if (network === "none" && allowed_hosts.length > 0) {
    // Not an error — just meaningless; drop the hosts so the approval card is honest.
    allowed_hosts.length = 0;
  }
  if (network === "allowlist" && allowed_hosts.length === 0) {
    errors.push("network 'allowlist' needs at least one allowed_hosts entry");
  }

  const secretsRaw = Array.isArray(r.secrets) ? r.secrets : [];
  const secrets: string[] = [];
  for (const s of secretsRaw.slice(0, MAX_DECLARED_SECRETS + 1)) {
    const name = String(s || "").trim();
    if (!name) continue;
    if (!SECRET_NAME_RE.test(name)) { errors.push(`invalid secret name: ${JSON.stringify(name).slice(0, 60)} (UPPER_SNAKE_CASE)`); continue; }
    if (!secrets.includes(name)) secrets.push(name);
  }
  if (secrets.length > MAX_DECLARED_SECRETS) errors.push(`too many secrets (max ${MAX_DECLARED_SECRETS})`);

  let timeout_ms = Number(r.timeout_ms);
  if (!Number.isFinite(timeout_ms)) timeout_ms = 15_000;
  timeout_ms = Math.min(MAX_PROGRAM_TIMEOUT_MS, Math.max(MIN_PROGRAM_TIMEOUT_MS, Math.round(timeout_ms)));

  return { ok: errors.length === 0, errors, manifest: { network, allowed_hosts, timeout_ms, secrets } };
}

export interface IoSpecValidation { ok: boolean; errors: string[]; io_spec: ProgramIoSpec; }

export function validateIoSpec(raw: unknown): IoSpecValidation {
  const errors: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const io_spec: ProgramIoSpec = {};
  if (typeof r.input_schema === "string" && r.input_schema.trim()) io_spec.input_schema = r.input_schema.slice(0, 2000);
  if (Array.isArray(r.examples)) {
    const ex: Array<{ args: unknown; expect?: string }> = [];
    for (const e of r.examples.slice(0, MAX_IO_EXAMPLES)) {
      if (!e || typeof e !== "object") continue;
      const rec = e as Record<string, unknown>;
      ex.push({ args: rec.args ?? {}, ...(typeof rec.expect === "string" ? { expect: rec.expect.slice(0, 2000) } : {}) });
    }
    if (ex.length > 0) io_spec.examples = ex;
  }
  if (Array.isArray(r.invariants)) {
    const inv = r.invariants.map((s) => String(s || "").slice(0, 300)).filter(Boolean).slice(0, MAX_IO_EXAMPLES);
    if (inv.length > 0) io_spec.invariants = inv;
  }
  // A program with NO examples and NO invariants can only ever be verified with
  // weak generic checks; that is surfaced as an 'inconclusive' verdict later,
  // not blocked here — the user's real gate is the visible code.
  return { ok: errors.length === 0, errors, io_spec };
}

// ── description sanitation (prompt-injection hygiene for a persisted string) ──
/** Program descriptions land in the system prompt roster, in a Toolshed card,
 *  and in read_program output. They are model-authored, so they get the same
 *  single-line + marker-stripping treatment as tool descriptions, PLUS the
 *  neutralization of prompt-section markers a longer, VPS-flavoured description
 *  might carry. This is hygiene; the nonce fence + roster scrub at re-entry are
 *  the boundary. */
const SECTION_MARKER_RE =
  /\b(system|assistant|user|developer)\s*:|^#{1,6}\s|(ignore|disregard)\s+(all\s+)?(previous|prior|above)|available\s+tools\b|you\s+are\s+(now\s+)?an?\b/gi;

export function sanitizeProgramDescription(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^[#>\-*\s]+/, "")
    .replace(SECTION_MARKER_RE, " ")
    .replace(/\s+/g, " ")
    .slice(0, 300)
    .trim();
}

// ── availability probe (dual-mode; first real read IS the probe) ─────────────
let programsAvailableCache: boolean | null = null;
let programsProbe: Promise<boolean> | null = null;

function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205" || code === "42883";
}

/**
 * One probe per session: does agent_programs exist yet?
 *
 * A real GET (`select(...).limit(1)`), never a HEAD — a HEAD error response
 * carries no JSON body, so its error CODE never arrives and the missing-schema
 * case is indistinguishable from success. Caching mirrors foundryAvailable:
 *   • success        → cache true  (never re-probed)
 *   • missing schema → cache false (never re-probed; the migration is user-gated)
 *   • other failure  → cache stays null, returns false for now, re-probes next
 *
 * RESOLVES false, never rejects, on a missing relation, so an awaited roster /
 * prompt path can never throw when the client is ahead of the migration.
 */
export async function programsAvailable(): Promise<boolean> {
  if (programsAvailableCache !== null) return programsAvailableCache;
  if (programsProbe) return programsProbe;
  programsProbe = (async () => {
    try {
      const { error } = await (supabase.from("agent_programs" as any) as any).select("id").limit(1);
      if (!error) { programsAvailableCache = true; return true; }
      if (isMissingSchema(error)) { programsAvailableCache = false; return false; }
      programsAvailableCache = null;
      return false;
    } catch {
      programsAvailableCache = null;
      return false;
    } finally {
      programsProbe = null;
    }
  })();
  return programsProbe;
}

export function resetProgramsAvailability(): void {
  programsAvailableCache = null;
  programsProbe = null;
}

// ── reads ────────────────────────────────────────────────────────────────────
export async function listPrograms(opts: { status?: string } = {}): Promise<AgentProgramRow[]> {
  let q: any = (supabase.from("agent_programs" as any) as any)
    .select(ROW_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(100);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) throw error;
  return (data as AgentProgramRow[]) || [];
}

export async function countApprovedPrograms(): Promise<number | null> {
  try {
    const { count, error } = await (supabase.from("agent_programs" as any) as any)
      .select("id", { count: "exact", head: true })
      .eq("status", "approved")
      .is("superseded_by", null);
    if (error) return null;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

export async function resolveApprovedProgram(name: string): Promise<AgentProgramRow> {
  const { data, error } = await (supabase.from("agent_programs" as any) as any)
    .select(ROW_COLUMNS)
    .eq("name", name)
    .eq("status", "approved")
    .is("superseded_by", null);
  if (error) throw error;
  const rows = (data as AgentProgramRow[]) || [];
  if (rows.length === 0) throw new Error(`no approved program named '${name}' — it may be awaiting approval in Settings → Program Foundry`);
  if (rows.length > 1) throw new Error(`program '${name}' resolves ambiguously (${rows.length} approved rows) — fix in Settings → Program Foundry`);
  return rows[0];
}

export async function resolveProgramByName(name: string): Promise<AgentProgramRow | null> {
  const { data, error } = await (supabase.from("agent_programs" as any) as any)
    .select(ROW_COLUMNS)
    .eq("name", name)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = (data as AgentProgramRow[]) || [];
  if (rows.length === 0) return null;
  return rows.find((r) => r.status === "approved" && !r.superseded_by)
    ?? rows.find((r) => r.status === "draft")
    ?? rows[0];
}

export async function deleteProgramsByName(name: string): Promise<{ deleted: number; versions: number[] }> {
  const { data, error } = await (supabase.from("agent_programs" as any) as any)
    .delete()
    .eq("name", name)
    .select("id, version");
  if (error) throw error;
  const rows = (data as { id: string; version: number }[]) || [];
  return { deleted: rows.length, versions: rows.map((r) => Number(r.version) || 0).sort((a, b) => a - b) };
}

// ── run audit (read-only; program_runs is written server-side) ───────────────
export interface ProgramRunRow {
  id: string;
  mode: "run" | "verify";
  status: "pending" | "ok" | "error" | "killed" | "timeout" | "oom" | "egress_blocked" | "sandbox_unavailable";
  exit_code: number | null;
  ms: number | null;
  stdout_bytes: number | null;
  stderr_bytes: number | null;
  error: string | null;
  created_at: string;
}

const RUN_COLUMNS = "id, mode, status, exit_code, ms, stdout_bytes, stderr_bytes, error, created_at";

export async function recentProgramRuns(programId: string, limit = 5): Promise<ProgramRunRow[]> {
  const { data, error } = await (supabase.from("program_runs" as any) as any)
    .select(RUN_COLUMNS)
    .eq("program_id", programId)
    .eq("mode", "run")
    .order("created_at", { ascending: false })
    .limit(Math.min(20, Math.max(1, limit)));
  if (error) throw error;
  return (data as ProgramRunRow[]) || [];
}

// ── RPCs ─────────────────────────────────────────────────────────────────────
export async function programFingerprint(programId: string): Promise<string> {
  const { data, error } = await (supabase.rpc as any)("program_fingerprint", { p_program_id: programId });
  if (error) throw error;
  return String(data);
}

export async function approveProgram(programId: string, expectedSha256: string): Promise<void> {
  const { error } = await (supabase.rpc as any)("approve_program", { p_program_id: programId, p_expected_sha256: expectedSha256 });
  if (error) throw error;
}

export async function disableProgram(name: string): Promise<void> {
  const { error } = await (supabase.rpc as any)("disable_program", { p_name: name });
  if (error) throw error;
}

export async function latestProgramApprovalSha(programId: string): Promise<string | null> {
  const { data, error } = await (supabase.from("program_approvals" as any) as any)
    .select("sha256, approved_at")
    .eq("program_id", programId)
    .order("approved_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = (data as Array<{ sha256: string }>) || [];
  return rows.length > 0 ? rows[0].sha256 : null;
}

// ── Toolshed mirror (DEFERRED to approval time) ──────────────────────────────
const TOOLSHED_WIKI_NAME = "Toolshed";

/**
 * File an APPROVED program as a retrieval card in the Toolshed neuron so the
 * assistant can rediscover its own programs by meaning. Called ONLY after the
 * user approves — an unapproved, model-authored description must never re-enter
 * context via search_wiki, which is why the draft is not mirrored at forge time.
 * Best-effort: a failure here means the program still runs by exact name but is
 * not findable by description, never that approval failed.
 */
export async function mirrorApprovedProgram(input: {
  name: string;
  description: string;
  version: number;
  language: string;
  manifest: ProgramManifest;
  code: string;
  verdict?: ProgramVerdict | null;
  health?: { runCount?: number; failCount?: number; lastRunAt?: string | null };
}): Promise<string | null> {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) return null;

    let wikiId: string | null = null;
    const { data: existing } = await (supabase.from("wikis" as any) as any).select("id").ilike("name", TOOLSHED_WIKI_NAME).limit(1);
    if (existing && (existing as any[]).length > 0) wikiId = (existing as any[])[0].id;
    if (!wikiId) {
      // Deliberately NOT activated — self-built programs must not displace loaded neurons.
      const { data: created } = await (supabase.from("wikis" as any) as any)
        .insert({ user_id: uid, name: "Toolshed", description: "Self-built tools and programs the assistant forged.", tags: ["tools"] })
        .select().single();
      if (created) wikiId = (created as any).id;
    }
    if (!wikiId) return null;

    const { title, content } = buildProgramCard({
      name: input.name, description: input.description, version: input.version,
      language: input.language, network: input.manifest.network,
      allowedHosts: input.manifest.allowed_hosts, secrets: input.manifest.secrets,
      code: input.code, verdict: input.verdict ?? null, health: input.health,
    });

    let entryId: string | null = null;
    try {
      const { data: prior } = await supabase.from("knowledge_entries").select("id").eq("wiki_id", wikiId).eq("title", title).limit(1);
      if (prior && prior.length > 0) entryId = (prior[0] as any).id;
    } catch { /* fresh entry */ }

    const upsert = async (entryType: string) => (supabase.rpc as any)("memory_entry_upsert", {
      _id: entryId, _wiki_id: entryId ? null : wikiId, _title: title, _content: content,
      _entry_type: entryType, _tags: ["program"], _confidence: 1,
    });
    let { data, error } = await upsert("program");
    if (error) ({ data, error } = await upsert("tool"));     // pre-'program' CHECK fallback
    if (error) ({ data, error } = await upsert("concept"));  // pre-'tool' CHECK fallback
    if (error) return null;
    try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch { /* no-op */ }
    return (data as any) || entryId;
  } catch {
    return null;
  }
}
