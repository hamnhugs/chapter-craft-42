import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";
import { sanitizeIlike } from "@/lib/sanitize";

// Nano Banana image generation via OpenRouter (the user's existing key).
// Primary: Nano Banana 2 (Gemini 3.1 Flash Image) — near-Pro quality at half
// the price. Fallback: the original Nano Banana (Gemini 2.5 Flash Image).
export const IMAGE_MODELS = [
  "google/gemini-3-pro-image",
  "google/gemini-3.1-flash-image-preview",
  "google/gemini-2.5-flash-image",
];

export const IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] as const;

// Every outbound fetch carries a deadline: a request with no signal can hang
// the tab forever on a socket the server accepted but never answers. 45s for
// API calls, 180s for media transfers (multi-MB image bodies).
const API_TIMEOUT_MS = 45_000;
const MEDIA_TIMEOUT_MS = 180_000;

/** Lightweight reference attached to chat messages — the actual pixels stay
 *  in the private `generated-images` bucket and load via short-lived signed URLs. */
export interface ChatImageRef {
  id: string;
  storage_path: string;
  prompt: string;
  entry_id?: string | null;
  /** Memory Lens: title of the memory entry this image was recalled from —
   *  rendered as "From your memory: <title>" provenance. */
  memory_title?: string;
  /** Memory Lens: true when the deterministic layer auto-attached this image
   *  (never-seen policy) rather than a tool call. */
  lens_auto?: boolean;
}

export interface ImageAttachmentRow {
  id: string;
  user_id: string;
  entry_id: string | null;
  source_image_id: string | null;
  prompt: string;
  caption: string;
  model: string;
  storage_path: string;
  mime: string;
  created_at: string;
}

interface GenerateArgs {
  apiKey: string;
  /** Gemini key — used when no OpenRouter key exists (or the chosen model is
   *  a gemini id), so Gemini-only users keep image generation. */
  geminiApiKey?: string;
  prompt: string;
  aspectRatio?: string;
  /** When set, the image is sent as input — Nano Banana edits/refines it. */
  inputImageDataUrl?: string;
  /**
   * Reference images sent alongside the prompt, in order.
   *
   * This is the ONLY channel that carries appearance reliably. Text cannot: a
   * hex code written into a prompt is split by the encoder into tokens with no
   * colour meaning and is adhered to under 10% of the time, while the same
   * colour shown as a swatch in a reference image lands within the threshold of
   * human perception. Everything a blueprint knows about how a thing looks
   * reaches the model through here, as pixels.
   *
   * Kept separate from `inputImageDataUrl` on purpose: that one means "edit
   * THIS image", and chaining edits decays hard — measured at roughly 25 points
   * of subject fidelity lost over three turns from exposure bias. References
   * re-anchor from a fixed source instead.
   */
  referenceImageDataUrls?: string[];
  /** Optional user-preferred primary image model id. */
  primaryModel?: string;
  /** Optional user-preferred fallback model id. */
  fallbackModel?: string;
}

export interface GenerateResult {
  dataUrl: string;
  mime: string;
  /** The model's accompanying text — usually a description of what it drew. */
  text: string;
  modelUsed: string;
}

/** Direct-to-Gemini image models, tried in order when the OpenRouter path is
 *  unavailable. The Gemini image line takes TYPED reference inputs (Nano
 *  Banana 2: up to 4 character-consistency images; NB Pro: 5) — sending each
 *  reference as its own labeled part, canonical sheet first, is the measured
 *  best practice, not a composite collage. */
const GEMINI_IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"];

/** One generation attempt against the Gemini API (browser-direct — the same
 *  origin the Gemini chat adapter already uses, covered by the CSP). */
async function generateViaGemini(
  model: string,
  geminiKey: string,
  prompt: string,
  attachments: string[],
  aspectRatio?: string,
): Promise<GenerateResult> {
  const parts: any[] = [{ text: prompt }];
  attachments.forEach((url, i) => {
    const comma = url.indexOf(",");
    const meta = url.slice(5, url.indexOf(";"));
    // Each reference is its own LABELED part — the typed-slot pattern. The
    // label tells the model what the image is FOR; the prompt then only needs
    // to carry pose, action and setting.
    parts.push({ text: i === 0 && attachments.length > 1
      ? `Reference ${i + 1} (canonical character/tech sheet — match identity, proportions and palette exactly):`
      : `Reference ${i + 1} (match appearance exactly):` });
    parts.push({ inline_data: { mime_type: meta || "image/png", data: url.slice(comma + 1) } });
  });
  const body: any = { contents: [{ role: "user", parts }] };
  if (aspectRatio && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    body.generationConfig = { imageConfig: { aspectRatio } };
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini · ${model}: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const respParts: any[] = data?.candidates?.[0]?.content?.parts || [];
  const img = respParts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  const text = respParts.filter((p) => typeof p?.text === "string").map((p) => p.text).join(" ").trim();
  if (!img) {
    throw new Error(text
      ? `Gemini · ${model} declined: ${text.slice(0, 300)}`
      : `Gemini · ${model}: no image in response`);
  }
  const inline = img.inlineData || img.inline_data;
  const mime = inline.mimeType || inline.mime_type || "image/png";
  return { dataUrl: `data:${mime};base64,${inline.data}`, mime, text, modelUsed: model };
}

/** Generate (or edit) an image. OpenRouter's chat-completions API with
 *  `modalities: ["image", "text"]` when an OpenRouter key exists; otherwise
 *  direct-to-Gemini with the Gemini key. Tries each candidate in order. */
export async function generateImage({ apiKey, geminiApiKey, prompt, aspectRatio, inputImageDataUrl, referenceImageDataUrls, primaryModel, fallbackModel }: GenerateArgs): Promise<GenerateResult> {
  let lastError = "";
  // No OpenRouter key: the Gemini path is the whole show.
  if (!apiKey && geminiApiKey) {
    const gemAttachments = [
      ...(inputImageDataUrl ? [inputImageDataUrl] : []),
      ...(referenceImageDataUrls || []).filter((u) => typeof u === "string" && u.startsWith("data:")),
    ].slice(0, 7);
    for (const model of GEMINI_IMAGE_MODELS) {
      try {
        return await generateViaGemini(model, geminiApiKey, prompt, gemAttachments, aspectRatio);
      } catch (e: any) {
        lastError = e?.name === "TimeoutError"
          ? `Gemini · ${model}: request timed out after ${API_TIMEOUT_MS / 1000}s`
          : e?.message || `Gemini · ${model}: request failed`;
      }
    }
    throw new Error(lastError || `Gemini · ${GEMINI_IMAGE_MODELS[0]}: image generation failed`);
  }
  // Build candidate list: user's primary, user's fallback, then the built-in
  // defaults. Dedupe while preserving order.
  const seen = new Set<string>();
  const candidates = [primaryModel, fallbackModel, ...IMAGE_MODELS]
    .filter((m): m is string => !!m && !seen.has(m) && (seen.add(m), true));
  for (const model of candidates) {

    try {
      // Images follow the text. Reference order is preserved because the
      // reference-capable APIs let a prompt address them by index ("the palette
      // in image 2"), and a shuffled order would make that instruction wrong.
      const attachments = [
        ...(inputImageDataUrl ? [inputImageDataUrl] : []),
        ...(referenceImageDataUrls || []).filter((u) => typeof u === "string" && u.startsWith("data:")),
      ].slice(0, 7); // 1 optional input image + up to 6 references — matches the tool's cap
      const content: any = attachments.length
        ? [
            { type: "text", text: prompt },
            ...attachments.map((url) => ({ type: "image_url", image_url: { url } })),
          ]
        : prompt;
      const body: any = {
        model,
        messages: [{ role: "user", content }],
        modalities: ["image", "text"],
        stream: false,
      };
      if (aspectRatio && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
        body.image_config = { aspect_ratio: aspectRatio };
      }
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": window.location.origin,
          "X-Title": "Chapter Craft",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 402) throw new Error("Insufficient OpenRouter credits — image generation is billed to the user's own OpenRouter key (~$0.04–0.07 per image) and cannot run on NVIDIA.");
        lastError = `OpenRouter · ${model}: HTTP ${res.status} ${errText.slice(0, 200)}`;
        continue;
      }
      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      const imageUrl: string | undefined = message?.images?.[0]?.image_url?.url;
      const text = String(message?.content || "").trim();
      if (!imageUrl || !imageUrl.startsWith("data:")) {
        // Model replied with text only — usually a safety refusal. Surface it.
        lastError = text ? `OpenRouter · ${model} declined: ${text.slice(0, 300)}` : `OpenRouter · ${model}: no image in response`;
        continue;
      }
      const mime = imageUrl.slice(5, imageUrl.indexOf(";")) || "image/png";
      return { dataUrl: imageUrl, mime, text, modelUsed: model };
    } catch (e: any) {
      if (e?.message?.includes("Insufficient OpenRouter credits")) throw e;
      lastError = e?.name === "TimeoutError"
        ? `OpenRouter · ${model}: request timed out after ${API_TIMEOUT_MS / 1000}s`
        : `OpenRouter · ${model}: ${e?.message || "request failed"}`;
    }
  }
  throw new Error(lastError || `OpenRouter · ${candidates[0] || IMAGE_MODELS[0]}: image generation failed`);
}

/** Upload a generated image to the private bucket + record its attachment row. */
export async function storeGeneratedImage(opts: {
  prompt: string;
  caption: string;
  model: string;
  dataUrl: string;
  mime: string;
  entryId?: string | null;
  sourceImageId?: string | null;
}): Promise<ChatImageRef> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");
  const ext = opts.mime === "image/jpeg" ? "jpg" : opts.mime === "image/webp" ? "webp" : "png";
  const path = `${uid}/${crypto.randomUUID()}.${ext}`;
  let blob: Blob;
  try {
    blob = await (await fetch(opts.dataUrl, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) })).blob();
  } catch (e: any) {
    // Attribute to the right provider — Gemini-generated images come through
    // here too, and blaming OpenRouter for them is the anonymity bug again.
    const who = opts.model.startsWith("gemini") ? "Gemini" : "OpenRouter";
    if (e?.name === "TimeoutError") throw new Error(`${who} · ${opts.model}: image decode timed out after ${MEDIA_TIMEOUT_MS / 1000}s.`);
    throw e;
  }
  const { error: upErr } = await supabase.storage
    .from("generated-images")
    .upload(path, blob, { contentType: opts.mime, upsert: false });
  if (upErr) throw new Error(`Image upload failed: ${upErr.message}`);
  const { data: row, error: insErr } = await (supabase.from("image_attachments" as any) as any)
    .insert({
      user_id: uid,
      entry_id: opts.entryId || null,
      source_image_id: opts.sourceImageId || null,
      prompt: opts.prompt.slice(0, 2000),
      caption: opts.caption.slice(0, 2000),
      model: opts.model,
      storage_path: path,
      mime: opts.mime,
    })
    .select("id")
    .single();
  if (insErr) {
    // The row is the source of truth — without it the uploaded object is
    // invisible to every UI. Remove it instead of orphaning (best-effort,
    // mirroring figureJobs' rollback).
    try { await supabase.storage.from("generated-images").remove([path]); } catch { /* best-effort */ }
    throw new Error(`Image record failed: ${insErr.message}`);
  }
  if (typeof window !== "undefined") {
    try { window.dispatchEvent(new CustomEvent("image-attachments-changed", { detail: { created: [(row as any).id] } })); } catch { /* noop */ }
  }
  return { id: (row as any).id, storage_path: path, prompt: opts.prompt, entry_id: opts.entryId || null };
}

/** Create a neuron (knowledge entry) for a generated image so the memory
 *  system can retrieve it later. The content is the image's best text
 *  representation: the generation prompt + the model's own description —
 *  embedded through the existing text pipeline (no second vector index). */
export async function saveImageNeuron(opts: {
  prompt: string;
  caption: string;
  model: string;
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
    `AI-generated image.`,
    `Prompt: ${opts.prompt}`,
    opts.caption && opts.caption !== opts.prompt ? `Description: ${opts.caption}` : "",
    `Generated with ${opts.model}.`,
  ].filter(Boolean).join("\n");
  const { data: entry, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: uid,
      title: `Image: ${shortPrompt}`,
      content: content.slice(0, 4000),
      entry_type: "concept",
      tags: ["image", "generated"],
      confidence: 0.9,
      ...(wikiId ? { wiki_id: wikiId } : {}),
    } as any)
    .select("id")
    .single();
  if (error || !entry) return null;
  // Embed the new neuron in the background so retrieval can find it.
  void reindexEmbeddings(true, wikiId).catch(() => {});
  return (entry as any).id;
}

/** Save any library image (uploaded or generated) to memory: create a neuron
 *  for it, or attach it to an existing entry. Idempotent — an image already
 *  linked to an entry returns that entry unless a different entryId is given. */
export async function saveImageToMemory(opts: {
  imageId: string;
  title?: string;
  description?: string;
  entryId?: string | null;
}): Promise<{ entryId: string; created: boolean; prompt: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");
  const row = await fetchImageById(opts.imageId);
  if (!row) throw new Error("Image not found");
  if (opts.entryId) {
    const { data: entry } = await supabase
      .from("knowledge_entries")
      .select("id")
      .eq("id", opts.entryId)
      .maybeSingle();
    if (!entry) throw new Error("Target memory entry not found");
    const { error } = await (supabase.from("image_attachments" as any) as any)
      .update({ entry_id: opts.entryId })
      .eq("id", row.id);
    if (error) throw new Error(`Could not attach image: ${error.message}`);
    return { entryId: opts.entryId, created: false, prompt: row.prompt };
  }
  if (row.entry_id) {
    return { entryId: row.entry_id, created: false, prompt: row.prompt };
  }
  const isUpload = row.model === "upload";
  const { data: settings } = await supabase
    .from("user_settings")
    .select("active_wiki_id" as any)
    .maybeSingle();
  const wikiId = (settings as any)?.active_wiki_id || null;
  const titleSource = (opts.description || row.caption || row.prompt || "untitled").trim();
  const title = (opts.title?.trim() || `Image: ${titleSource.length > 57 ? titleSource.slice(0, 57).trimEnd() + "…" : titleSource}`).slice(0, 120);
  const content = [
    isUpload ? "Image uploaded by the user." : "AI-generated image.",
    opts.description ? `Description: ${opts.description}` : "",
    row.prompt ? (isUpload ? `File: ${row.prompt}` : `Prompt: ${row.prompt}`) : "",
    row.caption && row.caption !== row.prompt ? `Caption: ${row.caption}` : "",
  ].filter(Boolean).join("\n");
  const { data: entry, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: uid,
      title,
      content: content.slice(0, 4000),
      entry_type: "concept",
      tags: ["image", isUpload ? "uploaded" : "generated"],
      confidence: 0.9,
      ...(wikiId ? { wiki_id: wikiId } : {}),
    } as any)
    .select("id")
    .single();
  if (error || !entry) throw new Error(`Could not create memory entry: ${error?.message || "unknown"}`);
  const entryId = (entry as any).id as string;
  const { error: linkErr } = await (supabase.from("image_attachments" as any) as any)
    .update({ entry_id: entryId })
    .eq("id", row.id);
  if (linkErr) {
    // Keep the operation atomic: a text entry without its image (and an
    // image still "unsaved") would both break idempotency and duplicate
    // neurons on retry — roll the entry back and fail loudly.
    try { await supabase.from("knowledge_entries").delete().eq("id", entryId); } catch { /* best-effort */ }
    throw new Error(`Could not link the image to the new memory entry: ${linkErr.message}`);
  }
  // Embed the new neuron in the background so retrieval can find it.
  void reindexEmbeddings(true, wikiId).catch(() => {});
  return { entryId, created: true, prompt: row.prompt };
}

export async function fetchImageById(id: string): Promise<ImageAttachmentRow | null> {
  const { data } = await (supabase.from("image_attachments" as any) as any)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as ImageAttachmentRow) || null;
}

export async function fetchImagesForEntries(entryIds: string[]): Promise<ImageAttachmentRow[]> {
  if (entryIds.length === 0) return [];
  const { data } = await (supabase.from("image_attachments" as any) as any)
    .select("id, entry_id, prompt, caption, model, storage_path, mime, created_at")
    .in("entry_id", entryIds);
  return (data as ImageAttachmentRow[]) || [];
}

export async function searchImages(query: string | undefined, limit = 10): Promise<ImageAttachmentRow[]> {
  let q = (supabase.from("image_attachments" as any) as any)
    .select("id, entry_id, prompt, caption, model, storage_path, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(25, Math.max(1, limit)));
  const trimmed = (query || "").trim();
  if (trimmed) {
    const safe = sanitizeIlike(trimmed);
    q = q.or(`prompt.ilike.%${safe}%,caption.ilike.%${safe}%`);
  }
  const { data } = await q;
  return (data as ImageAttachmentRow[]) || [];
}

export async function deleteImageAttachment(row: { id: string; storage_path: string }): Promise<void> {
  // 1. Delete the DB row first (source of truth for the UI) and verify a row was actually removed.
  const { data: deleted, error } = await (supabase.from("image_attachments" as any) as any)
    .delete()
    .eq("id", row.id)
    .select("id");
  if (error) throw error;
  if (!deleted || (deleted as any[]).length === 0) {
    throw new Error("Image could not be deleted (not found or no permission). Please sign out and back in.");
  }
  // 2. Uploaded chat images share their storage file with an image_memories
  //    row — deleting "the image" removes that record too, then the file once.
  //    If the record delete ERRORS (supabase builders resolve {error}, they
  //    don't throw), KEEP the file: a surviving memory row must never point
  //    at a deleted object — delete_image_memory can finish the job later.
  let sharedRecordsCleared = true;
  try {
    const { error: memErr } = await (supabase.from("image_memories" as any) as any)
      .delete().eq("storage_path", row.storage_path);
    sharedRecordsCleared = !memErr;
  } catch { sharedRecordsCleared = false; }
  // 3. Best-effort storage cleanup. Failure here doesn't bring back the row.
  if (sharedRecordsCleared) {
    try { await supabase.storage.from("generated-images").remove([row.storage_path]); }
    catch (e) { console.warn("[deleteImageAttachment] storage remove failed", e); }
  }
  // 4. Purge any cached signed URL so stale references can't render.
  try { urlCache.delete(row.storage_path); } catch { /* noop */ }
}

/** Delete an uploaded image memory (the `image_memories` table + storage file).
 *  Mirrors the order in deleteImageAttachment: DB delete (source of truth) first,
 *  best-effort storage cleanup second, signed-URL cache purge last.
 *  Returns whether the underlying PICTURE was removed too — false when a
 *  library image (image_attachments row) still uses the same file. */
export async function deleteImageMemory(row: { id: string; storage_path?: string | null }): Promise<{ pictureRemoved: boolean }> {
  const { data: deleted, error } = await (supabase.from("image_memories" as any) as any)
    .delete()
    .eq("id", row.id)
    .select("id, storage_path");
  if (error) throw error;
  const rows = (deleted as any[]) || [];
  if (rows.length === 0) {
    throw new Error("Image memory could not be deleted (not found or no permission).");
  }
  const path = rows[0]?.storage_path || row.storage_path;
  if (!path) return { pictureRemoved: false };
  // An uploaded chat image may ALSO be registered in image_attachments,
  // sharing this file. Deleting just the memory record must not break the
  // library image — leave the file when an attachment still references it.
  // On lookup ERROR (builders resolve {error}, they don't throw) fail SAFE
  // and keep the file: an orphaned file is recoverable, a live library row
  // pointing at a deleted object is not.
  let stillReferenced = true;
  try {
    const { data: att, error: attErr } = await (supabase.from("image_attachments" as any) as any)
      .select("id").eq("storage_path", path).limit(1);
    stillReferenced = !!attErr || (!!att && (att as any[]).length > 0);
  } catch { stillReferenced = true; }
  if (stillReferenced) return { pictureRemoved: false };
  try { await supabase.storage.from("generated-images").remove([path]); }
  catch (e) { console.warn("[deleteImageMemory] storage remove failed", e); }
  try { urlCache.delete(path); } catch { /* noop */ }
  return { pictureRemoved: true };
}

// ── Signed URL cache ────────────────────────────────────────────────────────
// The bucket is private; render through short-lived signed URLs, cached so a
// chat full of images doesn't re-sign on every render.
const SIGNED_TTL_S = 60 * 60 * 24; // 24h
const urlCache = new Map<string, { url: string; expires: number }>();

export async function getSignedImageUrl(
  storagePath: string,
  opts: { fresh?: boolean } = {},
): Promise<string | null> {
  // fresh: skip the cache and sign anew, guaranteeing the FULL 24h validity.
  // A cached URL may have only minutes left — fine for rendering in this tab,
  // fatal for a URL handed to a third-party provider that fetches it later
  // (e.g. a video job that sits in an upstream queue past the expiry).
  if (!opts.fresh) {
    const cached = urlCache.get(storagePath);
    if (cached && cached.expires > Date.now()) return cached.url;
  }
  const { data, error } = await supabase.storage
    .from("generated-images")
    .createSignedUrl(storagePath, SIGNED_TTL_S);
  if (error || !data?.signedUrl) return null;
  urlCache.set(storagePath, { url: data.signedUrl, expires: Date.now() + (SIGNED_TTL_S - 300) * 1000 });
  return data.signedUrl;
}

/** Download a stored image and return it as a data URL (for vision input or
 *  as the source image for an edit). */
export async function loadImageAsDataUrl(storagePath: string): Promise<string | null> {
  const url = await getSignedImageUrl(storagePath);
  if (!url) return null;
  try {
    const blob = await (await fetch(url, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) })).blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
