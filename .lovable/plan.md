## Bundle received

All 15 files extracted. Before applying, two real conflicts need a decision — silently proceeding would break existing features.

---

## 🔴 Blocker 1: Embedding column collision

Your `knowledge_entries.embedding` column already exists as **`vector(768)`** (Gemini, used by `_shared/embed.ts`, `match_knowledge`, `hybrid_search_knowledge`, the existing `knowledge-retrieve` and `knowledge-embed` functions).

Migration `0002` does `ADD COLUMN IF NOT EXISTS embedding halfvec(1536)` — because the column already exists, **this silently no-ops**, and then every new `embed-entries` / `search-knowledge` / `wiki-embed.ts` call will fail when it tries to write 1536-dim vectors into a 768-dim column.

### Options

**A. Side-by-side (safest, recommended)** — Rename the new column to `embedding_v2 halfvec(1536)`, point all 4 new/updated functions and the `match_knowledge_entries` RPC at `embedding_v2`. Old retrieval keeps working untouched. Cost: a bit of code patching in the bundle files, two columns on the table.

**B. Cutover** — Drop existing `embedding` column (+ the two RPCs that depend on it) and recreate as `halfvec(1536)`. Then re-embed everything via `embed-entries`. Breaks `knowledge-retrieve` / `knowledge-embed` / `hybrid_search_knowledge` until they're rewritten. Existing 768-dim embeddings are lost.

**C. Park the search feature** — Apply everything *except* migration `0002`'s embedding pieces and the `embed-entries` / `search-knowledge` functions. Wikis + bridges + meta-wiki still work; semantic search across wikis is deferred.

---

## 🟡 Blocker 2: All 5 overwrite files have diverged

The bundle's overwrites are based on an older snapshot. Current files are larger (Inworld TTS persistence, wiki-conflict chat tools, etc. landed since):

| File | Bundle | Current |
|---|---|---|
| ChatPanel.tsx | 396 | 512 |
| WikiPanel.tsx | 718 | 787 |
| AppContext.tsx | 465 | 463 |
| Index.tsx | 126 | 217 |
| knowledgeApi.ts | 261 | 302 |

Straight overwrite would wipe: Inworld TTS UI hooks in ChatPanel, recent WikiPanel features, and added `knowledgeApi` exports (conflicts, sleep-cycle, etc.).

**Plan:** I will **merge, not overwrite** — keep all current code intact and only graft in the wiki additions called out in your notes (B) and (C):
- `wiki_id` param + `active_wiki_id` fallback in extract/ingest
- wiki-scoped dedup, `wiki_id` stamped on inserts, auto-embed call
- `activeWikiId`/`activeWiki` from `useApp` threaded into ChatPanel
- "Your Knowledge Wiki: [name]" heading in system prompt
- New `wikisApi` exports + `WikiLibrary` / `WikiQuickSwitcher` wired into `Index`/`AppContext`

---

## Execution sequence (after you pick A/B/C)

1. **Migration 0001** (wikis table, `wiki_id` column, backfill "My Wiki" for existing users, set `active_wiki_id`) — clean, no conflicts.
2. **Migration 0002** — applied per your choice above (A patches column name to `embedding_v2`; B drops+recreates; C skips).
3. **Drop in 7 new files** as-is: `wiki-embed.ts`, `embed-entries/`, `search-knowledge/`, `wikisApi.ts`, `WikiLibrary.tsx`, `WikiQuickSwitcher.tsx`.
4. **Merge** the 5 overwrite files into current versions (additions only — nothing removed).
5. **Deploy** edge functions: `embed-entries`, `search-knowledge`, `knowledge-extract`, `knowledge-ingest`.
6. **Smoke tests:**
   - SQL check: every existing user has a "My Wiki" + `active_wiki_id` set + all entries have `wiki_id`.
   - `POST /embed-entries { backfill: true, limit: 50 }` → embeddings populate (option A only — uses `embedding_v2`).
   - `POST /search-knowledge { query: "...", limit: 5 }` → ranked results with `wiki_name`.
7. **Report back** with results / any failures.

---

**Which option for the embedding column — A, B, or C?** Once you answer I'll execute end-to-end.