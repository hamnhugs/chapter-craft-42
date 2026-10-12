// Local image generation — stable-diffusion.cpp's sd-server on this machine
// (Vulkan), reached through the same-origin /local/images proxy.
//
// Model: Z-Image-Turbo (TwinFlow few-step distillation, Q4_K GGUF) with the
// Qwen3-4B text encoder — the established low-VRAM choice for sd.cpp on
// Vulkan (stable-diffusion.cpp docs/z_image.md). Measured on this machine
// (docs/local-ai/results/2026-10-12-images.txt): on the RX 5600M a Z-Image
// dispatch outlives the driver's lockup timeout ("device lost"); on the
// integrated Radeon, which uses system RAM, 512x512 takes ~74 s. So sd-server
// runs on the iGPU (scripts/local-up.sh), and the chat model on the discrete
// card is never evicted for an image.

import type { GenerateResult } from "@/lib/imageGen";
import { ollamaBaseUrl } from "@/lib/providers/ollamaConfig";

export const LOCAL_IMAGE_PREFIX = "local:";
export const LOCAL_IMAGE_MODEL = "local:z-image-turbo";
const SD = "/local/images";
const TIMEOUT_MS = 600_000;

export function isLocalImageModel(id: string | undefined): boolean {
  return String(id || "").startsWith(LOCAL_IMAGE_PREFIX);
}

/** Served by the local dev/preview server, the only place the proxy exists. */
export function localImagesAvailable(): boolean {
  return typeof window !== "undefined" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);
}

/** Aspect ratio → a size near 512x512's pixel count (multiples of 32). Time
 *  scales with pixels; ~0.26 MP is ~75 s on the iGPU. */
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

export async function generateViaLocal(opts: {
  prompt: string;
  aspectRatio?: string;
  inputImageDataUrl?: string;
}): Promise<GenerateResult> {
  const size = sizeFor(opts.aspectRatio);
  let res: Response;
  try {
    if (opts.inputImageDataUrl) {
      const form = new FormData();
      form.append("prompt", opts.prompt);
      form.append("size", size);
      form.append("image", dataUrlToBlob(opts.inputImageDataUrl), "input.png");
      res = await fetch(`${SD}/v1/images/edits`, { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } else {
      res = await fetch(`${SD}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: opts.prompt, n: 1, size, output_format: "png" }),
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
  return { dataUrl: `data:${mime};base64,${b64}`, mime, text: "", modelUsed: LOCAL_IMAGE_MODEL };
}
