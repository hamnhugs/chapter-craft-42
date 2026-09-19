# E2 — the Card Catalog quality gate (full vs catalog A/B)

The measured decision for flipping the book-context default from **full**
(budgeted whole-text block) to **catalog** (chapter maps + gists, text fetched
on demand). Design report §8, experiments E2 + E3.

## What it does

A fixed ~40-question set over two real library books runs through BOTH modes
on the live provider with the user's daily-driver model. Everything except the
book block's mode is identical: the app's real `buildChatSystemPrompt` and
`buildBookContextBlock`, the real `openrouterAdapter`, the real
`executeChatTool` serving fixture chapters, the app's tool-loop semantics
(5-iteration cap, 24k result slice, side-channel strip).

Question types: **needle** facts (accept-list graded, judge fallback),
**quote** requests (fully mechanical: claimed spans verified verbatim against
`chapters.text_content` — the E3 gate — AND overlap the author-verified key
passage), **synthesis** across chapters (blind LLM judge, 0–5 vs authored key
points), **routing** across books.

## Pass criteria (§8)

- Needle + quote: catalog ≥ full − ONE QUESTION per type (counted, never a
  rate — a rate constant becomes a zero-question tolerance the moment a type
  has more questions than its denominator; review-caught).
- E3 (gating): ≥95% of the quote spans claimed in catalog-mode QUOTE-question
  answers verify mechanically. `report.json` also carries an informational
  all-answers span-verify rate per mode.
- Synthesis: ≤10% regression vs full.
- Verdict `FLIP` = all pass → the default flips (full text stays as the
  escalation path); `HOLD` = fix what failed, rerun.

## Running it

```
npm run e2:answer   # answer phase — checkpointed, rerun to resume/retry
npm run e2:grade    # grade + report → e2-data/report.json
```

Needs `.env.e2.local` (`OPENROUTER_API_KEY`, `E2_MODEL`, optional `E2_JUDGE`)
and `e2-data/` (fixtures + questions). Checkpoint resume is keyed to the RUN
IDENTITY (model + fixture sha + question sha): switching any of them makes old
rows stale rather than silently mixing runs, and the grade phase refuses
mixed-model answer sets outright. **Everything under `e2-data/` and the
env file is gitignored — the user's book text and keys derived from it must
never reach the repo.** Harness entries are `*.e2run.ts`, collected only by
`vitest.e2.config.ts` — the normal suite can never run them.

## Deviations from the live app (each mode-neutral or conservative-against-catalog, and measured)

1. Roster is the reading tools (`list_books`, `get_book`, `get_chapter_text`,
   and — since the Stage 2 rerun — `search_book_text`) instead of the full
   75 — removes unrelated-tool noise; the system prompt is built with the
   same `offeredTools` gate the app uses, so it stays truthful.
   `search_book_text` rides in EVERY arm (fairness: full may improve too;
   parity−1 on a level field is the honest gate). `read_span` deliberately
   does NOT join: fixtures carry no wiki cards, so it would be dead roster
   weight in all arms alike. The roster is part of the run identity
   (`rosterSha`) — changing it re-keys the checkpoints, so a rerun can never
   resume over a previous configuration's answers.
1b. THE STAGE 2 RERUN ADDS A THIRD ARM, `catalog_nogist`: the catalog block
   rebuilt over gist-stripped fixture copies. The flip changes the default
   for legacy users whose books are largely ungisted, and that configuration
   was never measured by the original A/B (design-review HIGH). The §8 gate
   stays catalog-vs-full; `nogist_criteria` in report.json decides the
   flip's SHAPE (unconditional vs gisted-books-only). The baseline
   two-arm run is archived under `e2-data/raw/run1-baseline-20260831/`.
2. Knowledge retrieval, conversation memory, focus, and Foundry surfaces are
   empty (the E1 hermetic-mock pattern).
3. Single-turn conversations; no history, no rolling summary.
4. `loadChapterText` serves fixtures (byte-identical to the DB rows they were
   exported from).
5. No text-written-tool-call salvage pass; a run that ends in prose call
   syntax just ends. Its incidence is measured: `report.json` counts
   `proseCallSuspects` per mode (call-shaped answer text against the roster) —
   this deviation is anti-catalog in direction (only that arm NEEDS tool
   calls), so a nonzero catalog count next to a HOLD verdict warrants a look.
6. The fixture library is the whole library (the real one lists ~56 books in
   the prompt's catalog section for both arms alike).

## Files

- `src/harness/e2/harnessCore.ts` — offline mechanics (loop, verification,
  criteria math); unit-tested in the NORMAL suite
  (`src/test/e2HarnessCore.test.ts`).
- `src/harness/e2/answer.e2run.ts`, `grade.e2run.ts` — the two phases.
- `e2-data/` (gitignored) — fixtures, questions, `answers.jsonl`,
  `grades.jsonl`, `report.json`.
