## Voice Notes side panel

Add a collapsible **Voice Notes** panel to the Voice tab with a simple list of notes you can append, edit, and delete. Notes are captured from chat messages.

### Behavior

- A **toggle button** in the Voice tab header expands/collapses a side panel (slides in from the right on desktop, slides up as a sheet on mobile).
- Panel shows a scrollable list of notes (newest on top). Each note has: text, timestamp, edit, and delete buttons.
- A **"+ Add note"** button at the top lets you type a note manually.
- **Capture from chat:**
  - **Desktop:** small "Save to notes" icon appears on each chat bubble on hover.
  - **Mobile:** **press-and-hold (~500ms)** on any chat bubble appends that bubble's text as a new note, with a brief haptic + toast confirmation ("Saved to notes").
- Notes persist in **localStorage** (per browser, instant, no backend setup). Clear-all button at the bottom of the panel.
- Panel state (open/closed) is remembered between sessions.

### Files touched

- `src/components/VoiceChat.tsx` — add panel UI, toggle button, long-press handler on message bubbles, hover save button, note CRUD against localStorage.
- No backend, no migrations, no other components affected.

### Out of scope

- Syncing notes across devices or to the existing Notes Library (kept separate so the Voice scratchpad stays fast and private).
- Editing inside chat bubbles, or formatting/markdown in notes (plain text only).
