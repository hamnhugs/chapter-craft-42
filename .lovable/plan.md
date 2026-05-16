## Goal
Make voice notes sync across devices for the same account. Today they only live in `localStorage`.

## Approach
Reuse the existing `notes` table (already RLS-protected per `user_id`). Voice notes are stored with `book_id = NULL` and `title = 'Voice Note'` so they don't mix with the per-book Notes Library.

## Database
- Migration: make `public.notes.book_id` nullable (`ALTER COLUMN ... DROP NOT NULL`). RLS, columns, and existing book-scoped notes unchanged.
- Enable realtime on `public.notes` (`REPLICA IDENTITY FULL` + add to `supabase_realtime` publication) so a note added on one device appears on the other.

## Frontend (`src/components/VoiceNotesPanel.tsx` only)
- Replace `localStorage` storage with Supabase `notes` table queries scoped to `user_id = auth.uid()` AND `book_id IS NULL`.
- `loadVoiceNotes()` → async fetch from Supabase, ordered by `created_at desc`.
- `appendVoiceNote(text)` → insert row `{ user_id, book_id: null, title: 'Voice Note', content: text }`.
- Edit / delete / clear-all → corresponding Supabase update/delete calls (scoped to current user, `book_id IS NULL`).
- Subscribe to realtime `postgres_changes` on `notes` filtered by current user; refresh list on any insert/update/delete so two open devices stay in sync.
- One-time migration: on first load, if `localStorage` key `voice_notes_v1` exists, push those notes into Supabase, then clear the key.
- Preserve all existing UI: header, count, add button + textarea, edit/cancel/save, delete, clear-all confirm, panel slide-in, long-press-to-save flow from `VoiceChat` (the exported `appendVoiceNote` keeps the same signature).

## Out of scope
- No changes to `NotesLibrary` (book-scoped notes), `VoiceChat`, chat, wiki, or anything else.
- No new tables, no auth changes.

## Files
- New migration (book_id nullable + realtime on `notes`)
- `src/components/VoiceNotesPanel.tsx`
