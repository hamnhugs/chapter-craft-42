import { supabase } from "@/integrations/supabase/client";
import {
  fetchVideoByJobId, saveVideoNeuron, markVideoJobFailed, posterFromVideoBlob,
  extractApiError, type VideoGenerationRow,
} from "@/lib/videoGen";

// Motion transfer + reference-draft video via fal.ai's queue API, billed to the
// user's fal key (same key as splats). Two features OpenRouter's /videos API
// cannot do ride here:
//
//   1. MOTION TRANSFER ("motion_plate"): a driving video's kinematics applied
//      to the master's appearance. Every productized backend requires a HUMAN
//      performer in the driving clip; the character image may be stylized.
//   2. REFERENCE DRAFTS: Vidu Q2's flat-priced reference-to-video — a cheap
//      identity-pack iteration tier ($0.10-0.30 per clip, not per second).
//
// Rows live in the SAME video_generations table with provider='fal' and
// job_id='fal:<request_id>' so list/show/delete and chat references work
// unchanged. Polling mirrors splatGen (same queue API).

const FAL_QUEUE = "https://queue.fal.run";
const BUCKET = "generated-videos";

// Every outbound fetch carries a deadline: a request with no signal can hang
// the tab forever on a socket the server accepted but never answers. 45s for
// submit/poll/result API calls, 180s for the finished-clip download.
const API_TIMEOUT_MS = 45_000;
const MEDIA_TIMEOUT_MS = 180_000;

export interface FalVideoModel {
  id: string;
  label: string;
  kind: "motion" | "reference";
  /** USD per output second (fal pricing pages, verified 2026-07-24). */
  perSecondUSD: number | null;
  /** Flat USD per clip by resolution (Vidu Q2, up to 720p). */
  flatByResolution?: Record<string, number>;
  /** Vidu's 1080p tier is base + per-second, not flat. */
  resolution1080?: { baseUSD: number; perSecondUSD: number };
  maxDrivingSeconds?: number;
  notes: string;
}

export const DEFAULT_MOTION_MODEL = "fal-ai/wan-motion";

export const FAL_VIDEO_MODELS: FalVideoModel[] = [
  {
    id: "fal-ai/wan-motion",
    label: "Wan Motion — default, pose retargeting ($0.06/s)",
    kind: "motion",
    perSecondUSD: 0.06,
    maxDrivingSeconds: 30,
    notes: "Wan-Animate based. adapt_motion retargets the driver's skeleton to the master's proportions (the right default for stylized characters). enhance_identity adds ~$0.08.",
  },
  {
    id: "fal-ai/kling-video/v3/standard/motion-control",
    label: "Kling v3 Motion Control — premium ($0.126/s)",
    kind: "motion",
    perSecondUSD: 0.126,
    maxDrivingSeconds: 10, // character_orientation=image (proportion-preserving) caps at 10s
    notes: "character_orientation=image preserves the master's proportions (10s cap). Driving video must show a realistic human, full/upper body + head, unoccluded.",
  },
  {
    id: "fal-ai/vidu/q2/reference-to-video",
    label: "Vidu Q2 Reference — cheap identity drafts (flat $0.10-0.30)",
    kind: "reference",
    perSecondUSD: null,
    flatByResolution: { "360p": 0.1, "520p": 0.2, "720p": 0.3 },
    // 1080p is NOT flat: $0.20 base + $0.10 per second (fal pricing page).
    resolution1080: { baseUSD: 0.2, perSecondUSD: 0.1 },
    notes: "Up to 7 reference images, flat per-clip pricing up to 720p. Draft tier: iterate here, re-render winners on a premium model.",
  },
];

/** Resolutions the draft submit path accepts; anything else must be snapped
 *  BEFORE pricing, so the estimate always matches what is actually sent. */
export const DRAFT_RESOLUTIONS = ["360p", "520p", "720p", "1080p"] as const;

/** Vidu Q2's duration is an INTEGER 1–8 — live-verified 2026-07-24: sending
 *  the string "4" fails with literal_error "Input should be 1, 2, 3, 4, 5,
 *  6, 7 or 8". fal validates the payload only when a worker picks the job
 *  up, so a bad value enqueues fine, reports COMPLETED, and stores the
 *  validation error as the job's RESULT — client-side correctness is the
 *  only real guard. Clamp BEFORE pricing (1080p bills per second). */
export function clampDraftDuration(durationS: number): number {
  return Math.min(8, Math.max(1, Math.round(Number(durationS) || 4)));
}

/** Aspect ratios Vidu accepts; anything else is dropped (provider defaults to
 *  16:9) rather than 422-ing the whole job. */
export const DRAFT_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

export function getFalVideoModel(id: string): FalVideoModel | null {
  return FAL_VIDEO_MODELS.find((m) => m.id === id) || null;
}

/** Estimated USD for a fal clip. Returns null for ANY unrecognized model or
 *  resolution — callers must treat null as "unknown price, fail safe to
 *  confirmation", never as "cheap". */
export function estimateFalVideoCostUSD(
  modelId: string,
  opts: { durationS: number; resolution?: string | null; enhanceIdentity?: boolean },
): number | null {
  const m = getFalVideoModel(modelId);
  if (!m) return null;
  const dur = Math.max(1, Number(opts.durationS) || 5);
  if (m.flatByResolution) {
    const res = (opts.resolution || "720p").toLowerCase();
    const flat = m.flatByResolution[res];
    if (typeof flat === "number") return flat;
    if (res === "1080p" && m.resolution1080) {
      return m.resolution1080.baseUSD + m.resolution1080.perSecondUSD * dur;
    }
    // Unknown resolution: NEVER substitute another tier's price.
    return null;
  }
  if (m.perSecondUSD == null) return null;
  return m.perSecondUSD * dur + (opts.enhanceIdentity ? 0.08 : 0);
}

const falHeaders = (apiKey: string) => ({
  "Content-Type": "application/json",
  Authorization: `Key ${apiKey}`,
});

/** fal queue status/result routes hang off the first two path segments of a
 *  model id. Same convention splatGen relies on. */
function queueBase(model: string): string {
  return model.split("/").filter(Boolean).slice(0, 2).join("/");
}

export const FAL_JOB_PREFIX = "fal:";

export function isFalJobId(jobId: string): boolean {
  return jobId.startsWith(FAL_JOB_PREFIX);
}

/** How long a fal video job may sit in-flight before it stops blocking new
 *  ones — same rationale as the splat guard: fal keys have no spend ceiling,
 *  so one concurrent paid job per user is a cheap cross-tab safety rail, and
 *  the age bound keeps a crashed-tab row from becoming a permanent lockout. */
const IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000;

export async function hasInFlightFalVideo(): Promise<boolean> {
  const since = new Date(Date.now() - IN_FLIGHT_MAX_AGE_MS).toISOString();
  const { count } = await (supabase.from("video_generations" as any) as any)
    .select("id", { count: "exact", head: true })
    .eq("provider", "fal")
    .in("status", ["pending", "processing"])
    .gte("created_at", since);
  return (count || 0) > 0;
}

export function falRequestId(jobId: string): string {
  return jobId.slice(FAL_JOB_PREFIX.length);
}

// ── Submit ──────────────────────────────────────────────────────────────────

export interface FalSubmitResult {
  requestId: string;
  jobId: string; // "fal:<requestId>" — the video_generations key
}

async function submitToFal(apiKey: string, model: string, body: Record<string, unknown>): Promise<FalSubmitResult> {
  let res: Response;
  try {
    res = await fetch(`${FAL_QUEUE}/${model}`, {
      method: "POST",
      headers: falHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${model}: video submit timed out after ${API_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error("Invalid fal.ai API key.");
    if (res.status === 402) throw new Error("Insufficient fal.ai credits — this bills to your own fal key.");
    if (res.status === 422) throw new Error(`fal.ai · ${model}: rejected the request — ${extractApiError(errText)}`);
    throw new Error(`fal.ai · ${model}: video submit failed (HTTP ${res.status}) ${extractApiError(errText)}`);
  }
  const data = await res.json().catch(() => ({}));
  const requestId: string | undefined = data?.request_id || data?.requestId;
  if (!requestId) throw new Error(`fal.ai · ${model}: submit returned no request id.`);
  return { requestId, jobId: `${FAL_JOB_PREFIX}${requestId}` };
}

/** Motion transfer: master appearance + driving-video kinematics. */
export async function submitMotionTransfer(opts: {
  apiKey: string;
  model: string;
  characterImageUrl: string;
  drivingVideoUrl: string;
  prompt?: string;
  enhanceIdentity?: boolean;
}): Promise<FalSubmitResult> {
  const model = opts.model || DEFAULT_MOTION_MODEL;
  let body: Record<string, unknown>;
  if (model.includes("motion-control")) {
    // Kling: character_orientation=image preserves the MASTER's proportions —
    // the correct mode for stylized characters driven by human video.
    body = {
      image_url: opts.characterImageUrl,
      video_url: opts.drivingVideoUrl,
      character_orientation: "image",
      keep_original_sound: false,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    };
  } else {
    // Wan Motion: adapt_motion retargets driver skeleton to the character's
    // body proportions (defaults true upstream; sent explicitly for clarity).
    body = {
      image_url: opts.characterImageUrl,
      video_url: opts.drivingVideoUrl,
      adapt_motion: true,
      ...(opts.enhanceIdentity ? { enhance_identity: true } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    };
  }
  return await submitToFal(opts.apiKey, model, body);
}

/** Reference draft (Vidu Q2): identity pack -> cheap flat-priced clip. */
export async function submitReferenceDraft(opts: {
  apiKey: string;
  model?: string;
  prompt: string;
  referenceImageUrls: string[];
  durationS?: number;
  resolution?: string;
  aspectRatio?: string;
}): Promise<FalSubmitResult> {
  const model = opts.model || "fal-ai/vidu/q2/reference-to-video";
  // duration goes out as a BARE INTEGER — the string form ("4") is exactly
  // what the live API 422s on (see clampDraftDuration). Defensive re-clamp:
  // callers clamp before pricing, but an out-of-range value must never fly.
  const ar = (opts.aspectRatio || "").trim();
  const body: Record<string, unknown> = {
    prompt: opts.prompt.slice(0, 3000),
    reference_image_urls: opts.referenceImageUrls.slice(0, 7),
    duration: clampDraftDuration(opts.durationS || 4),
    resolution: opts.resolution || "720p",
    ...((DRAFT_ASPECT_RATIOS as readonly string[]).includes(ar) ? { aspect_ratio: ar } : {}),
  };
  return await submitToFal(opts.apiKey, model, body);
}

// ── Poll ────────────────────────────────────────────────────────────────────

export interface FalVideoPollSnapshot {
  status: "pending" | "processing" | "completed" | "failed";
  error: string | null;
  ready: boolean;
  /** 401/403: the KEY is bad, not the job. The job may still be rendering and
   *  billed — callers must NOT mark the row failed; fix the key and retry. */
  authError?: boolean;
}

/** Poll a queued fal video job. Never throws for normal not-ready states. */
export async function pollFalVideo(
  apiKey: string,
  opts: { model: string; jobId: string },
): Promise<FalVideoPollSnapshot> {
  const requestId = falRequestId(opts.jobId);
  const url = `${FAL_QUEUE}/${queueBase(opts.model)}/requests/${encodeURIComponent(requestId)}/status`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e: any) {
    // Thrown errors were already the contract for network failures (the
    // bubble's poll loop catches and keeps polling) — a timeout rides the
    // same path, it just says who stalled.
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${opts.model}: status poll timed out after ${API_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { status: "failed", error: "fal.ai rejected the API key — the clip may still be rendering. Fix the key in Settings and press Try again.", ready: false, authError: true };
    }
    if (res.status === 404 || res.status === 410) {
      return { status: "failed", error: `fal.ai · ${opts.model}: video job unavailable (HTTP ${res.status}).`, ready: false };
    }
    return { status: "processing", error: null, ready: false };
  }
  const data = await res.json().catch(() => ({}));
  const raw = String(data?.status || "").toUpperCase();
  if (raw === "COMPLETED") return { status: "completed", error: null, ready: true };
  if (raw === "FAILED" || raw === "ERROR") {
    return { status: "failed", error: `fal.ai · ${opts.model}: ${String(data?.error || "generation failed upstream")}`, ready: false };
  }
  if (raw === "IN_QUEUE") return { status: "pending", error: null, ready: false };
  return { status: "processing", error: null, ready: false };
}

/** Pull the finished clip's URL out of a fal result payload. fal video models
 *  return { video: { url } } — with fallbacks so a schema tweak degrades
 *  instead of breaking. */
export function extractFalVideoUrl(payload: any): string | null {
  const candidates = [
    payload?.video?.url,
    payload?.video_url,
    payload?.output?.url,
    typeof payload?.video === "string" ? payload.video : null,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  for (const v of Object.values(payload || {})) {
    const u = typeof v === "string" ? v : (v as any)?.url;
    if (typeof u === "string" && /\.(mp4|webm|mov)(\?|$)/i.test(u)) return u;
  }
  return null;
}

// ── Finalize ────────────────────────────────────────────────────────────────

/** Complete a finished fal job: read the result, download the MP4, store it +
 *  a poster in the shared generated-videos bucket, create the memory neuron,
 *  and flip the row to completed. Idempotent — mirrors finalizeVideoJob. */
export async function finalizeFalVideoJob(opts: {
  apiKey: string;
  jobId: string;
  model: string;
  prompt?: string;
  remember?: boolean;
}): Promise<VideoGenerationRow> {
  let existing = await fetchVideoByJobId(opts.jobId);
  if (existing?.status === "completed" && existing.storage_path) return existing;

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");

  // Reconstruct the row if the pending insert failed at submit time — the
  // user already paid for this clip.
  if (!existing) {
    await (supabase.from("video_generations" as any) as any).upsert(
      {
        user_id: uid,
        job_id: opts.jobId,
        model: opts.model,
        prompt: (opts.prompt || "").slice(0, 2000),
        // Safe to include: fal jobs can only have been submitted on a database
        // that already has the identity migration (the submit path gates on it).
        provider: "fal",
        status: "processing",
      },
      { onConflict: "job_id" },
    );
    existing = await fetchVideoByJobId(opts.jobId);
    if (!existing) throw new Error("Video job record could not be created");
  }

  const requestId = falRequestId(opts.jobId);
  const modelId = existing.model || opts.model;
  const resultUrl = `${FAL_QUEUE}/${queueBase(modelId)}/requests/${encodeURIComponent(requestId)}`;
  let res: Response;
  try {
    res = await fetch(resultUrl, {
      headers: { Authorization: `Key ${opts.apiKey}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${modelId}: reading the finished clip timed out after ${API_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // A 422 here is the job's TERMINAL outcome, not a read hiccup: fal
    // validates the payload at worker pickup, so a bad request "completes"
    // and stores the validation error as its result. Persist the failure so
    // the row is honest and the one-in-flight rail frees immediately instead
    // of blocking new fal jobs for up to 30 minutes.
    if (res.status === 422) {
      const msg = `fal.ai · ${modelId}: rejected the job's inputs — ${extractApiError(t)}`;
      await markVideoJobFailed(opts.jobId, msg);
      throw new Error(msg);
    }
    throw new Error(`fal.ai · ${modelId}: could not read the finished clip (HTTP ${res.status}) ${extractApiError(t).slice(0, 160)}`);
  }
  const payload = await res.json().catch(() => ({}));

  const videoUrl = extractFalVideoUrl(payload);
  if (!videoUrl) {
    const msg = `fal.ai · ${modelId}: the finished job contained no video file.`;
    await markVideoJobFailed(opts.jobId, msg);
    throw new Error(msg);
  }

  let blob: Blob;
  try {
    // The deadline covers the body read too — blob() on a stalled stream
    // hangs exactly like the initial request would.
    const clipRes = await fetch(videoUrl, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!clipRes.ok) throw new Error(`fal.ai · ${modelId}: video download failed (HTTP ${clipRes.status})`);
    blob = await clipRes.blob();
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`fal.ai · ${modelId}: video download timed out after ${MEDIA_TIMEOUT_MS / 1000}s.`);
    throw e;
  }

  const safeJob = opts.jobId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  const base = `${uid}/${safeJob}`;
  const videoPath = `${base}.mp4`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(videoPath, blob, { contentType: "video/mp4", upsert: true });
  if (upErr) throw new Error(`Video upload failed: ${upErr.message}`);

  let posterPath: string | null = null;
  try {
    const poster = await posterFromVideoBlob(blob);
    if (poster) {
      const pPath = `${base}.jpg`;
      const { error: pErr } = await supabase.storage
        .from(BUCKET)
        .upload(pPath, poster, { contentType: "image/jpeg", upsert: true });
      if (!pErr) posterPath = pPath;
    }
  } catch { posterPath = null; }

  let entryId: string | null = existing.entry_id;
  if (opts.remember !== false && !entryId) {
    const fresh = await fetchVideoByJobId(opts.jobId);
    entryId = fresh?.entry_id || null;
    if (!entryId) {
      entryId = await saveVideoNeuron({
        prompt: existing.prompt,
        caption: existing.caption || "",
        model: existing.model,
        durationS: existing.duration_s,
        sourceImageIds: existing.source_image_ids || null,
        sourceSplatId: existing.source_splat_id || null,
        masterId: existing.master_id || null,
        conditionMode: existing.condition_mode || null,
        motionMode: existing.motion_mode || null,
      });
    }
  }

  const { data: row, error: updErr } = await (supabase.from("video_generations" as any) as any)
    .update({
      storage_path: videoPath,
      poster_path: posterPath,
      mime: "video/mp4",
      entry_id: entryId,
      status: "completed",
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("job_id", opts.jobId)
    .select("*")
    .single();
  if (updErr) throw new Error(`Video finalize failed: ${updErr.message}`);
  return row as VideoGenerationRow;
}
