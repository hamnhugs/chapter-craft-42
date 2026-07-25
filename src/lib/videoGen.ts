import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";
import { getSignedImageUrl } from "@/lib/imageGen";
import {
  DEFAULT_VIDEO_MODEL, providerSlugFor, negativePromptKey, identityScaleKey,
  type VideoModel, type FrameImageType,
} from "@/lib/videoCatalog";

// Video generation via OpenRouter's async jobs API, billed to the user's own
// OpenRouter key (same key as chat + image generation). Unlike images (a single
// blocking call), video is asynchronous: submit a job, poll until it's ready,
// then download the MP4 (the content URL needs the Authorization header, so it
// can't be embedded directly), store it in the private `generated-videos`
// bucket, and save it as a memory neuron. The `video_generations` table is the
// source of truth for a clip's lifecycle, keyed by the OpenRouter job id — so a
// page reload can resume polling or render a finished clip. This is DISTINCT
// from the YouTube-transcript `video_jobs` table.

const OR_BASE = "https://openrouter.ai/api/v1";
const BUCKET = "generated-videos";

export { DEFAULT_VIDEO_MODEL };

/** Lightweight reference persisted on a chat message. The heavy state lives in
 *  the `video_generations` row (looked up by job_id); the message only needs to
 *  know which clip to render. */
export interface ChatVideoRef {
  job_id: string;
  prompt: string;
  model: string;
}

export type VideoStatus = "pending" | "processing" | "completed" | "failed";

export type ConditionMode = "first_frame" | "reference" | "identity_lock";
export type MotionMode = "text" | "motion_plate";

/** Post-generation consistency scores logged on the row (advisory only). */
export interface VideoQcResult {
  qc_version: number;
  model_id: string;
  device: string;
  frame_timestamps: number[];
  ref_sim_mean: number | null;
  ref_sim_min: number | null;
  temporal_mean: number | null;
  palette_delta_e: number | null;
  verdict: "green" | "amber" | "red";
  runtime_ms: number;
}

export interface VideoGenerationRow {
  id: string;
  user_id: string;
  job_id: string;
  model: string;
  prompt: string;
  caption: string;
  entry_id: string | null;
  storage_path: string | null;
  poster_path: string | null;
  mime: string;
  duration_s: number | null;
  resolution: string | null;
  aspect_ratio: string | null;
  has_audio: boolean | null;
  cost: number | null;
  status: VideoStatus;
  error: string | null;
  created_at: string;
  updated_at?: string;
  // Identity-conditioning columns (video_identity migration). Absent/null on
  // rows created before the migration — every reader must tolerate undefined.
  provider?: string;
  source_image_ids?: string[] | null;
  source_splat_id?: string | null;
  master_id?: string | null;
  condition_mode?: string | null;
  motion_mode?: string | null;
  motion_video_id?: string | null;
  identity_scale?: number | null;
  assembly_instruction?: string | null;
  negative_constraints?: string[] | null;
  lock_palette?: string[] | null;
  qc?: VideoQcResult | null;
}

/** True when the identity-conditioning columns exist (migration applied).
 *  Pure text-to-video works either way; identity features refuse cleanly
 *  until the migration runs. */
export async function videoIdentityMigrated(): Promise<boolean> {
  try {
    const { error } = await (supabase.from("video_generations" as any) as any)
      .select("source_image_ids", { head: true, count: "exact" })
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ── Source image resolution ─────────────────────────────────────────────────

/** Resolve stored image ids into URLs OpenRouter's upstream providers can
 *  fetch. Images live in a private bucket, so this signs time-limited URLs.
 *  Throws when any id is missing: silently dropping an identity reference is
 *  exactly the failure mode this feature exists to eliminate.
 *
 *  freshSign: sign anew instead of reusing this tab's render cache, so the
 *  URL is valid for the FULL 24h. Submit paths must pass it — a provider may
 *  fetch the reference only when the job leaves its queue, and a cache-aged
 *  URL that expires first strands the job in "pending" forever. */
export async function resolveVideoSourceImages(
  imageIds: string[],
  opts: { freshSign?: boolean } = {},
): Promise<{
  urls: string[];
  ids: string[];
}> {
  const ids = imageIds.map((s) => String(s || "").trim()).filter(Boolean);
  if (ids.length === 0) return { urls: [], ids: [] };
  const { data, error } = await (supabase.from("image_attachments" as any) as any)
    .select("id, storage_path")
    .in("id", ids);
  if (error) throw new Error(`Could not look up source images: ${error.message}`);
  const byId = new Map<string, string>(
    ((data as any[]) || []).map((r) => [r.id, r.storage_path]),
  );
  const urls: string[] = [];
  for (const id of ids) {
    const path = byId.get(id);
    if (!path) throw new Error(`Image ${id} was not found (was it deleted?).`);
    const signed = await getSignedImageUrl(path, { fresh: opts.freshSign === true });
    if (!signed) throw new Error(`Could not prepare image ${id} for generation.`);
    urls.push(signed);
  }
  return { urls, ids };
}

// ── Pre-flight: verify conditioning media is fetchable BEFORE spending ──────

export interface PreflightIssue {
  label: string;
  kind: "unreachable" | "http_error" | "bad_content_type" | "empty" | "too_large";
  detail: string;
  /** Blocking issues must refuse the submit; the rest are warnings. */
  blocking: boolean;
}

export interface PreflightResult {
  ok: boolean; // no blocking issues
  issues: PreflightIssue[];
  checked: number;
}

/** Verify that each conditioning URL actually serves the expected media,
 *  from the browser, before a job is queued — the #1 cause of a job that
 *  submits fine and then stalls in "pending" is a reference the upstream
 *  provider cannot fetch (deleted object, expired signature, wrong bucket).
 *
 *  strict targets (our own storage — the app provably fetches these URLs
 *  elsewhere) treat any failure as blocking. Non-strict targets (arbitrary
 *  user-supplied URLs) only block on a definitive HTTP error status; network/
 *  CORS failures downgrade to warnings because the browser check can be
 *  blocked where a server-side fetch would succeed.
 *
 *  HEAD first (no body, no CORS preflight), plain GET as a fallback for
 *  servers that reject HEAD; bodies are cancelled after the headers arrive. */
export async function preflightRemoteMedia(
  targets: Array<{ url: string; label: string; expect: "image" | "video"; strict: boolean }>,
  opts: { timeoutMs?: number } = {},
): Promise<PreflightResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const WARN_IMAGE_BYTES = 10 * 1024 * 1024;  // common provider ref-image cap
  const WARN_VIDEO_BYTES = 100 * 1024 * 1024;

  const checkOne = async (t: { url: string; label: string; expect: "image" | "video"; strict: boolean }): Promise<PreflightIssue | null> => {
    // Each attempt gets its OWN controller and deadline — with a shared one,
    // a HEAD that hangs to the timeout hands the GET arbiter a pre-aborted
    // signal and a valid job gets refused.
    const probe = async (method: "HEAD" | "GET"): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(t.url, { method, signal: ctrl.signal });
        if (method === "GET") void res.body?.cancel().catch(() => {});
        return res;
      } finally { clearTimeout(timer); }
    };
    try {
      let res: Response | null = null;
      try { res = await probe("HEAD"); } catch { res = null; }
      if (!res || !res.ok) {
        // Any failed HEAD retries as the plain GET the app already uses on
        // these URLs elsewhere — GET is the arbiter, so a server that
        // mishandles HEAD can never false-positive a valid job into refusal.
        res = await probe("GET");
      }
      if (!res.ok) {
        // Blocking only for our own storage. A browser-observed 403/404 on an
        // arbitrary URL is NOT proof the provider's server-side fetch fails
        // (hotlink protection commonly 403s browsers and serves datacenters).
        const why = res.status === 403 || res.status === 401
          ? (t.strict
            ? "access denied — the signed URL is invalid or expired"
            : `HTTP ${res.status} to the browser — some hosts block browser fetches but allow server-side ones`)
          : res.status === 404 ? "not found — the file no longer exists"
          : `HTTP ${res.status}`;
        return { label: t.label, kind: "http_error", detail: why, blocking: t.strict };
      }
      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      if (ctype && !ctype.startsWith(`${t.expect}/`) && !ctype.startsWith("application/octet-stream")) {
        return {
          label: t.label, kind: "bad_content_type",
          detail: `serves "${ctype}", expected ${t.expect}/*`,
          blocking: t.strict,
        };
      }
      // An ABSENT Content-Length is unknown, not zero (chunked/compressed
      // responses legally omit it) — only a declared 0 counts as empty.
      const rawLen = res.headers.get("content-length");
      const len = rawLen == null || rawLen === "" ? NaN : Number(rawLen);
      if (Number.isFinite(len)) {
        if (len === 0) return { label: t.label, kind: "empty", detail: "reports 0 bytes", blocking: t.strict };
        const warnAt = t.expect === "image" ? WARN_IMAGE_BYTES : WARN_VIDEO_BYTES;
        if (len > warnAt) {
          return {
            label: t.label, kind: "too_large",
            detail: `${(len / (1024 * 1024)).toFixed(1)} MB — some providers cap ${t.expect}s around ${Math.round(warnAt / (1024 * 1024))} MB and fail silently`,
            blocking: false,
          };
        }
      }
      return null;
    } catch {
      return {
        label: t.label, kind: "unreachable",
        detail: t.strict
          ? "could not be fetched from the browser — the provider almost certainly can't fetch it either"
          : "could not be verified from the browser (CORS may block the check); the provider may still fetch it fine",
        blocking: t.strict,
      };
    }
  };

  const issues = (await Promise.all(targets.map(checkOne))).filter(Boolean) as PreflightIssue[];
  return { ok: !issues.some((i) => i.blocking), issues, checked: targets.length };
}

/** One-line human summary of blocking preflight issues, for refusal messages. */
export function describePreflightFailures(r: PreflightResult): string {
  return r.issues.filter((i) => i.blocking).map((i) => `${i.label}: ${i.detail}`).join("; ");
}

// ── Provider passthrough (negatives + identity strength) ────────────────────

export interface PassthroughPlan {
  /** provider.options payload for the submit body, or null when nothing to send. */
  providerOptions: Record<string, unknown> | null;
  /** What was actually applied — surfaced to the model so it reports honestly. */
  applied: { negative_prompt: boolean; identity_scale: boolean };
  /** Human-readable notes for anything requested but NOT applicable. */
  skipped: string[];
}

/** Build the provider.options passthrough for negatives + identity strength,
 *  gated on the model's live allowed_passthrough_parameters. Negatives are
 *  normalized to descriptive noun lists (Google's documented guidance: no
 *  "no"/"don't" phrasing — instructive language is ignored). */
export function buildPassthrough(opts: {
  modelId: string;
  catalogModel: Pick<VideoModel, "allowed_passthrough_parameters"> | null;
  negatives?: string[];
  identityScale?: number | null;
}): PassthroughPlan {
  const skipped: string[] = [];
  const applied = { negative_prompt: false, identity_scale: false };
  const slug = providerSlugFor(opts.modelId);
  const params: Record<string, unknown> = {};

  const negatives = (opts.negatives || [])
    .map((n) => String(n || "").trim().replace(/^(no|don'?t|never|avoid)\s+/i, ""))
    .filter(Boolean);

  if (negatives.length > 0) {
    const key = opts.catalogModel ? negativePromptKey(opts.catalogModel) : null;
    if (key && slug) {
      params[key] = negatives.join(", ").slice(0, 2000);
      applied.negative_prompt = true;
    } else {
      skipped.push(`negative constraints (model "${opts.modelId}" exposes no negative-prompt parameter — enforce via QC instead)`);
    }
  }

  const scale = typeof opts.identityScale === "number"
    ? Math.min(1, Math.max(0, opts.identityScale))
    : null;
  if (scale != null) {
    const key = opts.catalogModel ? identityScaleKey(opts.catalogModel) : null;
    if (key && slug) {
      params[key] = scale;
      applied.identity_scale = true;
    } else {
      skipped.push(`identity_scale (model "${opts.modelId}" exposes no conditioning-strength parameter)`);
    }
  }

  if (!slug || Object.keys(params).length === 0) {
    return { providerOptions: null, applied, skipped };
  }
  return {
    providerOptions: { options: { [slug]: { parameters: params } } },
    applied,
    skipped,
  };
}

interface SubmitArgs {
  apiKey: string;
  model: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
  seed?: number;
  /** Exact frame anchors ({url, frameType}). Core field — hard 400 when the
   *  model's supported_frame_images doesn't include the type, so callers gate
   *  first. */
  frameImages?: Array<{ url: string; frameType: FrameImageType }>;
  /** Multi-image identity pack URLs. NEVER combined with frameImages — when
   *  both are present OpenRouter silently ignores input_references. */
  inputReferences?: string[];
  /** provider.options passthrough (from buildPassthrough). */
  providerOptions?: Record<string, unknown> | null;
}

const orHeaders = (apiKey: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiKey}`,
  "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "",
  "X-Title": "Chapter Craft",
});

/** Kick off a video generation job. Returns the OpenRouter job id. */
export async function submitVideo({
  apiKey, model, prompt, duration, resolution, aspectRatio, generateAudio, seed,
  frameImages, inputReferences, providerOptions,
}: SubmitArgs): Promise<{ jobId: string }> {
  const body: Record<string, unknown> = { model: model || DEFAULT_VIDEO_MODEL, prompt };
  if (duration) body.duration = duration;
  if (resolution) body.resolution = resolution;
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (typeof generateAudio === "boolean") body.generate_audio = generateAudio;
  if (typeof seed === "number") body.seed = seed;
  // frame_images and input_references are mutually exclusive by policy:
  // OpenRouter treats a request with both as image-to-video (frame_images
  // wins, references silently ignored) — callers decide ONE conditioning mode.
  if (frameImages && frameImages.length > 0) {
    body.frame_images = frameImages.map((f) => ({
      type: "image_url",
      image_url: { url: f.url },
      frame_type: f.frameType,
    }));
  } else if (inputReferences && inputReferences.length > 0) {
    body.input_references = inputReferences.map((url) => ({
      type: "image_url",
      image_url: { url },
    }));
  }
  if (providerOptions && Object.keys(providerOptions).length > 0) {
    body.provider = providerOptions;
  }

  const res = await fetch(`${OR_BASE}/videos`, {
    method: "POST",
    headers: orHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("Invalid OpenRouter API key.");
    if (res.status === 402) throw new Error("Insufficient OpenRouter credits — video is billed to your own key.");
    throw new Error(`Video submit failed (HTTP ${res.status}) ${extractApiError(errText)}`);
  }
  const data = await res.json().catch(() => ({}));
  const jobId: string | undefined = data?.id || data?.data?.id || data?.generation_id;
  if (!jobId) throw new Error("Video submit returned no job id.");
  return { jobId };
}

/** Pull the useful message out of a provider error body (OpenRouter wraps in
 *  {error:{message}}, FastAPI-style validators in {detail:[...]}) so a 400/422
 *  tells the user WHAT was invalid instead of just the status code. */
export function extractApiError(errText: string): string {
  try {
    const j = JSON.parse(errText);
    const msg = j?.error?.message || j?.message
      || (j?.detail ? (typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail)) : "");
    if (msg) return String(msg).slice(0, 500);
  } catch { /* not JSON — fall through to the raw slice */ }
  return errText.slice(0, 500);
}

export interface PollSnapshot {
  status: VideoStatus;
  cost: number | null;
  error: string | null;
  ready: boolean;
  /** 401/403: the KEY is bad, not the job. The clip may still be rendering
   *  and billed — callers must NOT mark the row failed; fix the key + retry. */
  authError?: boolean;
}

/** Poll a job's status. Never throws for normal not-ready states. */
export async function pollVideo(apiKey: string, jobId: string): Promise<PollSnapshot> {
  const res = await fetch(`${OR_BASE}/videos/${encodeURIComponent(jobId)}`, {
    headers: orHeaders(apiKey),
  });
  if (!res.ok) {
    // 401/403 is a KEY problem, not a job problem: stop polling but leave the
    // row alone so the paid clip stays recoverable after the key is fixed.
    if (res.status === 401 || res.status === 403) {
      return { status: "failed", cost: null, error: "OpenRouter rejected the API key — the clip may still be rendering. Fix the key in Settings and press Try again.", ready: false, authError: true };
    }
    // Terminal: the job is gone (404/410 purged or expired) — fail rather
    // than polling forever. Other non-2xx (5xx, 429) are transient.
    if (res.status === 404 || res.status === 410) {
      return { status: "failed", cost: null, error: `Video job unavailable (HTTP ${res.status}).`, ready: false };
    }
    return { status: "processing", cost: null, error: null, ready: false };
  }
  const data = await res.json().catch(() => ({}));
  // The submit response is seen both bare and wrapped in {data:{...}} — read
  // each field TOP-LEVEL FIRST with a nested fallback (same precedence as the
  // submit path's id extraction), so a payload that carries status at the top
  // plus an unrelated object under `data` is never misread as in-flight.
  const nested = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : null;
  const raw = String(data?.status ?? nested?.status ?? "").toLowerCase();
  const errField = data?.error ?? nested?.error;
  const upstreamErr = typeof errField === "string" ? errField : errField?.message;
  const status: VideoStatus =
    raw === "completed" || raw === "succeeded" || raw === "success" ? "completed"
    // Terminal-failure synonyms must land on "failed" — an unrecognized
    // terminal status that falls through to "processing" is a 15-minute wait.
    : ["failed", "error", "errored", "cancelled", "canceled", "expired", "rejected"].includes(raw) ? "failed"
    : raw === "pending" || raw === "queued" ? "pending"
    // Anything else — recognized in-flight vocabulary or unknown — keeps
    // polling. One ambiguous payload (e.g. a transient error envelope on a
    // 200) must NEVER fail the row: the bubble persists "failed" and drops
    // the retry affordance, destroying a possibly-still-rendering paid clip.
    // A genuine unknown-terminal stall is bounded by the bubble's 15-min
    // watchdog, which stops WATCHING but leaves the row recoverable.
    : "processing";
  const cost = typeof data?.usage?.cost === "number" ? data.usage.cost
    : typeof nested?.usage?.cost === "number" ? nested.usage.cost
    : null;
  const error = status === "failed" ? String(upstreamErr || "Generation failed") : null;
  return { status, cost, error, ready: status === "completed" };
}

/** Download the finished MP4 (requires the Authorization header). */
export async function downloadVideoContent(apiKey: string, jobId: string, index = 0): Promise<Blob> {
  const res = await fetch(`${OR_BASE}/videos/${encodeURIComponent(jobId)}/content?index=${index}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Video download failed (HTTP ${res.status})`);
  return await res.blob();
}

/** Best-effort first-frame capture for a poster image. Returns null on failure
 *  (unsupported codec, no DOM) — callers fall back to the native first frame.
 *  Exported for the fal video path, which finalizes through the same bucket. */
export async function posterFromVideoBlob(blob: Blob): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (b: Blob | null, url?: string) => {
      if (settled) return;
      settled = true;
      if (url) try { URL.revokeObjectURL(url); } catch { /* noop */ }
      resolve(b);
    };
    try {
      const url = URL.createObjectURL(blob);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = url;
      video.onloadeddata = () => {
        try { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); }
        catch { done(null, url); }
      };
      video.onseeked = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 360;
          const ctx = canvas.getContext("2d");
          if (!ctx) return done(null, url);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((b) => done(b, url), "image/jpeg", 0.7);
        } catch { done(null, url); }
      };
      video.onerror = () => done(null, url);
      setTimeout(() => done(null, url), 8000);
    } catch { done(null); }
  });
}

/** Insert a pending row when a job is submitted, so list_videos + reload can
 *  find it and the bubble can resume polling. Returns the row id. */
export async function insertPendingVideo(opts: {
  jobId: string;
  model: string;
  prompt: string;
  durationS?: number | null;
  resolution?: string | null;
  aspectRatio?: string | null;
  hasAudio?: boolean | null;
  estCost?: number | null;
  /** Identity-conditioning linkage (video_identity migration). Only included
   *  in the insert when set, so pure-text clips still insert cleanly on a
   *  database without the migration. */
  provider?: string;
  sourceImageIds?: string[] | null;
  sourceSplatId?: string | null;
  masterId?: string | null;
  conditionMode?: string | null;
  motionMode?: string | null;
  motionVideoId?: string | null;
  identityScale?: number | null;
  assemblyInstruction?: string | null;
  negativeConstraints?: string[] | null;
  lockPalette?: string[] | null;
}): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");
  const row: Record<string, unknown> = {
    user_id: uid,
    job_id: opts.jobId,
    model: opts.model,
    prompt: opts.prompt.slice(0, 2000),
    caption: "",
    duration_s: opts.durationS ?? null,
    resolution: opts.resolution ?? null,
    aspect_ratio: opts.aspectRatio ?? null,
    has_audio: opts.hasAudio ?? null,
    cost: opts.estCost ?? null,
    status: "pending",
  };
  const identityKeys: string[] = [];
  const setIdent = (k: string, v: unknown) => { row[k] = v; identityKeys.push(k); };
  if (opts.provider) setIdent("provider", opts.provider);
  if (opts.sourceImageIds && opts.sourceImageIds.length > 0) setIdent("source_image_ids", opts.sourceImageIds);
  if (opts.sourceSplatId) setIdent("source_splat_id", opts.sourceSplatId);
  if (opts.masterId) setIdent("master_id", opts.masterId);
  if (opts.conditionMode) setIdent("condition_mode", opts.conditionMode);
  if (opts.motionMode && opts.motionMode !== "text") setIdent("motion_mode", opts.motionMode);
  if (opts.motionVideoId) setIdent("motion_video_id", opts.motionVideoId);
  if (typeof opts.identityScale === "number") setIdent("identity_scale", opts.identityScale);
  if (opts.assemblyInstruction) setIdent("assembly_instruction", opts.assemblyInstruction.slice(0, 2000));
  if (opts.negativeConstraints && opts.negativeConstraints.length > 0) setIdent("negative_constraints", opts.negativeConstraints);
  if (opts.lockPalette && opts.lockPalette.length > 0) setIdent("lock_palette", opts.lockPalette);
  const ins = () => (supabase.from("video_generations" as any) as any)
    .insert({ ...row })
    .select("id")
    .single();
  let { data, error } = await ins();
  // The identity columns are newer than the base table. On a database without
  // the video_identity migration, retry WITHOUT them so the pending row (which
  // list_videos and reload-resume depend on) survives — e.g. a pure-text clip
  // that merely carried negative_constraints must not lose its row.
  if (error && identityKeys.length > 0) {
    for (const k of identityKeys) delete row[k];
    ({ data, error } = await ins());
  }
  if (error) throw new Error(`Video record failed: ${error.message}`);
  return (data as any)?.id || null;
}

export async function fetchVideoByJobId(jobId: string): Promise<VideoGenerationRow | null> {
  const { data } = await (supabase.from("video_generations" as any) as any)
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  return (data as VideoGenerationRow) || null;
}

export async function fetchVideoById(id: string): Promise<VideoGenerationRow | null> {
  const { data } = await (supabase.from("video_generations" as any) as any)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as VideoGenerationRow) || null;
}

/** Create a memory neuron for a generated video (text-proxy embedding: prompt +
 *  model caption + duration + identity linkage). Mirrors saveImageNeuron. */
export async function saveVideoNeuron(opts: {
  prompt: string;
  caption: string;
  model: string;
  durationS?: number | null;
  /** Identity linkage, persisted in the neuron text so recall knows which
   *  master/sources a clip was locked to. */
  sourceImageIds?: string[] | null;
  sourceSplatId?: string | null;
  masterId?: string | null;
  conditionMode?: string | null;
  motionMode?: string | null;
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
  const identityConditioned = (opts.sourceImageIds?.length || 0) > 0 || !!opts.masterId || !!opts.sourceSplatId;
  const content = [
    `AI-generated video clip.`,
    `Prompt: ${opts.prompt}`,
    opts.caption && opts.caption !== opts.prompt ? `Description: ${opts.caption}` : "",
    `${opts.durationS ? `${opts.durationS}s ` : ""}clip generated with ${opts.model}.`,
    identityConditioned
      ? `Identity-locked clip${opts.conditionMode ? ` (${opts.conditionMode})` : ""}${opts.motionMode && opts.motionMode !== "text" ? `, motion: ${opts.motionMode}` : ""}.`
      : "",
    opts.masterId ? `Master asset: ${opts.masterId}` : "",
    opts.sourceImageIds && opts.sourceImageIds.length > 0
      ? `Source image id(s): ${opts.sourceImageIds.join(", ")}`
      : "",
    opts.sourceSplatId ? `Source splat id: ${opts.sourceSplatId}` : "",
  ].filter(Boolean).join("\n");
  const { data: entry, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: uid,
      title: `Video: ${shortPrompt}`,
      content: content.slice(0, 4000),
      entry_type: "concept",
      tags: identityConditioned ? ["video", "generated", "identity-locked"] : ["video", "generated"],
      confidence: 0.9,
      ...(wikiId ? { wiki_id: wikiId } : {}),
    } as any)
    .select("id")
    .single();
  if (error || !entry) return null;
  void reindexEmbeddings(true, wikiId).catch(() => {});
  return (entry as any).id;
}

/** Complete a finished job: download the MP4, store it + a poster in the
 *  private bucket, create the memory neuron, and flip the row to completed.
 *  Idempotent — if the row is already completed with a stored file, returns it. */
export async function finalizeVideoJob(opts: {
  apiKey: string;
  jobId: string;
  cost?: number | null;
  remember?: boolean;
  /** Fallback metadata used to reconstruct the row if the pending insert failed
   *  at submit time, so a paid clip can still be stored. */
  model?: string;
  prompt?: string;
}): Promise<VideoGenerationRow> {
  let existing = await fetchVideoByJobId(opts.jobId);
  if (existing?.status === "completed" && existing.storage_path) return existing;

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");

  // Reconstruct the row if the pending insert failed at submit time (transient
  // DB error) — the user already paid for this clip, so don't drop it. Keyed by
  // the unique job_id; a concurrent finalizer's row is preserved via upsert.
  if (!existing) {
    await (supabase.from("video_generations" as any) as any)
      .upsert(
        { user_id: uid, job_id: opts.jobId, model: opts.model || "", prompt: (opts.prompt || "").slice(0, 2000), status: "processing" },
        { onConflict: "job_id" },
      );
    existing = await fetchVideoByJobId(opts.jobId);
    if (!existing) throw new Error("Video job record could not be created");
  }

  const blob = await downloadVideoContent(opts.apiKey, opts.jobId);
  // Deterministic path (keyed by job_id) with upsert:true so concurrent
  // finalizers (e.g. two open tabs) converge on ONE object instead of each
  // writing a random path and orphaning the loser's file.
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

  // Create the memory neuron once — re-read entry_id first so a concurrent
  // finalizer's neuron isn't duplicated.
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
      cost: typeof opts.cost === "number" ? opts.cost : existing.cost,
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

export async function markVideoJobFailed(jobId: string, error: string): Promise<void> {
  try {
    await (supabase.from("video_generations" as any) as any)
      .update({ status: "failed", error: error.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("job_id", jobId);
  } catch { /* best effort */ }
}

export async function searchVideos(query: string | undefined, limit = 10): Promise<VideoGenerationRow[]> {
  // Identity columns are newer — cascade to the legacy select if the migration
  // hasn't been applied so list_videos never fails outright.
  const buildQuery = (cols: string) => {
    let q = (supabase.from("video_generations" as any) as any)
      .select(cols)
      .order("created_at", { ascending: false })
      .limit(Math.min(25, Math.max(1, limit)));
    const trimmed = (query || "").trim();
    if (trimmed) {
      const safe = trimmed.replace(/[%,()]/g, " ");
      q = q.or(`prompt.ilike.%${safe}%,caption.ilike.%${safe}%`);
    }
    return q;
  };
  const LEGACY_COLS = "id, job_id, entry_id, prompt, caption, model, storage_path, poster_path, duration_s, resolution, cost, status, created_at";
  const IDENTITY_COLS = `${LEGACY_COLS}, provider, source_image_ids, source_splat_id, master_id, condition_mode, motion_mode, qc`;
  let { data, error } = await buildQuery(IDENTITY_COLS);
  if (error) ({ data, error } = await buildQuery(LEGACY_COLS));
  if (error) return [];
  return (data as VideoGenerationRow[]) || [];
}

/** Delete a generated video: DB row first (source of truth for the UI), then
 *  best-effort storage cleanup, then signed-URL cache purge. Mirrors
 *  deleteImageAttachment. */
export async function deleteVideoGeneration(row: { id: string; storage_path?: string | null; poster_path?: string | null }): Promise<void> {
  const { data: deleted, error } = await (supabase.from("video_generations" as any) as any)
    .delete()
    .eq("id", row.id)
    .select("id, storage_path, poster_path");
  if (error) throw error;
  const rows = (deleted as any[]) || [];
  if (rows.length === 0) {
    throw new Error("Video could not be deleted (not found or no permission).");
  }
  const paths = [rows[0]?.storage_path || row.storage_path, rows[0]?.poster_path || row.poster_path].filter(Boolean) as string[];
  if (paths.length) {
    try { await supabase.storage.from(BUCKET).remove(paths); }
    catch (e) { console.warn("[deleteVideoGeneration] storage remove failed", e); }
    for (const p of paths) { try { urlCache.delete(p); } catch { /* noop */ } }
  }
}

// ── Signed URL cache ────────────────────────────────────────────────────────
// The bucket is private; render through short-lived signed URLs, cached so a
// chat full of clips doesn't re-sign on every render (mirrors imageGen).
const SIGNED_TTL_S = 60 * 60 * 24; // 24h
const urlCache = new Map<string, { url: string; expires: number }>();

export async function getSignedVideoUrl(
  storagePath: string,
  opts: { fresh?: boolean } = {},
): Promise<string | null> {
  if (!storagePath) return null;
  // fresh: full-TTL signature for URLs handed to third-party providers (e.g.
  // a motion-transfer driving clip) — a cache-aged URL can expire before the
  // provider dequeues the job and fetches it. Mirrors getSignedImageUrl.
  const cached = opts.fresh ? undefined : urlCache.get(storagePath);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_TTL_S);
  if (error || !data?.signedUrl) return null;
  urlCache.set(storagePath, { url: data.signedUrl, expires: Date.now() + (SIGNED_TTL_S - 300) * 1000 });
  return data.signedUrl;
}
