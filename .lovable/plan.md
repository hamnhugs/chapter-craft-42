# Fix: Wiki tab doesn't reflect the loaded wiki

## Root cause

The Wiki tab (`WikiPanel`) only filters **entries** by `activeWikiId`. Everything else it shows — memory graph, conflicts, episodic log, consolidation queue, plus side-effect actions (Sleep Cycle, Reindex, Health Check / Lint) — runs **globally across all wikis**. There is also no visible indicator of which wiki is loaded (the header always says "Knowledge Wiki"). The net effect: switching wikis silently changes the entry list under the hood but the panel still looks like the "original" (default) wiki, because the graph, conflicts, episodes, queue, and header are identical.

Sales Wiki actually has 6 entries assigned and My Wiki has 79 — the data is partitioned correctly. The UI just doesn't expose it.

No features get removed; everything becomes wiki-scoped with an explicit "All wikis" escape hatch where it makes sense.

## What changes

### 1. Wiki identity in the header (`WikiPanel.tsx`)
- Replace static "Knowledge Wiki" title with the active wiki's `name`, with `description` as the subtitle and a small `cover_color` swatch.
- Add an inline **wiki switcher** (shadcn `Select` or `Popover` + command list) next to the title — driven by `wikis` + `setActiveWiki` from `AppContext`. Lets the user change wikis without leaving the tab.
- Show an "entries: N · bridged: M · last loaded: …" meta row.
- Empty state: when the active wiki has 0 entries, render a clear "This wiki is empty — ingest a book or switch wikis" card instead of looking identical to a populated one.

### 2. Scope all data fetches to the active wiki
Extend `knowledgeApi.ts` to accept an optional `wikiId` and filter accordingly. All callers in `WikiPanel` pass `activeWikiId`.

- **`fetchMemoryGraph(wikiId?)`** — filter edges whose `source_entry_id` *and* `target_entry_id` are in `entries_for_wiki(wikiId)`. Implement as a new SQL function `memory_graph_for_wiki(target_wiki_id uuid)` (SECURITY INVOKER, `auth.uid()` scoped) returning the same shape as the table. Avoids large client-side joins.
- **`fetchConflicts(wikiId?, status?)`** — same pattern via `conflicts_for_wiki(target_wiki_id)` joining on `entry_a`/`entry_b`.
- **`fetchEpisodicLog(limit, wikiId?)`** — add nullable `wiki_id` column to `episodic_log` (already user-scoped). New rows record their wiki; old rows return when `wikiId` is null OR matches. UI shows a small "global" badge for legacy null rows.
- **`fetchConsolidationQueue(includingProcessed, wikiId?)`** — filter via join on `entry_id → knowledge_entries.wiki_id` (or `entries_for_wiki` for bridges).
- **`runLint(wikiId?)`**, **`reindexEmbeddings(all_missing, wikiId?)`**, **`triggerSleepCycle(wikiId?)`** — forward `wiki_id` to their edge functions; functions filter their working set by `wiki_id` when provided, otherwise keep current global behaviour. Default invocation from `WikiPanel` always passes the active wiki.
- **`ingestBook`** — already accepts `wikiId`; verify the panel always passes `activeWikiId` (currently does).

### 3. Optional "All wikis" scope toggle
Small segmented control in the header: `This wiki` (default) ↔ `All wikis`. Passing `null` to the new APIs preserves today's global behaviour for power users who want the cross-wiki view. Persist preference per-session in `useState` (not in DB).

### 4. Wiki-scoped counters / badges
- Conflicts button badge counts only open conflicts in the active wiki (under current scope).
- Episodes / Queue counts respect scope.
- Sleep Cycle report continues to render verbatim from the edge function response.

### 5. Loading & error UX
- Show a skeleton while `activeWikiId` is `null` (initial bootstrap) rather than running fetches with `null` and rendering an empty graph.
- If `setActiveWiki` fails, surface the toast and don't switch tabs (already mostly handled in `WikiLibrary.handleLoad`).

## Technical details

**New SQL functions** (one migration, all `SECURITY INVOKER`, `set search_path = public`):

```sql
create or replace function public.memory_graph_for_wiki(target_wiki_id uuid)
returns setof public.memory_graph
language sql stable
as $$
  with scope as (select id from public.entries_for_wiki(target_wiki_id))
  select g.* from public.memory_graph g
  where g.user_id = auth.uid()
    and g.source_entry_id in (select id from scope)
    and g.target_entry_id in (select id from scope);
$$;

create or replace function public.conflicts_for_wiki(target_wiki_id uuid)
returns setof public.knowledge_conflicts
language sql stable
as $$
  with scope as (select id from public.entries_for_wiki(target_wiki_id))
  select c.* from public.knowledge_conflicts c
  where c.user_id = auth.uid()
    and (c.entry_a in (select id from scope) or c.entry_b in (select id from scope));
$$;
```

**Schema additions:**
- `alter table episodic_log add column wiki_id uuid` (nullable; index on `(user_id, wiki_id, created_at desc)`).
- Update the writer (the `sleep-cycle` / consolidation paths that insert into `episodic_log`) to stamp `wiki_id` from the triggering context. Old rows stay null and surface in both scopes.

**Edge functions to update** (add optional `wiki_id` body param, default global):
- `lint-knowledge` (or whichever powers `runLint`) — filter `knowledge_entries` query by `wiki_id`.
- `reindex-embeddings` — same filter.
- `sleep-cycle` — pass `wiki_id` through to its consolidation/prune queries; stamp `episodic_log.wiki_id` on insert.

**Frontend:**
- `WikiPanel`: header rewrite (title = active wiki name, switcher, scope toggle), all `loadData` calls pass `activeWikiId`, count badges respect scope.
- `knowledgeApi.ts`: extend signatures; default arguments preserve current behaviour for any other callers (chat tools etc.). Audit `src/lib/chatTools.ts` and `src/lib/buildChatSystemPrompt.ts` — leave their calls untouched (they should remain global or already pass a wiki).

**Why not just rename the title?** Because the *data* shown (graph, conflicts, episodes, queue) doesn't change between wikis today — the panel would still misrepresent reality. Scoping the fetches is the actual fix; the header update makes the scoping legible.

## Out of scope
- No removal of global views — preserved via the scope toggle.
- No changes to `WikiLibrary`, Smart Filing pipeline, or chat ingest.
- No change to RLS policies (the new SQL functions rely on existing per-row policies via `auth.uid()`).

## Build order
1. Migration: new SQL functions + `episodic_log.wiki_id` column + index.
2. Edge function updates (`lint`, `reindex`, `sleep-cycle`) to accept & honour `wiki_id`.
3. `knowledgeApi.ts` signature extensions.
4. `WikiPanel` header rewrite + scoped fetches + scope toggle.
5. Manual QA: load each wiki, confirm entries / graph / conflicts / episodes / queue all change; toggle "All wikis" and confirm prior global behaviour returns.
