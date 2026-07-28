# Bi-temporal supersession ("the memory time axis")

Shipped 2026-07-27 on `new1`. Applies the VGMS 4D-axis design (Zep/Graphiti-style
bi-temporal facts: supersede, never delete) to Chapter Craft's knowledge graph.

## What changes

Before: correcting a memory overwrote it in place; resolving a conflict hard-deleted
the losing entry. History was unrecoverable and "what did I believe before?" was
unanswerable.

After (once the migration is applied):

- **Corrections create lineage.** `supersede_knowledge_entry` writes the corrected
  entry and retires the old one — `valid_to` closes its belief window,
  `superseded_by` links old → new, `archived=true` removes it from spaced reviews.
  Graph edges and wiki bridges move to the living entry; the Sleep Cycle is queued
  to grow fresh edges (priority 3).
- **Conflict resolution stops destroying evidence.** `keep_a_delete_b` /
  `keep_b_delete_a` retire the loser (linked to the winner); `merge` creates one
  successor that supersedes BOTH originals; `edit_a`/`edit_b` with content changes
  supersede instead of patching. Falls back to the legacy delete/patch only while
  the migration is unapplied.
- **History is queryable.** `entry_lineage(entry_id)` walks the chain both ways
  (handles merge DAGs); the assistant exposes it as the `get_memory_history` chat
  tool, and corrects facts via the `supersede_memory_entry` tool (gated by the
  existing "Edit memory entries" permission plus its own toggle).
- **Retrieval shows current truth only.** `entries_for_wiki` (WikiPanel + chat
  fallback) excludes superseded rows in-database; `search_wiki` and the unscoped
  entry list filter client-side; graph-aware retrieval results are post-filtered in
  `buildChatSystemPrompt` (`filterSupersededNodes`) because the deployed
  `knowledge-retrieve` / `search-knowledge` functions predate the upgrade.

## Applying the migration (required — git push does NOT run migrations)

`supabase/migrations/20260728000000_bitemporal_supersession.sql` is idempotent and
purely additive. Apply it — along with `20260727120000_chat_persistence.sql` if
that one is still pending — via the SQL editor, or paste this into Lovable chat:

> Please run the repo migrations `supabase/migrations/20260727120000_chat_persistence.sql`
> (if not yet applied) and `supabase/migrations/20260728000000_bitemporal_supersession.sql`
> exactly as written, without modifications. Both are idempotent and additive.

Until applied, everything keeps working exactly as before — the client
feature-detects (42703 / PGRST204 / 42883 / PGRST202) and uses legacy behavior,
and the new chat tools explain that the upgrade is pending.

## Feature-detection contract

`isMissingSupersessionSchema(err)` in `src/lib/knowledgeApi.ts` is the single
predicate; `SUPERSESSION_MIGRATION_MESSAGE` is the user-facing explanation. Same
pattern as `isChainsMigrationMissing` / `mastersMigrated`.

## Known limitations / follow-ups

- Deployed edge functions still *match* retired rows server-side (they predate
  the filter); the client drops them before the prompt is built. A future Lovable
  prompt can add `AND superseded_by IS NULL` to `match_knowledge_entries` /
  `hybrid_search_knowledge` / `search-knowledge` for defense in depth.
- Superseded rows keep their embeddings; `knowledge-consolidate` may occasionally
  route one through the queue — harmless (it's archived) but could be filtered in
  a future function redeploy.
- No WikiPanel history UI yet — history is reachable through the assistant's
  `get_memory_history` tool. A "History" drawer on the entry card is the natural
  next step.
- `conversation_memory` (the assistant's own cross-session summary + key facts)
  still has no validity model — candidate for the same treatment later.
