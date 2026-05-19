## Wiki Tab Controls Guide

Add a pulsing "What do these controls do?" chip in the Wiki tab header (matching the Wikis-tab memory link) that opens a new `/wiki-controls-guide` page explaining every control in plain language.

### 1. New route + page

- Add `/wiki-controls-guide` route in `App.tsx` (protected, same pattern as `/memory-guide`).
- Create `src/pages/WikiControlsGuide.tsx` styled like `MemoryGuide.tsx` (editorial, warm tones, sticky back bar saying "Back to Wiki").

### 2. Plain-English explanations

Group controls into sections. For each, a one-line analogy + 2–3 sentences of "what it does / when to use it." No jargon.

**Scope & identity**
- **This wiki vs. All wikis** — "Are you looking at one notebook, or every notebook stacked together?" Pick "This wiki" for focused work; "All wikis" to see everything you've ever saved.
- **Wiki switcher dropdown** — Jump straight to another wiki without leaving this page.

**Daily controls**
- **Conflicts** — Cards that disagree with each other. Click to review and pick the right one. The number badge = how many need your attention.
- **Recording / Retrieval mode** — Recording lets the AI add new cards as you chat. Retrieval is read-only — useful when you just want answers without growing the wiki.

**Maintenance (run occasionally)**
- **Sleep Cycle** — Like sleeping on it. The system links lonely cards, merges duplicates, and tidies the web. Run it after a busy day of adding stuff.
- **Health Check** — Scans for problems (broken links, weird entries) and surfaces them. Run it when things feel off.
- **Reindex** — Rebuilds the search index so semantic search stays accurate. Run if search results feel stale.
- **Refresh** — Reload the page's data from the server.

**Browse what's happened**
- **Episodes** — A diary of past chat sessions. Helps you remember what you talked about.
- **Queue** — Cards waiting in line for the next Sleep Cycle to process.

**Settings (gear icon)**
- Pick the AI model used for this wiki, manage advanced options.

**Filters (in entries list)**
- Filter cards by type: concept, entity, fact, summary, etc.

### 3. Link from `WikiPanel.tsx`

Insert the same animated pulsing chip used on the Wikis page, just below the wiki description line (around line 330). Same component pattern: `HelpCircle` + label + `ArrowRight`, with `animate-pulse-glow` and `animate-icon-wiggle`. Label: **"What do these controls do?"**

### Files touched
- `src/App.tsx` — add route.
- `src/pages/WikiControlsGuide.tsx` — new page.
- `src/components/WikiPanel.tsx` — add the chip link.

No features removed. No backend changes.
