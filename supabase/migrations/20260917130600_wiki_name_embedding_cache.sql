-- Cache the wiki name/description embedding used by wiki-drift-check.
--
-- The rename-drift signal compares a wiki's centroid with the embedding of
-- "<name>. <description>". wiki-drift-check re-embedded that text for every
-- qualifying wiki on every run, although names change rarely. The vector and
-- the exact text it was computed from now live beside the centroid; the check
-- re-embeds only when the text differs. wiki-drift-check feature-detects these
-- columns (42703) and embeds every run, as before, until this is applied.
--
-- recompute-centroids upserts wiki_centroids with an explicit column list, so
-- it never clears the cache. Idempotent.

ALTER TABLE public.wiki_centroids
  ADD COLUMN IF NOT EXISTS name_embedding        extensions.halfvec(1536),
  ADD COLUMN IF NOT EXISTS name_embedding_source text;

COMMENT ON COLUMN public.wiki_centroids.name_embedding IS
  'Embedding (openai/text-embedding-3-small, 1536) of name_embedding_source; cache for wiki-drift-check''s rename signal.';
COMMENT ON COLUMN public.wiki_centroids.name_embedding_source IS
  'Exact "<name>. <description>" text name_embedding was computed from; a mismatch means re-embed.';
