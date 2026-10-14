// Voice screenshots in the reader: the whole page, or the pictures on it,
// saved to the user's image library (same rows as a chat upload, so they show
// up with their other images and every image tool can use them).

import type { PDFDocumentProxy } from "pdfjs-dist";
import { locatePageImages } from "@/lib/figureExtraction";
import { registerUploadedImage, uploadChatImage } from "@/lib/imageUpload";
import type { Ordinal } from "@/lib/voiceCommands";

const PAGE_LONG_EDGE = 2200;

async function renderPdfPage(pdf: PDFDocumentProxy, pageNum: number): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.5, Math.min(4, PAGE_LONG_EDGE / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function crop(src: HTMLCanvasElement, box: { x0: number; y0: number; x1: number; y1: number }): HTMLCanvasElement {
  const sx = Math.floor(box.x0 * src.width), sy = Math.floor(box.y0 * src.height);
  const sw = Math.max(1, Math.ceil((box.x1 - box.x0) * src.width)), sh = Math.max(1, Math.ceil((box.y1 - box.y0) * src.height));
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

async function saveCanvas(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const mime = "image/png";
  const dataUrl = canvas.toDataURL(mime);
  const { storagePath } = await uploadChatImage(dataUrl, mime);
  await registerUploadedImage({ storagePath, mime, filename, width: canvas.width, height: canvas.height });
}

function pick<T>(list: T[], which: Ordinal | "all" | null): T[] | string {
  if (which === "all" || which === null) return list;
  const idx = which === "last" ? list.length - 1 : which - 1;
  if (idx < 0 || idx >= list.length) return `There ${list.length === 1 ? "is only one picture" : `are only ${list.length} pictures`} on this page.`;
  return [list[idx]];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function screenshotPdf(opts: {
  pdf: PDFDocumentProxy;
  page: number;
  bookTitle: string;
  target: "page" | "image";
  which?: Ordinal | "all" | null;
}): Promise<string> {
  const { pdf, page, bookTitle } = opts;
  const canvas = await renderPdfPage(pdf, page);
  const base = `${bookTitle || "Book"} — p. ${page}`;
  if (opts.target === "page") {
    await saveCanvas(canvas, base);
    return `Saved a screenshot of page ${page} to your images.`;
  }
  const ocConfig = await pdf.getOptionalContentConfig().catch(() => null);
  const boxes = await locatePageImages(await pdf.getPage(page), ocConfig);
  const figures = boxes.filter((b) => !b.fullPage);
  if (figures.length === 0) {
    if (boxes.length > 0) {
      await saveCanvas(canvas, base);
      return "This page is one big picture, so I saved the whole page to your images.";
    }
    return "I don't see any pictures on this page. Say screenshot the page to capture all of it.";
  }
  const chosen = pick(figures, opts.which ?? null);
  if (typeof chosen === "string") return chosen;
  for (const [i, b] of chosen.entries()) {
    const n = chosen.length === 1 ? figures.indexOf(b) + 1 : i + 1;
    await saveCanvas(crop(canvas, b), `${base} picture ${n}`);
  }
  return chosen.length === 1
    ? `Saved ${figures.length > 1 ? `picture ${figures.indexOf(chosen[0]) + 1} of ${figures.length}` : "the picture"} to your images.`
    : `Saved all ${plural(chosen.length, "picture")} on this page to your images.`;
}

/** HTML books: their <img> elements, in reading order. */
export async function screenshotHtmlImages(opts: {
  doc: Document;
  bookTitle: string;
  which?: Ordinal | "all" | null;
}): Promise<string> {
  const imgs = Array.from(opts.doc.images).filter((im) => im.complete && im.naturalWidth >= 48 && im.naturalHeight >= 48);
  if (imgs.length === 0) return "I don't see any pictures here.";
  // Prefer what's on screen: images whose box intersects the viewport.
  const view = opts.doc.defaultView;
  const onScreen = imgs.filter((im) => {
    const r = im.getBoundingClientRect();
    return view ? r.bottom > 0 && r.top < view.innerHeight : true;
  });
  const list = onScreen.length ? onScreen : imgs;
  const chosen = pick(list, opts.which ?? null);
  if (typeof chosen === "string") return chosen;
  let saved = 0;
  for (const [i, im] of chosen.entries()) {
    const c = document.createElement("canvas");
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    try {
      c.getContext("2d")!.drawImage(im, 0, 0);
      c.toDataURL(); // throws when the image taints the canvas (cross-origin)
    } catch {
      try {
        const blob = await (await fetch(im.currentSrc || im.src)).blob();
        const bmp = await createImageBitmap(blob);
        c.getContext("2d")!.drawImage(bmp, 0, 0);
      } catch { continue; }
    }
    await saveCanvas(c, `${opts.bookTitle || "Book"} — picture ${i + 1}`);
    saved++;
  }
  if (saved === 0) return "I couldn't copy that picture — it's blocked by its website.";
  return saved === 1 ? "Saved the picture to your images." : `Saved ${plural(saved, "picture")} to your images.`;
}
