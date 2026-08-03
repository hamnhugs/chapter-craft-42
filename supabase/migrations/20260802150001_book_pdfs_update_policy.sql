-- Apply via Lovable chat prompt — git push does NOT run migrations.
--
-- book-pdfs has INSERT/SELECT/DELETE policies (20260222150406) but no UPDATE,
-- so re-uploading an existing file with upsert:true (AppContext.addBook) always
-- fails RLS — Storage upserts issue an UPDATE on the existing storage.objects
-- row. Owners are identified by the {uid}-first path convention.
DO $$ BEGIN
  CREATE POLICY "Users can update own PDFs"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
