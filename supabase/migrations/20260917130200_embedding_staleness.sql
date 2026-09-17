-- Stale embeddings: clear the vectors when the text they describe changes.
--
-- Before this, editing a card (memory_entry_upsert, WikiPanel save, conflict
-- edits) rewrote title/content but left `embedding` / `embedding_v2` pointing
-- at the OLD text — so semantic search kept finding the card by what it used
-- to say, and knowledge-embed's all_missing sweep (embedding IS NULL) never
-- noticed. Clearing on change makes "needs embedding" and "embedding IS NULL"
-- the same set again: the client re-embeds right after the write
-- (knowledgeApi.embedEntriesSoon → knowledge-embed entry_ids), and anything
-- that slips through is picked up by all_missing / the Sleep Cycle's
-- embed-missing pass.
--
-- Why a trigger rather than hashes: every writer (RPCs, PostgREST updates from
-- the client and edge functions, SQL functions) goes through it, and the
-- condition is exactly "the embedded text changed" — no hash to keep in sync.
--
-- Guard rails:
--   • BEFORE UPDATE OF title, content — an embedding write (SET embedding=…)
--     doesn't list those columns, so it never fires on the embed itself.
--   • Fires on SET title = coalesce(_title, title) too (memory_entry_upsert
--     always lists both), so the body compares OLD vs NEW and does nothing
--     when the text is unchanged.
--   • If the same UPDATE also writes a new vector (text + embedding together),
--     that fresh vector is kept: only a vector carried over unchanged from OLD
--     is cleared.
--   • search_path includes `extensions` so the pgvector `=` operators used by
--     IS DISTINCT FROM resolve.
--
-- Idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS).

-- Mirror-guard so this applies even if 20260917130100 hasn't run yet.
ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS embedding_768_model text;

CREATE OR REPLACE FUNCTION public.clear_stale_entry_embeddings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content IS DISTINCT FROM OLD.content THEN
    IF NEW.embedding IS NOT NULL AND NOT (NEW.embedding IS DISTINCT FROM OLD.embedding) THEN
      NEW.embedding := NULL;
      NEW.embedding_768_model := NULL;
    END IF;
    IF NEW.embedding_v2 IS NOT NULL AND NOT (NEW.embedding_v2 IS DISTINCT FROM OLD.embedding_v2) THEN
      NEW.embedding_v2 := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_stale_entry_embeddings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS clear_stale_entry_embeddings_trg ON public.knowledge_entries;
CREATE TRIGGER clear_stale_entry_embeddings_trg
  BEFORE UPDATE OF title, content ON public.knowledge_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_stale_entry_embeddings();
