import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";
import { DEFAULT_VIDEO_MODEL } from "@/lib/videoCatalog";

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
}: SubmitArgs): Promise<{ jobId: string }> {
  const body: Record<string, unknown> = { model: model || DEFAULT_VIDEO_MODEL, prompt };
  if (duration) body.duration = duration;
  if (resolution) body.resolution = resolution;
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (typeof generateAudio === "boolean") body.generate_audio = generateAudio;
  if (typeof seed === "number") body.seed = seed;

  const res = await fetch(`${OR_BASE}/videos`, {
    method: "POST",
    headers: orHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("Invalid OpenRouter API key.");
    if (res.status === 402) throw new Error("Insufficient OpenRouter credits — video is billed to your own key.");
    throw new Error(`Video submit failed (HTTP ${res.status}) ${errText.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  const jobId: string | undefined = data?.id || data?.data?.id || data?.generation_id;
  if (!jobId) throw new Error("Video submit returned no job id.");
  return { jobId };
}

export interface PollSnapshot {
  status: VideoStatus;
  cost: number | null;
  error: string | null;
  ready: boolean;
}

/** Poll a job's status. Never throws for normal not-ready states. */
export async function pollVideo(apiKey: string, jobId: string): Promise<PollSnapshot> {
  const res = await fetch(`${OR_BASE}/videos/${encodeURIComponent(jobId)}`, {
    headers: orHeaders(apiKey),
  });
  if (!res.ok) {
    // Terminal: the job is gone (404/410 purged or expired) or the key is
    // rejected (401/403) — fail rather than polling forever. Other non-2xx
    // (5xx, 429) are transient, so keep polling.
    if (res.status === 404 || res.status === 410 || res.status === 401 || res.status === 403) {
      return { status: "failed", cost: null, error: `Video job unavailable (HTTP ${res.status}).`, ready: false };
    }
    return { status: "processing", cost: null, error: null, ready: false };
  }
  const data = await res.json().catch(() => ({}));
  const raw = String(data?.status || "").toLowerCase();
  const status: VideoStatus =
    raw === "completed" ? "completed"
    : raw === "failed" ? "failed"
    : raw === "in_progress" ? "processing"
    : raw === "pending" ? "pending"
    : "processing";
  const cost = typeof data?.usage?.cost === "number" ? data.usage.cost : null;
  const error = status === "failed" ? String(data?.error || "Generation failed") : null;
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
 *  (unsupported codec, no DOM) — callers fall back to the native first frame. */
async function posterFromVideoBlob(blob: Blob): Promise<Blob | null> {
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
}): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");
  const { data, error } = await (supabase.from("video_generations" as any) as any)
    .insert({
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
    })
    .select("id")
    .single();
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
 *  model caption + duration). Mirrors saveImageNeuron. */
export async function saveVideoNeuron(opts: {
  prompt: string;
  caption: string;
  model: string;
  durationS?: number | null;
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
    `AI-generated video clip.`,
    `Prompt: ${opts.prompt}`,
    opts.caption && opts.caption !== opts.prompt ? `Description: ${opts.caption}` : "",
    `${opts.durationS ? `${opts.durationS}s ` : ""}clip generated with ${opts.model}.`,
  ].filter(Boolean).join("\n");
  const { data: entry, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: uid,
      title: `Video: ${shortPrompt}`,
      content: content.slice(0, 4000),
      entry_type: "concept",
      tags: ["video", "generated"],
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
  let q = (supabase.from("video_generations" as any) as any)
    .select("id, job_id, entry_id, prompt, caption, model, storage_path, poster_path, duration_s, resolution, cost, status, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(25, Math.max(1, limit)));
  const trimmed = (query || "").trim();
  if (trimmed) {
    const safe = trimmed.replace(/[%,()]/g, " ");
    q = q.or(`prompt.ilike.%${safe}%,caption.ilike.%${safe}%`);
  }
  const { data } = await q;
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

export async function getSignedVideoUrl(storagePath: string): Promise<string | null> {
  if (!storagePath) return null;
  const cached = urlCache.get(storagePath);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_TTL_S);
  if (error || !data?.signedUrl) return null;
  urlCache.set(storagePath, { url: data.signedUrl, expires: Date.now() + (SIGNED_TTL_S - 300) * 1000 });
  return data.signedUrl;
}
