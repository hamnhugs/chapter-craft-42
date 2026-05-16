# Auto-save transcript PDFs to the user's PDF library

## What changes

When a video transcription job completes, the generated transcript PDF will be saved to the user's PDF library (the same library that holds uploaded books), in addition to the existing behavior:

- The "Download Transcript PDF" button keeps working exactly as it does now.
- The auto-saved wiki entry keeps being created.
- The job row in `video_jobs` keeps being updated.

A new copy of the PDF lands in the library as a regular book item, so the user can open, read, chapterize, or chat with it just like any uploaded PDF.

## How it works

Inside the `video-to-pdf` edge function's status route, the moment a job transitions to `completed`:

1. Build the PDF from the transcript (reuse the existing `buildPdf` helper).
2. Skip if a library entry for this exact job already exists (dedupe via `file_name = video-{jobId}.pdf` scoped to the user).
3. Otherwise:
   - Generate a fresh `bookId` (uuid).
   - Upload the PDF bytes to the `book-pdfs` storage bucket at `{userId}/{bookId}.pdf`.
   - Insert a row into `books` with:
     - `id`: the new bookId
     - `user_id`: the job's user
     - `title`: video title from metadata, falling back to the video URL
     - `file_name`: `video-{jobId}.pdf`
     - `page_count`: page count returned by pdf-lib

If the upload or insert fails, log the error and continue — the transcript, wiki entry, and download button still work; only the library copy is missing, and the next status poll will retry.

## Files touched

- `supabase/functions/video-to-pdf/index.ts` — extend the `completed` branch with the library-save block; have `buildPdf` also return the page count.

No DB schema changes, no new buckets, no frontend changes. The Library UI auto-refreshes via its existing fetch on load; newly added books appear on next library visit or refresh.

## Open question

The library entries created from videos will appear alongside uploaded books. Want me to tag them visually (e.g. prefix the title with a small icon or "[Video]") so they're distinguishable, or keep titles clean as just the video title?
