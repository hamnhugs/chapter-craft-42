
# Infinite-Brain Upgrade: Plan

Implements all 5 audit findings. Patterns drawn from Supabase hybrid-search docs (RRF over pgvector + tsvector), Microsoft GraphRAG (vector → graph expansion), and the three-layer contradiction model (detect on ingest, store negative edge, surface in retrieval).

---

## Phase 1 — Database foundations (one migration)

**Atomicity gate**
- Add validation trigger on `knowledge_entries`: reject `content` > 1500 chars or with more than 1 top-level `##` heading (one-claim-per-node rule). Soft warning column `atomicity_warning text` for borderline cases.

**Vector layer**
- Enable `pgvector` extension.
- Add `knowledge_entries.embedding vector(1536)` + `tsv tsvector` generated column (title + content).
- HNSW index on `embedding` (cosine), GIN index on `tsv`.

**Edge taxonomy & integrity**
- Add CHECK constraint on `memory_graph.relationship` (enum-style: `contradicts, refutes, supports, extends, derived_from, prerequisite, relates_to, mentions`).
- Add `memory_graph.edge_class text` derived via trigger: `structural` (contradicts/refutes/supports/extends/derived_from/prerequisite) vs `associative` (relates_to/mentions).
- Add `memory_graph.weight float default 1.0` and `created_by text` ('ingest'|'lint'|'user').
- Unique index `(source_entry_id, target_entry_id, relationship)` to prevent dupes.

**RPC functions (security definer, user-scoped via auth.uid())**
- `match_knowledge(query_embedding, match_count, book_filter)` — cosine kNN.
- `hybrid_search_knowledge(query_text, query_embedding, match_count)` — RRF fusion of tsvector + vector (Supabase pattern).
- `get_neighbors(entry_id, depth int, classes text[])` — recursive CTE, bidirectional traversal, returns rows with `hop`, `path`, `relationship`.
- `find_contradictions(entry_id)` — returns entries connected via `contradicts`/`refutes` in either direction.

**Conflict alerts table**
- New `knowledge_conflicts (id, user_id, entry_a, entry_b, kind, rationale, status, created_at)`; RLS by `user_id`; status enum `open|acknowledged|resolved|dismissed`.

## Phase 2 — Embedding pipeline

- New edge function `knowledge-embed`:
  - Input: `{ entry_ids?: string[], all_missing?: bool }`.
  - Calls Lovable AI Gateway embeddings endpoint (`google/text-embedding-004` or OpenAI `text-embedding-3-small` — use whichever the gateway exposes; fallback: store text and skip if unavailable).
  - Batches up to 50, writes `embedding`.
- Trigger embed automatically inside `knowledge-extract` and `knowledge-ingest` right after insert/update.
- Backfill: one-off call `{all_missing: true}` from the WikiPanel toolbar ("Reindex" button).

## Phase 3 — Ingest pipeline upgrades

`knowledge-extract` and `knowledge-ingest` both get:

1. **Atomicity split step** — before insert, ask the LLM (tool call `split_if_compound`) to break any candidate entry > 1500 chars or covering >1 distinct claim into atomic children. Reject anything that still violates after one split pass.
2. **Conflict probe** — for each candidate entry:
   - Embed candidate.
   - `match_knowledge` top-5 nearest existing entries (full content, not 200-char preview).
   - Tool call `assess_conflicts` returns `[{target_id, kind: contradicts|refutes|supersedes|consistent, rationale}]`.
   - Insert non-`consistent` rows into `memory_graph` with proper relationship + into `knowledge_conflicts` as `open`.
3. **Edge class auto-tag** — relationship value drives `edge_class` via trigger; no client logic needed.

## Phase 4 — Graph-aware retrieval (the big win)

Rewrite `src/lib/buildChatSystemPrompt.ts`:

1. Embed the user's last message (call new `knowledge-embed` with `text` mode, returns vector to client; or do retrieval server-side via a new `knowledge-retrieve` function — preferred, keeps embedding key server-side).
2. New edge function `knowledge-retrieve`:
   - `hybrid_search_knowledge(query, embedding, 12)` → seed nodes.
   - `get_neighbors(seed_ids, depth=2, classes=['structural'])` → expansion set, prefer `contradicts`/`refutes`/`supports`.
   - Dedupe, rank by `seed_score * 0.7 + graph_boost * 0.3` (mirrors `kg_hybrid_search` α/β pattern).
   - Returns full-content entries + edge labels.
3. Prompt builder injects results as:
   ```
   ## Retrieved Knowledge (k nodes, m structural edges)
   ### Node: <title>
   <full content>
   **Edges:** contradicts → "Other title"; supports → "X"
   ```
4. Deep Research mode bumps `depth=3` and `match_count=20`.

## Phase 5 — UI surfacing

`WikiPanel.tsx`:
- New "Conflicts" tab (badge with open count) listing `knowledge_conflicts` with both entries side-by-side, accept/dismiss/resolve actions.
- Entry detail view shows incoming + outgoing edges grouped by class; `contradicts` edges rendered with destructive variant.
- Toolbar: "Reindex embeddings" button → calls `knowledge-embed { all_missing: true }` with progress toast.
- Lint tab: contradiction issues now link directly to conflict records.

## Phase 6 — Verification

- Migration linter clean.
- Manual probe: insert one entry that contradicts an existing one → assert conflict row appears + `contradicts` edge created + chat retrieves both when asked "what refutes X".
- Backfill embeddings; confirm `match_knowledge` returns sensible neighbors.
- Confirm RLS: `knowledge_conflicts`, RPCs all enforce `auth.uid()`.

---

## Technical reference (for the implementer)

- Hybrid search SQL: Supabase `hybrid_search` RRF template.
- Graph traversal: recursive CTE on `memory_graph` UNIONing source↔target for symmetric edges.
- Embeddings: Lovable AI Gateway `text-embedding-3-small` (1536 dims) — confirm availability at implementation; if absent, fall back to `google/text-embedding-004` (768 dims, adjust column).
- Trigger `validate_knowledge_entry_atomicity` mirrors style of existing `validate_knowledge_entry_enums`.
- Edge class auto-tag via `BEFORE INSERT OR UPDATE` trigger keyed on the relationship enum.

## Out of scope

- Vector quantization / FTS language tuning beyond English.
- Real-time websocket alerts (poll on WikiPanel mount for now).
- Multi-tenant beyond per-user RLS.

Ready to implement on approval.
