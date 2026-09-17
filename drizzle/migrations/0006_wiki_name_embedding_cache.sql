ALTER TABLE public.wiki_centroids
  ADD COLUMN IF NOT EXISTS name_embedding        extensions.halfvec(1536),
  ADD COLUMN IF NOT EXISTS name_embedding_source text;

COMMENT ON COLUMN public.wiki_centroids.name_embedding IS
  'Embedding (openai/text-embedding-3-small, 1536) of name_embedding_source; cache for wiki-drift-check''s rename signal.';
COMMENT ON COLUMN public.wiki_centroids.name_embedding_source IS
  'Exact "<name>. <description>" text name_embedding was computed from; a mismatch means re-embed.';