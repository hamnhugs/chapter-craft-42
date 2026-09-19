import { useCallback, useState } from "react";

/**
 * Reader preferences and per-book position, device-local in localStorage.
 * Every access is guarded: storage can be blocked or throw (private mode,
 * cleared site data), and the reader must work the same without it.
 */

export type ZoomSetting = "fit" | number;

const ZOOM_KEY = "cc_reader_zoom";
const SWIPE_KEY = "cc_reader_swipe";
const AUTO_HIGHLIGHT_KEY = "cc_reader_auto_highlight";
const pageKey = (bookId: string) => `cc_reader_page_${bookId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference just won't persist */
  }
}

export function loadLastPage(bookId: string): number {
  const n = Number(read(pageKey(bookId)));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function saveLastPage(bookId: string, page: number) {
  write(pageKey(bookId), String(page));
}

export function useReaderPrefs() {
  const [zoom, setZoomState] = useState<ZoomSetting>(() => {
    const raw = read(ZOOM_KEY);
    const n = Number(raw);
    return raw && raw !== "fit" && n >= 0.5 && n <= 3 ? n : "fit";
  });
  const [swipeEnabled, setSwipeState] = useState(() => read(SWIPE_KEY) !== "off");

  const setZoom = useCallback((z: ZoomSetting) => {
    setZoomState(z);
    write(ZOOM_KEY, String(z));
  }, []);
  const setSwipeEnabled = useCallback((on: boolean) => {
    setSwipeState(on);
    write(SWIPE_KEY, on ? "on" : "off");
  }, []);

  const [autoHighlight, setAutoHighlightState] = useState(() => read(AUTO_HIGHLIGHT_KEY) !== "off");
  const setAutoHighlight = useCallback((on: boolean) => {
    setAutoHighlightState(on);
    write(AUTO_HIGHLIGHT_KEY, on ? "on" : "off");
  }, []);

  return { zoom, setZoom, swipeEnabled, setSwipeEnabled, autoHighlight, setAutoHighlight };
}
