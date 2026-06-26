# Memory Cleanup Suggestions

Give the AI a way to flag memory entries that should be deleted, surface them with a red highlight in the wiki, and add a "Cleanup" side panel in the BRAIN tab where the user can review and bulk-delete everything in one click.

## What the user sees

1. **Red highlight in the wiki** — any entry the AI has flagged shows a red left border, a red "Cleanup suggested" chip, and the reason on hover.
2. **New "Cleanup" button** in the BRAIN tab toolbar (right next to "Images"). Shows a red badge with the count of flagged entries.
3. **Side panel slides in from the right** (same pattern as Images panel) listing every flagged entry with:
   - Title, snippet, wiki name, flagged date
   - Reason the AI flagged it (duplicate / low-confidence / stale / contradicted / empty / superseded)
   - Individual "Keep" (dismiss flag) and "Delete" buttons
   - Search box to filter
   - Multi-select with "Select all"
   - **"Delete all selected"** button with one confirmation dialog
4. **Safety rail**: confirmation dialog shows count + "This cannot be undone." Admin/paid users can opt into a 7-day soft-delete recycle window (Phase 2, not in this build).

## How the AI flags entries

A new background edge function `memory-cleanup-scan` runs on demand (button: "Re-scan memory") and after each Sleep Cycle. It walks the user's entries for the active wiki and writes flags into a new `cleanup_flags` table. Reasons it can assign:

- **duplicate** — cosine similarity ≥ 0.95 to a newer entry (keep the newest, flag the older)
- **low_confidence** — `confidence < 0.3` and never referenced by chat
- **stale** — not retrieved in 180+ days AND superseded by a newer entry on the same concept
- **contradicted** — appears in `knowledge_conflicts` on the losing side
- **empty_or_trivial** — content < 40 chars after trim, or just a heading
- **atomicity_violation** — `atomicity_warning is not null` for 30+ days with no edits

The AI in chat can also call a new tool `flag_for_cleanup(entry_id, reason, note)` when the user says things like "this is junk" or "forget that."

## Data model

New table `public.cleanup_flags`:

```text
id              uuid pk
user_id         uuid  (RLS: auth.uid())
wiki_id         uuid
entry_id        uuid  -> knowledge_entries(id) on delete cascade
reason          text  (enum-checked)
note            text  (optional, AI's short explanation)
confidence      real  (how sure the AI is, 0-1)
flagged_by      text  ('scan' | 'chat' | 'user')
created_at      timestamptz default now()
unique(entry_id, reason)
```

RLS: owner-only select/insert/update/delete. Service role full. Grants for `authenticated`.

## Files to add / change

**New**
- `supabase/migrations/<ts>_cleanup_flags.sql` — table, indexes, RLS, grants
- `supabase/functions/memory-cleanup-scan/index.ts` — scan + populate flags for a `wiki_id`
- `src/components/CleanupPanel.tsx` — side panel (mirrors `ImagesPanel.tsx` structure)
- `src/lib/cleanupFlags.ts` — `listFlags`, `dismissFlag`, `bulkDeleteEntries`, `rescan`, realtime subscription

**Changed**
- `src/components/WikiLibrary.tsx` — add Cleanup button to BRAIN toolbar with red count badge; mount `<CleanupPanel />`
- `src/components/WikiPanel.tsx` — red left-border + chip when an entry has any active flag; tooltip with reason
- `src/lib/chatTools.ts` — register `flag_for_cleanup` tool
- `src/lib/buildChatSystemPrompt.ts` — short instruction telling the AI when to flag

## Best-practice details

- **Server-authoritative delete**: bulk delete goes through a single `delete_entries_bulk(uuid[])` RPC so RLS + cascade handles `image_attachments`, `memory_graph`, `entry_bridges`, and `cleanup_flags` atomically — no orphans, same fix pattern used after the image-delete bug.
- **Optimistic UI with reconcile** (same `recentlyDeletedRef` pattern as `ImagesPanel`) so realtime can't resurrect a row the user just removed.
- **Throttled rescan** — button disabled while a scan is running; progress toast.
- **Accessibility** — red highlight pairs with a "Cleanup suggested" text label and an icon, never color alone (WCAG 1.4.1).
- **Reversible per-item dismiss** — "Keep" sets `dismissed_at` rather than hard-deleting the flag, so the scanner won't immediately re-raise it.

## Out of scope (can come later)

- 7-day soft-delete recycle bin
- Scheduled nightly auto-scan
- "Auto-delete anything flagged 30+ days ago" toggle
