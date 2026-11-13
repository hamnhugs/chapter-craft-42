# Read tab usability audit — 2026-11-13

Branch `new1`. Read-only audit: no reader code changed. Two dev-only edits were made so the reader can be looked at without signing in (`#/arena-lab?reader`, `&html` for an HTML book; `AppContext` is now exported for it).

Files: reader = `src/components/PdfViewer.tsx`, read-along = `src/components/ReadAlong.tsx`, highlight menu = `src/components/HighlightActions.tsx`, swipe rules = `src/lib/readerGestures.ts`, focus mode = `src/hooks/useReaderFocus.ts`, shell/dock = `src/pages/Index.tsx` + `src/styles/arena.css`.
Line numbers are as of 2026-11-13; re-verify before editing.

Screenshots: `shots/<size>-<n>-<state>.png`, measurements in `shots/metrics.json`, capture script `shoot.mjs` (needs `npx vite --port 8093`).
Kept in the repo at half resolution: phone-360, desk-956, desk-476 (before and after). The other sizes are in `metrics.json` and can be re-shot with the script.
Sizes: phone-360 (360×740), phone-412 (412×915), phone-land (740×360), tablet-port (800×1280), tablet-land (1280×800), desk-956 (956×506), desk-476 (476×506), desk-1440 (1440×900).
States: 1 default, 2 options menu, 3 toolbar scrolled to its end, 4 chapter isolation started + chapter picked, 5 read-along pressed, 6 text selected, 7 focus mode.

Not captured: the read-along dock while playing (headless Chromium has no voice, it stops at once) — that part is from code. The red "invalid input syntax for type uuid" toast in shots 6–7 is the lab's fake book id, not an app bug. Nothing was tested on a real Android device.

## Root problem

The reader shows every tool at once, at the same level, in four stacked bands, and the loudest control is the rarest one.

1. **Four bands of chrome around the page**: app bar, page bar, tool bar, dock.
2. **12 controls in the default state**, up to 21 with read-along playing, spread over 3 fixed bars and up to 4 floating layers.
3. **No hierarchy by frequency.** Turning the page and "listen" are the daily actions. "Chapter Isolation" (a rare authoring action) is the only solid-filled button on the screen.
4. **On a phone the bar does not fit**, so more than half the tools are off-screen to the right.

## Measured

| Size | Chrome (bars + dock) | Left for the page | Tool bar content vs. window |
|---|---|---|---|
| phone 360×740 | 238px = 32% | 503px | 817px in 358px |
| phone 412×915 | 238px = 26% | 678px | 817px in 410px |
| phone landscape 740×360 | 198px = 55% | 163px | 809px in 738px |
| tablet portrait 800×1280 | 238px = 19% | 1043px | 809px in 798px |
| tablet landscape 1280×800 | 238px = 30% | 563px | fits |
| desktop 956×506 | 198px = 39% | 309px | fits; 989px in 954px once isolation starts |
| half-tile 476×506 | 198px = 39% | 309px | 793px in 474px |
| desktop 1440×900 | 238px = 26% | 663px | fits |

## Findings — phone (Android)

- **P1. Over half the tool bar is hidden.** At 360 wide you see Read Along, Focus and "− Fit"; zoom-in, options, Isolate, chapter jump and manage chapters are off to the right (shots phone-360-1 vs -3). The only hint is a fade on the right edge. With isolation started the row grows to 997px — nearly three screens wide. PdfViewer.tsx:519.
- **P2. Page arrows are in the top corners** (:499-505), the hardest place to reach one-handed, for the most frequent action. Swipe exists but is deliberately strict (readerGestures.ts: 30% of the width or a fast flick, not from the edges) and is explained only inside the options menu (:599).
- **P3. The page is unreadable at "Fit".** A letter page fitted to 344px wide gives body text about 5px tall (shot phone-360-1). Reading needs zoom, and zoom is ±20% buttons, one of them off-screen. There is no pinch-zoom on the page itself; a zoomed page then needs sideways panning on every line.
- **P4. 32% of the screen is chrome**, and it never gets out of the way unless you find Focus mode — an unlabelled corner-brackets icon (:540-549; the label is hidden below 1280px wide).
- **P5. Focus mode is a second layout to learn**, not a cleaner version of the first. It drops zoom, chapter jump, options and "Save quote" (:781, :792), and shows a read-along player at the bottom even if you never listen (ReadAlong.tsx:790-837). Controls hide only while audio is playing (:302); otherwise a tap on the page toggles them (:307-314). Nothing on screen says so until the helper line at :829.
- **P6. Selecting text has two outcomes the user did not choose.** "Highlight when I select text" is on by default (useReaderPrefs.ts), so selecting to copy makes a highlight. Then a "Save quote to notebook" pill appears in a fixed spot low on the screen (:782), far from the selection, over the text (shot phone-360-6), while Android shows its own Copy/Share bar at the selection. A tapped highlight gets a third, different menu next to the mark (HighlightActions.tsx). Three menus for one job.
- **P7. Floating layers stack over the page bottom**: chapter chip (:823), read-along dock (ReadAlong.tsx:724, about 120px tall, 94% wide), selection pills (:782), toasts. The chip covers the last lines of the page (shot phone-360-5).
- **P8. Read-along controls are doubled.** The tool-bar button turns into Stop while the dock also has Stop; Focus is in the tool bar and in the dock; page position is in the page bar, the dock and the progress hairline. The dock's first row gives level, XP, streak, combo and daily goal more room than the play controls (ReadAlong.tsx:732-757).
- **P9. Small or unlabelled targets.** Zoom, options, manage-chapters are 40px (Android's guideline is 48dp); sleep, speed, voice are 36px tall. Five icon-only controls: Focus, options (tune), manage chapters (gear), a decorative bookmark that looks tappable (:648), sleep. The gear here, the sliders icon beside it and the gear in the app bar all read as "settings".
- **P10. Wording.** "Chapter Isolation"/"Isolate" with a lightning bolt does not say what it does (it saves a page range as a chapter). "Read Along" is preceded by a bare "1" (the level ring) with no explanation. "Tap to jump" is a caption for a control that already looks like a title.

## Findings — desktop and tablet

- **D1. Two bars where one would do.** The page bar holds three things (‹ Page ›) across the full width; the tool bar below it holds the rest. Together 100–118px. At 956×506 the page gets 309px — 61% of the window — and a fitted page is 1154px tall, so one page is almost four screens of scrolling.
- **D2. Scroll down, travel up.** The reader shows one page at a time (:744). At the bottom of a page the only on-screen way forward is the arrow back at the top right. ← → work but are documented only in the options menu (:600). Space, PageDown and the wheel at the page end do nothing to the page number.
- **D3. Same flat hierarchy as the phone.** Left to right: Read Along, Focus, zoom, options, Isolate, chapter jump, manage. Nothing separates "reading" from "listening" from "organising the book". Isolate is the visual anchor.
- **D4. Labels are dropped exactly where Manny works.** Below 1280px wide "Focus" loses its label and "Chapter Isolation" becomes "Isolate" (:548, :619-620) — that covers 956 and 476.
- **D5. The row breaks once isolation starts.** "Started p.2 · End on p.2 · Cancel" pushes it to 989px in a 954px window; the manage-chapters gear is cut off at the right edge (shot desk-956-4).
- **D6. Chapter jump is a native select** 160–224px wide (:649-659): long names truncate, no page numbers, no sign of where you are; picking one adds a floating chip over the page that has to be dismissed (:823-833).
- **D7. Tablet landscape wastes 30%** on bars identical to the desktop's while the dock's four tabs sit in the middle 768px; tablet portrait is the one size where the layout is comfortable (19%).

## Research

Checked this session:
- Icons need visible text labels; hover-only labels fail on touch (nngroup.com/articles/icon-usability).
- Hidden navigation is used less and found later than visible navigation, on phone and desktop (nngroup.com/articles/hamburger-menus). A Wikimedia test found 3 of 5 people could not find items moved from a toolbar into overflow (phabricator T298978) — so what goes behind "More" must be the rarely used things, never the daily ones.
- Progressive disclosure: defer rarely used features to a secondary screen, and get the split right (nngroup.com/articles/progressive-disclosure).
- Phone grip: Hoober's observations of 1,300+ people — one thumb about half the time, the bottom and centre of the screen easiest, top corners hardest (uxmatters.com, 2013; alistapart.com "How We Hold Our Gadgets"). Hoober does not call it a controlled study.
- Touch targets: Android recommends 48×48dp; WCAG 2.2 SC 2.5.8 requires 24×24 CSS px (AA), 2.5.5 asks 44×44 (AAA). Secondary sources only; the primary pages were not opened.
- Kindle app: a tap in the middle of the page shows the bars; side taps turn pages. Sources are help blogs and disagree in places.
- Adobe Liquid Mode reflows a PDF's text for phone screens to remove pinch-and-pan. Product coverage only; no usability study was found.

From general knowledge, not checked this session: Apple Books and Google Play Books also hide all controls while reading and bring them back with a tap; Fitts's law (bigger and nearer targets are faster); Hick's law (more choices, slower choice).

Not found: any study on horizontally scrolling toolbars, or on reader tap-zone sizes.

## Proposed design

One rule: **the page is the screen; one bar; five things on it; everything else one tap down.**

### The one bar (all sizes)

| Slot | What | Replaces |
|---|---|---|
| Contents | Opens a sheet: chapter list with page numbers, current one marked, rename/delete inline, "+ New chapter from pages…" | chapter select, gear, floating chip, Chapter Isolation button, manage dialog |
| Listen | Play. While playing the bar itself becomes the player: back a sentence · pause · forward · speed · ⋯ (voice, sleep timer, stop) | Read Along button, floating dock, focus-mode mini player |
| Page | "2 of 5" — tap to type a page, drag to scrub | page bar, progress hairline, "Tap to jump" |
| View | Zoom − / Fit / +, and on phones "Text view" | zoom pill |
| ⋯ | Swipe on/off, highlight-on-select, full screen, keyboard shortcuts | options menu, Focus button |

Every slot has a word under or beside its icon at every width. 12–21 controls become 5.

### Phone

- The bar sits at the **bottom**, above the dock — thumb reach.
- **Reading is immersive by default.** Opening a book shows bar and dock for a moment, then both slide away. Tap the middle of the page: they come back. This replaces Focus mode as a thing to discover. Chrome goes from 32% to about 0% while reading.
- **Tap the right third to go forward, the left third to go back.** Swipe stays. While listening, a tap on a word still jumps there.
- **Pinch to zoom the page**, double-tap to zoom to the text column and back.
- **Text view** (later, bigger): show the page's extracted text reflowed at a readable size. The text is already extracted for chapters and read-along. This is the real fix for P3.
- All targets 48px.

### Desktop and tablet

- The bar is one row at the **top**, 44–48px: Contents + book title on the left, ‹ 2 of 5 › in the middle, Listen · View · ⋯ on the right. The page bar and tool bar merge: at 956×506 the page gains about 55px (309 → about 365).
- **Keep scrolling to reach the next page** (continuous pages), or at minimum a "Next page" button at the foot of each page, plus Space / PageDown. Fixes D2.
- Tooltips carry the shortcut (← → F Space).
- Tablet landscape gets the same one row; nothing else changes.

### Selecting text (all sizes)

One small menu **at the selection**: Highlight · Ask in chat · Save as card · Copy. The same menu on an existing highlight, with Remove instead of Highlight. Selecting on its own does nothing. Replaces auto-highlight, the bottom "Save quote" pill and the separate highlight menu. On Android it goes below the selection, clear of the system's bar above it.

### Listening rewards

Level, XP, streak and combo leave the control path: one small ring on the Listen button, details on tap. The player row is only player controls.

## Plan (nothing started)

1. One bar + Contents sheet + ⋯ sheet, both layouts. Biggest change, removes most of the list above.
2. Phone: bar at the bottom, immersive by default, tap zones, 48px targets.
3. Player folds into the bar; rewards move to the ring.
4. One selection menu.
5. Desktop: continuous pages or next-at-foot + Space/PageDown. Phone: pinch-zoom.
6. Text view for phones (separate piece of work).

Open questions for Manny:
- Should "Chapter Isolation" keep a visible button, or is inside Contents right? (Recommendation: inside Contents.)
- Immersive by default on phones, or keep the bar always visible? (Recommendation: immersive.)
- Keep auto-highlight as an option in ⋯, off by default? (Recommendation: yes.)

## Progress

Manny's answers (2026-11-13): go with all three recommendations — chapter-making inside Contents, phones immersive by default, auto-highlight an option that is off by default.

**Steps 1–5 done 2026-11-13** (not committed). Screenshots: `shots/after/` (same sizes; states 0 first-time hint, 1 reading, 2 controls, 3 contents, 4 page menu, 5 view menu, 6 more menu, 7 selection menu, 8 page foot, 9 listening, 9b listening ⋯). Old capture script kept as `shoot-before.mjs`.

- **One bar** (PdfViewer.tsx): Contents · Listen · Page · View · More, a word on every control. Top row with a mouse (48px; book title + current chapter beside Contents; ‹ Page › in the middle; zoom inline from 768px wide). Below 640px wide the controls stack icon over label. On a phone it is a card at the bottom, above the dock. The page bar, tool bar, floating chapter chip and "Save quote" pill are gone.
- **Contents** (new ReaderContents.tsx): chapters with page ranges, "reading now" on the current one (PDF: follows the page), rename and delete on each row, and "New chapter from pages" (first page / last page / name; the range survives closing the sheet). Replaces the chapter dropdown, ChapterManageDialog, ChapterNameDialog (both deleted) and the Chapter Isolation start/end/cancel flow.
- **Phone = immersive**: the reader lies over the whole app; app bar, dock and reader bar slide away 3.5s after a book opens; tap the middle to bring them back, tap again to hide; tap the left/right 30% to turn the page. Shown once on first use as a three-zone sheet (`cc_reader_tap_hint`). While listening a tap always reveals (it may be a jump-to-word) and the controls hide again after 3s. "Phone" = touch and under 640px wide or 500px tall. arena.css `cc-reader-shell-hidden` hides the shell.
- **Full screen** is in More (F / Esc with a keyboard; an Exit button joins the bar). It is the same layout with the app bar and dock hidden, not a second one.
- **Player in the bar** (ReadAlong.tsx): Listen starts; the bar's row becomes speed · back a sentence · play/pause · forward · ⋯ · Stop. ⋯ holds level/XP/streak/today's words, Voice and Sleep timer. The floating dock and the focus-mode mini player are gone. Level shows as a ring round the Listen icon. Space / [ / ] work whenever a session is on.
- **One text menu** (HighlightActions.tsx): on a selection — Highlight · Ask · Save card · Copy; on a saved highlight — Ask · Save card · Copy · Remove. It sits at the text and follows it on scroll. Auto-highlight is off unless turned on in More (`cc_reader_auto_highlight === "on"`); anyone who never touched the setting moves from on to off.
- **Page menu**: type a number, step, or drag a slider through the book.
- **Desktop reading on**: Previous page / Next page at the foot of every page; Space and PageDown scroll a screen and cross to the next page at the foot (Shift+Space / PageUp back).
- **Pinch-zoom** on the page (new usePinchZoom.ts); the scroller has `touch-action: pan-x pan-y` so the browser does not zoom the app instead.

Measured after (shots/after/metrics.json): phone 360×740 reading = 740px for the page (was 503), 0% chrome; with controls up the bar is 5 controls at 48px in 330px, nothing off-screen. Desktop 956×506 = 363px for the page (was 309); bar 922px wide, fits. Half-tile 476×506 = 363px, 7 controls fit in 458px.

Checked in headless Chromium at all eight sizes: side taps turn the page and return (2→3→2), middle tap shows the controls, typing a page number goes there, Space walks to the next page, selection menu shows the four actions, Listen swaps the bar for the player and Stop swaps it back, no console errors, no sideways page overflow. `tsc` clean, 2,630 tests pass, `vite build` builds.

Not checked: a real Android device; pinch-zoom (needs two real fingers); real speech (the player was captured with a silent stand-in voice); HTML books beyond a typecheck; the tablet layout with a finger. Not built: double-tap zoom (it would delay every page-turn tap), continuous scrolling across pages, and step 6, the phone Text view.
