-- Track which model produced each 768-dim `embedding`.
--
-- `embedding_model` can't answer that: the old _shared/embed.ts stamped
-- 'google/text-embedding-004' on every write while actually trying OpenRouter
-- (perplexity/pplx-embed-v1-4b) first and two Google transports after it, and
-- _shared/wiki-embed.ts overwrote the same column with the embedding_v2 model.
-- So the column mixes three vector spaces under one misleading label.
--
-- embedding_768_model is written ONLY by the 768-dim writers (embed.ts
-- writeEntryEmbedding) with the model that really produced the vector.
--   NULL      = legacy/unknown (anything embedded before this migration)
--   non-NULL  = trustworthy
-- Retrieval (hybrid_search_knowledge_v2) excludes rows whose known model
-- differs from the active one; NULL rows stay searchable because nothing is
-- re-embedded automatically. To clean up legacy vectors, call knowledge-embed
-- with { stale_model: true } (repeat until total = 0).
--
-- The embedding-staleness trigger (20260917130200) clears this together with
-- the vector when title/content change.
--
-- Idempotent.

ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS embedding_768_model text;

COMMENT ON COLUMN public.knowledge_entries.embedding_768_model IS
  'Model that produced `embedding` (vector(768)), stamped at write time by _shared/embed.ts. NULL = unknown/legacy. Unlike embedding_model, never written by the embedding_v2 pipeline.';
