/**
 * Focus policy — the single helper through which the composer may ever be
 * programmatically focused.
 *
 * Why it exists: Android Chrome opens the soft keyboard on ANY programmatic
 * focus() once a user gesture has happened in the session (documented Chromium
 * intervention policy) — so an after-reply refocus pops the keyboard on every
 * AI response. iOS ignores async focus, which masked the bug there. WCAG 2.2
 * (4.1.3 Status Messages, 3.2.1, 2.4.3) says async content must arrive
 * without moving focus. Focus therefore moves only on explicit user intent —
 * or, on fine-pointer desktops only, as a convenience the caller gates.
 */

export function isTouchPrimary(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export interface FocusComposerOpts {
  /** The call is running synchronously inside a real user gesture handler. */
  fromUserGesture?: boolean;
  /** Hands-free voice mode is on — never present the keyboard. */
  handsFreeActive?: boolean;
}

/** Returns true when focus was applied. Silently refuses when policy says no. */
export function focusComposer(el: HTMLElement | null, opts: FocusComposerOpts = {}): boolean {
  if (!el) return false;
  if (opts.handsFreeActive) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  if (isTouchPrimary() && !opts.fromUserGesture) return false;
  if (import.meta.env.DEV) {
    const ua = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
    if (ua && !ua.isActive && opts.fromUserGesture) {
      console.warn("[focusPolicy] fromUserGesture claimed but userActivation is inactive — this focus() would open the Android keyboard unprompted.");
    }
  }
  el.focus({ preventScroll: true });
  return true;
}
