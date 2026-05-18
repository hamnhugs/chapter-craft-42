## Remaining work (continuing Option A: side-by-side `embedding_v2`)

Database + new files are already in place. Five items left:

### 1. `Index.tsx` — surface wikis in the shell
- Add a "Wikis" tab/route that renders `<WikiLibrary />`
- Add active-wiki badge + `<WikiQuickSwitcher />` in the header (Cmd/Ctrl+K)
- Pull `activeWiki` from `useApp()`; no business-logic changes

### 2. `knowledge-extract` edge function — wiki-aware extraction
- Accept optional `wiki_id` in the request body; fall back to `user_settings.active_wiki_id`
- Scope existing dedup lookup to that `wiki_id`
- Stamp `wiki_id` on every inserted `knowledge_entries` row
- After insert, fire-and-forget call to `embed-entries` for the new IDs
- Preserve all current Inworld/lint/consolidate behavior

### 3. `knowledge-ingest` edge function — same wiki plumbing
- Same `wiki_id` param + `active_wiki_id` fallback
- Wiki-scoped dedup, `wiki_id` stamped on inserts, post-insert embed call

### 4. Chat threading
- `ChatPanel.tsx`: read `activeWikiId` / `activeWiki` from `useApp()`, show "Your Knowledge Wiki: <name>" heading, pass `wiki_id` to extract/ingest calls
- `buildChatSystemPrompt.ts`: include the active wiki name + a hint that retrieval is scoped to it
- Wire `searchKnowledge` (from `wikisApi`/`knowledgeApi`) into the existing retrieval tool path, filtered by `activeWikiId`

### 5. Deploy + smoke tests
- Deploy: `embed-entries`, `search-knowledge`, `knowledge-extract`, `knowledge-ingest`
- Smoke tests via `curl_edge_functions`:
  1. **Backfill check** — `read_query` confirms every existing user has a default wiki and `active_wiki_id` set
  2. **embed-entries** — call on 1–2 recent entry IDs, confirm `embedding_v2` populated and `embedding_model` stamped
  3. **search-knowledge** — query with a known phrase, confirm hits scoped to active wiki
  4. **End-to-end** — create a new wiki via UI flow (or direct insert), run ingest with that `wiki_id`, confirm entries land in the right wiki and become searchable
- Report results inline; if any step fails, stop and surface the error rather than looping

### Notes / non-goals
- No changes to existing 768-dim `embedding` column or `match_knowledge` / `hybrid_search_knowledge` — old retrieval keeps working
- No new secrets (LOVABLE_API_KEY already covers embeddings via the gateway)
- Types regen deferred; `as any` casts stay until you run `supabase gen types` locally

Approve and I'll execute steps 1–5 in order.
