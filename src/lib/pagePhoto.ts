/**
 * A page photo, from the shutter to the transcriber — and no further.
 *
 * THE PHOTO IS NEVER STORED. `preparePagePhoto` turns the camera's file into
 * one downscaled JPEG data URL held in memory; the caller hands it to the
 * transcriber and drops the reference as soon as the words are back (or the
 * reader gives up on the shot). Nothing here writes to storage, IndexedDB,
 * localStorage or the network.
 *
 * It also takes two cheap measurements so a hopeless shot can be caught
 * BEFORE a model call is spent on it: sharpness and exposure. They warn; they
 * never block — published blur thresholds vary fourfold between sources, and
 * a reader who says "use it anyway" is right more often than a number.
 */

/** Long edge sent to the transcriber. Enough for body text of a trade
 *  paperback at the x-height OCR guidance asks for (20–30 px), and at or under
 *  what the vision models downsize to anyway. */
export const PHOTO_LONG_EDGE = 2000;
const PHOTO_QUALITY = 0.85;
/** Measurements run on a copy this size, so a threshold means the same thing
 *  on a 12 MP phone and a 2 MP webcam. */
const PROBE_EDGE = 640;

/** Below this the shot is very likely too soft to read. Deliberately at the
 *  low end of the published range: a false "blurry" costs the reader a tap on
 *  every page; a missed one costs a single retake. */
export const BLUR_WARN = 60;

export type PhotoProblem = "blurry" | "dark" | "glare";

export interface PagePhoto {
  /** JPEG data URL — the only copy. Drop the reference to dispose of it. */
  dataUrl: string;
  width: number;
  height: number;
  /** Variance of the Laplacian on the probe copy; higher is sharper. */
  sharpness: number;
  problem: PhotoProblem | null;
}

/** Variance of a 3×3 Laplacian over a grayscale image — the standard cheap
 *  focus measure. Pure, so it is tested without a canvas. */
export function laplacianVariance(gray: Uint8Array | Uint8ClampedArray | Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v; sumSq += v * v; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** What is wrong with the shot, if anything a retake would fix. */
export function judgePhoto(gray: Uint8Array | Uint8ClampedArray, w: number, h: number): { sharpness: number; problem: PhotoProblem | null } {
  const sharpness = laplacianVariance(gray, w, h);
  let total = 0, blown = 0;
  for (let i = 0; i < gray.length; i++) { total += gray[i]; if (gray[i] >= 250) blown++; }
  const mean = gray.length ? total / gray.length : 0;
  // A page is mostly paper, so it is bright; a dark frame is a dim room.
  if (mean < 55) return { sharpness, problem: "dark" };
  // Paper is white but not clipped; a quarter of the frame at full white is a
  // lamp or flash reflecting off the page.
  if (blown / Math.max(1, gray.length) > 0.25) return { sharpness, problem: "glare" };
  if (sharpness < BLUR_WARN) return { sharpness, problem: "blurry" };
  return { sharpness, problem: null };
}

export const PROBLEM_COPY: Record<PhotoProblem, { title: string; tip: string }> = {
  blurry: { title: "This one looks blurry", tip: "Hold still a moment and let the camera focus." },
  dark: { title: "This one is quite dark", tip: "Move nearer a light, or turn on the flash." },
  glare: { title: "There is a bright glare on the page", tip: "Tilt the book a little so the light slides off." },
};

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      // Honour the phone's orientation tag: a sideways page transcribes badly.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
    } catch { /* HEIC on a browser that cannot decode it this way — try <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That photo could not be opened. Try taking it again."));
      i.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => { img.src = ""; } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Camera file → one in-memory JPEG plus its quality reading. */
export async function preparePagePhoto(file: Blob): Promise<PagePhoto> {
  const img = await decode(file);
  try {
    const long = Math.max(img.width, img.height);
    if (!long) throw new Error("That photo is empty. Try taking it again.");
    const scale = Math.min(1, PHOTO_LONG_EDGE / long);
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot prepare photos.");
    ctx.drawImage(img.source, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);

    const ps = Math.min(1, PROBE_EDGE / Math.max(width, height));
    const pw = Math.max(3, Math.round(width * ps)), ph = Math.max(3, Math.round(height * ps));
    const probe = document.createElement("canvas");
    probe.width = pw; probe.height = ph;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    let verdict: { sharpness: number; problem: PhotoProblem | null } = { sharpness: 0, problem: null };
    if (pctx) {
      pctx.drawImage(canvas, 0, 0, pw, ph);
      const rgba = pctx.getImageData(0, 0, pw, ph).data;
      const gray = new Uint8Array(pw * ph);
      for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
      verdict = judgePhoto(gray, pw, ph);
    }
    // Release the pixel buffers now rather than at the next collection.
    canvas.width = canvas.height = 0;
    probe.width = probe.height = 0;
    return { dataUrl, width, height, ...verdict };
  } finally {
    img.close();
  }
}

/** A small cover thumbnail from a photo of the book's COVER — the one image a
 *  paper book keeps, and only when the reader chose to photograph it. */
export async function coverFromPhoto(dataUrl: string, width = 420): Promise<Blob | null> {
  try {
    const img = await decode(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, width / img.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(Math.min(img.height * scale, canvas.width * 1.7));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img.source, 0, 0, canvas.width, Math.round(img.height * scale));
    img.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    canvas.width = canvas.height = 0;
    return blob;
  } catch {
    return null;
  }
}
