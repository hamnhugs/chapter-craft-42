import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

// Client-side figure extraction from PDF books.
//
// Strategy ("locate via operators, crop via render" — the robust hybrid):
//   1. Walk each page's operator list tracking the transform stack to find
//      where images are PAINTED on the page (device-space rectangles).
//   2. Merge overlapping/adjacent rectangles — printers and design tools often
//      slice one visual figure into many strip XObjects.
//   3. Render the page ONCE through pdf.js's full pipeline and crop the merged
//      rectangles from that render. Cropping the render (instead of decoding
//      raw XObjects) is what guarantees correct colors (CMYK/JPX), composited
//      transparency masks, and whole figures — "what the reader sees".
//   4. Cheap noise filters run before any AI spend: size/aspect/coverage
//      thresholds plus a perceptual-hash pass that drops images repeating on
//      3+ pages (logos, headers, watermarks, page furniture).
//
// EPUB uploads are converted to PDF client-side before storage (epubToPdf.ts),
// so their images arrive here as ordinary embedded rasters.

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export interface ExtractedFigure {
  /** JPEG for storage/display, long edge ≤ STORE_MAX_EDGE. */
  blob: Blob;
  width: number;
  height: number;
  page: number;
  /** Nearby page text (caption band below, then above, then inside). */
  context: string;
  /** 64-bit perceptual hash, hex — persisted for dedup across re-runs. */
  phash: string;
}

export interface ExtractionResult {
  figures: ExtractedFigure[];
  scannedPages: number;
  /** Candidates dropped by the figure cap (not by quality filters). */
  droppedByCap: number;
}

const MAX_SCAN_PAGES = 800;
const MAX_FIGURES = 80;
const MAX_CANDIDATES_IN_FLIGHT = 240;
const RENDER_TARGET_EDGE = 1600; // px, long edge of the page render
const STORE_MAX_EDGE = 1200;     // px, long edge of the stored figure JPEG
const VLM_MAX_EDGE = 768;        // px, long edge sent to the vision model
const MERGE_GAP_PX = 12;
const MIN_DIM_PX = 64;
const MIN_PAGE_AREA_FRACTION = 0.01;
const MAX_ASPECT = 6;
const FULL_PAGE_COVERAGE = 0.92;
const HAMMING_DUP = 8;
const FURNITURE_PAGE_COUNT = 3;
const CONTEXT_CAP = 600;

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** pdf.js matrix composition: result applies `m2` first, then `m1`. */
function mat(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function apply(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function intersect(a: Rect, b: Rect): Rect {
  return {
    x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
  };
}

const isEmptyRect = (r: Rect) => r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3;

/**
 * Device-space rectangles of every VISIBLE image paint on the page.
 *
 * Beyond raw paint ops this tracks, as part of the graphics state:
 * - clip paths (W/W*) and form-XObject BBoxes, as device-space bounding
 *   boxes — producers crop images by clipping (InDesign frames, Word crops),
 *   and the render honors the clip while the paint op covers the full image;
 * - optional-content (layer) visibility — getOperatorList emits ops for
 *   hidden layers, but the render paints nothing there.
 * Both would otherwise yield crops of blank page or of content the reader
 * never sees.
 */
function collectImageRects(
  opList: { fnArray: number[]; argsArray: unknown[] },
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
  ocConfig: { isVisible: (group: unknown) => boolean } | null,
): Rect[] {
  const OPS = pdfjsLib.OPS;
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  let ctm = IDENTITY.slice();
  let clip: Rect | null = null;
  const stack: { ctm: number[]; clip: Rect | null }[] = [];
  const ocStack: boolean[] = [];
  let hiddenDepth = 0; // count of enclosing invisible marked-content groups
  let lastPathBox: Rect | null = null;
  const rects: Rect[] = [];
  const { fnArray, argsArray } = opList;

  /** Bounding device rect of a user-space rectangle under matrix m. */
  const deviceRect = (m: number[], x0: number, y0: number, x1: number, y1: number): Rect => {
    const corners = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)]
      .map(([x, y]) => viewport.convertToViewportPoint(x, y));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };

  const pushImageRect = (m: number[]) => {
    if (hiddenDepth > 0) return; // inside a hidden layer — render paints nothing
    let r = deviceRect(m, 0, 0, 1, 1); // image ops paint the unit square
    if (clip) r = intersect(r, clip);
    if (!isEmptyRect(r)) rects.push(r);
  };

  const isBox = (v: unknown): v is ArrayLike<number> =>
    !!v && typeof v === "object" && (v as ArrayLike<number>).length === 4 &&
    Number.isFinite((v as ArrayLike<number>)[0]) && Number.isFinite((v as ArrayLike<number>)[1]) &&
    Number.isFinite((v as ArrayLike<number>)[2]) && Number.isFinite((v as ArrayLike<number>)[3]);

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as any;
    if (fn === OPS.save) {
      stack.push({ ctm: ctm.slice(), clip });
    } else if (fn === OPS.restore) {
      const st = stack.pop();
      ctm = st ? st.ctm : IDENTITY.slice();
      clip = st ? st.clip : null;
    } else if (fn === OPS.transform) {
      ctm = mat(ctm, args as number[]);
    } else if (fn === OPS.constructPath) {
      // argsArray = [ops, coords, minMax]; minMax = [minX, minY, maxX, maxY]
      // in current user space — enough for a bounding-box clip.
      const mm = args?.[2];
      lastPathBox = isBox(mm) ? deviceRect(ctm, mm[0], mm[1], mm[2], mm[3]) : null;
    } else if (fn === OPS.clip || fn === OPS.eoClip) {
      // Over-approximate non-rectangular clips by their bounding box.
      if (lastPathBox) clip = clip ? intersect(clip, lastPathBox) : lastPathBox;
    } else if (fn === OPS.endPath) {
      lastPathBox = null;
    } else if (fn === OPS.paintFormXObjectBegin) {
      // Forms nest their own coordinate space; treated as save + transform,
      // and their BBox clips the form's content.
      stack.push({ ctm: ctm.slice(), clip });
      const m = args?.[0];
      if (m && typeof m === "object" && (m as ArrayLike<number>).length === 6) {
        ctm = mat(ctm, Array.from(m as ArrayLike<number>));
      }
      const bbox = args?.[1];
      if (isBox(bbox)) {
        const b = deviceRect(ctm, bbox[0], bbox[1], bbox[2], bbox[3]);
        clip = clip ? intersect(clip, b) : b;
      }
    } else if (fn === OPS.paintFormXObjectEnd) {
      const st = stack.pop();
      ctm = st ? st.ctm : IDENTITY.slice();
      clip = st ? st.clip : null;
    } else if (fn === OPS.beginMarkedContentProps) {
      let visible = true;
      if (args?.[0] === "OC" && ocConfig) {
        try { visible = ocConfig.isVisible(args?.[1]) !== false; } catch { visible = true; }
      }
      ocStack.push(visible);
      if (!visible) hiddenDepth++;
    } else if (fn === OPS.beginMarkedContent) {
      ocStack.push(true);
    } else if (fn === OPS.endMarkedContent) {
      if (ocStack.pop() === false) hiddenDepth--;
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      pushImageRect(ctm);
    } else if (fn === OPS.paintImageXObjectRepeat) {
      // Optimized repeats carry their own placements: [id, scaleX, scaleY,
      // [x0, y0, x1, y1, ...]] — each instance is a separate paint.
      const scaleX = args?.[1], scaleY = args?.[2], positions = args?.[3];
      if (typeof scaleX === "number" && typeof scaleY === "number" && positions?.length >= 2) {
        for (let k = 0; k + 1 < positions.length; k += 2) {
          pushImageRect(mat(ctm, [scaleX, 0, 0, scaleY, positions[k], positions[k + 1]]));
        }
      }
    }
  }
  return rects;
}

/** Union rectangles that overlap or sit within `gap` px of each other. */
function mergeRects(input: Rect[], gap: number): Rect[] {
  const merged = input.map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        if (a.x0 <= b.x1 + gap && b.x0 <= a.x1 + gap && a.y0 <= b.y1 + gap && b.y0 <= a.y1 + gap) {
          merged[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          };
          merged.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return merged;
}

/** 64-bit DCT perceptual hash of a canvas, as 16 hex chars. */
function phashFromCanvas(source: HTMLCanvasElement): string {
  const N = 32, K = 8;
  const c = document.createElement("canvas");
  c.width = N; c.height = N;
  const cx = c.getContext("2d")!;
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, N, N);
  cx.drawImage(source, 0, 0, N, N);
  const d = cx.getImageData(0, 0, N, N).data;
  const gray = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  // 2D DCT-II — only the K×K low-frequency block is needed.
  const coeffs: number[] = [];
  for (let u = 0; u < K; u++) {
    for (let v = 0; v < K; v++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          sum += gray[y * N + x] *
            Math.cos(((2 * x + 1) * v * Math.PI) / (2 * N)) *
            Math.cos(((2 * y + 1) * u * Math.PI) / (2 * N));
        }
      }
      coeffs.push(sum);
    }
  }
  const ac = coeffs.slice(1); // drop DC term
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)];
  let bits = "";
  for (const cf of ac) bits += cf > median ? "1" : "0";
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  }
  return hex;
}

export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not encode figure image"))),
      "image/jpeg",
      quality,
    );
  });
}

/** Downscale a stored figure blob to a JPEG data URL for the vision call. */
export async function blobToScaledJpegDataUrl(blob: Blob, maxEdge = VLM_MAX_EDGE): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    const t = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * t));
    const h = Math.max(1, Math.round(bitmap.height * t));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d")!;
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, w, h);
    cx.drawImage(bitmap, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.8);
  } finally {
    bitmap.close();
  }
}

interface TextItemPos { str: string; x: number; y: number }

async function getPageTextPositions(
  page: PDFPageProxy,
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
): Promise<TextItemPos[]> {
  try {
    const tc = await page.getTextContent();
    return (tc.items as any[])
      .filter((it) => typeof it.str === "string" && it.str.trim().length > 0)
      .map((it) => {
        const [x, y] = viewport.convertToViewportPoint(it.transform?.[4] ?? 0, it.transform?.[5] ?? 0);
        return { str: it.str as string, x, y };
      });
  } catch {
    return [];
  }
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Nearby text for a figure: caption band below first, then above, then inside. */
function contextForRect(items: TextItemPos[], rect: Rect, pageH: number): string {
  const band = (y0: number, y1: number) =>
    items
      .filter((it) => it.y >= y0 && it.y <= y1)
      .sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x))
      .map((it) => it.str)
      .join(" ");
  const below = band(rect.y1, rect.y1 + pageH * 0.15);
  const above = band(rect.y0 - pageH * 0.12, rect.y0);
  const inside = band(rect.y0, rect.y1);
  return collapse([below, above, inside].filter(Boolean).join(" … ")).slice(0, CONTEXT_CAP);
}

interface Candidate extends ExtractedFigure { clusterPages?: Set<number> }

export async function extractFiguresFromPdf(opts: {
  file?: File | Blob;
  fileUrl?: string;
  onProgress?: (msg: string) => void;
}): Promise<ExtractionResult> {
  const { onProgress } = opts;
  let loadingTask;
  if (opts.file) {
    loadingTask = pdfjsLib.getDocument({ data: await opts.file.arrayBuffer() });
  } else if (opts.fileUrl) {
    loadingTask = pdfjsLib.getDocument({ url: opts.fileUrl });
  } else {
    throw new Error("No file provided for figure extraction.");
  }
  const pdf: PDFDocumentProxy = await loadingTask.promise;

  // Layer visibility for the operator walk — mirrors what page.render uses,
  // so we never crop regions the render leaves blank.
  const ocConfig = await pdf.getOptionalContentConfig().catch(() => null);

  const candidates: Candidate[] = [];
  const pageCount = Math.min(pdf.numPages, MAX_SCAN_PAGES);
  let stoppedEarlyAt = 0;

  try {
    for (let p = 1; p <= pageCount; p++) {
      if (candidates.length >= MAX_CANDIDATES_IN_FLIGHT) {
        // Memory ceiling: candidate blobs are held in RAM until the dedup
        // pass — an art book with thousands of images must not OOM the tab.
        stoppedEarlyAt = p;
        break;
      }
      onProgress?.(`Scanning page ${p}/${pageCount} — ${candidates.length} figure candidate${candidates.length === 1 ? "" : "s"}…`);
      let page: PDFPageProxy;
      try {
        page = await pdf.getPage(p);
      } catch { continue; }

      try {
        const base = page.getViewport({ scale: 1 });
        // Cap the render at RENDER_TARGET_EDGE on the long side: oversized
        // pages (plates, maps — PDF allows 14,400pt) downscale instead of
        // allocating a native-size canvas that OOMs or silently no-ops.
        const scale = Math.max(0.2, Math.min(2.5, RENDER_TARGET_EDGE / Math.max(base.width, base.height)));
        const viewport = page.getViewport({ scale });
        const pageW = viewport.width, pageH = viewport.height;
        const pageArea = pageW * pageH;

        const opList = await page.getOperatorList();
        const raw = collectImageRects(opList, viewport, ocConfig as any);
        if (raw.length === 0) continue;

        // Clamp to the page, merge slices, then filter noise.
        const clamped = raw
          .map((r) => ({
            x0: Math.max(0, r.x0), y0: Math.max(0, r.y0),
            x1: Math.min(pageW, r.x1), y1: Math.min(pageH, r.y1),
          }))
          .filter((r) => r.x1 - r.x0 > 2 && r.y1 - r.y0 > 2);
        const textItems = await getPageTextPositions(page, viewport);
        const kept = mergeRects(clamped, MERGE_GAP_PX).filter((r) => {
          const w = r.x1 - r.x0, h = r.y1 - r.y0;
          if (w < MIN_DIM_PX || h < MIN_DIM_PX) return false;
          if (w * h < pageArea * MIN_PAGE_AREA_FRACTION) return false;
          if (Math.max(w, h) / Math.min(w, h) > MAX_ASPECT) return false;
          // A near-full-page image is a background, watermark, or whole-page
          // scan layer — not a croppable figure either way.
          if (w * h >= pageArea * FULL_PAGE_COVERAGE) return false;
          return true;
        });
        if (kept.length === 0) continue;

        // One full-quality render per page with kept figures.
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(pageW);
        canvas.height = Math.ceil(pageH);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        for (const r of kept) {
          // Small padding captures thin borders around the figure.
          const pad = 6;
          const sx = Math.max(0, Math.floor(r.x0 - pad));
          const sy = Math.max(0, Math.floor(r.y0 - pad));
          const sw = Math.min(canvas.width - sx, Math.ceil(r.x1 - r.x0 + pad * 2));
          const sh = Math.min(canvas.height - sy, Math.ceil(r.y1 - r.y0 + pad * 2));
          if (sw < 8 || sh < 8) continue;
          const t = Math.min(1, STORE_MAX_EDGE / Math.max(sw, sh));
          const crop = document.createElement("canvas");
          crop.width = Math.max(1, Math.round(sw * t));
          crop.height = Math.max(1, Math.round(sh * t));
          const cropCtx = crop.getContext("2d")!;
          cropCtx.fillStyle = "#fff";
          cropCtx.fillRect(0, 0, crop.width, crop.height);
          cropCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

          const phash = phashFromCanvas(crop);
          const blob = await canvasToJpegBlob(crop, 0.85);
          candidates.push({
            blob,
            width: crop.width,
            height: crop.height,
            page: p,
            context: contextForRect(textItems, r, pageH),
            phash,
          });
          crop.width = 0; crop.height = 0;
        }
        canvas.width = 0; canvas.height = 0;
      } catch (e) {
        console.warn(`[figureExtraction] page ${p} failed`, e);
      } finally {
        try { page.cleanup(); } catch { /* ignore */ }
      }
      // Yield so the UI stays responsive between pages.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }

  // Cross-page dedup: cluster by perceptual hash. Images recurring on 3+
  // pages are page furniture (logos, headers) — drop the whole cluster.
  // A figure repeated on 1-2 pages keeps its first occurrence only.
  const clusters: { rep: Candidate; members: Candidate[]; pages: Set<number> }[] = [];
  for (const cand of candidates) {
    const cluster = clusters.find((cl) => hammingHex(cl.rep.phash, cand.phash) <= HAMMING_DUP);
    if (cluster) {
      cluster.members.push(cand);
      cluster.pages.add(cand.page);
    } else {
      clusters.push({ rep: cand, members: [cand], pages: new Set([cand.page]) });
    }
  }
  const unique = clusters
    .filter((cl) => cl.pages.size < FURNITURE_PAGE_COUNT)
    .map((cl) => cl.members[0])
    .sort((a, b) => a.page - b.page);

  const droppedByCap = Math.max(0, unique.length - MAX_FIGURES);
  return {
    figures: unique.slice(0, MAX_FIGURES),
    scannedPages: stoppedEarlyAt ? stoppedEarlyAt - 1 : pageCount,
    droppedByCap,
  };
}
