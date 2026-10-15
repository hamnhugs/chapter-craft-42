// Local image generation — stable-diffusion.cpp's sd-server on this machine
// (Vulkan), reached through the same-origin /local/images proxy.
//
// Model: Qwen Image 2.1 Turbo (Unsloth's merged Q4_K_M GGUF, 8 steps) with the
// Qwen3-VL-8B text encoder and its vision tower, so it both generates and
// edits. ~200 s per 512x512 on this machine
// (docs/local-ai/results/2026-10-13-qwen-image.txt). Z-Image-Turbo is the
// fallback (CC_IMAGE_MODEL=zimage): ~74 s, but no real editing. Either way
// sd-server runs on the integrated Radeon — on the RX 5600M a diffusion
// dispatch outlives the driver's lockup timeout ("device lost") — so the chat
// model on the discrete card is never evicted for an image.

import type { GenerateResult } from "@/lib/imageGen";
import { ollamaBaseUrl } from "@/lib/providers/ollamaConfig";

export const LOCAL_IMAGE_PREFIX = "local:";
export const LOCAL_IMAGE_MODEL = "local:qwen-image-2.1-turbo";
const SD = "/local/images";
const TIMEOUT_MS = 900_000;
/** Images sent to an edit, input first. Each one adds conditioning tokens
 *  (time) — and Qwen Image 2.1's own examples stop at a few. */
const MAX_EDIT_IMAGES = 3;

export function isLocalImageModel(id: string | undefined): boolean {
  return String(id || "").startsWith(LOCAL_IMAGE_PREFIX);
}

/** Served by the local dev/preview server, the only place the proxy exists. */
export function localImagesAvailable(): boolean {
  return typeof window !== "undefined" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);
}

/** Aspect ratio → a size near 512x512's pixel count (multiples of 32). Time
 *  scales with pixels; ~0.26 MP is ~200 s on the iGPU. */
export function sizeFor(aspect?: string): string {
  switch (aspect) {
    case "16:9": return "704x384";
    case "21:9": return "768x320";
    case "9:16": return "384x704";
    case "4:3": return "576x448";
    case "3:4": return "448x576";
    case "3:2": return "640x416";
    case "2:3": return "416x640";
    default: return "512x512";
  }
}

/** A width x height with the input's aspect ratio and ~512x512's pixel count,
 *  in multiples of 32 — so an edit isn't squashed square or rendered at the
 *  input's full size (time scales with pixels). */
export function sizeForDimensions(w: number, h: number): string {
  if (!(w > 0 && h > 0)) return sizeFor();
  const scale = Math.sqrt((512 * 512) / (w * h));
  const snap = (v: number) => Math.min(1024, Math.max(256, Math.round((v * scale) / 32) * 32));
  return `${snap(w)}x${snap(h)}`;
}

/** The loaded model's file stem as a `local:` id, e.g.
 *  "local:qwen-image-2.1-turbo-Q4_K_M". Cached; never throws. */
let loadedModel: Promise<string> | null = null;
function localModelId(): Promise<string> {
  loadedModel ??= fetch(`${SD}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(5_000) })
    .then((r) => r.json())
    .then((c) => (c?.model?.stem ? `${LOCAL_IMAGE_PREFIX}${c.model.stem}` : LOCAL_IMAGE_MODEL))
    .catch(() => { loadedModel = null; return LOCAL_IMAGE_MODEL; });
  return loadedModel;
}

/** Ask Ollama to drop every resident model so the GPU is free. Never throws.
 *  Only needed if sd-server is moved onto the discrete card (CC_IMAGES_GPU=1). */
export async function freeGpuForImages(): Promise<void> {
  try {
    const ps = await fetch(`${ollamaBaseUrl()}/api/ps`).then((r) => r.json());
    await Promise.all((ps?.models || []).map((m: any) => fetch(`${ollamaBaseUrl()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m.name, keep_alive: 0 }),
    }).catch(() => {})));
  } catch { /* Ollama down — nothing to free */ }
}

function dataUrlToBlob(url: string): Blob {
  const [meta, b64] = url.split(",", 2);
  const mime = /data:([^;]+)/.exec(meta)?.[1] || "image/png";
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function imageSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const dims = { w: bmp.width, h: bmp.height };
    bmp.close();
    return dims;
  } catch { return null; }
}

export async function generateViaLocal(opts: {
  prompt: string;
  aspectRatio?: string;
  /** Edit this image (or, with no instruction-able input, use it as the reference). */
  inputImageDataUrl?: string;
  /** More images the edit may draw on ("put the character from image 2 …"), in order. */
  referenceImageDataUrls?: string[];
}): Promise<GenerateResult> {
  const images = [opts.inputImageDataUrl, ...(opts.referenceImageDataUrls || [])]
    .filter((u): u is string => typeof u === "string" && u.startsWith("data:"))
    .slice(0, MAX_EDIT_IMAGES)
    .map(dataUrlToBlob);
  let res: Response;
  try {
    if (images.length) {
      const dims = opts.aspectRatio ? null : await imageSize(images[0]);
      const form = new FormData();
      form.append("prompt", opts.prompt);
      form.append("size", dims ? sizeForDimensions(dims.w, dims.h) : sizeFor(opts.aspectRatio));
      images.forEach((b, i) => form.append("image[]", b, `input-${i}.png`));
      res = await fetch(`${SD}/v1/images/edits`, { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } else {
      res = await fetch(`${SD}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: opts.prompt, n: 1, size: sizeFor(opts.aspectRatio), output_format: "png" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`Local images: no image after ${TIMEOUT_MS / 1000}s`);
    throw new Error("Local image generator isn't running — start it with scripts/local-up.sh.");
  }
  if (!res.ok) throw new Error(`Local images: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Local images: no image in response");
  const mime = `image/${data?.output_format || "png"}`;
  return { dataUrl: `data:${mime};base64,${b64}`, mime, text: "", modelUsed: await localModelId() };
}
