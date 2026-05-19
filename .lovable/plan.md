# Smart Filing — Phases 2–4

Phase 1 (Reroute MVP) shipped. Here's what to build next, in order.

## Phase 2 — Incubator (new-wiki proposals)

**Goal:** when a new entry doesn't fit any existing wiki well, hold it aside, cluster siblings, and propose a brand-new wiki once a real cluster forms.

- New tables
  - `incubator_entries` — entry_id, embedding (halfvec 1536), reason, created_at, expires_at (14-day TTL), status (`pending` | `clustered` | `expired` | `promoted`)
  - `wiki_proposals` — proposed_name, member_entry_ids[], rationale, sample_titles[], status (`pending` | `accepted` | `dismissed`)
- `smart-file` extension: when `s_max < novelty_threshold` (default 0.55) and not a confident assimilate, write to `incubator_entries` instead of forcing a reroute.
- New scheduled edge function `incubator-sweep` (hourly, pg_cron)
  - Pull pending incubator rows for each user
  - HDBSCAN-lite clustering on embeddings (min cluster size 5)
  - For each cluster: call Gemini 2.5 Flash with self-consistency n=5 to propose a wiki name; only keep names that survive ≥3 of 5 runs AND pass the 0.82 cosine name-collision gate against existing wiki names
  - Insert `wiki_proposals` row; mark members `clustered`
  - Expire rows past TTL
- Suggestions tab gets a second card type: "New wiki proposal" with sample titles preview, Accept / Dismiss.
- Accept → create wiki, move members, run `recompute-centroids` for the new wiki.

**Cold-start guard:** incubator stays dormant until ≥2 wikis with ≥10 entries each (same gate as Phase 1).

## Phase 3 — Learning loop

**Goal:** thresholds adapt to the user instead of staying at defaults.

- `recompute-centroids` extension: after each run, look at the last 90 days of `routing_decisions` for that wiki and adjust per-wiki:
  - `confident_threshold` ← p60 of similarity scores where user kept the suggested wiki
  - `novelty_threshold` ← p20 of similarity scores where user accepted a new-wiki proposal
  - Clamp to `[0.65, 0.92]` and `[0.40, 0.65]` respectively
- Track acceptance/rejection rates per suggestion type; if reject rate >70% over last 20 suggestions, auto-pause Smart Filing and surface a banner explaining why.
- Add a "Routing accuracy" mini-stat to the Suggestions tab header (e.g. "82% of recent suggestions accepted").

## Phase 4 — Drift detection

**Goal:** notice when a wiki's contents have wandered from its name/description and offer a split or rename.

- Nightly job `wiki-drift-check`
  - For each wiki: compute cluster cohesion (avg pairwise cosine within wiki) and bimodality (silhouette on k=2 split)
  - If silhouette > 0.35 AND wiki has ≥30 entries → propose a split with two candidate names (same self-consistency naming as Phase 2)
  - If centroid has drifted >0.25 cosine from the embedding of the wiki's name+description → propose a rename
- Surface in Suggestions tab as a third card type: "Wiki health" with Split / Rename / Dismiss actions.

## Build order

1. Phase 2 tables + `smart-file` incubator branch
2. `incubator-sweep` edge function + pg_cron schedule
3. Suggestions tab — new-wiki proposal card + accept flow
4. Phase 3 learning loop in `recompute-centroids`
5. Phase 3 auto-pause + accuracy stat
6. Phase 4 drift check + UI card

Each phase ships independently and is gated by the same cold-start rule. Suggestion cap stays at 10 total across all card types.

## Technical notes

- All new tables: RLS by `user_id`, halfvec(1536) for embeddings, indexes on `(user_id, status)`.
- Self-consistency naming uses `google/gemini-2.5-flash` (cheap, fast); falls back to `gemini-2.5-flash-lite` if rate-limited.
- pg_cron schedules go through the insert tool (not migrations) so they don't run on remixes.
- No new secrets needed — Lovable AI Gateway covers all LLM calls.