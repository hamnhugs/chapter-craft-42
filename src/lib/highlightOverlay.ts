/**
 * Glowing marks for saved highlights on PDF pages. The pdf.js text layer draws
 * transparent glyphs over the canvas, so ::highlight can only tint boxes and
 * can't glow (box-shadow isn't allowed there). Instead, like Hypothesis, the
 * range's client rects become absolutely positioned boxes over the page with
 * mix-blend-mode: multiply — the printed ink stays at full contrast.
 *
 * The layer sits below the text layer (z-index 1 vs 2) and ignores pointer
 * events, so selecting text and read-along's tap-to-jump pass straight
 * through; the read-along pill is appended later and paints above it.
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One box per line: pdf.js splits a line into many spans, and adjacent boxes
 * with individual glows would stack into blotches at every seam.
 */
export function mergeLineRects(rects: readonly RectLike[]): RectLike[] {
  const sorted = rects
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: RectLike[] = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last) {
      const overlap = Math.min(last.top + last.height, r.top + r.height) - Math.max(last.top, r.top);
      const sameLine = overlap > Math.min(last.height, r.height) * 0.5;
      const gap = r.left - (last.left + last.width);
      if (sameLine && gap < Math.max(last.height, r.height) * 0.8) {
        const left = Math.min(last.left, r.left);
        const top = Math.min(last.top, r.top);
        const right = Math.max(last.left + last.width, r.left + r.width);
        const bottom = Math.max(last.top + last.height, r.top + r.height);
        Object.assign(last, { left, top, width: right - left, height: bottom - top });
        continue;
      }
    }
    lines.push(r);
  }
  return lines;
}

export class HighlightOverlay {
  private host: HTMLElement;
  private layer: HTMLDivElement;

  constructor(host: HTMLElement) {
    this.host = host;
    const doc = host.ownerDocument;
    this.layer = doc.createElement("div");
    this.layer.className = "user-hl-layer";
    this.layer.setAttribute("aria-hidden", "true");
    // After the page element (its height is measured as firstElementChild),
    // before anything read-along appends.
    host.insertBefore(this.layer, host.firstElementChild?.nextSibling ?? null);
  }

  get attached(): boolean {
    return this.layer.parentNode === this.host;
  }

  setHue(hue: number) {
    this.layer.style.setProperty("--uh-hue", String(hue));
  }

  render(items: ReadonlyArray<{ id: string; range: Range }>, fresh?: ReadonlySet<string>) {
    const hostRect = this.host.getBoundingClientRect();
    const frag = this.host.ownerDocument.createDocumentFragment();
    for (const { id, range } of items) {
      for (const r of mergeLineRects(Array.from(range.getClientRects()))) {
        const padX = Math.max(1, r.height * 0.08);
        const el = this.host.ownerDocument.createElement("div");
        el.className = fresh?.has(id) ? "user-hl user-hl-fresh" : "user-hl";
        el.dataset.highlightId = id;
        el.style.left = `${r.left - hostRect.left - padX}px`;
        el.style.top = `${r.top - hostRect.top}px`;
        el.style.width = `${r.width + padX * 2}px`;
        el.style.height = `${r.height}px`;
        frag.appendChild(el);
      }
    }
    this.layer.replaceChildren(frag);
  }

  clear() {
    this.layer.replaceChildren();
  }

  destroy() {
    this.layer.remove();
  }
}
