-- ── Chat persistence hardening ──────────────────────────────────────────
-- Cross-device chat history: the client loads the newest window of
-- chat_messages, pages older ones by keyset cursor, and subscribes to
-- realtime INSERTs so a second device sees new turns live.
--
-- The table itself predates the repo's migration history (it was created
-- directly on the hosted database), so EVERYTHING here is idempotent —
-- safe to run on databases where any subset already exists, and makes a
-- fresh database fully self-sufficient.

-- 1. Table (no-op where it already exists).
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  book_id UUID,
  images JSONB DEFAULT NULL,
  videos JSONB DEFAULT NULL,
  splats JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Columns that may be missing on databases created before each feature.
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS book_id UUID,
  ADD COLUMN IF NOT EXISTS images JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS videos JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS splats JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 3. RLS + owner-scoped policies (guarded: only created where absent).
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'chat_messages' AND cmd = 'SELECT') THEN
    EXECUTE 'CREATE POLICY "Users can view own chat messages" ON public.chat_messages
             FOR SELECT USING (auth.uid() = user_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'chat_messages' AND cmd = 'INSERT') THEN
    EXECUTE 'CREATE POLICY "Users can insert own chat messages" ON public.chat_messages
             FOR INSERT WITH CHECK (auth.uid() = user_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'chat_messages' AND cmd = 'DELETE') THEN
    EXECUTE 'CREATE POLICY "Users can delete own chat messages" ON public.chat_messages
             FOR DELETE USING (auth.uid() = user_id)';
  END IF;
END $$;

-- 4. Keyset index: the history window and every "load earlier" page walk
--    (user_id, created_at DESC, id DESC) exactly.
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
  ON public.chat_messages (user_id, created_at DESC, id DESC);

-- 5. Live cross-device sync. postgres_changes respects RLS for
--    authenticated clients, so each user only receives their own rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages';
  END IF;
END $$;
