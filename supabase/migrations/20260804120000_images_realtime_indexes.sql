-- Images realtime + pagination indexes.
--
-- ImagesPanel has subscribed to postgres_changes on image_attachments since
-- it was built, but neither image table was ever added to the realtime
-- publication, so the subscription has never delivered an event (the exact
-- failure chat_messages had before 20260727120000). The panel works without
-- this migration — reload-on-open + in-app CustomEvents cover same-device
-- freshness — applying it lights up live cross-device sync with no code
-- change.
--
-- Idempotent; safe to run more than once.

-- 1. Realtime publication membership. postgres_changes respects RLS for
--    authenticated clients on INSERT/UPDATE, so each user only receives
--    their own rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'image_attachments'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.image_attachments';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'image_memories'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.image_memories';
  END IF;
END $$;

-- 2. DELETE events carry only the replica identity; with the default
--    (primary key) the panel's user_id filter can't match deletes. FULL
--    mirrors chat_messages' setup so delete events reach the right client.
ALTER TABLE public.image_attachments REPLICA IDENTITY FULL;
ALTER TABLE public.image_memories REPLICA IDENTITY FULL;

-- 3. Composite indexes matching the unified library's (user_id,
--    created_at DESC, id DESC) read order — also what any future keyset
--    pagination would walk.
CREATE INDEX IF NOT EXISTS idx_image_attachments_user_created
  ON public.image_attachments (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_image_memories_user_created
  ON public.image_memories (user_id, created_at DESC, id DESC);
