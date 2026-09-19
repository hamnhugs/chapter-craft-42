ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS vibrancy          float       NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS retrieval_count   int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retrieved_at timestamptz,
  ADD COLUMN IF NOT EXISTS importance        float,
  ADD COLUMN IF NOT EXISTS surprise          float,
  ADD COLUMN IF NOT EXISTS encoding_strength float,
  ADD COLUMN IF NOT EXISTS storage_strength  float       NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS review_count      int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_review_at    timestamptz,
  ADD COLUMN IF NOT EXISTS archived          boolean     NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ke_next_review_idx
  ON public.knowledge_entries (user_id, next_review_at)
  WHERE archived = false AND next_review_at IS NOT NULL;

ALTER TABLE public.knowledge_entries DISABLE TRIGGER USER;
UPDATE public.knowledge_entries
SET next_review_at = now() + make_interval(days => GREATEST(1, round(COALESCE(vibrancy, 0.5) * 14))::int)
WHERE next_review_at IS NULL AND archived = false;
ALTER TABLE public.knowledge_entries ENABLE TRIGGER USER;

CREATE OR REPLACE FUNCTION public.entries_due_for_review(_wiki_id uuid DEFAULT NULL, _limit int DEFAULT 10)
RETURNS TABLE (
  id uuid, title text, content text, entry_type text, wiki_id uuid,
  vibrancy float, storage_strength float, next_review_at timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT ke.id, ke.title, ke.content, ke.entry_type, ke.wiki_id,
         ke.vibrancy, ke.storage_strength, ke.next_review_at
  FROM public.knowledge_entries ke
  WHERE ke.user_id = auth.uid()
    AND ke.archived = false
    AND ke.next_review_at IS NOT NULL
    AND ke.next_review_at <= now()
    AND (_wiki_id IS NULL OR ke.wiki_id = _wiki_id)
  ORDER BY COALESCE(ke.importance, 0.5) DESC, COALESCE(ke.storage_strength, 1.0) ASC, ke.next_review_at ASC
  LIMIT GREATEST(1, LEAST(50, _limit));
$$;

CREATE OR REPLACE FUNCTION public.record_review(_entry_id uuid, _recalled boolean DEFAULT true)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  cur record;
  gain float;
  next_interval_days float;
  new_review_count int;
  new_next timestamptz;
BEGIN
  SELECT vibrancy, storage_strength, review_count INTO cur
  FROM public.knowledge_entries
  WHERE id = _entry_id AND user_id = auth.uid();
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF _recalled THEN
    gain := 0.15 + 0.35 * (1.0 - COALESCE(cur.vibrancy, 0.5));
    new_review_count := cur.review_count + 1;
    next_interval_days := LEAST(180, power(2.0, new_review_count));
  ELSE
    gain := 0.0;
    new_review_count := GREATEST(0, cur.review_count - 1);
    next_interval_days := 1;
  END IF;

  new_next := now() + make_interval(days => GREATEST(1, round(next_interval_days))::int);

  UPDATE public.knowledge_entries
  SET storage_strength  = LEAST(4.0, COALESCE(storage_strength, 1.0) + gain),
      vibrancy          = LEAST(1.0, COALESCE(vibrancy, 0.5) + CASE WHEN _recalled THEN 0.2 ELSE 0.0 END),
      retrieval_count   = retrieval_count + CASE WHEN _recalled THEN 1 ELSE 0 END,
      last_retrieved_at = CASE WHEN _recalled THEN now() ELSE last_retrieved_at END,
      review_count      = new_review_count,
      next_review_at    = new_next
  WHERE id = _entry_id AND user_id = auth.uid();

  RETURN new_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.renormalize_vibrancy(_user_id uuid, _target_mean float DEFAULT 0.5, _wiki_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE cur_mean float; g float; n int;
BEGIN
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN RETURN 0; END IF;
  SELECT avg(vibrancy) INTO cur_mean FROM public.knowledge_entries
    WHERE user_id = _user_id AND archived = false AND (_wiki_id IS NULL OR wiki_id = _wiki_id);
  IF cur_mean IS NULL OR cur_mean <= 0 THEN RETURN 0; END IF;
  g := _target_mean / cur_mean;
  IF g >= 1.0 THEN RETURN 0; END IF;
  g := GREATEST(0.6, g);
  UPDATE public.knowledge_entries
  SET vibrancy = GREATEST(0.10, LEAST(1.0, vibrancy * g))
  WHERE user_id = _user_id AND archived = false AND (_wiki_id IS NULL OR wiki_id = _wiki_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.entries_due_for_review(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_review(uuid, boolean)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.renormalize_vibrancy(uuid, float, uuid) TO authenticated;