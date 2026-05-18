# Fix wiki scoping across read paths

The migrations and wikis table are correct. Three read-path bugs cause "new wiki shows everything" and "chat still uses original wiki". Apply all three; bug 2 must be shipped as one coherent change so the chat pipeline is consistent end-to-end.

## Bug 1 — WikiPanel ignores active wiki (2-line fix)

**File:** `src/components/WikiPanel.tsx`

- Destructure `activeWikiId` from `useApp()` (alongside the existing `activeWiki`).
- Pass it to `fetchKnowledgeEntries(activeWikiId)` inside `loadData`.
- Add `activeWikiId` to the `useCallback` dependency array so it re-runs on switch.

No backend changes — `fetchKnowledgeEntries(wikiId)` already routes through the `entries_for_wiki` RPC which returns native + bridged entries scoped to that wiki.

## Bug 2 — Chat retrieval has zero wiki awareness (4 files, ship together)

**(a) `supabase/functions/knowledge-retrieve/index.ts`**
- Add `wiki_id = null` to the request body destructure.
- After the `seeds[]` array is built (covers both hybrid and FTS fallback paths), if `wiki_id` is set, post-filter seeds to entries where `wiki_id` matches OR `wiki_id IS NULL` OR the entry is bridged into the active wiki (lookup via `entry_bridges`).
- Apply the same allow-set filter to the `neighbors` array before merging into `nodeMap`.
- Keep `wiki_id === null` behavior unchanged (legacy/all-entries).
- Redeploy the function.

**(b) `src/lib/knowledgeApi.ts`**
- Extend `retrieveKnowledge` signature: `opts: { depth?; match_count?; deep?; wiki_id?: string | null }`. Spread into the edge call body.

**(c) `src/lib/buildChatSystemPrompt.ts`**
- Add `activeWikiId?: string | null` to `BuildOpts`.
- Pass `wiki_id: activeWikiId ?? null` to `retrieveKnowledge(...)`.
- Pass `activeWikiId ?? null` to the `fetchKnowledgeEntries(...)` fallback.

**(d) `src/components/ChatPanel.tsx`**
- At each `buildChatSystemPrompt({...})` call site, add `activeWikiId` to the options object (already in scope from `useApp()`).

## Bug 3 — Voice/AI switch_wiki doesn't refresh React state (polish)

**File:** `src/lib/chatTools.ts`
- After successful `switch_wiki` and after `create_wiki` when `activate: true`, dispatch `new CustomEvent("wiki-active-changed")` on `window` (guarded by `typeof window !== "undefined"`).

**File:** `src/context/AppContext.tsx`
- In `AppProvider`, add a `useEffect` that listens for `wiki-active-changed` on `window` and calls `refreshWikis()` (or whatever currently refetches active wiki id + list). Clean up on unmount.

## Verification

1. Create empty wiki → Load → Wiki tab shows empty state (not all entries).
2. Ask chat a question while empty wiki is active → response does not surface entries from the original wiki.
3. Say "switch to my X wiki" in chat → header chip and Wiki tab update without page reload.

## Out of scope

- No migrations, no changes to `hybrid_search_knowledge` / `get_neighbors` / `entries_for_wiki` RPCs.
- No changes to the wikis table, embeddings pipeline, or voice/TTS work.
