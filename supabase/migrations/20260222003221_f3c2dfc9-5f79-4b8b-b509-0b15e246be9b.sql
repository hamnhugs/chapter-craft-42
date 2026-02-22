
-- Add user_id to books
ALTER TABLE public.books ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Add user_id to chapters  
ALTER TABLE public.chapters ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Drop old permissive policies
DROP POLICY IF EXISTS "Anyone can read books" ON public.books;
DROP POLICY IF EXISTS "Anyone can insert books" ON public.books;
DROP POLICY IF EXISTS "Anyone can delete books" ON public.books;
DROP POLICY IF EXISTS "Anyone can read chapters" ON public.chapters;
DROP POLICY IF EXISTS "Anyone can insert chapters" ON public.chapters;
DROP POLICY IF EXISTS "Anyone can delete chapters" ON public.chapters;

-- New RLS policies for books
CREATE POLICY "Users can read own books" ON public.books FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own books" ON public.books FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own books" ON public.books FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can update own books" ON public.books FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- New RLS policies for chapters
CREATE POLICY "Users can read own chapters" ON public.chapters FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own chapters" ON public.chapters FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own chapters" ON public.chapters FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can update own chapters" ON public.chapters FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- Allow the API edge function (anon key) to still read all data
CREATE POLICY "Anon can read all books" ON public.books FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can read all chapters" ON public.chapters FOR SELECT TO anon USING (true);
