import { useCallback, useEffect, useRef, useState } from "react";

const STATE_KEY = "ccReaderFocus";

/**
 * Focus mode for the reader: just the page. Entering pushes a history entry
 * so Android's back gesture (and the browser back button) leaves focus mode
 * instead of the app, and asks for real fullscreen where the browser allows
 * it (Chrome on Android / the TWA hides the system bars). Leaving fullscreen
 * any other way (Esc, system gesture) also leaves focus mode.
 */
export function useReaderFocus() {
  const [focused, setFocused] = useState(false);
  const pushedRef = useRef(false);
  const fullscreenRef = useRef(false);

  const leaveFullscreen = () => {
    fullscreenRef.current = false;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };

  const enter = useCallback(() => {
    if (focused) return;
    setFocused(true);
    try {
      history.pushState({ ...(history.state ?? {}), [STATE_KEY]: true }, "");
      pushedRef.current = true;
    } catch {
      pushedRef.current = false;
    }
    const root = document.documentElement;
    if (root.requestFullscreen && !document.fullscreenElement) {
      root.requestFullscreen({ navigationUI: "hide" })
        .then(() => { fullscreenRef.current = true; })
        .catch(() => { /* not allowed here (iOS, iframes): focus mode still works */ });
    }
  }, [focused]);

  const exit = useCallback(() => {
    if (!focused) return;
    leaveFullscreen();
    if (pushedRef.current && history.state?.[STATE_KEY]) {
      // popstate below finishes the exit, keeping history balanced.
      history.back();
      return;
    }
    pushedRef.current = false;
    setFocused(false);
  }, [focused]);

  useEffect(() => {
    if (!focused) return;
    const onPop = () => {
      if (history.state?.[STATE_KEY]) return;
      pushedRef.current = false;
      leaveFullscreen();
      setFocused(false);
    };
    const onFullscreen = () => {
      if (document.fullscreenElement || !fullscreenRef.current) return;
      fullscreenRef.current = false;
      exitRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      // Esc closes an open menu or dialog first, not focus mode.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role='menu'], [role='dialog'], [role='alertdialog']")) return;
      exitRef.current();
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("keydown", onKey);
    };
  }, [focused]);

  const exitRef = useRef(exit);
  exitRef.current = exit;

  // Leaving the reader while focused (tab switch, unmount): tidy up.
  useEffect(() => () => {
    if (fullscreenRef.current) leaveFullscreen();
    if (pushedRef.current && history.state?.[STATE_KEY]) history.back();
  }, []);

  return { focused, enter, exit, toggle: focused ? exit : enter };
}
