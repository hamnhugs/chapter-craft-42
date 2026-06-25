import { supabase } from "@/integrations/supabase/client";

export interface PendingChatImage {
  /** Local-only id for keying & removal in the composer */
  localId: string;
  /** Preview / model-ready data URL (downscaled) */
  dataUrl: string;
  /** MIME of the data URL */
  mime: string;
  /** Optional filename for display */
  filename?: string;
  /** Storage path after upload, if already uploaded */
  storagePath?: string;
  /** image_memories row id after persistence */
  memoryId?: string;
}

export interface UploadedChatImage {
  storagePath: string;
  dataUrl: string;
  mime: string;
  memoryId?: string;
  filename?: string;
  width?: number;
  height?: number;
}

const MAX_LONG_EDGE = 2048;
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const ACCEPTED = /^image\/(png|jpeg|webp|gif|heic|heif)$/i;

/** Convert a File or Blob to a downscaled JPEG data URL (max 2048px long edge). */
export async function fileToDownscaledDataUrl(file: File | Blob): Promise<{ dataUrl: string; mime: string; width: number; height: number }> {
  if ((file as File).size && (file as File).size > MAX_BYTES) {
    throw new Error("Image too large (max 20 MB)");
  }
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read image — try a different file"));
      i.src = blobUrl;
    });
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unsupported in this browser");
    ctx.drawImage(img, 0, 0, w, h);
    // Always emit JPEG — handles HEIC and trims size aggressively.
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    return { dataUrl, mime: "image/jpeg", width: w, height: h };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function isAcceptedImage(file: File | Blob): boolean {
  const type = (file as File).type || "";
  return ACCEPTED.test(type);
}

/** Upload to private `generated-images` bucket under `chat-uploads/{uid}/...`. */
export async function uploadChatImage(
  dataUrl: string,
  mime: string,
): Promise<{ storagePath: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const path = `chat-uploads/${uid}/${crypto.randomUUID()}.${ext}`;
  const blob = await (await fetch(dataUrl)).blob();
  const { error } = await supabase.storage
    .from("generated-images")
    .upload(path, blob, { contentType: mime, upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return { storagePath: path };
}

/** Create the `image_memories` row and kick off the embed-image function (fire-and-forget). */
export async function persistImageMemory(opts: {
  storagePath: string;
  mime: string;
  width?: number;
  height?: number;
  wikiId?: string | null;
  source?: "upload" | "generated";
  sourceMessageId?: string;
}): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data, error } = await (supabase.from("image_memories" as any) as any)
    .insert({
      user_id: uid,
      wiki_id: opts.wikiId || null,
      storage_path: opts.storagePath,
      mime_type: opts.mime,
      width: opts.width || null,
      height: opts.height || null,
      source: opts.source || "upload",
      source_message_id: opts.sourceMessageId || null,
    })
    .select("id")
    .single();
  if (error || !data) return null;
  const memoryId = (data as any).id as string;
  // Background captioning + OCR + embedding — never blocks the chat send.
  void supabase.functions.invoke("embed-image", { body: { memory_id: memoryId } }).catch(() => {});
  return memoryId;
}
