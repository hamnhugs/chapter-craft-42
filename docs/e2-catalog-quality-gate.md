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

- Needle + quote: catalog ≥ full − one question's tolerance (6.25%).
- E3: ≥95% of catalog-mode claimed quote spans verify mechanically.
- Synthesis: ≤10% regression vs full.
- Verdict `FLIP` = all pass → the default flips (full text stays as the
  escalation path); `HOLD` = fix what failed, rerun.

## Running it

```
npm run e2:answer   # answer phase — checkpointed, rerun to resume/retry
npm run e2:grade    # grade + report → e2-data/report.json
```

Needs `.env.e2.local` (`OPENROUTER_API_KEY`, `E2_MODEL`, optional `E2_JUDGE`)
and `e2-data/` (fixtures + questions). **Everything under `e2-data/` and the
env file is gitignored — the user's book text and keys derived from it must
never reach the repo.** Harness entries are `*.e2run.ts`, collected only by
`vitest.e2.config.ts` — the normal suite can never run them.

## Deviations from the live app (all mode-neutral, by design)

1. Roster is the 3 reading tools (`list_books`, `get_book`,
   `get_chapter_text`) instead of the full 73 — removes unrelated-tool noise;
   the system prompt is built with the same `offeredTools` gate the app uses,
   so it stays truthful.
2. Knowledge retrieval, conversation memory, focus, and Foundry surfaces are
   empty (the E1 hermetic-mock pattern).
3. Single-turn conversations; no history, no rolling summary.
4. `loadChapterText` serves fixtures (byte-identical to the DB rows they were
   exported from).
5. No text-written-tool-call salvage pass; a run that ends in prose call
   syntax just ends (counted via `finish`).
6. The fixture library is the whole library (the real one lists ~56 books in
   the prompt's catalog section for both arms alike).

## Files

- `src/harness/e2/harnessCore.ts` — offline mechanics (loop, verification,
  criteria math); unit-tested in the NORMAL suite
  (`src/test/e2HarnessCore.test.ts`).
- `src/harness/e2/answer.e2run.ts`, `grade.e2run.ts` — the two phases.
- `e2-data/` (gitignored) — fixtures, questions, `answers.jsonl`,
  `grades.jsonl`, `report.json`.
