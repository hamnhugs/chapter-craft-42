## Goal
Let the user collapse the Voice page bottom controls downward to reclaim screen space, with a polished animation that feels great on both desktop and mobile. Nothing existing is removed.

## Changes (all in `src/components/VoiceChat.tsx`)

1. **State**
   - Add `const [controlsCollapsed, setControlsCollapsed] = useState(false);`
   - Persist preference in `localStorage` (`voice_controls_collapsed`) so it sticks across sessions.

2. **Collapse handle (always visible)**
   - Add a slim, centered grab-handle bar above the controls panel:
     - Small pill (`w-12 h-1.5 rounded-full bg-on-surface-variant/30`) inside a tappable header row (`h-7`, full width, centered).
     - Click toggles `controlsCollapsed`.
     - `aria-expanded`, `aria-controls`, and a chevron icon (`expand_more` / `expand_less`) that rotates 180° via `transition-transform duration-300`.
     - Tooltip: "Hide controls" / "Show controls".

3. **Animated collapse**
   - Wrap the existing controls block (the flex row of buttons + status `<p>`) in a container that animates:
     - `grid-template-rows` trick for smooth height animation without measuring: outer `<div className="grid transition-[grid-template-rows,opacity] duration-300 ease-out" style={{ gridTemplateRows: collapsed ? '0fr' : '1fr', opacity: collapsed ? 0 : 1 }}>` with inner `<div className="overflow-hidden">…controls…</div>`.
     - Adds `translate-y` + `opacity` on inner content for a soft downward slide-out feel (`transition-transform duration-300`, `translate-y-2` when collapsed).
   - When collapsed, panel shows only the handle row → minimal footprint, more room for messages.

4. **Collapsed mini-bar (preserves access)**
   - When collapsed, render a compact inline row beside the handle: just the **mic button** (smaller, `w-12 h-12`) so the user can still talk without expanding. This keeps the core feature one tap away.
   - All other controls remain reachable by tapping the handle to expand.

5. **Mobile polish**
   - Increase handle hit area on touch (`py-3` on the header) so it's easy to grab.
   - Add a subtle swipe-down gesture on the handle row using `onTouchStart`/`onTouchEnd` (delta > 30px down collapses, up expands). Falls back to tap.
   - Respect `prefers-reduced-motion`: disable the transform/opacity transition when set (use `motion-safe:` Tailwind variants).

6. **Interim transcript bar**
   - Keep it above the controls panel; unaffected by collapse.

## Out of scope
- No changes to mic logic, STT, TTS, hands-free, notes panel, settings, deep research, save-to-wiki, clear chat, or any backend.
- No restructuring of the messages area.

## Verification
- Toggle collapse on desktop and mobile viewports; confirm smooth animation, persisted state, mic still works when collapsed, all controls return when expanded.
