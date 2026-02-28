import JSZip from "jszip";
import { jsPDF } from "jspdf";

interface EpubConversionResult {
  file: File;
  pageCount: number;
}

interface SpineItem {
  href: string;
  id: string;
}

/**
 * Convert an EPUB file to a high-quality PDF client-side.
 * Parses the EPUB archive, extracts content in spine order, renders text and
 * images into a paginated jsPDF document, and returns the result as a File.
 */
export async function convertEpubToPdf(epubFile: File): Promise<EpubConversionResult> {
  const zip = await JSZip.loadAsync(epubFile);

  // 1. Locate the OPF file via META-INF/container.xml
  const containerXml = await readZipText(zip, "META-INF/container.xml");
  const opfPath = parseRootfilePath(containerXml);
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";

  // 2. Parse the OPF to get manifest and spine
  const opfXml = await readZipText(zip, opfPath);
  const { manifest, spine } = parseOpf(opfXml);

  // 3. Build the PDF
  const pdf = new jsPDF({ unit: "pt", format: "letter" });
  const PAGE_WIDTH = pdf.internal.pageSize.getWidth();
  const PAGE_HEIGHT = pdf.internal.pageSize.getHeight();
  const MARGIN = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
  const LINE_HEIGHT = 16;
  const FONT_SIZE = 11;
  const HEADING_SIZES: Record<string, number> = {
    h1: 22,
    h2: 18,
    h3: 15,
    h4: 13,
  };

  pdf.setFont("Helvetica");
  pdf.setFontSize(FONT_SIZE);

  let cursorY = MARGIN;
  let isFirstPage = true;

  const ensureSpace = (needed: number) => {
    if (cursorY + needed > PAGE_HEIGHT - MARGIN) {
      pdf.addPage();
      cursorY = MARGIN;
    }
  };

  const addNewPage = () => {
    if (!isFirstPage) {
      pdf.addPage();
    }
    cursorY = MARGIN;
    isFirstPage = false;
  };

  // Process each spine item (chapter)
  for (let si = 0; si < spine.length; si++) {
    const spineItem = spine[si];
    const manifestEntry = manifest.get(spineItem.id);
    if (!manifestEntry) continue;

    const itemHref = resolveHref(opfDir, manifestEntry.href);
    const zipEntry = zip.file(itemHref) ?? zip.file(decodeURIComponent(itemHref));
    if (!zipEntry) continue;

    const html = await zipEntry.async("string");

    // Start each chapter on a new page (except the very first)
    if (si > 0) {
      addNewPage();
    } else {
      isFirstPage = false;
    }

    // Parse HTML into content blocks
    const blocks = parseHtmlToBlocks(html);

    for (const block of blocks) {
      if (block.type === "heading") {
        const size = HEADING_SIZES[block.tag ?? "h2"] ?? 15;
        ensureSpace(size + LINE_HEIGHT);
        cursorY += size * 0.5; // spacing before heading
        pdf.setFontSize(size);
        pdf.setFont("Helvetica", "bold");
        const lines = pdf.splitTextToSize(block.text, CONTENT_WIDTH);
        for (const line of lines) {
          ensureSpace(size + 4);
          pdf.text(line, MARGIN, cursorY);
          cursorY += size + 4;
        }
        pdf.setFontSize(FONT_SIZE);
        pdf.setFont("Helvetica", "normal");
        cursorY += 4;
      } else if (block.type === "image") {
        // Try to load the image from the zip
        try {
          const imgHref = resolveHref(opfDir, block.src ?? "");
          const imgEntry = zip.file(imgHref) ?? zip.file(decodeURIComponent(imgHref));
          if (imgEntry) {
            const imgData = await imgEntry.async("base64");
            const ext = getImageFormat(imgHref);
            if (ext) {
              // Determine image dimensions (max width = CONTENT_WIDTH, max height = 400)
              const maxW = CONTENT_WIDTH;
              const maxH = 400;
              const dims = await getImageDimensions(imgData, ext);
              let w = dims.width;
              let h = dims.height;
              if (w > maxW) {
                h = (h * maxW) / w;
                w = maxW;
              }
              if (h > maxH) {
                w = (w * maxH) / h;
                h = maxH;
              }
              ensureSpace(h + 10);
              const dataUri = `data:image/${ext};base64,${imgData}`;
              pdf.addImage(dataUri, ext.toUpperCase(), MARGIN, cursorY, w, h);
              cursorY += h + 10;
            }
          }
        } catch {
          // Skip images that fail to load
        }
      } else {
        // paragraph / text block
        if (!block.text.trim()) continue;
        pdf.setFontSize(FONT_SIZE);
        const isBold = block.bold === true;
        const isItalic = block.italic === true;
        const style = isBold && isItalic ? "bolditalic" : isBold ? "bold" : isItalic ? "italic" : "normal";
        pdf.setFont("Helvetica", style);

        const lines: string[] = pdf.splitTextToSize(block.text, CONTENT_WIDTH);
        for (const line of lines) {
          ensureSpace(LINE_HEIGHT);
          pdf.text(line, MARGIN, cursorY);
          cursorY += LINE_HEIGHT;
        }
        pdf.setFont("Helvetica", "normal");
        cursorY += 6; // paragraph spacing
      }
    }
  }

  const pageCount = pdf.getNumberOfPages();
  const pdfBlob = pdf.output("blob");
  const pdfFileName = epubFile.name.replace(/\.epub$/i, ".pdf");
  const pdfFile = new File([pdfBlob], pdfFileName, { type: "application/pdf" });

  return { file: pdfFile, pageCount };
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`Missing file in EPUB: ${path}`);
  return entry.async("string");
}

function parseRootfilePath(containerXml: string): string {
  const match = containerXml.match(/rootfile[^>]*full-path="([^"]+)"/);
  if (!match) throw new Error("Cannot find OPF rootfile in container.xml");
  return match[1];
}

function parseOpf(opfXml: string): { manifest: Map<string, { href: string; mediaType: string }>; spine: SpineItem[] } {
  const manifest = new Map<string, { href: string; mediaType: string }>();
  const itemRegex = /<item\s[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(opfXml)) !== null) {
    const tag = m[0];
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    const mediaType = attr(tag, "media-type");
    if (id && href) {
      manifest.set(id, { href: decodeXmlEntities(href), mediaType: mediaType ?? "" });
    }
  }

  const spine: SpineItem[] = [];
  const spineMatch = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
  if (spineMatch) {
    const itemrefRegex = /<itemref\s[^>]*>/gi;
    while ((m = itemrefRegex.exec(spineMatch[1])) !== null) {
      const idref = attr(m[0], "idref");
      if (idref) {
        const entry = manifest.get(idref);
        spine.push({ id: idref, href: entry?.href ?? "" });
      }
    }
  }

  return { manifest, spine };
}

function attr(tag: string, name: string): string | undefined {
  const regex = new RegExp(`${name}="([^"]*)"`, "i");
  const m = tag.match(regex);
  return m ? m[1] : undefined;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function resolveHref(baseDir: string, href: string): string {
  // Strip fragment
  const clean = href.split("#")[0];
  return baseDir + clean;
}

interface ContentBlock {
  type: "paragraph" | "heading" | "image";
  text: string;
  tag?: string;
  bold?: boolean;
  italic?: boolean;
  src?: string;
}

function parseHtmlToBlocks(html: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Remove script/style tags
  let cleaned = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Extract images
  const imgRegex = /<img\s[^>]*src="([^"]*)"[^>]*\/?>/gi;
  let imgMatch: RegExpExecArray | null;
  // We'll process inline – first collect image positions
  const imgPositions: { index: number; src: string }[] = [];
  while ((imgMatch = imgRegex.exec(cleaned)) !== null) {
    imgPositions.push({ index: imgMatch.index, src: decodeXmlEntities(imgMatch[1]) });
  }

  // Split by block-level elements
  const blockRegex = /<(h[1-6]|p|div|li|blockquote|tr|dt|dd)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  let blockMatch: RegExpExecArray | null;
  const processedRanges: { start: number; end: number }[] = [];

  while ((blockMatch = blockRegex.exec(cleaned)) !== null) {
    const tag = blockMatch[1].toLowerCase();
    const content = blockMatch[0];
    const start = blockMatch.index;
    const end = start + content.length;
    processedRanges.push({ start, end });

    // Check for images inside this block
    for (const img of imgPositions) {
      if (img.index >= start && img.index < end) {
        blocks.push({ type: "image", text: "", src: img.src });
      }
    }

    const text = stripTags(content).trim();
    if (!text) continue;

    if (tag.startsWith("h")) {
      blocks.push({ type: "heading", text, tag });
    } else {
      const isBold = /<(b|strong)\b/i.test(content);
      const isItalic = /<(i|em)\b/i.test(content);
      blocks.push({ type: "paragraph", text, bold: isBold, italic: isItalic });
    }
  }

  // Catch any images not inside processed blocks
  for (const img of imgPositions) {
    const inside = processedRanges.some((r) => img.index >= r.start && img.index < r.end);
    if (!inside) {
      blocks.push({ type: "image", text: "", src: img.src });
    }
  }

  // If no blocks were extracted, fall back to full text
  if (blocks.length === 0) {
    const fallbackText = stripTags(cleaned).trim();
    if (fallbackText) {
      blocks.push({ type: "paragraph", text: fallbackText });
    }
  }

  return blocks;
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getImageFormat(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop();
  if (!ext) return null;
  const map: Record<string, string> = {
    jpg: "JPEG",
    jpeg: "JPEG",
    png: "PNG",
    gif: "GIF",
    webp: "WEBP",
  };
  return map[ext] ?? null;
}

function getImageDimensions(base64: string, format: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 300, height: 200 }); // fallback
    img.src = `data:image/${format};base64,${base64}`;
  });
}
