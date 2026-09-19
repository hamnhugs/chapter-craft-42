import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";
import { getSignedImageUrl } from "@/lib/imageGen";
import { sanitizeIlike } from "@/lib/sanitize";
import {
  DEFAULT_SPLAT_MODEL, getSplatModel, getTier, detectSplatFormat,
  mimeForFormat, extForFormat, estimateSplatCostUSD,
  type SplatFormat, type QualityTier,
} from "@/lib/splatCatalog";

// 3D Gaussian splat generation via fal.ai's queue API, billed to the user's own
// fal key. The flow mirrors videoGen.ts exactly — submit, poll, download, store
// in a private bucket, save a memory neuron — with three differences:
//
//   1. fal takes an IMAGE, not text. Text-to-splat goes through generate_image
//      first; this module only ever receives an image reference.
//   2. Every leg is CORS-clean from a browser (verified 2026-07-24), so there
//      is no edge function and no proxy — same as OpenRouter video.
//   3. The output field is named `model_mesh` but holds a GAUSSIAN SPLAT.
//      We never trust the field name: the blob's bytes are sniffed against the
//      format we requested before anything is stored.
//
// The `splat_generations` table, keyed by fal's request_id, is the source of
// truth for the lifecycle, so a page reload resumes polling or renders a
// finished asset.

const FAL_QUEUE = "https://queue.fal.run";
const BUCKET = "generated-splats";

// Every outbound fetch carries a deadline: a request with no signal can hang
// the tab forever on a socket the server accepted but never answers. 45s for
// submit/poll/result API calls, 180s for asset/poster downloads (PLY size is
// genuinely unpredictable).
const API_TIMEOUT_MS = 45_000;
const MEDIA_TIMEOUT_MS = 180_000;

export { DEFAULT_SPLAT_MODEL };

/** Lightweight reference persisted on a chat message. Heavy state lives in the
 *  `splat_generations` row (looked up by request_id). */
export interface ChatSplatRef {
  request_id: string;
  prompt: string;
  model: string;
}

export type SplatStatus = "pending" | "processing" | "completed" | "failed";

export interface SplatGenerationRow {
  id: string;
  user_id: string;
  request_id: string;
  provider: string;
  model: string;
  prompt: string;
  caption: string;
  source_image_id: string | null;
  entry_id: string | null;
  storage_path: string | null;
  poster_path: string | null;
  format: SplatFormat;
  mime: string;
  splat_count: number | null;
  file_bytes: number | null;
  coord_system: string;
  status_url: string | null;
  response_url: string | null;
  cost: number | null;
  status: SplatStatus;
  error: string | null;
  created_at: string;
  updated_at?: string;
}

const falHeaders = (apiKey: string) => ({
  "Content-Type": "application/json",
  Authorization: `Key ${apiKey}`,
});

/** fal's queue status/result routes hang off the first two path segments of a
 *  model id (`fal-ai/sam-3/3d-objects` → `fal-ai/sam-3`), while submit uses the
 *  full id. Only used as a fallback — the submit response's own status_url and
 *  response_url are preferred and persisted. */
function queueBase(model: string): string {
  const parts = model.split("/").filter(Boolean);
  return parts.slice(0, 2).join("/");
}

function fileUrl(x: unknown): string | null {
  if (!x) return null;
  if (typeof x === "string") return x || null;
  const u = (x as any)?.url;
  return typeof u === "string" && u ? u : null;
}

// ── Source image ────────────────────────────────────────────────────────────

/** Resolve a stored image into a URL fal can fetch. Images live in a private
 *  bucket, so this signs a time-limited URL rather than uploading the bytes to
 *  a third party's storage. */
export async function resolveSourceImageUrl(opts: {
  imageId?: string | null;
  imageUrl?: string | null;
}): Promise<{ url: string; imageId: string | null }> {
  const direct = (opts.imageUrl || "").trim();
  if (direct) {
    if (!/^https?:\/\//i.test(direct)) throw new Error("image_url must be an http(s) URL.");
    return { url: direct, imageId: null };
  }
  const id = (opts.imageId || "").trim();
  // Names no tool on purpose. This message is interpolated as the LEADING clause
  // of a model-visible result (chatTools.ts, generate_splat's catch), whose tail
  // already routes the model correctly for BOTH permission states via
  // toolOnWire("generate_image"). Naming generate_image here fired even with
  // "Generate images" switched off, so the freshest thing in context pointed at
  // an absent verb and then contradicted itself one clause later.
  if (!id) throw new Error("Provide an image_id or an image_url.");

  const { data, error } = await supabase
    .from("image_attachments")
    .select("id, storage_path")
    .eq("id", id)
    .maybeSingle();
  if (error || !data?.storage_path) throw new Error("That image could not be found.");

  // Reuse the image module's own signer so the bucket name stays in one place.
  const signed = await getSignedImageUrl(data.storage_path);
  if (!signed) throw new Error("Could not prepare the source image for generation.");
  return { url: signed, imageId: data.id };
}

// ── Submit ──────────────────────────────────────────────────────────────────

interface SubmitArgs {
  apiKey: string;
  model: string;
  imageUrl: string;
  numGaussians?: number;
  outputFormat?: SplatFormat;
  seed?: number;
}

export interface SubmitResult {
  requestId: string;
  statusUrl: string | null;
  responseUrl: string | null;
}

export async function submitSplat({
  apiKey, model, imageUrl, numGaussians, outputFormat, seed,
}: SubmitArgs): Promise<SubmitResult> {
  const id = model || DEFAULT_SPLAT_MODEL;
  const info = getSplatModel(id);
  const body: Record<string, unknown> = { image_url: imageUrl };
  // Only TripoSplat exposes these; sending them to a model that doesn't accept
  // them is a 422, so gate on the catalog.
  if (info?.supportsGaussianCount && numGaussians) body.num_gaussians = numGaussians;
  if (info?.supportsGaussianCount && outputFormat && outputFormat !== "glb") body.output_format = outputFormat;
  if (typeof seed === "number") body.seed = seed;

  let res: Response;
  try {
    res = await fetch(`${FAL_QUEUE}/${id}`, {
      method: "POST",
      headers: falHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${id}: splat submit timed out after ${API_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error("Invalid fal.ai API key.");
    if (res.status === 402) throw new Error("Insufficient fal.ai credits — splats are billed to your own fal key.");
    if (res.status === 422) throw new Error(`fal.ai · ${id}: rejected the request — ${errText.slice(0, 200)}`);
    throw new Error(`fal.ai · ${id}: splat submit failed (HTTP ${res.status}) ${errText.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  const requestId: string | undefined = data?.request_id || data?.requestId;
  if (!requestId) throw new Error(`fal.ai · ${id}: splat submit returned no request id.`);
  return {
    requestId,
    statusUrl: typeof data?.status_url === "string" ? data.status_url : null,
    responseUrl: typeof data?.response_url === "string" ? data.response_url : null,
  };
}

// ── Poll ────────────────────────────────────────────────────────────────────

export interface SplatPollSnapshot {
  status: SplatStatus;
  error: string | null;
  ready: boolean;
  queuePosition: number | null;
}

/** Poll a queued job. Never throws for normal not-ready states. */
export async function pollSplat(
  apiKey: string,
  opts: { model: string; requestId: string; statusUrl?: string | null },
): Promise<SplatPollSnapshot> {
  const url = opts.statusUrl
    || `${FAL_QUEUE}/${queueBase(opts.model)}/requests/${encodeURIComponent(opts.requestId)}/status`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e: any) {
    // Thrown errors were already the contract for network failures (callers'
    // poll loops catch and keep polling) — a timeout rides the same path, it
    // just says who stalled.
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${opts.model}: status poll timed out after ${API_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  if (!res.ok) {
    // Terminal: job purged/expired, or the key is rejected. Everything else
    // (5xx, 429) is transient — keep polling.
    if (res.status === 404 || res.status === 410 || res.status === 401 || res.status === 403) {
      return { status: "failed", error: `fal.ai · ${opts.model}: splat job unavailable (HTTP ${res.status}).`, ready: false, queuePosition: null };
    }
    return { status: "processing", error: null, ready: false, queuePosition: null };
  }
  const data = await res.json().catch(() => ({}));
  const raw = String(data?.status || "").toUpperCase();
  const queuePosition = typeof data?.queue_position === "number" ? data.queue_position : null;

  if (raw === "COMPLETED") return { status: "completed", error: null, ready: true, queuePosition: null };
  if (raw === "FAILED" || raw === "ERROR") {
    return { status: "failed", error: `fal.ai · ${opts.model}: ${String(data?.error || "generation failed upstream")}`, ready: false, queuePosition: null };
  }
  if (raw === "IN_QUEUE") return { status: "pending", error: null, ready: false, queuePosition };
  return { status: "processing", error: null, ready: false, queuePosition };
}

/** Fetch the finished job payload. */
export async function fetchSplatResult(
  apiKey: string,
  opts: { model: string; requestId: string; responseUrl?: string | null },
): Promise<any> {
  const url = opts.responseUrl
    || `${FAL_QUEUE}/${queueBase(opts.model)}/requests/${encodeURIComponent(opts.requestId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${opts.model}: reading the finished splat timed out after ${API_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`fal.ai · ${opts.model}: could not read the finished splat (HTTP ${res.status}) ${t.slice(0, 160)}`);
  }
  return await res.json().catch(() => ({}));
}

/** Pull the splat file URL out of a result payload. Handles both catalog models
 *  plus a generic extension sniff, so a schema tweak degrades instead of
 *  breaking. Deliberately does NOT assume `model_mesh` means "mesh". */
export function extractSplatFileUrl(model: string, payload: any): string | null {
  if (!payload) return null;
  const candidates = [
    payload.model_mesh,          // TripoSplat — a splat despite the name
    payload.gaussian_splat,      // SAM 3D Objects
    Array.isArray(payload.individual_splats) ? payload.individual_splats[0] : null,
    payload.splat,
    payload.model_glb,
    Array.isArray(payload.individual_glbs) ? payload.individual_glbs[0] : null,
  ];
  for (const c of candidates) {
    const u = fileUrl(c);
    if (u) return u;
  }
  // Last resort: any field whose URL looks like a 3D asset.
  for (const v of Object.values(payload)) {
    const u = fileUrl(v);
    if (u && /\.(splat|ply|glb)(\?|$)/i.test(u)) return u;
  }
  return null;
}

export function extractPosterUrl(payload: any): string | null {
  return fileUrl(payload?.preprocessed_image) || fileUrl(payload?.preview_image) || null;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export async function insertPendingSplat(opts: {
  requestId: string;
  model: string;
  prompt: string;
  sourceImageId?: string | null;
  format: SplatFormat;
  splatCount?: number | null;
  statusUrl?: string | null;
  responseUrl?: string | null;
  estCost?: number | null;
}): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");
  const { data, error } = await (supabase.from("splat_generations" as any) as any)
    .insert({
      user_id: uid,
      request_id: opts.requestId,
      provider: "fal",
      model: opts.model,
      prompt: opts.prompt.slice(0, 2000),
      caption: "",
      source_image_id: opts.sourceImageId ?? null,
      format: opts.format,
      splat_count: opts.splatCount ?? null,
      status_url: opts.statusUrl ?? null,
      response_url: opts.responseUrl ?? null,
      cost: opts.estCost ?? null,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(`Splat record failed: ${error.message}`);
  return (data as any)?.id || null;
}

export async function fetchSplatByRequestId(requestId: string): Promise<SplatGenerationRow | null> {
  const { data } = await (supabase.from("splat_generations" as any) as any)
    .select("*")
    .eq("request_id", requestId)
    .maybeSingle();
  return (data as SplatGenerationRow) || null;
}

export async function fetchSplatById(id: string): Promise<SplatGenerationRow | null> {
  const { data } = await (supabase.from("splat_generations" as any) as any)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as SplatGenerationRow) || null;
}

/** How long a job may sit in-flight before it stops blocking new ones. fal
 *  inference is ~5s, so anything older than this is abandoned, not running —
 *  without this bound a single crashed/closed-tab job would lock the feature
 *  permanently. */
const IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000;

/** Is there already a splat in flight for this user? fal keys have no spend
 *  ceiling, so one concurrent paid job per user is a cheap safety rail that
 *  also works across tabs (unlike an in-memory flag). Age-bounded so a dead row
 *  can never become a permanent lockout. */
export async function hasInFlightSplat(): Promise<boolean> {
  const since = new Date(Date.now() - IN_FLIGHT_MAX_AGE_MS).toISOString();
  const { count } = await (supabase.from("splat_generations" as any) as any)
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "processing"])
    .gte("created_at", since);
  return (count || 0) > 0;
}

/** Generations started since the beginning of the current UTC month. */
export async function countSplatsThisMonth(): Promise<number> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { count } = await (supabase.from("splat_generations" as any) as any)
    .select("id", { count: "exact", head: true })
    .gte("created_at", start);
  return count || 0;
}

/** Total stored bytes across this user's splats, for the Settings readout. */
export async function splatStorageBytes(): Promise<number> {
  const { data } = await (supabase.from("splat_generations" as any) as any)
    .select("file_bytes")
    .not("file_bytes", "is", null);
  return ((data as any[]) || []).reduce((sum, r) => sum + (Number(r.file_bytes) || 0), 0);
}

// ── Memory ──────────────────────────────────────────────────────────────────

/** Create a memory neuron for a generated splat (text-proxy embedding).
 *  Mirrors saveVideoNeuron. */
export async function saveSplatNeuron(opts: {
  prompt: string;
  caption: string;
  model: string;
  splatCount?: number | null;
}): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data: settings } = await supabase
    .from("user_settings")
    .select("active_wiki_id" as any)
    .maybeSingle();
  const wikiId = (settings as any)?.active_wiki_id || null;
  const shortPrompt = opts.prompt.length > 60 ? opts.prompt.slice(0, 57).trimEnd() + "…" : opts.prompt;
  const content = [
    `AI-generated 3D Gaussian splat.`,
    `Prompt: ${opts.prompt}`,
    opts.caption && opts.caption !== opts.prompt ? `Description: ${opts.caption}` : "",
    `${opts.splatCount ? `${opts.splatCount.toLocaleString()} gaussians, ` : ""}generated with ${opts.model}.`,
  ].filter(Boolean).join("\n");
  const { data: entry, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: uid,
      title: `3D: ${shortPrompt}`,
      content: content.slice(0, 4000),
      entry_type: "concept",
      tags: ["splat", "3d", "generated"],
      confidence: 0.9,
      ...(wikiId ? { wiki_id: wikiId } : {}),
    } as any)
    .select("id")
    .single();
  if (error || !entry) return null;
  void reindexEmbeddings(true, wikiId).catch(() => {});
  return (entry as any).id;
}

// ── Finalize ────────────────────────────────────────────────────────────────

/** Complete a finished job: read the result, download + validate the splat,
 *  store it and a poster in the private bucket, create the memory neuron, and
 *  flip the row to completed. Idempotent. */
export async function finalizeSplatJob(opts: {
  apiKey: string;
  requestId: string;
  model: string;
  prompt?: string;
  remember?: boolean;
  /** Hard ceiling in MB; a larger asset is refused rather than half-stored. */
  maxFileMb?: number;
}): Promise<SplatGenerationRow> {
  let existing = await fetchSplatByRequestId(opts.requestId);
  if (existing?.status === "completed" && existing.storage_path) return existing;

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");

  // Reconstruct the row if the pending insert failed at submit time — the user
  // already paid for this asset, so don't drop it. Keyed on the unique
  // request_id; a concurrent finalizer's row is preserved via upsert.
  if (!existing) {
    const { error: recErr } = await (supabase.from("splat_generations" as any) as any).upsert(
      {
        user_id: uid,
        request_id: opts.requestId,
        provider: "fal",
        model: opts.model,
        prompt: (opts.prompt || "").slice(0, 2000),
        // NOT 'pending': the quota trigger only counts fresh submissions, so
        // recovering an already-paid job can never be blocked by the quota.
        status: "processing",
      },
      { onConflict: "request_id" },
    );
    existing = await fetchSplatByRequestId(opts.requestId);
    if (!existing) {
      throw new Error(
        `Splat job record could not be created${recErr?.message ? `: ${recErr.message}` : ""}`,
      );
    }
  }

  const modelId = existing.model || opts.model;
  const payload = await fetchSplatResult(opts.apiKey, {
    model: modelId,
    requestId: opts.requestId,
    responseUrl: existing.response_url,
  });

  // Terminal failures must move the row OFF pending. A row left pending is
  // counted by hasInFlightSplat and would otherwise keep refusing new jobs
  // (bounded by IN_FLIGHT_MAX_AGE_MS, but the user shouldn't have to wait it
  // out for a failure we already know is permanent).
  const failTerminal = async (message: string): Promise<never> => {
    await markSplatJobFailed(opts.requestId, message);
    throw new Error(message);
  };

  const assetUrl = extractSplatFileUrl(modelId, payload);
  if (!assetUrl) await failTerminal(`fal.ai · ${modelId}: the finished job contained no 3D file.`);

  let buf: ArrayBuffer;
  try {
    // The deadline covers the body read too — arrayBuffer() on a stalled
    // stream hangs exactly like the initial request would.
    const assetRes = await fetch(assetUrl as string, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!assetRes.ok) throw new Error(`fal.ai · ${modelId}: splat download failed (HTTP ${assetRes.status})`);
    buf = await assetRes.arrayBuffer();
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${modelId}: splat download timed out after ${MEDIA_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  const bytes = buf.byteLength;

  // Size guard BEFORE upload — an oversized asset fails cleanly instead of
  // partially occupying the bucket (PLY size is genuinely unpredictable).
  const maxMb = typeof opts.maxFileMb === "number" && opts.maxFileMb > 0 ? opts.maxFileMb : 25;
  if (bytes > maxMb * 1024 * 1024) {
    await failTerminal(
      `fal.ai · ${modelId}: the generated file is ${(bytes / 1048576).toFixed(1)} MB, over your ${maxMb} MB limit. Try the Fast or Standard quality.`,
    );
  }

  // Trust the bytes, never the field name: `model_mesh` holds a splat on
  // TripoSplat and a GLB on Trellis. Persist what it actually is.
  const head = new Uint8Array(buf.slice(0, 8));
  const sniffed = detectSplatFormat(head, bytes);
  const requested = (existing.format as SplatFormat) || "splat";
  const actual: SplatFormat = sniffed === "unknown" ? requested : sniffed;
  if (sniffed === "unknown") {
    await failTerminal(`fal.ai · ${modelId}: the downloaded file wasn't a recognisable splat, PLY or GLB.`);
  }

  const safeId = opts.requestId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  const base = `${uid}/${safeId}`;
  const assetPath = `${base}.${extForFormat(actual)}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(assetPath, new Blob([buf], { type: mimeForFormat(actual) }), {
      contentType: mimeForFormat(actual),
      upsert: true,
    });
  if (upErr) throw new Error(`Splat upload failed: ${upErr.message}`);

  // Poster: fal's background-removed composite is exactly what the model saw,
  // so it makes an honest thumbnail. Best effort.
  let posterPath: string | null = existing.poster_path;
  const posterUrl = extractPosterUrl(payload);
  if (!posterPath && posterUrl) {
    try {
      const pRes = await fetch(posterUrl, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
      if (pRes.ok) {
        const pBlob = await pRes.blob();
        const pPath = `${base}.jpg`;
        const { error: pErr } = await supabase.storage
          .from(BUCKET)
          .upload(pPath, pBlob, { contentType: pBlob.type || "image/jpeg", upsert: true });
        if (!pErr) posterPath = pPath;
      }
    } catch { posterPath = null; }
  }

  // Create the memory neuron once — re-read entry_id first so a concurrent
  // finalizer's neuron isn't duplicated.
  let entryId: string | null = existing.entry_id;
  if (opts.remember !== false && !entryId) {
    const fresh = await fetchSplatByRequestId(opts.requestId);
    entryId = fresh?.entry_id || null;
    if (!entryId) {
      const created = await saveSplatNeuron({
        prompt: existing.prompt,
        caption: existing.caption || "",
        model: existing.model,
        splatCount: typeof payload?.num_gaussians === "number" ? payload.num_gaussians : existing.splat_count,
      });
      if (created) {
        // Claim the slot atomically. Re-reading entry_id beforehand doesn't
        // close the race — the window is the whole duration of saveSplatNeuron,
        // so two tabs can both see NULL and both insert. The conditional update
        // decides a single winner; the loser removes its duplicate instead of
        // leaving an orphan neuron in the user's memory.
        const { data: claimed } = await (supabase.from("splat_generations" as any) as any)
          .update({ entry_id: created })
          .eq("request_id", opts.requestId)
          .is("entry_id", null)
          .select("entry_id");
        if (Array.isArray(claimed) && claimed.length > 0) {
          entryId = created;
        } else {
          try { await supabase.from("knowledge_entries").delete().eq("id", created); }
          catch { /* worst case an orphan neuron remains; never fail the asset */ }
          const winner = await fetchSplatByRequestId(opts.requestId);
          entryId = winner?.entry_id || null;
        }
      }
    }
  }

  const { data: row, error: updErr } = await (supabase.from("splat_generations" as any) as any)
    .update({
      storage_path: assetPath,
      poster_path: posterPath,
      format: actual,
      mime: mimeForFormat(actual),
      file_bytes: bytes,
      splat_count: typeof payload?.num_gaussians === "number" ? payload.num_gaussians : existing.splat_count,
      entry_id: entryId,
      cost: existing.cost ?? estimateSplatCostUSD(existing.model),
      status: "completed",
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("request_id", opts.requestId)
    .select("*")
    .single();
  if (updErr) throw new Error(`Splat finalize failed: ${updErr.message}`);
  return row as SplatGenerationRow;
}

export async function markSplatJobFailed(requestId: string, error: string): Promise<void> {
  try {
    await (supabase.from("splat_generations" as any) as any)
      .update({ status: "failed", error: error.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("request_id", requestId);
  } catch { /* best effort */ }
}

export async function searchSplats(query: string | undefined, limit = 10): Promise<SplatGenerationRow[]> {
  let q = (supabase.from("splat_generations" as any) as any)
    .select("id, request_id, entry_id, prompt, caption, model, storage_path, poster_path, format, splat_count, file_bytes, cost, status, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(25, Math.max(1, limit)));
  const trimmed = (query || "").trim();
  if (trimmed) {
    const safe = sanitizeIlike(trimmed);
    q = q.or(`prompt.ilike.%${safe}%,caption.ilike.%${safe}%`);
  }
  const { data } = await q;
  return (data as SplatGenerationRow[]) || [];
}

/** Delete a generated splat: DB row first, then best-effort storage cleanup. */
export async function deleteSplatGeneration(row: {
  id: string; storage_path?: string | null; poster_path?: string | null;
}): Promise<void> {
  const { data: deleted, error } = await (supabase.from("splat_generations" as any) as any)
    .delete()
    .eq("id", row.id)
    .select("id, storage_path, poster_path");
  if (error) throw error;
  const rows = (deleted as any[]) || [];
  if (rows.length === 0) throw new Error("Splat could not be deleted (not found or no permission).");
  const paths = [
    rows[0]?.storage_path || row.storage_path,
    rows[0]?.poster_path || row.poster_path,
  ].filter(Boolean) as string[];
  if (paths.length) {
    try { await supabase.storage.from(BUCKET).remove(paths); }
    catch (e) { console.warn("[deleteSplatGeneration] storage remove failed", e); }
    for (const p of paths) { try { urlCache.delete(p); } catch { /* noop */ } }
  }
}

// ── Signed URL cache ────────────────────────────────────────────────────────
const SIGNED_TTL_S = 60 * 60 * 24; // 24h
const urlCache = new Map<string, { url: string; expires: number }>();

export async function getSignedSplatUrl(storagePath: string): Promise<string | null> {
  if (!storagePath) return null;
  const cached = urlCache.get(storagePath);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_TTL_S);
  if (error || !data?.signedUrl) return null;
  urlCache.set(storagePath, { url: data.signedUrl, expires: Date.now() + (SIGNED_TTL_S - 300) * 1000 });
  return data.signedUrl;
}

/** Convenience for callers that only have a quality tier. */
export function tierToSubmitParams(quality: QualityTier): { numGaussians: number; format: SplatFormat } {
  const t = getTier(quality);
  return { numGaussians: t.numGaussians, format: t.format };
}
