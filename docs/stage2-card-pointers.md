# Stage 2 — Cards become pointers

Design for the Card Catalog redesign's Stage 2 (report §4.2/§4.3/§7): locators on
`knowledge_entries`, a dereference tool (`read_span`), an exact-text seek tool
(`search_book_text`) that closes the measured E2 quote gap, card-shaped retrieval,
and a capture flow. Written BEFORE code; reviewed adversarially by four lenses
(security · tool-truth/caching · data-model/migration · product/E2-fit); every
accepted finding is integrated below and marked (R) where it changed the design.

Context this design binds to:
- E2 verdict (2026-08-31): catalog HOLDs only on exact-quote retrieval — 6/11 vs
  8/11, every loss = seeking one sentence deep in a 384k-char book within a
  5-round tool budget. E3 verbatim gate ≥95% failed by BOTH arms (84.6% full /
  88.9% catalog) because models paraphrase/smooth when quoting from memory of an
  earlier read.
- The flip gates on rerunning the frozen 40-question set and passing quote
  parity−1 + the §8 criteria.
- Chapter text is IMMUTABLE per chapter id (isolation inserts new ids; rename
  touches only the name). This invariant is what makes char-offset locators
  permanent; it is now pinned by `src/test/chapterImmutability.test.ts`.

## 0. The one-sentence design

The wiki stops storing paraphrases-with-dead-end-provenance and starts storing
**claims that point into the immutable chapters**; the model gets two reading
primitives — *find exact wording* (`search_book_text`) and *dereference a card*
(`read_span`) — and every surface that serves a card serves a pointer-shaped
card, never a 4k-char body.

## 1. Data model (migration `20260831130000_card_locators.sql`, out-of-band)

Columns (nullable, additive; REAL named constraints, guarded for idempotent
re-runs — not comments (R)):

```sql
ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS locators jsonb,
  ADD COLUMN IF NOT EXISTS aliases  text[],
  ADD COLUMN IF NOT EXISTS author   text;
-- + CONSTRAINT knowledge_entries_locators_is_array CHECK (locators IS NULL OR jsonb_typeof(locators)='array') NOT VALID
-- + CONSTRAINT knowledge_entries_author_known CHECK (author IS NULL OR author IN ('user','assistant')) NOT VALID
```

Locator object (jsonb array element):

```jsonc
{
  "chapter_id": "<uuid>",     // into the user's own chapters (RLS-scoped reads)
  "char_start": 12410,        // resolved & verified at write time
  "char_end":   13880,        // span cap 6000 chars
  "page": 67,                 // display only, derived from chapter page range
  "quote": "difficulties that feel unproductive…",  // 8..160 chars, REQUIRED
  "stance": "supports",       // optional, free-text ≤24 chars
  "book_id": "<uuid>",        // denormalized at write time — provenance
  "book_title": "Make It Stick",          // display only, ≤80, UNTRUSTED
  "chapter_name": "Embrace Difficulties"  // display only, ≤80, UNTRUSTED
}
```

Laws:
- **quote is required** — it is the drift/tamper check and the human face of
  the locator. A locator you cannot verify is not a locator.
- **Denormalized display fields (R).** book/chapter names are stamped INTO the
  locator at write time; prompt rendering uses ONLY stored fields — identical
  DB state renders identical bytes on every device (the F9 lesson), and a
  not-yet-loaded client library can never make the prompt claim "(chapter no
  longer exists)" about a chapter that exists. `read_span` is the sole
  liveness authority. All denormalized names are UNTRUSTED (sanitizeInline at
  every render, like every chapter name).
- **NULL locators = grandfathered unanchored note.** Nothing breaks; retrieval
  marks them honestly; backfill is assisted, never faked.
- **No FK on chapter_id** (jsonb). A deleted chapter leaves a dead locator;
  `read_span` reports it honestly. Immutability means a locator is never
  *silently* wrong — it either verifies or visibly fails.
- `author`: `'user' | 'assistant'`, stamped at write — **creator, not last
  editor** (R: the extract-dedupe path can update content without re-stamping).
  NULL = predates Stage 2.
- `aliases`: lowercased, ≤6 per card, ≤60 chars each — the NISO authority
  register; register matching is normalized-exact only, never fuzzy.
- Cap **8 locators per card** (NISO §9.1). Dedupe key =
  `(chapter_id, char_start, char_end)`; a same-span re-add with a different
  stance keeps the FIRST (counted as duplicate, deterministic) (R).
- **Offsets are UTF-16 code units** into `chapters.text_content` as JS reads
  it (the unit `get_chapter_text` already slices with); the column COMMENT
  pins that server code must never slice by them with SQL string functions (R).

**Two RPCs ride in the SAME migration (R):**
1. `entry_locators_merge(_id uuid, _add jsonb) returns jsonb` — server-side
   append + dedupe + cap-8, `auth.uid()`-checked. Concurrent adds (chat tool
   vs capture UI vs second tab) commute — a client read-merge-write on one
   jsonb array is the replace-the-set shape the shelf-membership law exists to
   forbid. Also makes attach-retries idempotent.
2. `CREATE OR REPLACE public.supersede_knowledge_entry` (SAME signature — no
   overload ambiguity) now copying `locators, aliases, author` from the
   retired row to the successor, and UNIONing both rows' locators (dedupe,
   cap 8) in the `_also_supersede` conflict-merge case. Atomic, covers every
   call site, dual-mode for free (pre-migration DB = old RPC and nothing to
   carry). Migration comment carries the apply-order note: re-applying the
   bitemporal migration later reverts the RPC body — re-run this one after it.

Dual-mode client (`src/lib/cardLocators.ts`):
- **The first real read/write IS the probe (R)** — no dedicated probe select.
  Every locator-aware read attempts the new columns and, on 42703/PGRST204,
  caches "missing" for the session and retries without them; only
  missing-schema codes may cache the mode — transient errors stay
  re-probeable (shelf-membership law). `resetCardLocatorAvailability()`
  exported for tests. Mid-session Lovable apply: session stays degraded until
  reload — accepted; degraded write results carry a truthful
  "locators unavailable — migration not applied (or reload the app)" note.
- Writes go RPC-first (`memory_entry_upsert` unchanged) then attach the new
  fields (fresh entries: plain PATCH — no concurrent writer can hold a
  just-minted id; existing entries: `entry_locators_merge`).
- **Partial-failure contract (R):** RPC succeeded, attach failed ⇒ the entry
  EXISTS unanchored — the result says `locators_saved: false` + the honest
  reason + a retry hint (`update_memory_entry` add_locators, gated on wire),
  and the event summary must not claim an anchored save. A blind re-create is
  self-healing: the register lookup merges into the stranded card (R).
  PGRST204 on attach AFTER the schema was seen present = PostgREST
  schema-cache lag ⇒ retriable attach failure, never a mode flip (R).

## 2. Locator validation — where the poisoning defense actually lives

Threat: a card (model-written, imported, or corrupted) claims "the book says X"
with fake provenance, and the claim influences answers wearing the book's
authority.

Defense in two layers:

1. **Write-time (quality + fail-closed):** every locator entering the DB
   through the app is resolved and verified against the chapter text first:
   - `chapter_id` must resolve through the user's own RLS-scoped chapters;
   - offsets in bounds, span ≤ 6000 chars, quote 8..160 chars;
   - **ONE shared match predicate everywhere (R):** case-insensitive,
     whitespace-run-flexible, 1:1 glyph-folded (curly→straight quotes,
     dash variants→`-`, NBSP→space — offsets unchanged by construction).
     Used by locator resolution, read-time verification, and
     `search_book_text` — find and verify can never disagree (R). Letter-level
     typos still fail ("modem"≠"modern" is signal, not noise).
   - models supply `{chapter_id, quote}` WITHOUT offsets — the app anchors the
     quote by search (models cannot count chars). 0 hits ⇒ reject with the
     violation and the honest recourse ("copy the wording exactly as the book
     has it", naming `search_book_text` only via toolOnWire). >1 hits ⇒ first
     occurrence, noted.
   - ANY invalid locator rejects the whole write (fail-closed).
   - **Chapter text loads through a STRICT channel (R):** load-failure ≠
     empty-chapter. A transient DB error rejects as "couldn't verify — try
     again", NEVER as "quote not found" (a teaching error blaming a correct
     quote for a network blip would train the model wrong).

2. **Read-time (the security property):** `read_span` re-verifies
   quote-vs-text on every dereference and serves **the immutable chapter's
   actual bytes**, never the card's claim. Even a bogus locator smuggled past
   the app can only ever make the model read real text or see an honest
   verification failure. Influence flows through dereference; dereference
   serves ground truth.

No in-DB validation trigger (heavy, and read-time re-verification is the real
guarantee) — documented trade-off, contingent on the strict load channel above.

## 3. `read_span` — dereference a card

```
read_span(entry_id, locator_index?, context_chars?)
```

- Fetches the entry (RLS: any wiki the user owns — ids are unforgeable), reads
  its STORED locators — never caller-supplied spans; the card is the unit of
  dereference. The entry fetch does NOT select vibrancy (R: on a DB without
  the brain-memory migrations that column 42703s the whole tool).
- Per locator (or `locator_index`): resolve chapter by exact id across the
  library, load text via the STRICT channel (R — transient failure says
  "couldn't read the chapter — retry", never a drift claim), slice the span
  (≤4000 chars served per locator, ≤10k per call, honest truncation), verify
  with the shared predicate, serve with provenance header (stored book/chapter
  names sanitized + chapter_id + pages + char range) and
  `verified: true|false` (+ drift note ONLY when the text really disagrees).
- `context_chars` (0..1000, default 200) serves delimited context around the
  span so a whole sentence is quotable in one call.
- Missing schema ⇒ typed "Stage 2 migration not applied" result. Unanchored
  note ⇒ honest "this card has no locators".
- **Verification failure serves the QUOTE, never the stored offsets (R-sec):**
  when the span slice does not contain the quote, read_span re-anchors the
  quote in the full chapter text — found elsewhere ⇒ serve the re-anchored
  span with a "offsets were stale; served the quote's current location" note;
  not found ⇒ honest failure with NO span bytes (a locator that bypassed
  write validation must not get to choose which bytes ride under the card's
  name).
- **Served spans are fenced as untrusted (R-sec):** read_span results carry
  the span text nonce-fenced with the standard information-only note (the
  search_wiki pattern). Catalog-as-default makes tool results the dominant
  book-text channel; the new tools fence from day one (retrofitting
  get_chapter_text is a follow-up, §9).
- **Vibrancy bump**: its own isolated best-effort select+PATCH (min(1, v+0.04))
  swallowing every error incl. 42703; null vibrancy left alone; the
  read-then-write lost-bump race is accepted for a statistic (R). This
  mirrors the EXISTING semantic of the field — knowledge-retrieve already
  boosts vibrancy on every retrieval, permissionlessly — so it is a use
  statistic, not a content write, and does not ride the "Edit memory
  entries" choke point (R-sec: documented stance).
- No TOOL_PERMISSION entry — but the vibrancy bump means read_span is NOT a
  pure read (it changes what later turns retrieve/rank), so per
  RECOVERY_ALLOWED's own vetting rule it does NOT join the recovery
  allow-list: a prose-emitted read_span is refused, never run (R: an
  injection-steered reply could otherwise pump a poisoned card's retrieval
  standing with no roster on the wire). The allow-list comment documents the
  exception, and read_span is described as "a read with a use-statistic side
  effect", never as pure read-class.

## 4. `search_book_text` — the E2 quote-gap fix

The four catalog quote losses were all "find one sentence in 384k chars in ≤5
rounds". Locators fix this only for *carded* passages; the frozen E2 set runs
against raw books with no cards. The direct fix is exact-text seek:

```
search_book_text(query, book_id?, chapter_id?, max_results?)
```

- **Semantics: the shared predicate (R)** — case-insensitive, whitespace-run
  flexible (PDF extraction hard-wraps mid-sentence; load-bearing), 1:1
  glyph-folded (curly quotes/dashes/NBSP — pdf.js emits them routinely; the
  E3 verifier already forgives them, and a finder stricter than the verifier
  would spiral retries). Query 3..200 chars, regex-escaped, tokens joined by
  `\s+`. Deliberately NOT typo-tolerant: a search that corrects the text
  mints fake anchors. Hyphenated line-breaks ("diffi- culties") are NOT
  crossed in v1 (documented; the 0-match hint tells the model a line-break
  hyphen can hide a word — try another word from the sentence).
- **Scope**: books-in-play by default (active book first + context books —
  the same anti-lure scope as `get_chapter_text` recovery); an exact
  `book_id` / `chapter_id` may address anything the library catalog lists.
- **Execution**: chapters with client-side text are searched in memory. For
  text-less chapters (catalog mode!) ONE PostgREST prefilter scoped to the
  in-play book ids returns candidate chapter ids; candidates are fetched (in
  reading order (R)) via the strict loader and searched in memory. The JS
  predicate is the ONLY semantic authority. **The prefilter is a provable
  superset, not a translation (R-HIGH):** a single `ilike %token%` on the
  query's longest ASCII-alphanumeric token (≥3 chars) — no whitespace class,
  no non-ASCII case folding, and glyph-folding never touches `[a-z0-9]`, so
  token-containment strictly over-approximates the JS predicate. No such
  token ⇒ ALL in-scope text-less chapters are candidates (honest
  degradation). A differential property test pins superset-ness over
  adversarial fixtures (NBSP, curly quotes, case, unicode); a unit test
  exercises the PostgREST path with a mocked client.
- **Caps, spread not front-loaded (R):** pass 1 keeps ≤2 matches/chapter so a
  common term in early chapters cannot starve a deep target; pass 2 fills
  remaining slots (total 12) in reading order. Fetch cap 6 candidate
  chapters. EVERY cut is counted: `more_matches_not_listed`,
  `chapters_matched_not_searched` (+ ids), and unreadable candidates are
  reported as unreadable (strict loader), never as "0 matches" (R). The
  event summary states the actual scope searched.
- **Results**: per-match `{book_id, book_title, chapter_id, chapter_name,
  char_start, char_end, approx_page, excerpt}`; the excerpt is a RAW
  substring of the chapter (~160 before/~240 after — usually the whole
  target sentence), pinned by a purity test (no inline decorations ever —
  a decorated excerpt copied faithfully would fail E3 by construction) (R).
  Excerpts are nonce-fenced as untrusted in the result (R-sec: a hostile
  book can position instruction text exactly where searches land; the
  search_wiki fencing pattern applies), with the fence note phrased so
  quoting from inside the fence stays natural.
- **Verbatim-copy nudge (R-HIGH, the E3 fix):** every success result carries
  the static line "When quoting, copy an excerpt byte-for-byte, including odd
  spellings or OCR artifacts; never smooth them; no ellipses inside a quote."
  (names no tool — ungated by the result-layer law). The same clause rides
  the ifTools prompt sentence, in both harness arms (fair).
- 0 matches ⇒ honest result + hint (shorter distinctive phrase / single
  unusual word / book wording may differ / line-break hyphens hide words).
- Follow-up tail names `get_chapter_text` offset reading — gated on wire.
- Read-only, pure ⇒ no permission entry; joins RECOVERY_ALLOWED.

Prompt guidance (all through `ifTools`, pinned by promptToolTruth + a new
locator-bearing scenario (R) + mirror pins): the Library-catalog tail gains
one sentence for `search_book_text` (find exact wording before quoting +
copy-byte-for-byte clause), and the Retrieved-Knowledge header gains a
`read_span` sentence when cards carry locators.

Roster: 73 → **75**, a deliberate budget edit with the same justification
shape as the Program Foundry's: the two reading primitives the measured E2
quote gap demands; they earn their selection cost back in the rerun or the
flip HOLDs.

## 5. Card-shaped retrieval

- `knowledge-retrieve` (deployed edge fn) can't return new columns until a
  Lovable redeploy, so the client enriches: ONE batched
  `select id,locators,aliases,author where id=in(<retrieved ids>)` per send —
  running AFTER filterSupersededNodes (retired rows never enrich), degrading
  exactly like it on any error (swallow, render as today) (R). First-read-
  is-the-probe: a 42703 here caches "missing" and the send proceeds.
- Retrieved Knowledge rendering per card:
  - every card prints its `entry_id` (data, unconditional — the chapter_id
    lesson);
  - pointer cards: title + body + `Locators:` lines rendered purely from
    STORED denormalized fields (never client-library liveness — F9). The
    locator lines ride INSIDE the card's nonce fence (R-sec: a verified
    quote of a hostile book's real sentence is still hostile text — the
    never-obey cover must apply to it; sanitizeInline alone is not a fence),
    composed from sanitizeInline'd fields so a quote can never break the
    fence. `entry_id` + author stay in the header OUTSIDE the fence
    (actionable data, the attached-image-note precedent);
  - clip: pointer cards 1200 chars (voice 700) — the pointer makes the clip
    honest, since read_span serves the passage. UNANCHORED notes keep the
    pre-Stage-2 4000 (voice 1200): on day one that is 100% of every existing
    user's corpus, their body IS their value, and nothing measured justifies
    shrinking it (impl-review finding — an earlier 2400 would have been a
    silent 40% cut to every legacy wiki). Tool/program cards keep 4000.
    Honest `[…truncated — N more chars; fetch the full entry with
    search_wiki entry_id]` tail, fetch clause gated on wire, all three tiers
    pinned by tests.
- `search_wiki`:
  - gains `entry_id` param — fetch ONE entry in full (the escalation path
    that makes clipping honest);
  - results gain compact locators (from stored fields — quote portions ride
    inside the entry's existing fence, provenance ids outside) and `author`;
  - alias register matching (R): the query joins the alias clause ONLY when
    its register key matches `^[a-z0-9][a-z0-9-]{1,59}$` (single token,
    allowlisted — the cs-literal metachar class is not escapable-by-hand);
    otherwise the clause is skipped. A PGRST100 from the clause retries
    without it (not in the 42703 retry set).
- **Register lookup (create path)** uses supabase-js builder methods — a
  title-ilike query (wildcards ESCAPED, not stripped) and an
  `.overlaps("aliases", terms)` query in parallel (R: no hand-built `.or()`
  array literals, no cs-escaping class at all) — and the server filters only
  NARROW: before any write, candidates are re-verified CLIENT-SIDE with
  normalized-exact key equality (R-sec: a `%` in a title must never wildcard
  a merge into the wrong card; the client compare is the authoritative gate).
  Scope: the active wiki, living entries only.
- Supersession carries locators/aliases/author via the replaced RPC (§1) —
  no client-side carry code, no per-call-site drift (R).
- Token math (R): worst case 18 unanchored × 2400 ≈ 10.6k tok (down from
  ~18.4k; falls further as backfill anchors cards to 1200-clip pointer form).

## 6. Write paths: capture, register, no-orphans

`create_memory_entry` gains:
- `locators`: array of `{chapter_id, quote, char_start?, char_end?, stance?}`
  — validated/resolved per §2, all-or-nothing;
- `aliases`: ≤6 register terms;
- `unanchored: true` — explicit escape hatch. **When book context is in play
  (a non-empty context selection) and the args carry neither locators nor
  `unanchored`, the create is rejected with a teaching error** naming ONLY
  this tool's own params (locators / `unanchored:true`) — no other tool
  names. One-round cost on personal notes; silent minting of unanchored book
  notes becomes impossible ON THE TOOL PATH (R: knowledge-extract and Sleep
  Cycle write server-side and keep minting unanchored rows until their
  redeploys — grandfathered honestly, out of scope). Known decay risk (R):
  models may learn blanket `unanchored:true` — so an unanchored create with
  books in play gets a result note ("saved unanchored — if this claim came
  from a loaded book, add a locator via update_memory_entry", gated on
  wire), making the decay auditable; measuring the rate is Stage 4.
- **register lookup before minting**: normalized-exact match of the new title
  (and each alias) against titles + aliases in the ACTIVE wiki.
  - Match + new locators ⇒ **merge** (via entry_locators_merge) — but ONLY
    when the existing card's `author` is `'assistant'` (R-sec: auto-merging
    an assistant write into a USER-authored or grandfathered card would
    launder attacker-anchorable locators onto the user's own authority —
    a hostile book contains the false sentence, the quote verifies, and the
    user's trusted card now cites it). For `author:'user'`/NULL matches the
    tool returns the existing card for deliberate action instead (the
    permission-gated update path is the choke point). The capture UI may
    merge into any card — the user is clicking. On merge: return
    `{merged_into_existing: true, entry_id, existing_title}`.
  - Match + no locators ⇒ no write; return the existing card (id, gloss
    head) so the model acts deliberately. Result copy names
    `update_memory_entry`/`supersede_memory_entry` only via toolOnWire; when
    off-wire: "edit or supersede it from the wiki panel" (R). MODEL_FACT
    house shape: neutral fact + named fix, phrased as fixable-this-turn.
- stamps `author:'assistant'` (attach step).

`update_memory_entry` gains `add_locators` (validate per §2, then
entry_locators_merge; no model-facing removal path — removal is user UI or
supersession).

No-orphans law: NOT enforced as a hard ≥1-link requirement at create
(link_memory_entries has its own user permission; auto-linking would bypass
it, and a hard rule dead-ends the first card in an empty wiki). The create
result nudges toward `link_memory_entries` (gated on wire) when the wiki has
other cards; Sleep Cycle orphan reports stay the backstop; Stage 4's register
enforces sublinearity mechanically. **Deliberate deviation from report §4.3.**

Capture flow (UI, PDF books only in v1 — HTML books have no pdf.js text
layer (R)):
- **PdfViewer selection capture**: on selection inside the page container a
  floating "Save quote" affordance opens a card-draft dialog. Anchoring:
  candidate chapters = those whose page range contains the current page; the
  FIRST candidate (spine order) whose text anchors the selection wins
  (deterministic tie-break (R)); no candidate or no anchor ⇒ the dialog says
  so and offers an unanchored save or chapter isolation first — never a fake
  anchor. Quote = first ≤160 chars of the normalized selection; span = the
  anchored full selection (≤6000). Register-lookup panel is a THIN reuse of
  §6's exact-match helper — one "add this location to card X" action (R:
  anything richer is unmeasured scope creep). Saves stamp `author:'user'`.
- **Backfill assist** (WikiPanel): unanchored entries get "Find in book" — a
  search box (prefilled with the entry title) over the entry's source book
  (else books-in-play) using the same search machinery; the user picks the
  passage that grounds the card. Assisted, never automatic.
- The chat-side backfill needs no UI: "find where this card came from" →
  `search_book_text` → `update_memory_entry(add_locators)`.

## 7. Tool-truth + salvage, day one

- New definitions enter toolRosterBudget (75 + justification),
  toolDescriptionTruth (both descriptions name only ungoverned tools:
  `get_chapter_text`, `search_wiki` — verified against all three gates),
  promptToolTruth (new guidance rides `ifTools`; NEW scenario with a
  locator-bearing card + mirror pins), and the gates/differential tests.
- `RECOVERY_ALLOWED` += `search_book_text` ONLY (pure read). `read_span`
  deliberately stays off (vibrancy write — §3).
- Tool results of both tools enter the salvage `inbound` haystack
  automatically (`turnToolResultText`).
- **New inbound surface (R, narrowed twice):** locator quotes (untrusted book
  text) now ride inside the system prompt's retrieval section. The salvage
  `inbound` array gains PER-CARD strings (each card's rendered text as its
  own bounded source), NOT the whole prompt and not even the whole section as
  one string — the module budgets a comparison share per source and compares
  each source's head, so a single large source leaves its own tail (where
  deep cards sit) uncompared, which is precisely the ordering failure the
  module's history records (R-sec). Cards are ≤2.6k chars each, far under the
  per-source floor, so every card is fully compared. buildChatSystemPrompt
  returns the per-card strings alongside the prompt; ChatContext spreads
  them into `inbound`.
- Result-layer tails (get_chapter_text follow-up, search_wiki fetch clause,
  update/supersede mentions) all ride `toolOnWire`, per the result-layer law.

## 8. E2 rerun + the flip

- Harness roster gains `search_book_text` in BOTH arms (fairness: identical
  rosters; full may rise too — parity−1 on a level field is the honest gate).
  `read_span` stays out: fixtures carry no cards. Recorded in the deviation
  ledger (docs/e2-catalog-quality-gate.md).
- **The harness pins hermeticity (R-HIGH):** answer.e2run mocks
  `@/integrations/supabase/client` to throw "network reached the E2 harness"
  — the prefilter path CANNOT silently leak live traffic from a test run;
  fixtures keep text inline so the in-memory path serves everything, and the
  superset property test (normal suite) is what certifies the server path
  the harness cannot exercise.
- **Third arm (R-HIGH): `catalog_nogist`** — the catalog arm rerun with gists
  stripped from fixtures, because the flip changes the default for legacy
  users whose books are ungisted, and that configuration was never measured.
  Flip shape decided on evidence: nogist holds ⇒ flip unconditionally (nudge
  stays as UX); nogist fails ⇒ ungisted books resolve to full per-book and
  the gist nudge carries the migration.
- Prompt/roster changes re-key RunIdentity ⇒ fresh checkpoints by design.
- Run `npm run e2:answer` / `e2:grade`; §8 criteria in `buildReport` decide.
- **Landing IN STAGE 2, before any flip (R):** `resolveBookContextMode(sel,
  providerToolCapable)` as the single mode callee (sendMessage, picker,
  chips — a grep-lint pin forbids inline `=== "catalog"` coercions outside
  it), and sanitizeStored starts preserving `mode:"full"` so explicit
  opt-outs accumulate BEFORE the default changes (today "full" is stored as
  absence — the users with the strongest opt-out signal would otherwise be
  flipped against it).
- On PASS, the flip commit: the helper's absent-mode default becomes catalog
  for tool-capable providers (tool-less models keep forcing full; transient
  image-turn drops keep catalog exactly as today); picker default reflects
  catalog and renders the forced-full state explicitly; gist-nudge UX for
  ungisted books; full text stays one toggle away and remains the escalation
  path. Known bounded exposure, accepted: an OLD bundle's sanitizeStored
  strips `mode:"full"` on its own writes, so a stale tab open across the
  deploy can revert the opt-out until tabs cycle (Phase-4 acceptance class).
  Voice turns inherit the mode (halved budgets + tool-round latency) —
  unmeasured by the text harness; documented, watched post-flip.

## 8b. THE RESULT (2026-08-31) — FLIP, gist-aware

The frozen 40-question set, rerun on google/gemini-3.7-flash across all three
arms (120 answers, 0 errors, single model + single rosterSha):

| criterion (§8 gate) | full | catalog | catalog_nogist |
|---|---|---|---|
| needle | 14/15 | **15/15** | 15/15 |
| exact-quote | 10/11 | **11/11** | 7/11 |
| E3 spans verified | 15/17 (88.2%) | **16/16 (100%)** | 12/12 (100%) |
| synthesis (of 5) | 4.909 | 4.818 (−1.85%) | 4.909 |
| routing | 3/3 | 3/3 | 3/3 |
| **verdict** | — | **FLIP** | **HOLD** |

Catalog does not merely reach parity — it BEATS full text on the metric that
blocked it (quote 11/11 vs 8/11 before, and vs full's 10/11 now), at 33× less
first-send data (10.5k vs 346k chars), 10× less total, and the same latency.
Quote scores are mechanical (`by=quote-verify`), not judge-decided.

**The third arm changed the flip's shape.** Ungisted catalog HOLDs on quote
parity (7/11), and the mechanism is visible in the traces: without gists the
model has no routing signal, so it reads the WRONG chapter (trig-q2 re-read
Ch 5 three times), reads NOTHING at all (trig-q3), or searches unnarrowed
(sigil-q4, 14 chapters). With gists it searches once and reads the right
chapter. This is "summaries route, raw text answers" (ReadAgent), measured.

⇒ **The flip is gist-aware**: a book rides catalog only when it HAS a
catalog; ungisted books keep full text, and the gist nudge carries the
migration. That resolution is Stage 2's remaining build step.

## 9. Self-critique / open risks

- **Glyph folding is 1:1 only.** Hyphenated line-breaks still hide words in
  v1; the hint teaches the recourse. Dehyphenation needs an offset map —
  deferred until a measured miss demands it.
- **The imatch→ilike-token prefilter over-fetches** (any chapter containing
  the token). Bounded by the fetch cap + honest counters; FTS is Stage 4
  material if scale demands it.
- **Two more tools on a heavy roster.** Conscious budget edit; the rerun
  measures whether they earn their keep.
- **Register lookup is exact-match only.** "Desirable difficulty" vs
  "desirable difficulties" mints two cards; aliases + Stage-4 merge
  proposals close it. False merges destroy trust in writes — chosen.
- **PDF text-layer vs extracted-text drift** can defeat selection anchoring;
  the dialog degrades honestly to unanchored + assisted search.
- **The clip split (1200/2400/4000)** leaves worst-case knowledge context
  above the 5k-token design target until backfill progresses — honest today
  beats aggressive-but-lossy.
- **The enrichment select adds one round trip** per send (schema present +
  nodes retrieved only). Bounded, batched; the eventual edge-fn redeploy
  absorbs it server-side.
- **get_chapter_text still serves raw, unfenced chapter text** (pre-Stage-2
  convention). The two NEW tools fence; retrofitting get_chapter_text is a
  named follow-up so the E2 baseline comparison stays clean this stage
  (R-sec).
