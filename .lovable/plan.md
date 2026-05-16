## Problem

The app references three database objects that don't exist in the backend:

1. `user_settings.is_recording_mode` column — read/written by `getMemoryMode`/`setMemoryMode` in `src/lib/knowledgeApi.ts` and by `checkRecordingMode` in `supabase/functions/_shared/memory-layers.ts`.
2. `public.episodic_log` table — read by `fetchEpisodicLog` and written by `logEpisode`.
3. `public.consolidation_queue` table — read by `fetchConsolidationQueue` and written by `enqueueEntry` / `enqueueConflictStaged` / `markProcessed`.

The code (and the shared "Layered Memory Stack" module) was shipped but the schema migration never ran, so every call fails with "not found in schema cache".

## Fix

Run one migration that adds the missing column and two tables, with proper RLS (user-scoped, matching the rest of the project).

### Schema changes

- `user_settings`
  - Add `is_recording_mode boolean NOT NULL DEFAULT true`.

- `public.episodic_log`
  - `id uuid pk`, `user_id uuid not null`, `session_id uuid not null`,
    `summary text`, `key_facts jsonb not null default '[]'`,
    `entry_count int not null default 0`, `created_at timestamptz default now()`.
  - Indexes: `(user_id, created_at desc)`, `(user_id, session_id)`.
  - RLS: owner-only SELECT/INSERT/UPDATE/DELETE (`auth.uid() = user_id`).

- `public.consolidation_queue`
  - `id uuid pk`, `user_id uuid not null`,
    `entry_id uuid null` (nullable for `conflict_staged`),
    `reason text not null` (check in `'conflict_staged','new_entry','orphan'`),
    `priority int not null default 5`,
    `pending_data jsonb null`,
    `processed_at timestamptz null`,
    `created_at timestamptz default now()`.
  - Unique partial index on `(user_id, entry_id, reason) where entry_id is not null` to support the `onConflict` upsert in `enqueueEntry`.
  - Index `(user_id, processed_at, priority, created_at)` for the queue read in `fetchConsolidationQueue`.
  - RLS: owner-only SELECT/INSERT/UPDATE/DELETE.

### Out of scope

- No app code changes — the existing `knowledgeApi.ts` and edge function helpers already match this shape.
- No changes to existing tables besides the one new column.

After approval I'll create the migration; once it runs the three errors disappear.