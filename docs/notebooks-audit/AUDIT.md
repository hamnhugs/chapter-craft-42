# Notebooks tab usability audit — 2026-10-20

Read-only audit (4 agents: list-page code, open-notebook code, live screenshots, UX research). No code changed yet.
Screenshots: `shots/` (956-* and 476-* = viewport width; e.g. 956-20-list.png, 476-10-first-tap-notebooks-opens-active-notebook.png).
Files: list = src/components/WikiLibrary.tsx, open notebook = src/components/WikiPanel.tsx, routing = src/pages/Index.tsx (:201-210, :313-316).
Line numbers below are as of 2026-10-20; re-verify before editing.

## Root problem
Three concepts tangled across 4 surfaces (list page, ⌘K WikiQuickSwitcher, ChatPanel chips, LoadNeuronDialog):
1. viewing a notebook, 2. loading it into Counsel (primary/secondary = where notes save), 3. saved sets (ChainDialog).
Opening from the list calls setActiveWiki → applyActiveSet([id]) (AppContext.tsx:430-434), so viewing changes Counsel's loaded set.

## Findings
- List: 0 notebooks visible above the fold at 956x506 and 476x506 (first card y≈508/486). 18+ controls first: eyebrow badge + count + H2 (title x3), 2-line subtitle, pulsing "How notes work" pill (328-335), admin Mine/Everyone (340-357), compact/gallery toggle (360-383), MASTERS (387-394, DEAD: panel never rendered, import :5, state :73), IMAGES (396-403, only entry to ImagesPanel — rehome first), NEW NOTEBOOK, search, 11 tag pills (467-493).
- Gallery card (758-820) ≈400x270: empty 96px color band, all-caps name/desc/meta/tags, "ACTIVE" pill + ring. Short cards vertically centered (button default) → gap bug. Compact tile (721-756) denser but not default; view mode not persisted.
- Click inconsistency: active card opens directly; others open info dialog (542-628; 138-149). At 476 the dialog shows Delete first, Open cut off.
- Nav "Notebooks" lands inside active notebook, not list (Index.tsx setActiveTab(activeWiki ? "wiki" : "wikis")). At 476, Notebooks hidden under "More".
- Open notebook: ~390px chrome before first note; at 476 none visible. Scope chips/★/+Add notebook/Save as set/This-Open-Everything toggle (805-886), "Saving notes to X" pill (889-915), 7 type filters (67-75, 971-992), List/Map (993-1025, three.js EntryNeuronGraph w/ sound/thunder). Note cards ~200-230px; "p. N" not clickable (1075-1083); "Open page" buried at bottom of detail (1253-1260). Book anchors (EntryLocatorPanel) duplicates "Why this is here" (1225-1268).
- ⋯ menu: Tidy up now/Recent tidy-ups/Health check/Conflict history/Refresh/How notes work (743-799); overflows bottom nav at 476. Lint view 1272-1381, runs view 1446-1474. Conflicts: Acknowledge/Mark Resolved/Dismiss near-synonyms (1437-1439), raw badges (1393-1394).
- "+ Add notebook" opens ⌘K where row click REPLACES loaded set (WikiQuickSwitcher.tsx:120-131) — bug-level. ⌘K also mixes in Prompts group (257-282), META/PRIMARY badges.
- Jargon leaks: "My 1st Neuron", "Entries" vs "notes" (565), "Last loaded"/"Active"/"open" for same thing, `Loaded "neuron"` toast fallback (WikiQuickSwitcher.tsx:131,155,157), "Save saved set" (ChatPanel.tsx:1186), relation slugs relates_to (1216), "migration applied?" toast (842). System notebooks (Toolshed, Copy & Design Masters) shown as user notebooks — fetchWikis doesn't filter (lib/wikisApi.ts:22-30). Card says 25 notes, open view says 23.
- LoadNeuronDialog (on every Vault book load, AppContext.tsx:1245-1253): "alongside" used for two meanings (:179 vs :318).
- Dead code: Switch import (WikiLibrary :18), formIsMeta, requestSettingsSection import (WikiPanel :49).

## Research (NN/g cards-component, progressive-disclosure, aesthetic-minimalist; Material list specs; Anki/Readwise patterns)
Homogeneous items → list, not cards. ≤2 disclosure levels. Rows ~56-64px two-line. Recall as a due count (Anki), not content in list. Secondary actions in ⋯ (also right-click), never destructive at top level.

## Proposed design
List: one header row (Notebooks · search · + New). ~56px rows: color dot, name, "14 notes · 3 due", ⋯ (Rename, Delete). Row click always opens (view only, no setActiveWiki). Nav always lands on list. Empty state gets a +New button + one-line idea. Hide system notebooks. Search results rows open the note.
Notebook: one header line (back, title, count, Daily recall · N, ⋯ = Rename/color, Delete, How notes work). Search → note rows (title, summary, clickable p. N). Detail: text, Open page under title, Edit/Forget, collapsed More (tags/related/images). Conflicts = badge + Keep A / Keep B / Both are fine.
Cut: gallery+toggle, tag pills, info dialog, type filters, map, health check/tidy/runs/refresh menu items (nightly tidy stays; Undo in toast), MASTERS. Move: IMAGES → DesignCraft/Settings; Mine/Everyone → Admin; load/primary/saved sets → Counsel chip row only.
~30 controls → ~8.

## Plan (all three steps done 2026-10-20)
1. List page. 2. Notebook view. 3. ⌘K + LoadNeuronDialog alignment + wording fixes.
Open question to Manny: keep any of map / tags / health check? (recommendation: cut all three)

## Progress
Manny's answer (2026-10-20): cut map, tags and health check.

**Step 1 (list page) — done 2026-10-20.** Screenshots: `shots/step1/`.
- WikiLibrary.tsx rewritten: one header row (Notebooks · search · + New), 56px rows (dot, name, "N notes · N to review", ⋯ / right-click = Rename or recolor…, Delete…). Cut: gallery/compact toggle, tag pills, info dialog, MASTERS, IMAGES, Mine/Everyone (Admin → Notebooks already covers it), eyebrow/subtitle/How-notes-work pill, tags field in create/edit.
- Row click = `openNotebook(id)` (new in AppContext: `viewedWikiId`); Counsel's loaded set untouched (verified in the screenshot run). Every other way into the notebook view clears viewedWikiId and shows the loaded set as before.
- Index.tsx: nav "Notebooks" always lands on the list.
- wikisApi: `isSystemWiki` (Toolshed, Copy & Design Masters) hidden from list and search; counts exclude superseded notes (fixes 25 vs 23); `due_count` = next_review_at <= now (all null in DB today, so no due badges show yet).
- IMAGES moved to Settings → image models ("View all generated images").
- Not rebuilt: Manny's :8080 is `vite preview` of dist/; screenshots came from a dev server on :8091.

## Research follow-up (2026-10-20, after the web limit reset)
Verified: Anki deck list = per-deck New/Learn/Due counts, gear on the right for rename/delete/options/export, click deck → study screen (docs.ankiweb.net/studying.html). Hick's law wording (lawsofux.com/hicks-law). Readwise Daily Review mixes the whole library weighted by each book's share of highlights, tunable per book/source; default count NOT stated (the earlier "15" is unverified). Apple 44×44pt minimum for touch confirmed (developer.apple.com/design/tips).
Not confirmed: the "28×28pt macOS" figure (no source found — drop it). M3 one-line 56dp (m3.material.io page didn't render; Flutter's ListTile 56/72/88 remains the checked source). No NN/g article on hover-only actions found; WCAG "visible controls" draft + KDE design discussions say hover-only controls hurt discoverability and don't exist on touch — so the row ⋯ stays always visible (as built).
Still unchecked: NotebookLM home layout, Apple Notes/Bear/Things/Notion sidebar details (low impact).

**Step 2 (notebook view) — done 2026-10-20.** Screenshots: `shots/step2-3/` (10-17).
- WikiPanel.tsx rewritten: always ONE notebook (viewedWikiId, else Counsel's primary). One header line: back · dot · name · count (≥sm) · conflicts badge · Daily recall · N · ⋯ (Rename or recolor…, How notes work, Delete notebook…). Search → 56px note rows (title, summary, clickable p. N).
- Note: title, Edit/Forget, "Open page N of …" under the title, text, collapsed More (why this is here + page list + Find in book, related notes with plain relationship words, tags, images). EntryLocatorPanel got `assistOnly` so the page list isn't shown twice.
- Conflicts ("Notes to check"): open ones only, Keep A / Keep B / Both are fine. Real kinds are contradicts|refutes|supersedes|overlaps — the old "duplicate/overlap" check never matched, so its keep button never showed.
- Cut: map (EntryNeuronGraph.tsx deleted), 7 type filters, loaded-set chips/+Add notebook/Save as set/This-Open-Everything, Saving-notes-to pill, health check, tidy now, recent tidy-ups, refresh, conflict history.
- Nightly tidy (useAutoSleepCycle) now toasts what it changed with Undo (15s). MemoryGuide text updated.
- NotebookFormDialog.tsx: shared create/rename dialog + deleteNotebookWithConfirm.

**Step 3 (⌘K, Counsel chips, LoadNeuronDialog, wording) — done 2026-10-20.** Screenshots 20-22.
- ⌘K: Prompts group removed (PromptSwitcher in Counsel tools covers it; ChatContext inits the store). Counsel's "+" chip opens ⌘K in add mode (row click adds instead of replacing — the bug). Badges: Saves here / In use; Meta badge gone; system notebooks hidden unless in use. Toasts say "Counsel is now using / also using / stopped using".
- Counsel chips: "saves here", "Stop using", "Save as set". Header chip tooltip "Counsel is using: …".
- LoadNeuronDialog: "Which notebook should Counsel use with X?"; "Open alongside" → "Just open it" with matching explanation; system notebooks hidden; "current" → "in use".
- Left as user data: notebook names like "My 1st Neuron" (rename via ⋯).
