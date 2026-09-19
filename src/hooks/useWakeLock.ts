import { useEffect } from "react";

type WakeLockSentinelLike = { release(): Promise<void>; released?: boolean };
type NavigatorWithWakeLock = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };

/**
 * Keeps the screen on while `active` (Screen Wake Lock API). The browser drops
 * the lock whenever the page is hidden, so it is re-requested on return.
 * Unsupported or refused (battery saver): silently a no-op.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    const nav = navigator as NavigatorWithWakeLock;
    if (!active || !nav.wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      try {
        const s = await nav.wakeLock!.request("screen");
        if (cancelled) s.release().catch(() => {});
        else sentinel = s;
      } catch {
        /* refused: the screen may dim as usual */
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
    };
  }, [active]);
}
