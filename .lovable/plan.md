## Goal
When a video transcript job completes and its PDF is auto-saved to the library, the Library view should update immediately — no manual page refresh.

## Approach
Use Supabase Realtime on the `books` table, scoped to the current user, to reactively append new books to `AppContext` state as they are inserted (which is exactly what the edge function does after building the transcript PDF).

This also benefits other flows (mobile app uploads, future bot ingests) for free.

## Changes

**1. `src/context/AppContext.tsx`**
- In the existing `useEffect([user])` that loads books, also subscribe to a Supabase Realtime channel:
  - `postgres_changes` on `public.books`, event `INSERT`, filter `user_id=eq.${user.id}`
  - On insert: skip if book already in state (dedupe by id), otherwise prepend a new `BookDocument` built from the row (empty `fileData`, empty `chapters`, etc.)
  - Also subscribe to `DELETE` to keep state consistent if a book is removed elsewhere.
- Unsubscribe via `supabase.removeChannel` in the cleanup.

**2. Database migration**
- Ensure `books` is in the `supabase_realtime` publication:
  ```sql
  ALTER PUBLICATION supabase_realtime ADD TABLE public.books;
  ```
  (No-op if already added.)

## Out of scope
- No edge function changes — it already inserts into `books` correctly.
- No UI changes in `Library.tsx` — it already renders from `books` in context, so it will re-render automatically.
- Chapters realtime not needed for this request.
