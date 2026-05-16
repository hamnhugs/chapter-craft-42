## Fix: Voice Notes panel should overlay, not claim layout space

**Problem:** On the Voice page, `VoiceNotesPanel` is rendered as a sibling of the chat column inside a `flex` row. On desktop (`md+`) the panel uses `md:relative`, so when opened it pushes/shrinks the chat area into its own dedicated column. The user wants it to slide in over the content like a drawer at all breakpoints.

**Change (presentation only, 1 file):**

`src/components/VoiceNotesPanel.tsx`
- Drop the `md:relative` / `md:z-auto` / `md:shadow-none` modifiers on the `<aside>` so it stays `fixed top-0 right-0 h-full z-50 shadow-xl` at every breakpoint.
- Remove the `md:hidden` on the backdrop overlay so the dim backdrop also appears on desktop when `open` is true (click to close preserved).
- Keep width classes (`w-[88vw] sm:w-96 md:w-80 lg:w-96`) and the `translate-x` open/close animation exactly as-is.
- Keep `shrink-0` (harmless now that it's fixed) or drop it — no behavior change either way.

**Not changed:** `VoiceChat.tsx` layout, all notes CRUD, long-press-to-save, persistence key, toast behavior, panel state, props API. No other pages use this panel, so no side effects.

**Verify:** Open Voice tab → click "Notes" toggle → panel slides in from right over the chat without resizing it; backdrop dims the page; clicking backdrop or the chevron closes it. Mobile behavior unchanged.