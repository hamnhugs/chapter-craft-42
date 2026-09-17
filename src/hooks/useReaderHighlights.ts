import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  anchorInText, highlightHue, highlightStore, isHighlightWorthy, mergeRange, quoteSelector,
  type BookHighlight,
} from "@/lib/highlights";
import { HighlightOverlay } from "@/lib/highlightOverlay";
import { buildTextMap, caretFromPoint, paintHighlight, type TextMap } from "@/lib/readAlongDom";
import { anchorQuote } from "@/lib/bookSearch";
import type { BookDocument } from "@/types/library";

const HIGHLIGHT_NAME = "user-highlight";
const USER_HIGHLIGHT_PRIORITY = 0;
/** Handle drags on phones fire only selectionchange — commit once it settles. */
const SELECTION_SETTLE_MS = 650;
const FRESH_MS = 1200;

export interface HighlightHit {
  highlight: BookHighlight;
  /** Viewport rect of the highlight's first line (top-level coordinates). */
  rect: DOMRect;
}

interface Options {
  mode: "pdf" | "html";
  book: BookDocument | null;
  page: number;
  pageHostRef: React.RefObject<HTMLDivElement>;
  iframeRef: React.RefObject<HTMLIFrameElement>;
  textVersion: number;
  /** Highlight as soon as a selection settles (otherwise only on request). */
  autoHighlight: boolean;
  /** Read-along owns taps (jump to word) while it runs. */
  readAlongActive: boolean;
  loadChapterTextStrict: (chapterId: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  onTapHighlight: (hit: HighlightHit) => void;
}

interface Source {
  map: TextMap;
  root: Element;
  doc: Document;
  version: number;
}

const htmlHighlightCss = (hue: number) =>
  `background-color:hsl(${hue} 100% 55% / 0.30);` +
  `text-shadow:0 0 0.5em hsl(${hue} 100% 50% / 0.9);` +
  `text-decoration:underline 2px hsl(${hue} 90% 42% / 0.85);text-underline-offset:0.2em;`;
const htmlForcedColorsCss =
  `@media (forced-colors: active){::highlight(${HIGHLIGHT_NAME}){background-color:Mark;color:MarkText;}}`;

/**
 * Saved highlights in the reader: painted in their own colour (never the
 * read-along colour), created from text selections, and tappable.
 */
export function useReaderHighlights(opts: Options) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { mode, book, page, textVersion, autoHighlight, readAlongActive } = opts;
  const bookId = book?.id ?? null;

  const all = useSyncExternalStore(
    highlightStore.subscribe,
    () => highlightStore.get(bookId),
    () => highlightStore.get(bookId),
  );
  const onSurface = useCallback(
    (h: BookHighlight) => (mode === "pdf" ? h.page === page : h.page == null),
    [mode, page],
  );

  useEffect(() => {
    if (bookId) highlightStore.ensure(bookId);
  }, [bookId]);

  // ── Text source (rebuilt when the rendered text changes) ────────────────
  const sourceRef = useRef<Source | null>(null);
  const getSource = useCallback((): Source | null => {
    const o = optsRef.current;
    let root: Element | null | undefined;
    let doc: Document | null | undefined;
    if (o.mode === "pdf") {
      root = o.pageHostRef.current?.querySelector(".textLayer, .react-pdf__Page__textContent");
      doc = document;
    } else {
      doc = o.iframeRef.current?.contentDocument;
      root = doc?.body;
    }
    if (!root || !doc) return null;
    const cached = sourceRef.current;
    if (cached && cached.root === root && cached.version === o.textVersion && root.isConnected) return cached;
    const src = { map: buildTextMap(root), root, doc, version: o.textVersion };
    sourceRef.current = src;
    return src;
  }, []);

  /** Where each on-surface highlight sits in the current text. */
  const anchoredRef = useRef(new Map<string, { start: number; end: number }>());
  const freshRef = useRef(new Set<string>());
  const overlayRef = useRef<HighlightOverlay | null>(null);
  const [paintTick, setPaintTick] = useState(0);

  // ── Painting ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const src = getSource();
    const anchored = new Map<string, { start: number; end: number }>();
    const items: Array<{ id: string; range: Range }> = [];
    if (src) {
      for (const h of all) {
        if (!onSurface(h)) continue;
        const at = anchorInText(src.map.text, h);
        if (!at) continue;
        anchored.set(h.id, at);
        const range = src.map.rangeFor(at.start, at.end);
        if (range) items.push({ id: h.id, range });
      }
    }
    anchoredRef.current = anchored;
    const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary");
    const hue = highlightHue(primary);

    if (mode === "pdf") {
      const host = optsRef.current.pageHostRef.current;
      // No text layer yet means no rendered page to sit next to.
      if (!host || !src) { overlayRef.current?.clear(); return; }
      if (!overlayRef.current || !overlayRef.current.attached) {
        overlayRef.current?.destroy();
        overlayRef.current = new HighlightOverlay(host);
      }
      overlayRef.current.setHue(hue);
      overlayRef.current.render(items, freshRef.current);
    } else if (src) {
      paintHighlight(src.doc, HIGHLIGHT_NAME, items.map((i) => i.range), htmlHighlightCss(hue), USER_HIGHLIGHT_PRIORITY, htmlForcedColorsCss);
    }
  }, [all, onSurface, mode, textVersion, paintTick, getSource]);

  // A page turn: clear the old page's marks before the new text layer lands.
  useEffect(() => {
    overlayRef.current?.clear();
  }, [page, bookId]);

  // PDF marks are positioned boxes: re-place them when the page box resizes.
  useEffect(() => {
    if (mode !== "pdf") return;
    const host = opts.pageHostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setPaintTick((n) => n + 1));
    });
    ro.observe(host);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [mode, opts.pageHostRef]);

  useEffect(() => () => {
    overlayRef.current?.destroy();
    overlayRef.current = null;
  }, []);

  // ── Chapter locator (best effort, after the save) ───────────────────────
  const attachChapterLocator = useCallback(async (h: BookHighlight, sectionIndex: number | null) => {
    const o = optsRef.current;
    const b = o.book;
    if (!b || b.id !== h.book_id) return;
    const candidates = h.page != null
      ? b.chapters.filter((c) => h.page! >= c.startPage && h.page! <= c.endPage)
      : b.chapters.filter((c) => sectionIndex != null && c.startPage === sectionIndex);
    for (const chapter of candidates) {
      let text = chapter.textContent || "";
      if (!text) {
        const r = await o.loadChapterTextStrict(chapter.id);
        if (!r.ok) continue;
        text = r.text || "";
      }
      const hit = text ? anchorQuote(text, h.quote) : null;
      if (!hit) continue;
      const charEnd = Math.min(text.length, Math.max(hit.end, hit.start + h.quote.length));
      await highlightStore.update(h.book_id, h.id, { chapter_id: chapter.id, char_start: hit.start, char_end: charEnd }).catch(() => {});
      return;
    }
  }, []);

  // ── Creating from the selection ─────────────────────────────────────────
  /** The highlight made from the selection still on screen: adjusting the
   *  selection's handles replaces it instead of piling up marks. */
  const sessionIdRef = useRef<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState(false);

  const readSelection = useCallback(() => {
    const src = getSource();
    if (!src) return null;
    const sel = src.doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.intersectsNode(src.root)) return null;
    const start = src.map.boundaryOffset(range.startContainer, range.startOffset);
    const end = src.map.boundaryOffset(range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return null;
    const selector = quoteSelector(src.map.text, start, end);
    if (!selector || !isHighlightWorthy(selector.quote)) return null;
    return { src, selector, range };
  }, [getSource]);

  const commitSelection = useCallback(async (): Promise<boolean> => {
    const o = optsRef.current;
    const b = o.book;
    const found = readSelection();
    if (!b || !found) return false;
    const { src, range } = found;
    let { selector } = found;

    const sessionId = sessionIdRef.current;
    const session = sessionId ? highlightStore.get(b.id).find((h) => h.id === sessionId) : undefined;
    if (session && session.pos_start === selector.pos_start && session.pos_end === selector.pos_end) return true;

    const others = [...anchoredRef.current.entries()]
      .filter(([id]) => id !== sessionId)
      .map(([id, r]) => ({ id, ...r }));
    const merged = mergeRange(others, selector.pos_start, selector.pos_end);
    if (merged.absorbed.length > 0) {
      selector = quoteSelector(src.map.text, merged.start, merged.end) ?? selector;
    }

    let sectionIndex: number | null = null;
    if (o.mode === "html") {
      const sections = Array.from(src.doc.querySelectorAll("[id^='section-']"));
      for (const el of sections) {
        // The last section that starts before the selection does.
        if (range.comparePoint(el, 0) < 0) {
          const n = Number(el.id.slice("section-".length));
          if (Number.isInteger(n)) sectionIndex = n;
        }
      }
    }

    const replaced = [...merged.absorbed, ...(session ? [session.id] : [])];
    try {
      const created = await highlightStore.add({
        book_id: b.id,
        page: o.mode === "pdf" ? o.page : null,
        ...selector,
      });
      sessionIdRef.current = created.id;
      freshRef.current.add(created.id);
      window.setTimeout(() => freshRef.current.delete(created.id), FRESH_MS);
      if (replaced.length > 0) await highlightStore.remove(b.id, replaced).catch(() => {});
      void attachChapterLocator(created, sectionIndex);
      if (!session) {
        const sessionOnly = highlightStore.storage === "session";
        toast(sessionOnly ? "Highlighted (this session only)" : "Highlighted — saved for chat", {
          id: "reader-highlight",
          description: sessionOnly ? "Highlights will be kept once the database update is applied." : undefined,
          duration: 4000,
          action: {
            label: "Undo",
            onClick: () => {
              const id = sessionIdRef.current ?? created.id;
              sessionIdRef.current = null;
              highlightStore.remove(b.id, [id]).catch((e) => toast.error(e?.message || "Couldn't undo."));
            },
          },
        });
      }
      return true;
    } catch (e: any) {
      toast.error(e?.message || "Couldn't save the highlight.");
      return false;
    }
  }, [readSelection, attachChapterLocator]);

  // Selection lifecycle: settle-debounce (phones' handle drags fire only
  // selectionchange), immediate on pointer release, never mid mouse-drag.
  useEffect(() => {
    const doc = mode === "pdf" ? document : opts.iframeRef.current?.contentDocument;
    const surface: EventTarget | null | undefined = mode === "pdf" ? opts.pageHostRef.current : doc;
    if (!doc || !surface || !bookId) return;
    let timer = 0;
    let mouseDown = false;
    const settle = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const worthy = !!readSelection();
        setPendingSelection(worthy);
        if (!worthy) {
          const sel = doc.getSelection();
          if (!sel || sel.isCollapsed) sessionIdRef.current = null;
          return;
        }
        if (optsRef.current.autoHighlight && !mouseDown) void commitSelection();
      }, delay);
    };
    const onSelectionChange = () => { if (!mouseDown) settle(SELECTION_SETTLE_MS); };
    const onDown = (e: Event) => {
      if ((e as PointerEvent).pointerType === "mouse") mouseDown = true;
    };
    const onUp = () => {
      mouseDown = false;
      settle(60);
    };
    doc.addEventListener("selectionchange", onSelectionChange);
    surface.addEventListener("pointerdown", onDown);
    // pointerup can land outside the page when a drag overshoots.
    const upTarget: EventTarget = mode === "pdf" ? window : doc;
    upTarget.addEventListener("pointerup", onUp);
    upTarget.addEventListener("touchend", onUp);
    return () => {
      window.clearTimeout(timer);
      doc.removeEventListener("selectionchange", onSelectionChange);
      surface.removeEventListener("pointerdown", onDown);
      upTarget.removeEventListener("pointerup", onUp);
      upTarget.removeEventListener("touchend", onUp);
    };
  }, [mode, bookId, textVersion, opts.iframeRef, opts.pageHostRef, readSelection, commitSelection]);

  // ── Tapping a highlight ─────────────────────────────────────────────────
  useEffect(() => {
    if (readAlongActive) return; // read-along's tap-to-jump owns taps
    const doc = mode === "pdf" ? document : opts.iframeRef.current?.contentDocument;
    const target: EventTarget | null | undefined = mode === "pdf" ? opts.pageHostRef.current : doc;
    if (!doc || !target) return;
    const onClick = (e: Event) => {
      const me = e as MouseEvent;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const src = getSource();
      const caret = caretFromPoint(doc, me.clientX, me.clientY);
      if (!src || !caret) return;
      const off = src.map.boundaryOffset(caret.node, caret.offset);
      if (off < 0) return;
      let hitId: string | null = null;
      for (const [id, r] of anchoredRef.current) {
        if (off >= r.start && off < r.end) { hitId = id; break; }
      }
      const highlight = hitId ? highlightStore.get(optsRef.current.book?.id).find((h) => h.id === hitId) : undefined;
      const at = hitId ? anchoredRef.current.get(hitId) : undefined;
      const range = at ? src.map.rangeFor(at.start, at.end) : null;
      if (!highlight || !range) return;
      // Confirm the tap is on the mark itself, not just near its caret.
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      const inside = rects.find((r) => me.clientX >= r.left - 4 && me.clientX <= r.right + 4 && me.clientY >= r.top - 4 && me.clientY <= r.bottom + 4);
      if (!inside) return;
      e.stopImmediatePropagation();
      e.stopPropagation();
      const frame = mode === "html" ? optsRef.current.iframeRef.current?.getBoundingClientRect() : null;
      const first = rects[0];
      const rect = new DOMRect(first.left + (frame?.left ?? 0), first.top + (frame?.top ?? 0), first.width, first.height);
      optsRef.current.onTapHighlight({ highlight, rect });
    };
    target.addEventListener("click", onClick, true);
    return () => target.removeEventListener("click", onClick, true);
  }, [mode, readAlongActive, textVersion, opts.iframeRef, opts.pageHostRef, getSource]);

  const remove = useCallback(async (h: BookHighlight) => {
    if (sessionIdRef.current === h.id) sessionIdRef.current = null;
    try {
      await highlightStore.remove(h.book_id, [h.id]);
      toast("Highlight removed", {
        id: "reader-highlight",
        duration: 4000,
        action: {
          label: "Undo",
          onClick: () => {
            const { id: _id, created_at: _c, ...rest } = h;
            highlightStore.add(rest).catch((e) => toast.error(e?.message || "Couldn't restore it."));
          },
        },
      });
    } catch (e: any) {
      toast.error(e?.message || "Couldn't remove the highlight.");
    }
  }, []);

  const pageCount = all.filter(onSurface).length;
  return { commitSelection, pendingSelection, remove, pageCount, total: all.length, autoHighlight };
}
