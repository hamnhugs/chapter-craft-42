ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS embedding_768_model text;

COMMENT ON COLUMN public.knowledge_entries.embedding_768_model IS
  'Model that produced `embedding` (vector(768)), stamped at write time by _shared/embed.ts. NULL = unknown/legacy. Unlike embedding_model, never written by the embedding_v2 pipeline.';

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