
-- Create storage bucket for PDF files
INSERT INTO storage.buckets (id, name, public) VALUES ('book-pdfs', 'book-pdfs', false);

-- Users can upload their own PDFs (path format: user_id/book_id.pdf)
DROP POLICY IF EXISTS "Users can upload own PDFs" ON storage.objects;
CREATE POLICY "Users can upload own PDFs"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Users can read their own PDFs
DROP POLICY IF EXISTS "Users can read own PDFs" ON storage.objects;
CREATE POLICY "Users can read own PDFs"
ON storage.objects FOR SELECT
USING (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Users can delete their own PDFs
DROP POLICY IF EXISTS "Users can delete own PDFs" ON storage.objects;
CREATE POLICY "Users can delete own PDFs"
ON storage.objects FOR DELETE
USING (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);
