import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";

// Nano Banana image generation via OpenRouter (the user's existing key).
// Primary: Nano Banana 2 (Gemini 3.1 Flash Image) — near-Pro quality at half
// the price. Fallback: the original Nano Banana (Gemini 2.5 Flash Image).
export const IMAGE_MODELS = [
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
export async function generateImage({ apiKey, prompt, aspectRatio, inputImageDataUrl }: GenerateArgs): Promise<GenerateResult> {
  let lastError = "";
  for (const model of IMAGE_MODELS) {
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
  try { await supabase.storage.from("generated-images").remove([row.storage_path]); } catch { /* row delete still proceeds */ }
  const { error } = await (supabase.from("image_attachments" as any) as any).delete().eq("id", row.id);
  if (error) throw error;
}

// ── Signed URL cache ────────────────────────────────────────────────────────
// The bucket is private; render through short-lived signed URLs, cached so a
// chat full of images doesn't re-sign on every render.
const SIGNED_TTL_S = 60 * 60 * 24; // 24h
const urlCache = new Map<string, { url: string; expires: number }>();

export async function getSignedImageUrl(storagePath: string): Promise<string | null> {
  const cached = urlCache.get(storagePath);
  if (cached && cached.expires > Date.now()) return cached.url;
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
