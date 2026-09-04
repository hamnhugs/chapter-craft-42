# The library agent, and loading that replaces

Design for two user reports (2026-09-02), written BEFORE code, reviewed
adversarially (four lenses ran: security · tool-truth/caching/roster · state
model/concurrency · product/hands-free; the tests/claims lens never ran — its
audit was done by hand during implementation) and grounded in the research
digest `docs/library-agent-research.md`. Every accepted review finding is
folded in and marked (R). This is the AS-BUILT version (2026-09-03).

The reports, verbatim in spirit:

1. "When I load a Book and a Neuron and then open a shelf in the chat, the book
   and neuron I opened the first time stay loaded in context — at least that's
   what the Counsel tab displays. Loading a shelf doesn't replace them. Also,
   shelves open without the user having to select a neuron; provide that option
   before loading the shelf."
2. "Make it so the AI can save requested text from the chat into a PDF and
   upload it into the library automatically; give it the ability to load
   generated and/or existing books into shelves, create shelves, and overall
   have control over every aspect of the library, so hands-free mode is easier."

## 0. What the code said about report 1 — the display was telling the truth

`LibraryShelves.chatWithShelf` wrote ONE store: `bookContextStore.set({shelfId})`.
It touched neither `activeBookId` nor the neuron set, so `ChatPanel` still
rendered "Now discussing: <book>", `buildChatSystemPrompt` still emitted
`## Currently Active Book` with that book's chapter ids every turn,
`get_chapter_text`'s recovery scope still put the active book FIRST, and
`selectContextBooks` silently left a non-member active book out of the block
while the prompt and tool scope kept carrying it. The Counsel tab was not
stale: the book and neuron WERE still in the model's context. The neuron layer
already had the law ("activation replaces context, never silently appends" —
`setActiveWiki`); the book layer never got it. Report 1b was a plain gap:
book loads went through `LoadNeuronDialog`; shelf loads through nothing.

The research says this is not cosmetic: holding total length constant, each
additional *related* document costs accuracy (Levy et al. 2025 up to −20%;
Cuconasu et al. 2024 −19% relative for one; Shi et al. 2023: same-topic
distractors hurt most and "ignore it" instructions recover only part). A stale
book from the same library is the worst measured case. (Digest §1, verified.)

## 1. One rule: loading REPLACES what Counsel discusses

Counsel's **focus** has three layers:

| layer | state | before | after |
|---|---|---|---|
| loaded books | `bookContextStore` selection (shelf / hand-picked) | additive | replaced by any load |
| reader book | `activeBookId` (the Read tab) | conflated with focus | untouched by loads; DISCUSSED only when on the loaded set |
| neurons | `activeWikiIds` | independent | chosen at load time, current pre-selected |

**L1 — a load replaces the loaded books.** Loading a shelf or a set of books
swaps the selection. Loading a book from the Vault replaces the selection by
default, or — (R, product lens) — opens the book **alongside** the loaded shelf
(reader only) when the user picks that in the dialog. Nothing is replaced
silently.

**L1' — the reader is not the focus** (R, product lens; it also dissolves the
state lens's `excludedIds` finding). A shelf load never closes the book being
read. Instead every read door derives the book Counsel discusses through ONE
selector, `focusBookId(books, selection, activeBookId)` in
`src/lib/counselFocus.ts`: the reader's book when nothing is loaded, or when
it is a member of the EFFECTIVE selection (`selectContextBooks`, exclusions
honoured), else null. The prompt's `## Currently Active Book` + chapter lines
(`ChatContext`), `get_chapter_text`/`search_book_text`'s scope (`chatTools`),
and the chip (`ChatPanel`, which now shows "Reading: X · Discussing: <shelf>"
when they differ) all read it — so the invariant holds at read time whatever
a writer does.

**L2 — the neuron layer is asked, never assumed.** Every Vault load surface
goes through the same dialog (`LoadNeuronDialog` over `pendingLoad: {book |
shelf | books}`): current neuron pre-selected, chains offered, Skip keeps the
set, Esc/outside-click = Skip. The dialog SAYS what the load replaces ("This
replaces shelf X" / "Counsel will stop discussing Y — it stays open in the
reader") and, for a book load over a loaded shelf, offers **Open alongside**
next to **Load & open**. Research: the neuron is the one genuine uncertainty
with no cheap default (Horvitz 1999); the replacement itself must NOT get a
confirmation — routine confirmations habituate within days and degrade the
one that matters (Vance et al. MISQ 2018; Böhme & Köpsell CHI 2010).

**L3 — act-and-undo, with an epoch** (R, state lens). The load happens on
"Load & open"; the toast carries **Undo**. Nothing versioned the three layers
and the neuron write is async and fallible, so `counselFocus.focusEpoch` is
bumped by EVERY focus writer; Undo captures its epoch and is refused ("Focus
changed since — nothing undone") once it moved. Load ORDER is neurons-first
(the fallible layer), then the two synchronous layers, then the epoch bump,
then the toast; a failed neuron write still applies the book layers, the toast
says the neuron did not change, and Undo restores only what changed.

**L4 — one reducer, one writer per layer.** `applyLoad(prev, action) → {next,
changed}` is pure (2,000-case property test). `AppContext.loadFocus` is the
ONE writer: the dialog, the BookContextPicker's shelf switch (R, product lens
— it was a second, dialog-less shelf load), and the AI tool all call it; it
writes through each layer's owner (`bookContextStore.set`, `setActiveBookId`,
`applyActiveSet` — never `persistActiveSet`, (R) state lens). `deleteShelf`
of the LOADED shelf unloads it through the same writer.

(R, three lenses) **Mode survives an empty selection.** `bookContextStore`
now persists a mode-only record when the membership is empty and `clear()`
carries the mode; `isEmptySelection` stays a membership predicate. A stored
`"full"` — the user's opt-out from the catalog default — no longer vanishes
on the first non-member book load + reload.

## 2. The library agent — four new verbs, roster 75 → 79

Existing: `list_books`, `get_book`, `set_active_book`, `rename_book`,
`isolate_chapter`, `rename_chapter`, `delete_chapter`. Consolidation first
(digest §5: sibling expansion −8 to −19 points, merging +5 to +22):

- **No `list_shelves`.** `list_books` grows `shelves[]` (`{id, name,
  book_count, loaded_in_chat, digest?}`, digest FENCED + sanitized), per-book
  `shelf_ids`, `source: "assistant"` on assistant books, and `loaded` — but
  (R, tool-truth lens) ONLY when the app hands it a shelf reader. The E2
  harness hands none, so it gets today's bare array byte-for-byte, and the
  four E2 definitions are pinned by sha against the certified run
  (`e2DefinitionsPinned.test.ts`; the 184 certified answer rows on disk carry
  `rosterSha 5184e9daa9df05ac`, which the definitions still hash to).
- **`set_active_book` stays a READER verb** (R, product lens — the tool-truth
  lens wanted it merged into the load verb; with reader ≠ focus the two are
  different objects). It opens the book, never touches the loaded set, and
  its result says whether the book is discussed. Accepts an id or exact title.
- **`set_loaded_books`** `{shelf | book_ids | none:true, wiki_ids? |
  chain_id?}` — the tool twin of "Chat with this shelf", named for the family
  it joins (`set_active_book`, `set_active_neurons`; (R) product lens on
  naming — "chat context" is nobody's vocabulary). Calls `loadFocus` (same
  Undo toast), reports what was loaded, what it replaced and which neuron is
  in use; keeps the neuron unless told (the description says to ask ONCE if
  the user hasn't said). (R, tool-truth) the neuron branch honours the
  `switch_wiki` switch as a BRANCH permission; ids validated, plan gate
  applied, chains resolved. NOT recovery-executable.
- **`manage_shelf`** `{action: create | rename | add_books | remove_books |
  delete}`. Names sanitized (one line, ≤120), duplicates refused, `shelf`
  resolved by id or exact name against the LIVE roster (unknown id = error,
  never a silent 0-row success; `bookFolders.rename/delete` now `.select()`
  and throw on zero rows). add/remove are per-book DELTAS with honest
  partials (added · unchanged · moved · failed) and the exclusive-fallback
  "moved from X" wording. `delete` is a BRANCH permission (`delete_shelf`,
  danger; refusal via `permissionRefusal("manage_shelf (delete)", …)` — the
  resolve_conflict shape, allowlisted as self-reference) and a two-step bound
  to the shelf's NAME (`confirm_name`).
- **`save_to_library`** `{title, source: this_reply | last_reply | content,
  shelf?, chapters?}`. (R, product lens — CRITICAL) the document is read from
  the TRANSCRIPT, never re-emitted as arguments: tool args cap at the
  provider's output ceiling (`OR_MAX_TOKENS` 8000 ≈ 30k chars) and a stream
  cut by `length` DROPPED its calls silently — the narrated-action-that-
  never-ran class. `this_reply` = the assistant's text so far this turn,
  `last_reply` = its previous reply; inline `content` is capped at 20k and
  says so. A cut-short stream now pushes a visible event ("The reply was cut
  off before this action could run — nothing was changed"). Rendering:
  `src/lib/markdownPdf.ts` — markdown → jsPDF (the `epubToPdf` family) behind
  a `PdfSink` seam, chapters DERIVED from H1/H2 with the page each landed on
  (exact, no model spend), names normalised write-side (one line, ≤120,
  control chars dropped), 400-chapter cap folded and reported, 200k-char
  limit refused, front matter naming who wrote it and what was loaded. Upload
  through (R) `addBook(…, {createOnly:true})` — a path that INSERTs and can
  never enter addBook's ilike-matched overwrite branch (the existing lookup is
  also escaped and re-verified client-side); file name `<slug>-<id8>.pdf`
  with slug from `[a-z0-9-]` only. Chapters via (R) bulk `addChapters` (100
  rows per request, one state patch). Catalog via the shared
  `makeCatalogEnqueuer` (R: the built chapters are handed to the job, not an
  effect-updated ref), under the user's `auto_catalog_on_upload` opt-in only
  and (R) never under Lean Mode — the result says which. Returns the created
  book with chapter ids so the model can chain.
- **`delete_book`** `{book, confirm_title?, even_if_loaded?}`. (R, product +
  security lenses) consent is bound to the OBJECT: the first call returns
  `needs_confirmation` with the resolved book and manifest (chapters, shelves,
  loaded?); the second must carry `confirm_title` equal to the title as the
  user said it — "yes"/"delete it" is refused. This is the Type attractor in
  conversational form (Bravo-Lillo et al. SOUPS 2013) and it works a turn
  later by voice, because tool results do not survive the turn boundary a
  spoken "yes" crosses. `even_if_loaded` is required for the reader's or a
  loaded book. (R, state lens) `removeBook` is typed and REORDERED row-first
  (cascades carry chapters/junction/figure rows), storage cleanup best-effort
  after; the focus side-effect goes through `loadFocus({kind:"remove"})`.
  Hard delete stays hard; the permission copy says there is no trash.

Permissions (Library group): `set_active_book` relabelled "Open books in the
reader"; `set_loaded_books`; `manage_shelves`; `delete_shelf` (branch,
danger); `save_to_library`; `delete_book` (danger). Branch entries:
`delete_shelf`, and `switch_wiki` for the load verb's neuron branch. None
Lean-blocked (the tool itself spends nothing).

### 2.1 Deps: live readers, one clock, no direct writes

(R, state lens) `toolDeps` is rebuilt per call from `sendMessage`'s closure —
the render-time snapshot — so "save → shelve → load" in one turn answered
"Book not found". AppContext now mirrors `books`, `shelves` and `activeBookId`
into refs SYNCHRONOUSLY inside its own setter wrappers (the wrapper applies a
functional update against the mirror and hands React the value), and
`ToolDeps` gains `getBooks/getActiveBookId/getShelves/multiShelf`. (R) the
same mirror is why `setBookShelfMembership` computes its delta OUTSIDE React's
updater: computing it inside `setBooks(fn)` only worked while React ran the
updater eagerly, which it does not once the provider has a pending update — a
tool composing `createShelf` with a membership write would have written
nothing and thrown nothing. Every write goes through AppContext mutators in
`ToolDeps` (`createShelf`, `renameShelf`, `deleteShelf`,
`setBookShelfMembership`, `addBook`, `addChapters`, `removeBook`,
`setActiveNeurons` via `loadFocus`, `enqueueCatalog`, `getReplyText`).

### 2.2 Hands-free

The verbs are voice-agnostic; three things make them work by voice:
`confirm_title`/`confirm_name` are things a person SAYS; destructive verbs
resolve by NAME so a turn-later "yes" needs no id; and (R, product lens) a turn
that ends with tool events but no prose now SPEAKS the last event's sentence
(`sendMessage` returns it in voice mode) — the spoken channel never goes dark
after an action. The voice-rules block gains a library line: a spoken yes
after the assistant named the book/shelf IS the confirmation.

### 2.3 Prompt guidance and doors

One `ifTools`-gated line per verb in the user's words (§2.3 of the first
draft, as built in `buildChatSystemPrompt.libraryAgentLines`); the four verbs
join `CORE_TOOL_ORDER`. (R, security + tool-truth lenses) the `## Available
Library` door now runs every title and chapter name through `sanitizeInline`
(they were raw) and caps the focus book's chapter lines at 60 + "N more via
get_book"; an assistant-written book is labelled on its line. `BASELINE_DIGEST`
re-captured (24073/ccdfda4c → 25289/2f394aa4); the E2 prompt is built from
`E2_ROSTER` only and its definitions are sha-pinned, so `rosterSha` did not
move.

### 2.4 Provenance — assistant-written books are a separate tier

(R, security + tool-truth lenses; digest §4) the first draft's tag-based
provenance was wiped by Auto-tag (whole-array replace; new assistant books were
its next target), dropped by addBook's re-upload merge, and absent from the
INSERT. Now: migration `20260903120000_book_provenance.sql` adds
`books.source` ('user' | 'assistant', app-set), `source_model`,
`source_context` (what was LOADED when it was written — computed by the app,
never the model). Feature-detected like `books.summary`: when the column is
absent the reserved tag `written-by:assistant` carries it, `updateBookTags`
MERGES reserved tags, and Auto-tag excludes assistant books. One read door
(`bookProvenance.bookSource`). Structural defaults made explicit: search and
the book block reach only LOADED books, so an assistant book is never in the
default retrieval pool unless the user loads it; when loaded, the prompt line
and `get_book` say "written by the assistant at the user's request — not a
primary source" (a derivation label, not an "AI" badge — Altay & Gilardi
2024); never a supersede-carry or merge from an assistant book into a primary
book's cards.

## 3. Tool-truth and salvage, day one

- All four verbs are GOVERNED; results name no other governed tool (two
  self-referencing branch refusals are allowlisted with reasons).
- Descriptions name only `list_books` (ungoverned); branch permissions are
  referred to by label; no backticked phantom verbs.
- No new INBOUND surface: tool results already ride `turnToolResultText`; an
  assistant-written book enters through the existing block / `get_chapter_text`
  / `search_book_text` doors, all in the salvage `inbound` list and fenced.
- RECOVERY_ALLOWED gains nothing; `delete_book` is excluded by its `delete_`
  name and danger id.

## 4. Tests (as built — 2,047 passing, +166)

- `counselFocus.test.ts` — `applyLoad`/`focusBookId` as properties over 2,000
  generated states: focus ∈ effective selection or null; reader untouched by
  shelf/books/none; mode unchanged by every action; `changed` never lies;
  neuron choice maps exactly; epoch monotone.
- `chatBooks.test.ts` — mode survives `clear()` and a storage round-trip.
- `chapterTextRecovery.test.ts` — the focus book leads the scope; a
  non-member reader book is OUT of scope.
- `markdownPdf.test.ts` — parser; chapter spine as a property over 120
  generated documents (contiguous, covering, capped names, text preserved);
  hostile headings; slug charset; the 400-chapter fold.
- `libraryAgentTools.test.ts` — the five executors against a RECORDING deps
  fake: reader verb never writes the selection; load through `loadFocus` with
  neuron branch permission + id validation; shelf deltas with honest partials
  and the fallback "moved" wording; name-bound two-step deletes; branch
  permission leaves other actions running; unknown ids are errors;
  save reads the transcript, creates create-only with provenance, bulk
  chapters, shelves, queues catalog, skips under Lean; delete refuses
  loaded/reader books and reports failure honestly.
- `e2DefinitionsPinned.test.ts` — the E2 definitions' sha equals the certified
  run's; `list_books` without a shelf reader is the certified bare array.
- `toolRosterBudget` → 79 with the paragraph; `permissionCoverage`,
  `toolDescriptionTruth`, `toolResultToolTruth`, `promptToolTruth` (re-
  baselined), `chatContextWiring`, `leanModeCoverage` all green.
- NOT built: a mounted-AppProvider test for the membership race — the mirror
  design removed the dependence on React's eager updater, and no AppProvider
  harness exists in the repo; recorded as a follow-up in §5.

## 5. Open risks and follow-ups (not built here)

- Trash / soft delete for books (migration) — the research-backed answer;
  hard delete + `confirm_title` is the interim.
- A mounted-AppProvider regression test for two back-to-back membership
  writes with a pending shelf update.
- addBook's re-upload merge `{...b, ...nextBook, folderIds: b.folderIds}` also
  wipes `tags`/`category`/`summary`/`chapters` in client state on a human
  re-upload (pre-existing; `createOnly` sidesteps it for this feature).
- A ranking penalty for assistant books inside a mixed LOADED shelf.
- Roster research says the always-visible set should be ~30; 79 is a known
  cost paid deliberately (the roster diet is parked by the owner).
- Live verification: the flows are Supabase-backed; a logged-in Browser-pane
  session is needed to exercise them end to end (shelf load → dialog → chips;
  `save_to_library` by voice; `delete_book` two-step).

## 6. The Trash — a book delete you can take back (addendum, 2026-09-03)

Every delete of a book was HARD and, in the Vault, UNCONFIRMED: the list view's
trash icon called `removeBook` directly, which removed the PDF, the figures
and the row. The research (§2, §4 of the digest) is unambiguous that a
reversible action beats a confirmation, and the hands-free `delete_book` had to
carry a title-bound two-step only because there was nothing to undo into.

**Design.**
- Migration `20260903130000_book_trash.sql`: `books.deleted_at timestamptz`
  (NULL = live) + index `(user_id, deleted_at)`. No RLS change. Chapters,
  junction rows, figures, storage and card locators are UNTOUCHED by a trash —
  a restored book comes back exactly as it was, anchors included.
- **Live books are the only `books`.** Startup loads `deleted_at IS NULL`
  (first read IS the probe: a 42703 means the migration is absent, the
  session is marked trash-unavailable, and the load retries unfiltered). Every
  existing consumer of `books` — the block, the tools, search, the picker —
  therefore never sees a trashed book. The trash is separate state,
  `trashedBooks`, fetched once per session (`deleted_at IS NOT NULL`, newest
  first, capped at 200).
- **`removeBook` becomes a soft delete when the trash is available**: one
  UPDATE setting `deleted_at`, `.select("id")` (0 rows = not found), the book
  moves from `books` to `trashedBooks` in state, focus layers drop it through
  `loadFocus({kind:"remove"})`. When the migration is absent it stays the
  existing hard delete and every result SAYS so. `restoreBook(id)` is the
  reverse UPDATE (`deleted_at = null`); `purgeBook(id)` is the old hard path
  (row first, storage after); `emptyTrash()` purges all.
- **Auto-expiry**: 30 days. On each trash fetch, rows older than 30 days are
  purged client-side, best-effort (no pg_cron dependency; the UI says
  "deleted forever after 30 days").
- **Vault UI**: a "Trash (n)" button beside Auto-tag opens a dialog listing
  trashed books (title, pages, trashed date, days left) with Restore, Delete
  forever, and Empty trash (the last two need a click-through confirm — they
  are the only hard deletes left). The list/card delete controls become "Move
  to Trash" (no confirm; a toast with Undo = restore).
- **AI verbs**: `delete_book` = move to Trash when the trash is available —
  acts on the first call once the book is named (no `confirm_title`; the
  action is compensable), still refuses the reader's or a loaded book without
  `even_if_loaded`, and its result names the restore path. When the trash is
  unavailable the existing title-bound two-step stays. New `restore_book
  {book}` (roster 79 → 80; resolves against the trash by id or exact title).
  Realtime: DELETE events already remove purged rows; a restore is an UPDATE
  no channel carries, so another open tab sees it on reload (documented).
- **Prompt**: the `delete_book` line says the result decides whether it was
  trashed or permanent; a `restore_book` line rides gated on that verb.
- **Tests**: AppContext-free unit tests for the executors (trash available /
  unavailable; loaded guard; restore by title; unknown id), the startup
  feature-detect, and the 30-day cut.
