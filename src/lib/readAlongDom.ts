/**
 * DOM side of read-along: flattens rendered text (a pdf.js text layer, or an
 * HTML book's iframe body) into one string with a map back to text nodes, and
 * moves the animated highlight pill over the word being spoken.
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);

interface Segment {
  node: Text;
  /** Offset of the node's first char in the flattened text. */
  start: number;
}

export interface TextMap {
  text: string;
  /** DOM Range covering flattened offsets [start, end). */
  rangeFor(start: number, end: number): Range | null;
  /** Flattened offset of a DOM point, or -1 if it isn't in the map. */
  offsetOf(node: Node, offset: number): number;
  /**
   * Flattened offset of any boundary point — a selection's start or end,
   * which may sit on an element or outside the mapped root. Points before the
   * root clamp to 0, after it to text.length; -1 only if it can't be compared.
   */
  boundaryOffset(node: Node, offset: number): number;
}

/**
 * Walk visible text nodes in document order. A space is inserted between nodes
 * that sit in different block containers (pdf.js positions every text item as
 * its own absolutely-positioned span, which computes to display:block), so
 * words from adjacent lines never fuse; inline formatting (<em>) does not split.
 */
export function buildTextMap(root: Element): TextMap {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const blockOf = new WeakMap<Element, Element>();
  const containerBlock = (el: Element | null): Element | null => {
    let cur = el;
    const path: Element[] = [];
    while (cur && cur !== root) {
      const cached = blockOf.get(cur);
      if (cached) { for (const p of path) blockOf.set(p, cached); return cached; }
      path.push(cur);
      const display = view?.getComputedStyle(cur).display ?? "inline";
      if (!display.startsWith("inline") && display !== "contents") {
        for (const p of path) blockOf.set(p, cur);
        return cur;
      }
      cur = cur.parentElement;
    }
    for (const p of path) blockOf.set(p, root);
    return root;
  };

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = n.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const segments: Segment[] = [];
  const segmentByNode = new Map<Text, Segment>();
  let text = "";
  let prevBlock: Element | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const block = containerBlock(n.parentElement);
    const value = n.nodeValue || "";
    if (text && block !== prevBlock && !/\s$/.test(text) && !/^\s/.test(value)) text += " ";
    const seg = { node: n, start: text.length };
    segments.push(seg);
    segmentByNode.set(n, seg);
    text += value;
    prevBlock = block;
  }

  const segmentAt = (offset: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const clampInto = (i: number, offset: number) =>
    Math.max(0, Math.min(offset - segments[i].start, segments[i].node.length));

  return {
    text,
    rangeFor(start, end) {
      if (!segments.length || end <= start) return null;
      const a = segmentAt(start);
      const b = segmentAt(end - 1);
      try {
        const r = doc.createRange();
        r.setStart(segments[a].node, clampInto(a, start));
        r.setEnd(segments[b].node, clampInto(b, end));
        return r;
      } catch {
        return null;
      }
    },
    offsetOf(node, offset) {
      const s = segmentByNode.get(node as Text);
      return s ? s.start + offset : -1;
    },
    boundaryOffset(node, offset) {
      const own = segmentByNode.get(node as Text);
      if (own) return own.start + Math.max(0, Math.min(offset, own.node.length));
      if (!segments.length) return -1;
      try {
        const point = doc.createRange();
        point.setStart(node, offset);
        // The first mapped text node at or after the point.
        let lo = 0;
        let hi = segments.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (point.comparePoint(segments[mid].node, 0) >= 0) hi = mid;
          else lo = mid + 1;
        }
        return lo < segments.length ? segments[lo].start : text.length;
      } catch {
        return -1;
      }
    },
  };
}

/** Caret position under a viewport point, across the standard and WebKit APIs. */
export function caretFromPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

type HighlightWindow = Window & {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSS?: { highlights?: Map<string, unknown> };
};

/** Read-along paints above the user's saved highlights (higher priority wins
 *  where the same property is set; ties go to whichever registered last). */
export const READ_ALONG_HIGHLIGHT_PRIORITY = 10;

/**
 * Paints `range` (or several) with a named CSS Custom Highlight (no DOM
 * mutation), or clears it when `range` is null/empty. `declarations` style
 * `::highlight(name)`; `extraCss` is appended verbatim (e.g. a forced-colors
 * override).
 */
export function paintHighlight(
  doc: Document,
  name: string,
  range: Range | readonly Range[] | null,
  declarations: string,
  priority = READ_ALONG_HIGHLIGHT_PRIORITY,
  extraCss = "",
) {
  const win = doc.defaultView as HighlightWindow | null;
  const registry = win?.CSS?.highlights;
  if (!win?.Highlight || !registry) return;
  const ranges = !range ? [] : Array.isArray(range) ? range : [range as Range];
  if (ranges.length === 0) {
    registry.delete(name);
    return;
  }
  const id = `read-along-style-${name}`;
  let style = doc.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = id;
    (doc.head || doc.documentElement).appendChild(style);
  }
  const css = `::highlight(${name}){${declarations}}${extraCss}`;
  if (style.textContent !== css) style.textContent = css;
  const highlight = new win.Highlight(...ranges) as { priority?: number };
  highlight.priority = priority;
  registry.set(name, highlight);
}

/**
 * Recolours the spoken word's own text. Used for HTML books, where the pill
 * sits over an iframe and can't go behind the text: the word stays legible
 * inside the pill.
 */
export function paintWordText(doc: Document, range: Range | null, color: string) {
  paintHighlight(doc, "read-along-word", range, `color:${color};`);
}

/**
 * Softly tints the whole sentence being read (the "where am I" tier under the
 * word pill, as Edge Read Aloud and Speechify do). On a PDF the text layer's
 * glyphs are transparent, so only the tint shows over the printed page.
 */
export function paintSentence(doc: Document, range: Range | null, color: string) {
  paintHighlight(doc, "read-along-sentence", range, `background-color:${color};`);
}

/**
 * The glowing pill (plus a slower "comet" ghost) that glides between words.
 * Lives inside `host` (position: relative), so page scrolling needs no
 * repositioning. `frameOffset` maps rects from a child iframe's viewport.
 */
export class HighlightPill {
  private host: HTMLElement;
  private pill: HTMLDivElement;
  private ghost: HTMLDivElement;
  private lastTop: number | null = null;

  constructor(host: HTMLElement, variant: "pdf" | "html") {
    this.host = host;
    const doc = host.ownerDocument;
    this.ghost = doc.createElement("div");
    this.ghost.className = `read-along-ghost read-along-${variant}`;
    this.pill = doc.createElement("div");
    this.pill.className = `read-along-pill read-along-${variant}`;
    this.ghost.setAttribute("aria-hidden", "true");
    this.pill.setAttribute("aria-hidden", "true");
    host.appendChild(this.ghost);
    host.appendChild(this.pill);
  }

  /** Place over a range; returns the pill's viewport rect (for auto-scroll). */
  place(range: Range | null, frameOffset?: { x: number; y: number }): DOMRect | null {
    const rects = range ? Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0) : [];
    if (!rects.length) {
      this.hide();
      return null;
    }
    // A word wrapped across lines yields one rect per line: take the first.
    const r = rects[0];
    const hostRect = this.host.getBoundingClientRect();
    const ox = frameOffset?.x ?? 0;
    const oy = frameOffset?.y ?? 0;
    const padX = Math.max(2, r.height * 0.18);
    const padY = Math.max(1, r.height * 0.1);
    const x = r.left + ox - hostRect.left + this.host.scrollLeft - padX;
    const y = r.top + oy - hostRect.top + this.host.scrollTop - padY;
    const w = r.width + padX * 2;
    const h = r.height + padY * 2;
    // Jump (don't slide diagonally) when the word moves to another line.
    const lineChange = this.lastTop !== null && Math.abs(y - this.lastTop) > h * 0.6;
    this.lastTop = y;
    for (const el of [this.pill, this.ghost]) {
      if (lineChange) el.style.transition = "none";
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      el.style.opacity = "1";
      el.style.setProperty("--ra-radius", `${Math.round(h * 0.32)}px`);
    }
    if (lineChange) {
      // Flush the jump, then restore the stylesheet transition next frame.
      void this.pill.offsetWidth;
      requestAnimationFrame(() => {
        this.pill.style.transition = "";
        this.ghost.style.transition = "";
      });
    }
    return new DOMRect(r.left + ox - padX, r.top + oy - padY, w, h);
  }

  hide() {
    this.pill.style.opacity = "0";
    this.ghost.style.opacity = "0";
    this.lastTop = null;
  }

  destroy() {
    this.pill.remove();
    this.ghost.remove();
  }
}
