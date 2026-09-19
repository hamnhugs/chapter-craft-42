// Turning a sheet into pixels.
//
// This is the hinge of the whole pipeline. An SVG is a wonderful source of
// truth — deterministic, diffable, exact — and it is completely invisible to an
// image model. There is no published work that conditions a generator on vector
// input; every one of them sees a rasterisation. So a sheet only becomes an
// anchor at the moment it becomes a PNG.
//
// It is also what makes the palette work. A hex code written into a prompt is
// adhered to under 10% of the time, because a text encoder splits "#FF5733"
// into tokens with no colour meaning. The same colour rendered as a swatch and
// passed as a reference image measured ΔE 0.90 against 11.25 for the prompt
// string — imperceptible versus plainly wrong. The swatch strip on the sheet is
// the specification; this function is how it gets delivered.
//
// TAINTING. We serialise to a data: URL rather than a blob: URL, and the sheet
// vocabulary bans <foreignObject> and every external reference — so the canvas
// stays clean and toDataURL always works. Fonts are system stacks resolved by
// the OS, never fetched, which matters because an <img>-sourced SVG cannot load
// anything external at all.

export interface RasterOptions {
  /** Pixel width of the output. Height follows the sheet's aspect ratio. */
  width?: number;
  /** Painted behind the drawing. Sheets are drawn on white; a transparent
   *  raster would composite unpredictably as a reference image. */
  background?: string;
  mimeType?: "image/png" | "image/jpeg";
  quality?: number;
}

export interface RasterResult {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  const CHUNK = 0x8000; // avoid blowing the argument limit on a large sheet
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Read the intrinsic size out of a sheet's viewBox. Sheets carry no width or
 *  height by design, so the viewBox is the only source. */
export function sheetIntrinsicSize(svg: string): { width: number; height: number } | null {
  const m = /viewBox\s*=\s*"([^"]+)"/.exec(svg);
  if (!m) return null;
  const parts = m[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [, , w, h] = parts;
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** Give the root <svg> explicit pixel dimensions, for the rasterisation pass
 *  only. Without them some engines rasterise at a 300x150 default. */
function withExplicitSize(svg: string, width: number, height: number): string {
  const open = svg.slice(0, svg.indexOf(">") + 1);
  const rest = svg.slice(open.length);
  const sized = open.replace(/\s(width|height)="[^"]*"/g, "").replace(/>$/, ` width="${width}" height="${height}">`);
  return sized + rest;
}

/**
 * Rasterise a sheet to a data URL.
 *
 * Browser only — it needs an <img> decode and a canvas. Callers on any other
 * runtime should treat a rejection as "this environment cannot do it", not as
 * a malformed sheet.
 */
export async function rasterizeSheet(svg: string, opts: RasterOptions = {}): Promise<RasterResult> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("Rasterising a sheet needs a browser — no document available.");
  }
  const intrinsic = sheetIntrinsicSize(svg);
  if (!intrinsic) throw new Error("Sheet has no usable viewBox, so its size is unknown.");

  const width = Math.max(64, Math.min(4096, Math.round(opts.width ?? intrinsic.width)));
  const height = Math.max(1, Math.round((width * intrinsic.height) / intrinsic.width));

  const url = `data:image/svg+xml;base64,${utf8ToBase64(withExplicitSize(svg, width, height))}`;

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    // Belt and braces: a data: URL is same-origin, but decoding can still fail
    // on malformed markup and that must not hang the caller.
    const timer = setTimeout(() => reject(new Error("Sheet image decode timed out")), 15000);
    el.onload = () => { clearTimeout(timer); resolve(el); };
    el.onerror = () => { clearTimeout(timer); reject(new Error("Sheet could not be decoded as an image")); };
    el.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.fillStyle = opts.background ?? "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const mime = opts.mimeType ?? "image/png";
  const dataUrl = canvas.toDataURL(mime, opts.quality ?? 0.92);
  return { dataUrl, width, height, bytes: Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75) };
}

/**
 * Save a sheet as a one-page PDF sized exactly to the drawing.
 *
 * Goes through the raster rather than emitting vector PDF: the sheet is already
 * pixel-exact at print scale, and a vector path would need another dependency
 * plus font embedding for a document nobody edits after export.
 */
export async function downloadSheetPdf(svg: string, filename: string, opts: { scale?: number } = {}): Promise<void> {
  const intrinsic = sheetIntrinsicSize(svg);
  if (!intrinsic) throw new Error("Sheet has no usable viewBox, so its size is unknown.");

  const scale = Math.max(1, Math.min(4, opts.scale ?? 2));
  const raster = await rasterizeSheet(svg, { width: intrinsic.width * scale });

  const { default: JsPDF } = await import("jspdf");
  const pdf = new JsPDF({
    orientation: intrinsic.width >= intrinsic.height ? "landscape" : "portrait",
    unit: "pt",
    format: [intrinsic.width, intrinsic.height],
  });
  pdf.addImage(raster.dataUrl, "PNG", 0, 0, intrinsic.width, intrinsic.height);
  pdf.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}

/** Save the sheet as an SVG file — the lossless form, and the one worth keeping
 *  because it stays diffable. */
export function downloadSheetSvg(svg: string, filename: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".svg") ? filename : `${filename}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some engines before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
