# Variable system prompts — switcher, router, and earned proposals

Shipped 2026-09-18 on `new1` in three phases. Phase 1 (the switcher) is pure
client code and needs no migration. Phases 2-3 need one idempotent additive
migration plus two edge-function deploys — see "Applying the migration" below.

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

## Phase 1 — what changed

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

Phases 2-3 add: `src/lib/promptRoutingApi.ts`,
`supabase/migrations/20260919000000_prompt_routing.sql`,
`supabase/functions/prompt-incubator-sweep/`, `routePrompts()` inside
`supabase/functions/knowledge-retrieve/`, and the routing controls plus
proposal cards in `src/components/PromptLibrary.tsx`.

## Phase 2 — the router

### Why it is free

`knowledge-retrieve` already embeds the user's turn on every message. Scoring
the saved prompts needs exactly that vector and nothing else, so the match
happens **inside the same call**: no second embedding, no extra round trip, no
added latency. Anywhere else would have meant paying to embed the same words
twice per message, forever.

The edge function returns **data, never a decision** — a similarity per prompt,
the incumbent's similarity, and how strongly the turn leaned on retrieved
memory. Policy lives in `decideRoute()` in `src/lib/promptRouting.ts`, where it
is pure and every branch is reachable from a test.

Prompt embeddings are self-healing: a prompt with no vector, or one written by a
previous embedding model, is re-embedded inside the same call and written back.
There is no separate pipeline to run, forget, or fail.

### The decision

Thresholds are Smart Filing's, unchanged (`smart-file/index.ts`), because it is
the same kind of decision and fresh numbers would restart that tuning:
`confident 0.78`, `margin 0.08`, `novelty 0.55`.

The router is heavily biased toward **keep**, and a test enforces it: across a
generated matrix of scores it switches on under a quarter. It will not switch

- on a thin margin over the prompt already in force,
- when two prompts fit about equally (two near-identical prompts would otherwise
  trade the conversation back and forth on noise),
- twice inside three turns,
- or to the prompt that is already on.

**The recall guard.** PRISM (arXiv 2603.18507) measured expert personas
improving alignment-style tasks and *damaging* factual recall — 68.0% vs 71.6%
on MMLU. So when a turn is dominated by retrieved memory, the router leaves the
voice alone and says so. A setting, on by default, not a law.

### Being wrong without becoming a nuisance

Every decision is logged, including `keep` — an accuracy read that only saw the
switches would flatter the router. Each auto-switch's receipt carries one tap
that puts the old prompt back **and** records `user_corrected`, so a router the
user keeps overruling has the evidence to stop. Identical to Smart Filing's
propose → correct → auto-pause loop.

### The one honest limitation

`prompt_presets` has `neuron_ids`, `book_id` and `tool_permissions`, and they
are wired into the schema, but **the router does not apply context bindings**.
Retrieval is scoped by the loaded neurons, and routing rides *on* retrieval, so
a prompt that rebinds neurons would be deciding scope after scope was used.
Applying it from the next turn was rejected: the receipt would then describe a
scope the reply did not actually have. Bindings are therefore a manual-switch
feature, and are not yet surfaced in the UI. (`tool_permissions` may only ever
narrow the roster — granting stays with the existing permission gates.)

## Phase 3 — proposals the assistant earns

`supabase/functions/prompt-incubator-sweep` mirrors `incubator-sweep`, which
already proposes new neurons from orphaned memories:

1. A turn the router scored `propose_new` parks a ≤200-character gist.
2. The sweep embeds parked gists, clusters them greedily (≥5 members, cosine
   ≥0.62), and makes **one** structured drafting call per cluster.
3. A name colliding with an existing prompt is dropped; at most 3 proposals per
   user are ever pending.
4. The proposal appears in Settings → Prompts with its **exact body text**, the
   messages it was drafted from, and a plain statement that the AI wrote it.

**The safety property is structural, not procedural.** A proposal lives only in
`prompt_proposals` — a table the prompt builder never reads — so nothing the
assistant drafts has ever been in front of the model. Only the user pressing
Approve creates a `prompt_presets` row, and it is created **inactive with
routing off**: approving a suggestion means "this is worth keeping", not "start
using this on my next message". That is why this feature needs none of the
SECURITY DEFINER / GUC / immutable-row apparatus the Tool and Program Foundries
need — there is no draft state on the live table to escalate out of.

The sweep is triggered when the Prompt Library is opened, throttled to once per
six hours per device. It costs a model call, and the only place its output can
be seen is the panel the user just opened; a background schedule would spend
money drafting suggestions nobody is there to read.

The gists are quoted to the drafting model as **evidence to describe, never
instructions to follow** — but what makes that safe is the human gate, not the
wording.

## Why no chat tool

`CHAT_TOOL_DEFINITIONS.length === 80`, and `toolRosterBudget.test.ts` caps it at
80 with a documented rationale (measured degradation past 30–50 tools). Adding
`propose_prompt` would have meant spending that budget — and, worse, letting the
model suggest a prompt whenever it felt like it. Earning the suggestion from
accumulated evidence is both cheaper and better behaved.

## Applying the migration (the one user action)

Paste into Lovable's chat:

> Please run the repo migration
> `supabase/migrations/20260919000000_prompt_routing.sql` exactly as written,
> without modifications. It is idempotent and purely additive. Then redeploy the
> edge function `knowledge-retrieve` and deploy the new edge function
> `prompt-incubator-sweep`.

Until that is done the app behaves exactly as it does today: every client path
feature-detects on 42703 / PGRST204 / PGRST205, the routing UI does not appear,
and `ChatContext` never asks for routing. The migration was verified by applying
it twice against PGlite — existing presets keep their values, and all three
CHECK constraints refuse bad input.

## Not in this phase


- **Context bindings in the router** — see "The one honest limitation" above.
  The columns exist; applying them needs retrieval to be re-run inside the
  builder when a switch changes the neuron scope.
- **Auto-pause.** `promptRoutingAccuracy()` is written and returns the numbers;
  nothing reads it yet to switch routing off on the user's behalf.
- **Anchors.** Worth stating plainly, because it was asked for: an anchor in
  this codebase is a *locator* — a verified pointer from a memory card into a
  chapter — not a switchable mode. There is nothing to bind a prompt to. The
  real book-level tie is `book_id`, routed off the existing Counsel focus
  (`src/lib/counselFocus.ts`), and it is part of the unbuilt bindings work.
