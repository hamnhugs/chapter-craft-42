# Library tab usability audit and deck rework — 2026-11-13

Branch `new1`. Audit first, then the rework was built in the same pass. Nothing is committed.

Files: page = `src/components/Library.tsx`, deck = `src/components/LibraryDeck.tsx`, card and deck styles = `src/styles/arena.css`, load rules = `src/lib/counselFocus.ts`, the eight-book limit = `BOOK_CONTEXT_MAX_BOOKS` in `src/lib/chatBooks.ts`.

To look at it without signing in: start the dev server on port 8093 (`npx vite --port 8093 --strictPort`), then open `#/arena-lab?library` (dev only). It mounts the real Library over 18 fixture books and four shelves you can edit in memory.

Screenshots: `shots/before/` and `shots/after/`, named `<size>-<n>-<state>.png`; numbers in `metrics.json` in each. Capture scripts `shoot-before.mjs` and `shoot.mjs`. Sizes kept in the repo: phone-360 (360×740) and desk-956 (956×506), plus one half-tile shot (476×506).

## Root problem

Books, shelves and notebooks were three separate things on three separate screens, joined by a dialog.

1. **Shelves were a view, not a place.** You saw books (Cards) or shelves (Shelves), never both. Putting a book on a shelf meant leaving the shelf to find the book, or opening the book's profile and scrolling to a row of chips.
2. **The notebook only appeared as an interruption.** Pressing Read on a book, or "Chat with this shelf", opened "Which notebook should Counsel use with…?" — a question about a different tab, asked on the way to something else.
3. **Nothing on the Library said what Counsel had loaded**, or that it takes eight books at a time.
4. **Five views, two sort controls, three card designs.** Cards, Shelves, List, Showcase and Mind map sat on an icon-only switch; the toolbar had a sort button and the collection had four more; a book looked different in Cards, in Shelves and in the profile.

## Measured (before)

| | desk 956×506 | phone 360×740 |
|---|---|---|
| First book starts at | 371px — 87px of it shows above the dock | 442px |
| Shelves view: first book starts at | 825px (second screen) | 1326px (second screen) |
| Controls on the first screen, Cards | 20 | 24, 7 under 44px |
| Controls on the first screen, Shelves | 32, 18 under 44px | 27, 15 under 44px |
| Taps to take a shelf to Counsel | 4, one of them a dialog | same |
| Taps to put a book on a shelf from Cards | 3 and a scroll | same |

## Findings

- **L1. The page spent its first screen on itself.** Title, count, view switch, toolbar and a "From your library" line came before any book (shots before/desk-956-1, phone-360-1).
- **L2. The view switch was five unlabelled icons** below 1280px wide — every size Manny works at. Two of them (Showcase, Mind map) are occasional.
- **L3. Two sort controls on one screen** that did not agree: the toolbar's Recent/A–Z and the collection's Newest/Level/Size/A–Z. The first did nothing in the Cards view.
- **L4. Shelf cards carried four icon-only buttons each** (pick, chat, rename, delete), 36px, with delete one slip from chat (before/desk-956-3). At four shelves that is 16 small targets before the first book.
- **L5. Shelves had hidden modes**: a pick-several mode (the square, or ctrl/shift-click), "Open another shelf", and a spotlight that dimmed books on hover. None was explained.
- **L6. The shelf button on a book showed only on hover** in the Shelves view.
- **L7. Read asked about notebooks.** Opening a book raised the notebook dialog; with no notebooks it said "open the book and create one in the Notebooks tab" while standing in front of the book (before/desk-956-5).
- **L8. "Ask Counsel" on a book did not make Counsel discuss it** when a shelf was loaded and the book was not on it: it pointed the reader at the book and switched tabs, and Counsel kept the shelf. Read from the code (`focusBookId` in `counselFocus.ts`), not reproduced in a signed-in session.
- **L9. The eight-book limit was invisible.** A shelf of twelve loaded eight, chosen by id order, and the Library never said so.
- **L10. A stuck tilt on touch.** The card's hover tilt stayed on the last card tapped on a phone.
- **L11. A sliver of a third title line** showed under two-line card titles.

Not fixed, noticed on the way:
- Search results do not say why a book matched (the old shelf card showed the matching chapter; the cards never did).
- Category and tag filter chips existed only in the old Shelves view. Search still covers both.

## Research

Checked this session:
- A UX breakdown of Clash Royale (therookies.co, 2020): pop-ups are not full screen so the screen behind stays visible, and a tap on the background closes them; depth rarely goes past one level; yellow marks the primary action and green the secondary; info buttons share one look; the key controls sit in the bottom half; a card can be dragged or tapped-then-placed.
- Clash Royale's own facts, from search results only (the support page refused the fetch): a deck is eight cards (Wikipedia); up to ten saved decks per mode and a filter on the collection (Supercell support); the tower troop has its own slot outside the eight (RoyaleAPI).
- NN/g on bottom sheets: use them for short interactions; Back must close them; show a Close button; never stack them; they do not replace a page.
- Target size: WCAG 2.2 SC 2.5.8 asks 24×24 CSS px (AA), 2.5.5 asks 44×44 (AAA); Android recommends 48dp, iOS 44pt. Secondary sources.

Carried over from the Read tab audit earlier the same day (`docs/reader-audit/AUDIT.md`): icons need visible labels; hidden navigation is found later and used less, so only rare things go behind "more"; progressive disclosure.

From general knowledge, not checked this session: in Clash Royale's Cards screen, tapping a card lifts it and shows Info and Use under it, and Use makes the deck's cards wiggle until you tap the one to swap out. No source found this session describes that menu, so the build follows the pattern as remembered.

"Cutting edge" in usability is mostly the same standards applied more strictly. WCAG 2.2 is the current W3C recommendation; nothing newer was found that changes these findings.

## The design

One rule: **a shelf is a deck; the Library is where you build it and send it.**

| Clash Royale | Library |
|---|---|
| Deck tabs | Shelves. "Reading now" is a tab the app fills by itself. |
| Eight deck slots | The open shelf's books in eight slots — the eight Counsel reads at a time. |
| Tower troop slot | The notebook Counsel is using, beside the slots. |
| Battle | **Ask Counsel**: takes the open shelf and that notebook to the chat. |
| Collection | All books, underneath. |
| Tap a card: Info / Use | Tap a book: **Info**, **Read**, **Add to ‹shelf›** (or Take off). |

Two verbs, each with one meaning everywhere:
- **Read** opens the reader and changes nothing about what Counsel has loaded.
- **Ask Counsel** takes the thing you are looking at — a book or a shelf — to the chat, with an Undo on the toast.

Looking at a shelf tab never loads it (the rule from the Notebooks audit: viewing is not loading). The tab of the shelf Counsel has shows a small Counsel icon, and its button reads "Open Counsel".

## What was built

- **Deck panel** (`LibraryDeck.tsx`): shelf tabs with colour mark and count; "New shelf" at the end of the row; slots that fill out to eight (a phone shows four to a row and stops the empties at the end of the row); an empty slot scrolls to the collection; a line under the tabs says how many of eight, or that Counsel will take eight of a larger shelf.
- **Notebook slot + Ask Counsel**: the slot shows the loaded notebook, or "None — just chat", and opens the existing notebook switcher (⌘K). Ask Counsel loads the shelf and keeps the notebook. No dialog.
- **Card menu**: tapping any card lifts it and shows Info / Read / Add to. Beside the card where there is width, under it on a phone, and clear of the app bar and dock. It is a standard menu underneath, so Esc and a tap outside close it.
- **Info** is the existing book profile, unchanged apart from Ask Counsel now loading that book (L8).
- **Shelf "⋯"**: Rename, Summarize its books, Write a shelf summary, Delete. These were four icons per shelf card and two pills in the open shelf.
- **Collection**: "Not on a shelf" filter; books on the open shelf carry a tick in the shelf's colour; six cards to a row at 956 wide instead of five.
- **Page** (`Library.tsx`): the title block and five-icon switch are gone; List, Showcase and Mind map are in the "⋯" menu with a line each, and a "← Cards" button brings you back; the toolbar sort shows only where it does something; "From your library" moved under the books.
- **Read no longer raises the notebook dialog** from anywhere in the Library (L7).
- L10 and L11 fixed in `arena.css`.

### After

| | desk 956×506 | phone 360×740 |
|---|---|---|
| First book starts at | 250px, in a shelf slot | 263px |
| Controls under 44px on the first screen | 1 (was 2 in Cards, 18 in Shelves) | 2 (was 7 and 15) |
| Controls on the first screen | 31 (was 20) | 25 (was 24) |
| Taps to take a shelf to Counsel | 2 — the tab, then Ask Counsel; 1 if it is already open | same |
| Taps to put a book on the open shelf | 2 — the book, then Add to | same |

The count of controls on the first screen went up on the desktop, not down: the tabs and slots are controls. What changed is that they are one panel with one primary button, where before there was a toolbar and no books.

## Changed behaviour to know about

1. **The Shelves view is gone.** `LibraryShelves.tsx` and its test are still in the repo but nothing mounts them. The old big book card (`BookCard`, about 450 lines in `Library.tsx`) was deleted, and its rules in `index.css` (`.cc-book-*`, `.cc-vault-title`, `[data-cc-narrow]`) are now dead.
2. **Opening several shelves at once, the hover spotlight, and the category/tag chips** went with it.
3. **Read from the Library keeps the loaded shelf.** Before, it cleared the loaded books (after the dialog). The dialog component still exists; the Library no longer calls it.
4. **Shelves can still hold more than eight books.** The slots show them all and say Counsel takes eight; which eight is still picked in the chat.

## Not done

- Drag a card into a slot. Tap-then-Add only.
- A notebook per shelf. The notebook slot shows the one Counsel is using, the same on every shelf. (A `default_wiki_id` column for this existed once and was dropped.)
- Choosing which eight of a larger shelf from the Library.
- Deleting `LibraryShelves.tsx`, its test and the dead CSS — left until the deck has been used for real.
- The profile dialog was not redesigned.

## How it was checked

- `npx tsc -p tsconfig.app.json --noEmit` clean; `npx vite build` builds.
- `npx vitest run`: 115 files, 2,630 tests pass. Eleven tests that pinned the old book card were removed and three rewritten; eleven new ones in `src/test/libraryDeck.test.tsx` pin the deck (viewing is not loading, Ask Counsel keeps the notebook, shelf sizes stay true during a search).
- Driven in headless Chromium through the lab at 360×740, 476×506, 956×506 and 1440×900: open a shelf, tap a card, add it, open Info, make a shelf, open the notebook switcher, search, switch to the list and back, Ask Counsel (lands in the chat showing "4 books · Design").

Not run: anything signed in. Shelf create/rename/delete, adding a book to a shelf, the two summarize actions and the notebook slot with real notebooks have only run against the lab's in-memory stand-ins or the unchanged app functions they call. Keyboard use of the card menu was not driven. Not tried on a real phone.
