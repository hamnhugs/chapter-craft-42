import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";

// Nano Banana image generation via OpenRouter (the user's existing key).
// Primary: Nano Banana 2 (Gemini 3.1 Flash Image) — near-Pro quality at half
// the price. Fallback: the original Nano Banana (Gemini 2.5 Flash Image).
export const IMAGE_MODELS = [
  "google/gemini-3-pro-image",
  "google/gemini-3.1-flash-image-preview",
  "google/gemini-2.5-flash-image",
];

export const IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] as const;

/** Lightweight reference attached to chat messages — the actual pixels stay
 *  in the private `generated-images` bucket and load via short-lived signed URLs. */
export interface ChatImageRef {
  id: string;
  storage_path: string;
  prompt: string;
  entry_id?: string | null;
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
  prompt: string;
  aspectRatio?: string;
  /** When set, the image is sent as input — Nano Banana edits/refines it. */
  inputImageDataUrl?: string;
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

/** Generate (or edit) an image through OpenRouter's chat-completions API with
 *  `modalities: ["image", "text"]`. Tries each Nano Banana model in order. */
export async function generateImage({ apiKey, prompt, aspectRatio, inputImageDataUrl, primaryModel, fallbackModel }: GenerateArgs): Promise<GenerateResult> {
  let lastError = "";
  // Build candidate list: user's primary, user's fallback, then the built-in
  // defaults. Dedupe while preserving order.
  const seen = new Set<string>();
  const candidates = [primaryModel, fallbackModel, ...IMAGE_MODELS]
    .filter((m): m is string => !!m && !seen.has(m) && (seen.add(m), true));
  for (const model of candidates) {

    try {
      const content: any = inputImageDataUrl
        ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: inputImageDataUrl } },
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
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 402) throw new Error("Insufficient OpenRouter credits — image generation is billed to the user's own key (~$0.04–0.07 per image).");
        lastError = `${model}: HTTP ${res.status} ${errText.slice(0, 200)}`;
        continue;
      }
      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      const imageUrl: string | undefined = message?.images?.[0]?.image_url?.url;
      const text = String(message?.content || "").trim();
      if (!imageUrl || !imageUrl.startsWith("data:")) {
        // Model replied with text only — usually a safety refusal. Surface it.
        lastError = text ? `${model} declined: ${text.slice(0, 300)}` : `${model}: no image in response`;
        continue;
      }
      const mime = imageUrl.slice(5, imageUrl.indexOf(";")) || "image/png";
      return { dataUrl: imageUrl, mime, text, modelUsed: model };
    } catch (e: any) {
      if (e?.message?.includes("Insufficient OpenRouter credits")) throw e;
      lastError = `${model}: ${e?.message || "request failed"}`;
    }
  }
  throw new Error(lastError || "Image generation failed");
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
  const blob = await (await fetch(opts.dataUrl)).blob();
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
  if (insErr) throw new Error(`Image record failed: ${insErr.message}`);
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
    const safe = trimmed.replace(/[%,()]/g, " ");
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
    const blob = await (await fetch(url)).blob();
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
