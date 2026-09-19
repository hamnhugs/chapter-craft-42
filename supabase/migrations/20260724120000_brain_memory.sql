-- Brain-accurate memory upgrade (Waves 2-3 of the "Modeled on Memory" plan).
-- ALL ADDITIVE + backward-compatible: new columns have defaults, new RPCs don't
-- touch existing paths, and the client/edge functions feature-detect everything,
-- so the app keeps working before AND after this is applied.
--
-- Delivers the plan's highest-evidence spine:
--   • Spaced retrieval-practice (spacing effect + testing effect)
--   • Bjork's New Theory of Disuse (storage strength vs. retrieval strength)
--   • Encoding-salience columns (importance / surprise / encoding strength)
--   • SHY-style global renormalization of vibrancy (prevents saturation)

-- ── 1. New per-entry columns ────────────────────────────────────────────────
ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS importance        float,                       -- salience at encoding (0-1)
  ADD COLUMN IF NOT EXISTS surprise          float,                       -- prediction error at encoding (0-1)
  ADD COLUMN IF NOT EXISTS encoding_strength float,                       -- birth strength from salience
  ADD COLUMN IF NOT EXISTS storage_strength  float       NOT NULL DEFAULT 1.0,  -- Bjork: how deeply learned
  ADD COLUMN IF NOT EXISTS review_count      int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_review_at    timestamptz,                 -- spaced-repetition due time
  ADD COLUMN IF NOT EXISTS archived          boolean     NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ke_next_review_idx
  ON public.knowledge_entries (user_id, next_review_at)
  WHERE archived = false AND next_review_at IS NOT NULL;

-- ── 2. Seed a first review date for existing entries so reviews start flowing.
--     Weaker (low-vibrancy) memories come due sooner; vivid ones later.
--     Suppress user triggers for this one-time backfill so the updated_at
--     trigger doesn't rewrite every entry's updated_at (which would collapse
--     the knowledge list's chronological ordering — it sorts by updated_at).
ALTER TABLE public.knowledge_entries DISABLE TRIGGER USER;
UPDATE public.knowledge_entries
SET next_review_at = now() + make_interval(days => GREATEST(1, round(COALESCE(vibrancy, 0.5) * 14))::int)
WHERE next_review_at IS NULL AND archived = false;
ALTER TABLE public.knowledge_entries ENABLE TRIGGER USER;

-- ── 3. entries_due_for_review — memories whose spaced review is due, ordered by
--     salience then weakest-first. Scoped to the caller (SECURITY INVOKER + RLS).
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

-- ── 4. record_review — testing effect + Bjork desirable difficulty. An effortful
--     successful recall (low current retrieval strength) strengthens storage
--     most, and schedules the next review with an expanding interval.
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
    -- Desirable difficulty: bigger storage gain when the memory was nearly forgotten.
    gain := 0.15 + 0.35 * (1.0 - COALESCE(cur.vibrancy, 0.5));
    new_review_count := cur.review_count + 1;
    next_interval_days := LEAST(180, power(2.0, new_review_count));  -- expanding, capped
  ELSE
    gain := 0.0;
    new_review_count := GREATEST(0, cur.review_count - 1);
    next_interval_days := 1;  -- relearn soon
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

-- ── 5. renormalize_vibrancy — SHY-style gentle global downscaling toward a target
--     mean. Preserves relative order, prevents saturation / rich-get-richer.
CREATE OR REPLACE FUNCTION public.renormalize_vibrancy(_user_id uuid, _target_mean float DEFAULT 0.5, _wiki_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE cur_mean float; g float; n int;
BEGIN
  -- NULL-safe ownership guard (belt-and-suspenders atop RLS): reject
  -- unauthenticated callers and anyone acting on another user's id.
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN RETURN 0; END IF;
  SELECT avg(vibrancy) INTO cur_mean FROM public.knowledge_entries
    WHERE user_id = _user_id AND archived = false AND (_wiki_id IS NULL OR wiki_id = _wiki_id);
  IF cur_mean IS NULL OR cur_mean <= 0 THEN RETURN 0; END IF;
  g := _target_mean / cur_mean;
  IF g >= 1.0 THEN RETURN 0; END IF;         -- only downscale, never inflate
  g := GREATEST(0.6, g);                      -- cap the downscale so one run is gentle
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
