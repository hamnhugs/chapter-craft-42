# Smart Filing — Intelligent Wiki Router

Builds on the multi-wiki foundation. Every newly extracted entry gets scored against wiki centroids; the system **always proposes, never dispatches**. A single "Suggestions" tab on the Wikis page is the only review surface.

## Principles (non-negotiable)
1. Always propose — never silently move or create a wiki.
2. Show *why* (e.g. "6 nearby notes in {Sourdough}").
3. One review surface: Suggestions tab on Wikis page.
4. Log every decision (signals + outcome + user correction) to learn per-wiki thresholds.
5. Cold-start guard: feature dormant until ≥2 wikis with ≥10 entries each.

## Decision tree (runs after each new entry is embedded)
Signals: `s_max`, `s_active`, `s_2nd`, `novelty` (mean cos-dist to k=8 NN in best wiki).

- **A.** `s_active ≥ 0.78` → assimilate to active. Silent. Log only.
- **B.** `s_max ≥ 0.78` and winner ≠ active and `s_max − s_2nd ≥ 0.08` → save to active **and** create reroute_suggestion.
- **C.** `0.55 ≤ s_max < 0.78` → assimilate to active. Silent.
- **D.** `s_max < 0.55` → save to active **and** copy into incubator (TTL 14d).

Hourly incubator sweep: cluster (pairwise ≥0.70, min size 3) → LLM proposes a name (self-consistency n=5, temp 0.7, ≥3/5 agreement) → rejection gates (name-collision >0.82 vs existing wiki names; must cite ≥2 noun-phrases not in nearest wiki's top-50 TF-IDF). Accept → `wiki_proposals` row. Reject → split into reroute_suggestions.

TTL expiry without a cluster: `s_max ≥ 0.45` → reroute_suggestion to nearest; else aggregate into "Orphan notes" item.

## Build order (each phase shippable)

### Phase 1 — Reroute suggestions MVP
- Migration: `wiki_centroids`, `reroute_suggestions`, `routing_decisions` (RLS: `user_id = auth.uid()` on all).
- New edge function `smart-file`: scores entry, applies A/B/C, writes tables. Called from `knowledge-extract` and `knowledge-ingest` after embedding.
- New edge function `recompute-centroids` (scheduled every 6h via pg_cron + pg_net).
- Suggestions tab on Wikis page (desktop + mobile) showing only reroute suggestions with [Move] [Keep] [Dismiss].
- Cold-start guard + on/off setting in `user_settings`.

### Phase 2 — New-wiki proposals
- Migration: `incubator_entries` (HNSW index), `wiki_proposals`.
- Edge functions: `incubator-sweep` (hourly, clustering + LLM naming + rejection gates), `accept-wiki-proposal`.
- Extend `smart-file` with path D (incubator insert).
- Suggestions tab gains "New Wiki Proposals" section with [Create] [Rename and create] [Dismiss].

### Phase 3 — Learning loop
- Full `routing_decisions` logging on every path.
- `recompute-centroids` refits per-wiki `confident_threshold` / `novelty_threshold` from accepted decisions (95th percentile of accepted `s_max`).
- SaneBox-style rule: 3+ consecutive dismissals on the same wiki pairing → +0.03 to that pairing's reroute threshold.

### Phase 4 (deferred) — Wiki drift detection
Skip for v1. Surface "two wikis are converging" when centroid cos > 0.85.

## Mobile UI rules
- Sticky "Suggestions (N)" chip when scrolled.
- Full-width cards, stacked actions.
- Swipe right = primary action; swipe left = dismiss; long-press = "Why?" bottom-sheet (use `react-swipeable`, not a carousel lib).
- Proposals collapsed by default → tap opens shadcn Sheet (`side="bottom"`) with full justification, source entries, and pinned actions.

## Voice mode integration
New chat tools in `src/lib/chatTools.ts`:
- `list_pending_suggestions` — top 10 pending across both tables.
- `accept_wiki_proposal({ proposal_id, final_name? })`.
- `bulk_accept_reroutes({ suggestion_ids })`.
- `dismiss_suggestion({ id, kind })`.

Add to voice-mode rules block in `buildChatSystemPrompt.ts`: triggers on "what's pending / any suggestions / route my orphans / approve it / create the wiki" — must call the tool, never claim success without an ok response, confirm + offer next item.

## Research bibliography
Write `docs/smart-filing-research.md` containing the full bibliography (neuroscience: SLIMM, DG/CA3, locus coeruleus, Sekeres 2024; ML: Volkov & Averkin 2024, D'Oosterlinck 2024, Lu 2025, Sun 2022, Yadkori 2024, Yang 2024; dynamic taxonomy: HDP, BERTrend, CRP, CEMIL, TELEClass, Mu 2016; industry: Mem, Capacities, Tana, SaneBox, Hey, Gmail). No UI hook — reference only.

## Guardrails
- Match embedding dimension already in `knowledge_entries.embedding_v2` (this project is on **halfvec(1536)** — confirmed in schema). Centroids and incubator use the same.
- Cap pending proposals at 10; queue silently beyond.
- Wiki count >12 → one-time consolidation hint.
- Don't break: existing wiki-scoping (knowledge-retrieve filter, ChatPanel `activeWikiId`, WikiPanel filter), conflict/sleep-cycle pipeline, existing chatTools.

## Technical notes
- `wiki_centroids.centroid` = `halfvec(1536)`. Recompute = mean of `embedding_v2` across wiki entries.
- `smart-file` reads centroids via a new RPC `score_entry_against_wikis(embedding, user_id)` returning top-k (wiki_id, sim) rows — keeps cosine math in Postgres.
- Hourly/6h jobs: `pg_cron` + `pg_net` invoking the edge functions (per project convention — schedule SQL run via insert tool, not migration).
- All new edge functions: `verify_jwt = true` (default), CORS via `npm:@supabase/supabase-js@2/cors`.
- LLM calls go through `resolveWikiLlm` (same pattern as `knowledge-ingest`) so user's chosen wiki model is honored.

## Verification per phase
1. Create 2 wikis with 10+ entries each → extract a new entry that better fits the non-active wiki → reroute suggestion appears in Suggestions tab. Accept → entry moves.
2. Ingest a batch of off-topic entries → after hourly sweep, a wiki proposal appears with sensible name + 3 source entries. Accept → new wiki created, entries reassigned.
3. Dismiss 3 reroutes for the same pairing → threshold for that pairing rises by 0.03 in `wiki_centroids`.
4. Voice: say "what's pending" → assistant calls `list_pending_suggestions` and reads top items. Say "do it" → bulk accept fires, confirmation only after ok.
