-- Retrieval v2: scope and liveness INSIDE the search, OR-semantics full text,
-- raw cosine in the result, and a bounded graph walk.
--
-- Used by knowledge-retrieve (which falls back to the v1 functions when these
-- aren't applied yet — PGRST202/42883). New NAMES rather than new parameters
-- on hybrid_search_knowledge / get_neighbors: adding a defaulted parameter via
-- CREATE OR REPLACE creates a second overload, and PostgREST can't pick between
-- overloads that both accept the caller's named arguments (PGRST203).
--
-- ── Why ─────────────────────────────────────────────────────────────────────
-- v1 hybrid_search_knowledge searched ALL of the user's entries and returned a
-- global top-12; knowledge-retrieve then threw away everything outside the
-- loaded wiki(s) and every superseded row. A wiki whose best matches ranked
-- 13th+ globally got nothing — and the client ran the whole pipeline (embed,
-- search, walk, meta) once PER loaded neuron. v1's full-text leg used
-- websearch_to_tsquery, which ANDs every word, so a conversational question
-- ("what did the author say about memory palaces?") almost never matched.
--
-- ── hybrid_search_knowledge_v2 ──────────────────────────────────────────────
--   • filter_wiki_ids: NULL = all entries (legacy). Otherwise entries native to
--     one of the wikis, bridged into one (entry_bridges), or with no wiki at
--     all (pre-wiki legacy rows — the same allowance the v1 post-filter made).
--   • Living rows only: superseded_by IS NULL, archived = false, and valid_to
--     unset or in the future (what the client-side filterSupersededNodes did).
--   • Full text: OR of the query's stemmed lexemes (stopwords dropped), ranked
--     by ts_rank_cd — entries matching more terms still rank first.
--   • Semantic leg skipped when query_embedding IS NULL (embedding outage →
--     keyword-only, no separate fallback query).
--   • active_embedding_model: when given, rows whose embedding_768_model is KNOWN and
--     different are excluded from the semantic leg (a vector from another
--     model is noise, not a score). NULL/legacy rows stay in.
--   • Returns the RRF score AND the raw cosine `similarity` (for every row
--     that has a vector, including full-text-only hits) plus `ft_match`, so the
--     caller can apply an absolute relevance floor. Per-node meta the caller
--     used to fetch in extra round trips rides along (wiki_id, confidence,
--     vibrancy, locators, aliases, author).
--
-- ── get_neighbors_v2 ────────────────────────────────────────────────────────
--   • Same walk as get_neighbors, but: living rows only, optional wiki scope
--     (same rule as above), at most max_rows rows (nearest hops first), content
--     truncated to content_chars, and — when query_embedding is given — each
--     neighbour's cosine to the query so a neighbour only earns a slot when it
--     is actually relevant.
--
-- Both SECURITY INVOKER with auth.uid() (RLS, incl. the locked-neuron policy,
-- applies). Idempotent.

CREATE OR REPLACE FUNCTION public.hybrid_search_knowledge_v2(
  query_text        text,
  query_embedding   extensions.vector(768) DEFAULT NULL,
  match_count       int              DEFAULT 12,
  filter_wiki_ids   uuid[]           DEFAULT NULL,
  full_text_weight  double precision DEFAULT 1.0,
  semantic_weight   double precision DEFAULT 1.0,
  rrf_k             int              DEFAULT 50,
  active_embedding_model text        DEFAULT NULL
)
RETURNS TABLE (
  id             uuid,
  title          text,
  content        text,
  entry_type     text,
  tags           text[],
  source_book_id uuid,
  wiki_id        uuid,
  confidence     double precision,
  vibrancy       double precision,
  locators       jsonb,
  aliases        text[],
  author         text,
  score          double precision,
  similarity     double precision,
  ft_match       boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_n     int  := LEAST(GREATEST(COALESCE(match_count, 12), 1), 50);
  v_pool  int;
  v_query tsquery;
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  v_pool := v_n * 2;

  -- 'lexeme1' | 'lexeme2' | … built from the already-stemmed tsvector, cast
  -- without re-normalizing. NULL when the query is all stopwords/punctuation.
  SELECT CASE WHEN count(*) = 0 THEN NULL
              ELSE string_agg(quote_literal(l), ' | ')::tsquery END
    INTO v_query
    FROM unnest(tsvector_to_array(to_tsvector('english', COALESCE(query_text, '')))) AS l;

  RETURN QUERY
  WITH scope AS MATERIALIZED (
    SELECT e.id
      FROM public.knowledge_entries e
     WHERE e.user_id = v_uid
       AND e.superseded_by IS NULL
       AND e.archived = false
       AND (e.valid_to IS NULL OR e.valid_to > now())
       AND (
         filter_wiki_ids IS NULL
         OR e.wiki_id IS NULL
         OR e.wiki_id = ANY(filter_wiki_ids)
         OR EXISTS (SELECT 1 FROM public.entry_bridges b
                     WHERE b.entry_id = e.id
                       AND b.wiki_id = ANY(filter_wiki_ids)
                       AND b.user_id = v_uid)
       )
  ),
  ft AS (
    SELECT x.id, row_number() OVER (ORDER BY x.rank DESC, x.id) AS rank_ix
      FROM (
        SELECT k.id, ts_rank_cd(k.tsv, v_query) AS rank
          FROM public.knowledge_entries k
          JOIN scope s ON s.id = k.id
         WHERE v_query IS NOT NULL
           AND k.tsv @@ v_query
         ORDER BY rank DESC, k.id
         LIMIT v_pool
      ) x
  ),
  sem AS (
    SELECT x.id, row_number() OVER (ORDER BY x.dist, x.id) AS rank_ix
      FROM (
        SELECT k.id, k.embedding <=> query_embedding AS dist
          FROM public.knowledge_entries k
          JOIN scope s ON s.id = k.id
         WHERE query_embedding IS NOT NULL
           AND k.embedding IS NOT NULL
           AND (active_embedding_model IS NULL
                OR k.embedding_768_model IS NULL
                OR k.embedding_768_model = active_embedding_model)
         ORDER BY k.embedding <=> query_embedding, k.id
         LIMIT v_pool
      ) x
  )
  SELECT k.id, k.title, k.content, k.entry_type, k.tags, k.source_book_id,
         k.wiki_id,
         k.confidence::double precision,
         k.vibrancy::double precision,
         k.locators, k.aliases, k.author,
         (COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
          COALESCE(1.0 / (rrf_k + sem.rank_ix), 0.0) * semantic_weight)::double precision AS score,
         CASE WHEN query_embedding IS NOT NULL AND k.embedding IS NOT NULL
                   AND (active_embedding_model IS NULL OR k.embedding_768_model IS NULL
                        OR k.embedding_768_model = active_embedding_model)
              THEN (1 - (k.embedding <=> query_embedding))::double precision
         END AS similarity,
         (ft.id IS NOT NULL) AS ft_match
    FROM ft
    FULL OUTER JOIN sem ON ft.id = sem.id
    JOIN public.knowledge_entries k ON k.id = COALESCE(ft.id, sem.id)
   ORDER BY score DESC, k.id
   LIMIT v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.hybrid_search_knowledge_v2(text, extensions.vector, integer, uuid[], double precision, double precision, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_knowledge_v2(text, extensions.vector, integer, uuid[], double precision, double precision, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_neighbors_v2(
  seed_ids         uuid[],
  depth            int     DEFAULT 2,
  classes          text[]  DEFAULT ARRAY['structural','associative'],
  filter_wiki_ids  uuid[]  DEFAULT NULL,
  max_rows         int     DEFAULT 40,
  content_chars    int     DEFAULT 600,
  query_embedding  extensions.vector(768) DEFAULT NULL
)
RETURNS TABLE (
  entry_id         uuid,
  title            text,
  content          text,
  entry_type       text,
  wiki_id          uuid,
  confidence       double precision,
  vibrancy         double precision,
  hop              int,
  via_relationship text,
  via_edge_class   text,
  from_seed        uuid,
  similarity       double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR seed_ids IS NULL OR cardinality(seed_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE walk AS (
    SELECT s.id AS entry_id, 0 AS hop, NULL::text AS via_relationship,
           NULL::text AS via_edge_class, s.id AS from_seed
      FROM unnest(seed_ids) AS s(id)
    UNION
    SELECT CASE WHEN g.source_entry_id = w.entry_id THEN g.target_entry_id ELSE g.source_entry_id END,
           w.hop + 1, g.relationship, g.edge_class, w.from_seed
      FROM walk w
      JOIN public.memory_graph g
        ON (g.source_entry_id = w.entry_id OR g.target_entry_id = w.entry_id)
     WHERE w.hop < LEAST(GREATEST(COALESCE(depth, 2), 0), 3)
       AND g.user_id = v_uid
       AND g.edge_class = ANY(classes)
  ),
  nearest AS (
    SELECT DISTINCT ON (w.entry_id) w.*
      FROM walk w
     ORDER BY w.entry_id, w.hop ASC
  )
  SELECT n.entry_id, k.title, left(k.content, GREATEST(COALESCE(content_chars, 600), 0)),
         k.entry_type, k.wiki_id, k.confidence::double precision, k.vibrancy::double precision,
         n.hop, n.via_relationship, n.via_edge_class, n.from_seed,
         CASE WHEN query_embedding IS NOT NULL AND k.embedding IS NOT NULL
              THEN (1 - (k.embedding <=> query_embedding))::double precision END
    FROM nearest n
    JOIN public.knowledge_entries k ON k.id = n.entry_id
   WHERE k.user_id = v_uid
     AND n.hop > 0
     AND k.superseded_by IS NULL
     AND k.archived = false
     AND (k.valid_to IS NULL OR k.valid_to > now())
     AND (
       filter_wiki_ids IS NULL
       OR k.wiki_id IS NULL
       OR k.wiki_id = ANY(filter_wiki_ids)
       OR EXISTS (SELECT 1 FROM public.entry_bridges b
                   WHERE b.entry_id = k.id
                     AND b.wiki_id = ANY(filter_wiki_ids)
                     AND b.user_id = v_uid)
     )
   ORDER BY n.hop ASC,
            (CASE WHEN query_embedding IS NOT NULL AND k.embedding IS NOT NULL
                  THEN k.embedding <=> query_embedding END) ASC NULLS LAST,
            n.entry_id
   LIMIT LEAST(GREATEST(COALESCE(max_rows, 40), 1), 200);
END;
$$;

REVOKE ALL ON FUNCTION public.get_neighbors_v2(uuid[], integer, text[], uuid[], integer, integer, extensions.vector) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_neighbors_v2(uuid[], integer, text[], uuid[], integer, integer, extensions.vector) TO authenticated, service_role;
