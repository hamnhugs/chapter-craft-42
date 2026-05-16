## Problem

In the Chat tab, when Settings is open on mobile, the lower section (Deep Research model + Voice Playback Speed slider) is cut off behind the message area / input bar / bottom nav. The settings panel renders inline and isn't independently scrollable, so users can't reach the TTS speed control.

## Fix (frontend-only, ChatPanel.tsx)

Make the settings panel a self-contained, vertically-scrollable region on mobile, and tighten its mobile layout so more fits on screen before scrolling is needed.

1. **Scrollable container** — wrap the settings panel in a `max-h-[60vh] overflow-y-auto overscroll-contain` region on mobile (uncapped on `md+`). Keep the existing `border-b` and background.
2. **Sticky mini-header inside the panel** — small "Settings" title with a close (✕) button pinned to the top of the scroll area, so users always see how to dismiss it without scrolling back up.
3. **Mobile spacing pass** — reduce vertical padding on mobile (`py-3` instead of `py-4`), collapse the nested `p-4` rounded sections to `p-3` on mobile, and ensure the two `grid` sections stack cleanly (already `grid-cols-1` by default).
4. **Safe-area padding** — add `pb-[env(safe-area-inset-bottom)]` to the scroll container so the last control (TTS slider) clears the bottom nav on iOS.
5. **Keep desktop unchanged** — all overrides use `md:` breakpoints to preserve the current desktop layout.

No business logic, no state changes, no new dependencies — purely layout/CSS adjustments in `src/components/ChatPanel.tsx`.

## Verification

- Open Chat tab → tap settings → confirm TTS speed slider is reachable by scrolling within the panel.
- Confirm desktop layout (md+) is visually unchanged.
- Confirm input bar and bottom nav still work while settings is open.
