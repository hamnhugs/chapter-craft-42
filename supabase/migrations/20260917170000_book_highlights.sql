-- Reader highlights: passages the user marks while reading, anchored so they
-- can be repainted on the page and handed to chat as "what the user found
-- important". Deliberately NOT knowledge_entries: a highlight is a cheap,
-- automatic signal (no title, no embedding, no Sleep Cycle), and flooding
-- neuron retrieval with every marked sentence would crowd out curated cards.
-- "Save as card" in the reader promotes one into a neuron card explicitly.
--
-- Anchoring follows the W3C Web Annotation model:
--   quote + prefix/suffix  (TextQuoteSelector — survives re-renders),
--   pos_start/pos_end      (TextPositionSelector in the rendered page text —
--                           the fast path, verified against the quote),
--   chapter_id + char_*    (the app's chapter-text locator, when the quote
--                           anchors in the isolated chapter's extracted text).
-- Idempotent: safe to apply twice.

CREATE TABLE IF NOT EXISTS public.book_highlights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  -- 1-based PDF page; NULL for HTML books (one scrolling document).
  page integer CHECK (page IS NULL OR page >= 1),
  quote text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 4000),
  prefix text NOT NULL DEFAULT '' CHECK (char_length(prefix) <= 64),
  suffix text NOT NULL DEFAULT '' CHECK (char_length(suffix) <= 64),
  pos_start integer NOT NULL CHECK (pos_start >= 0),
  pos_end integer NOT NULL CHECK (pos_end > pos_start),
  chapter_id uuid REFERENCES public.chapters(id) ON DELETE SET NULL,
  char_start integer CHECK (char_start IS NULL OR char_start >= 0),
  char_end integer CHECK (char_end IS NULL OR char_end >= 0),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS book_highlights_user_book_page_idx
  ON public.book_highlights (user_id, book_id, page);
CREATE INDEX IF NOT EXISTS book_highlights_user_created_idx
  ON public.book_highlights (user_id, created_at DESC);

ALTER TABLE public.book_highlights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own highlights" ON public.book_highlights;
CREATE POLICY "Users read own highlights" ON public.book_highlights
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Writes must target the caller's own book, and a chapter of that book.
DROP POLICY IF EXISTS "Users add highlights to own books" ON public.book_highlights;
CREATE POLICY "Users add highlights to own books" ON public.book_highlights
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.books b WHERE b.id = book_id AND b.user_id = auth.uid())
    AND (chapter_id IS NULL OR EXISTS (
      SELECT 1 FROM public.chapters c WHERE c.id = chapter_id AND c.book_id = book_highlights.book_id
    ))
  );

DROP POLICY IF EXISTS "Users update own highlights" ON public.book_highlights;
CREATE POLICY "Users update own highlights" ON public.book_highlights
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.books b WHERE b.id = book_id AND b.user_id = auth.uid())
    AND (chapter_id IS NULL OR EXISTS (
      SELECT 1 FROM public.chapters c WHERE c.id = chapter_id AND c.book_id = book_highlights.book_id
    ))
  );

DROP POLICY IF EXISTS "Users delete own highlights" ON public.book_highlights;
CREATE POLICY "Users delete own highlights" ON public.book_highlights
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.book_highlights TO authenticated;
GRANT ALL ON public.book_highlights TO service_role;
