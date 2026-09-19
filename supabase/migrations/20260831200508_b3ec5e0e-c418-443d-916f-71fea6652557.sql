-- Card Catalog Stage 2: cards become pointers.

ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS locators jsonb,
  ADD COLUMN IF NOT EXISTS aliases text[],
  ADD COLUMN IF NOT EXISTS author text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_entries_locators_is_array'
  ) THEN
    ALTER TABLE public.knowledge_entries
      ADD CONSTRAINT knowledge_entries_locators_is_array
      CHECK (locators IS NULL OR jsonb_typeof(locators) = 'array') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_entries_author_known'
  ) THEN
    ALTER TABLE public.knowledge_entries
      ADD CONSTRAINT knowledge_entries_author_known
      CHECK (author IS NULL OR author IN ('user', 'assistant')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.knowledge_entries.locators IS
  'Array of verified pointers into the user''s own chapters: {chapter_id, char_start, char_end, page, quote<=160, stance?}. Offsets are UTF-16 code-unit indices into chapters.text_content (JS slice semantics). quote is UNTRUSTED text (book/OCR/model-supplied) — every prompt/tool door sanitizes it on read. NULL = grandfathered unanchored note. Validity depends on chapter-text immutability per id.';

COMMENT ON COLUMN public.knowledge_entries.aliases IS
  'Authority-register synonyms for this card''s label, lowercased, <=6. Untrusted text — sanitized at every render. Register lookups match normalized-exact against title + aliases (no fuzzy matching by design).';

COMMENT ON COLUMN public.knowledge_entries.author IS
  'Who authored the card: ''user'' | ''assistant''. NULL = predates Stage 2 (unknown). Study features count user-authored cards (report law 8).';

CREATE OR REPLACE FUNCTION public.entry_locators_merge(_id uuid, _add jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cur    jsonb;
  merged jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF _add IS NULL OR jsonb_typeof(_add) <> 'array' THEN
    RAISE EXCEPTION 'locators to add must be a jsonb array';
  END IF;

  SELECT locators INTO cur
    FROM public.knowledge_entries
   WHERE id = _id AND user_id = auth.uid()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry not found or not owned by current user';
  END IF;
  IF cur IS NULL OR jsonb_typeof(cur) <> 'array' THEN
    cur := '[]'::jsonb;
  END IF;

  WITH src AS (
    SELECT t.l, t.ord
      FROM jsonb_array_elements(cur || _add) WITH ORDINALITY AS t(l, ord)
  ), dedup AS (
    SELECT DISTINCT ON ((l->>'chapter_id'), (l->>'char_start'), (l->>'char_end'))
           l, ord
      FROM src
     ORDER BY (l->>'chapter_id'), (l->>'char_start'), (l->>'char_end'), ord
  ), capped AS (
    SELECT l, ord FROM dedup ORDER BY ord LIMIT 8
  )
  SELECT COALESCE(jsonb_agg(l ORDER BY ord), '[]'::jsonb) INTO merged FROM capped;

  UPDATE public.knowledge_entries
     SET locators = merged, updated_at = now()
   WHERE id = _id;

  RETURN merged;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.entry_locators_merge(uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.entry_locators_merge(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.supersede_knowledge_entry(
  _old_id         uuid,
  _new_title      text     DEFAULT NULL,
  _new_content    text     DEFAULT NULL,
  _new_entry_type text     DEFAULT NULL,
  _new_tags       text[]   DEFAULT NULL,
  _reason         text     DEFAULT NULL,
  _also_supersede uuid     DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  old_row       public.knowledge_entries%ROWTYPE;
  also_row      public.knowledge_entries%ROWTYPE;
  olds          uuid[];
  oid           uuid;
  new_id        uuid;
  carry_loc     jsonb;
  carry_aliases text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF _new_content IS NULL OR btrim(_new_content) = '' THEN
    RAISE EXCEPTION 'supersede requires the corrected content (_new_content)';
  END IF;

  olds := ARRAY[_old_id];
  IF _also_supersede IS NOT NULL AND _also_supersede <> _old_id THEN
    olds := olds || _also_supersede;
  END IF;

  FOREACH oid IN ARRAY olds LOOP
    PERFORM 1 FROM public.knowledge_entries
      WHERE id = oid AND user_id = auth.uid() AND superseded_by IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Entry % not found, not yours, or already superseded', oid;
    END IF;
  END LOOP;

  SELECT * INTO old_row FROM public.knowledge_entries WHERE id = _old_id;

  carry_loc := CASE WHEN jsonb_typeof(old_row.locators) = 'array' THEN old_row.locators ELSE NULL END;
  carry_aliases := old_row.aliases;
  IF _also_supersede IS NOT NULL AND _also_supersede <> _old_id THEN
    SELECT * INTO also_row FROM public.knowledge_entries WHERE id = _also_supersede;
    IF jsonb_typeof(also_row.locators) = 'array' THEN
      WITH src AS (
        SELECT t.l, t.ord
          FROM jsonb_array_elements(COALESCE(carry_loc, '[]'::jsonb) || also_row.locators)
               WITH ORDINALITY AS t(l, ord)
      ), dedup AS (
        SELECT DISTINCT ON ((l->>'chapter_id'), (l->>'char_start'), (l->>'char_end'))
               l, ord
          FROM src
         ORDER BY (l->>'chapter_id'), (l->>'char_start'), (l->>'char_end'), ord
      ), capped AS (
        SELECT l, ord FROM dedup ORDER BY ord LIMIT 8
      )
      SELECT COALESCE(jsonb_agg(l ORDER BY ord), NULL) INTO carry_loc FROM capped;
    END IF;
    IF also_row.aliases IS NOT NULL THEN
      carry_aliases := (
        SELECT ARRAY(
          SELECT DISTINCT a FROM unnest(COALESCE(carry_aliases, '{}'::text[]) || also_row.aliases) AS a
          LIMIT 6
        )
      );
    END IF;
  END IF;

  INSERT INTO public.knowledge_entries
    (user_id, wiki_id, title, content, entry_type, tags, confidence,
     source_book_id, vibrancy, valid_from, locators, aliases, author)
  VALUES
    (old_row.user_id,
     old_row.wiki_id,
     COALESCE(NULLIF(btrim(COALESCE(_new_title, '')), ''), old_row.title),
     _new_content,
     COALESCE(NULLIF(btrim(COALESCE(_new_entry_type, '')), ''), old_row.entry_type),
     COALESCE(_new_tags, old_row.tags),
     old_row.confidence,
     old_row.source_book_id,
     COALESCE(old_row.vibrancy, 1.0),
     now(),
     carry_loc,
     carry_aliases,
     old_row.author)
  RETURNING id INTO new_id;

  FOREACH oid IN ARRAY olds LOOP
    UPDATE public.knowledge_entries
       SET valid_to         = now(),
           superseded_by    = new_id,
           supersede_reason = _reason,
           archived         = true
     WHERE id = oid;

    BEGIN
      UPDATE public.memory_graph mg
         SET source_entry_id = new_id
       WHERE mg.source_entry_id = oid
         AND mg.target_entry_id <> new_id
         AND NOT EXISTS (SELECT 1 FROM public.memory_graph d
                          WHERE d.source_entry_id = new_id
                            AND d.target_entry_id = mg.target_entry_id
                            AND d.relationship    = mg.relationship);
      UPDATE public.memory_graph mg
         SET target_entry_id = new_id
       WHERE mg.target_entry_id = oid
         AND mg.source_entry_id <> new_id
         AND NOT EXISTS (SELECT 1 FROM public.memory_graph d
                          WHERE d.source_entry_id = mg.source_entry_id
                            AND d.target_entry_id = new_id
                            AND d.relationship    = mg.relationship);
      DELETE FROM public.memory_graph
       WHERE source_entry_id = oid OR target_entry_id = oid;
      DELETE FROM public.memory_graph
       WHERE source_entry_id = new_id AND target_entry_id = new_id;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
      UPDATE public.entry_bridges b
         SET entry_id = new_id
       WHERE b.entry_id = oid
         AND NOT EXISTS (SELECT 1 FROM public.entry_bridges d
                          WHERE d.entry_id = new_id AND d.wiki_id = b.wiki_id);
      DELETE FROM public.entry_bridges WHERE entry_id = oid;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  BEGIN
    INSERT INTO public.consolidation_queue (user_id, entry_id, reason, priority)
    VALUES (old_row.user_id, new_id, 'new_entry', 3);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN new_id;
END;
$$;