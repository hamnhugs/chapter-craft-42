# Variable system prompts — Phase 1: the switcher

Shipped 2026-09-18 on `new1`. **No migration.** Phase 1 is pure client code and
works on the schema that is already deployed.

## The problem

`prompt_presets` has existed for months, but a saved prompt could only be
changed from Settings → Prompts, and its body was injected as
`## User Custom Instructions` at the **very top** of the ~23,000-character
stable system prompt (`buildChatSystemPrompt.ts:449`).

Providers cache the longest byte-identical **prefix** of a request. A value that
is meant to vary, sitting at the top of the stable block, is the worst position
available: changing it invalidates the whole 23K prompt *and every token after
it*. That is why making prompts switchable was an architecture change rather
than a dropdown — a fast switcher over the old layout would have quietly made
every switch expensive.

## What changed

### 1. The switchable layer moved to its own system message, last

`leadingSystem` (`ChatContext.tsx`) is now:

```
book block? · the ~23K instruction prompt · pinned focus? · rolling summary? · switchable prompt?
```

The switchable layer rides **last**, below every cache breakpoint that protects
the stable head. Switching a prompt re-writes only its own bytes. Last is also
the closest an instruction can sit to the question, which is where it is
actually obeyed — the same reasoning that already put "Hard Response Length
Limit" at the end of the stable prompt.

**The old default is untouched.** The `is_active` preset still rides at the top
exactly as before. The new block is built *only* when an override resolves to a
**different body** — compared by body, not by id, so re-selecting the
already-active prompt produces a byte-identical request. `promptToolTruth.test.ts`
still passes its `BASELINE_LENGTH = 23103` / `BASELINE_DIGEST = "60b65160"`
assertions with those numbers untouched, which is the proof this is additive.

### 2. Cache breakpoints are counted from the FRONT

`stableSystemEnd` was `leadingSystem.length - 1 - (summaryNote ? 1 : 0)` — an
expression that silently encoded "there is exactly one optional member after the
stable head". A second optional tail member made it point at churning bytes, and
a breakpoint on churning bytes is **worse than no breakpoint**: it buys cache
writes at 1.25× that are never read, with no runtime symptom at all.

It is now `(bookBlock?.message ? 1 : 0) + (focusBlock ? 1 : 0)` — fixed by the
two *leading* optionals, immune to anything appended later. The logic moved into
`src/lib/cacheLayout.ts` so the invariant that matters is a test:
**at most four breakpoints**, because `withCacheBreakpoint`
(`openrouterAdapter.ts:58`) marks the first four distinct indices and silently
skips the rest — and the entry it would drop is the newest tool-result marker,
the one that makes multi-round tool loops cheap.

One marker covers *both* churning tails (summary + switchable prompt), which is
why the new layer costs no breakpoint slot.

### 3. The Counsel switcher

- A `psychology` chip in the composer's control strip, beside "Reading: …" —
  the same kind of claim, about what is shaping the next reply.
- A **Prompts** group in the ⌘K palette (`WikiQuickSwitcher`): three letters,
  Enter, done. This is the fast path.
- Choices are `Auto` (follow the saved default), `Plain` (no prompt), or a
  pinned preset.

The pin lives in `turnPromptStore` (session-scoped, per user, `sessionStorage`),
**not** in component state or `SendOpts` alone: hands-free sends call
`sendMessage` directly and never touch the composer, so a pin the spoken path
could not see would silently stop applying the moment the user started talking.
`SendOpts.promptPresetId` still exists and outranks the store, for programmatic
sends and for the router in Phase 2.

`sessionStorage`, not `localStorage`, on purpose: a pin is a "for now" decision.
The durable choice is the preset's own `is_active` flag.

### 4. Receipts

Every reply carries `usedPrompt` — a `<details>` row beside the existing
memories/focus/books receipts, stamped on the **first stream event** like
`toolAccess`, never at assembly time.

This is deliberate. The documented failure mode of persona switchers is a UI
that reports a persona as active while the code applies it elsewhere, or
nowhere, with no way for the user to tell. So:

- a prompt scoped to Voice only shows as "not used here" in the chip *and*
  in the receipt;
- `Plain` admits, in words, that it cannot remove what Settings put in the
  stable prompt;
- the default is only **named** when its text is demonstrably the text the
  caller inlined.

`promptRouting.test.ts` carries the law as a **property**, not examples:
*if the receipt names a prompt, that prompt's own words are in the block we
built or already in the stable prompt.* It runs over 432 generated combinations
of body × scope × lane × selection × default × inlined body. It caught a real
defect on its first run — an `is_active` preset with an empty body was being
reported as applied.

## Voice brevity

In the old layout the preset body sat *above* the builder's voice sentence, so
brevity won on recency. Moving the switchable layer to the tail inverts that, so
`renderTurnPromptBlock` re-states the brevity sentence after an override on
voice turns. The sentence is exported as `VOICE_BREVITY_SENTENCE` and a test
asserts the builder still contains it verbatim, so the two copies cannot drift.

## Files

- `src/lib/promptRouting.ts` — selection store, `resolveTurnPrompt` (pure), the
  rendered block, the `UsedPrompt` receipt type.
- `src/lib/cacheLayout.ts` — `computeCacheBreakpoints`, `MAX_CACHE_BREAKPOINTS`.
- `src/components/PromptSwitcher.tsx` — the Counsel chip.
- `src/context/ChatContext.tsx` — resolution, message ordering, breakpoints,
  receipt stamp.
- `src/components/ChatPanel.tsx` — chip placement + receipt row.
- `src/components/WikiQuickSwitcher.tsx` — the ⌘K Prompts group.
- `src/test/promptRouting.test.ts`, plus two new source-level pins in
  `src/test/chatContextWiring.test.ts`.

## Not in this phase

Phase 2 (automatic routing, prompts that bind neurons/books/tools) and Phase 3
(the prompt Incubator, which lets the assistant *earn* the right to propose a
new prompt from accumulated evidence rather than a chat tool — the roster is
full at 80/80) both need one idempotent additive migration and a
`knowledge-retrieve` redeploy. The design for both is in the approved plan; the
routing math reuses Smart Filing's constants (`confident_threshold` 0.78,
`REROUTE_MARGIN` 0.08, `novelty_threshold` 0.55) and its
propose→approve→`user_corrected`→auto-pause loop.

One research note that shapes Phase 2: PRISM (arXiv 2603.18507) found expert
personas reliably help alignment-style tasks and reliably *damage* factual
recall (MMLU 68.0% under a persona vs 71.6% plain). The router will therefore
keep a plain voice on memory-recall turns rather than applying a persona
uniformly.
