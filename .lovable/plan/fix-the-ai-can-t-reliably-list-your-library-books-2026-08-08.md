# Fix: the AI can't reliably list your library books

## What's happening

The chat's `list_books` tool doesn't query the database — it reads the library list the app holds in memory. That in-memory list is only filled after one big startup fetch that pulls **every chapter's full text** in a single request. For this account that's 469 chapters and about 6.9 MB of text on every load, and the code discards the whole library if that chapter fetch is slow, capped, or errors: books are never set, so the chat honestly reports an empty library.

On a phone connection this is exactly the failure being seen — the Vault may look fine after it eventually finishes, but the chat asks earlier and sees nothing.

## The fix

1. **Load books independently of chapter text.**
   - Fetch books first and show them immediately; don't block the library on chapters.
   - Fetch chapter *metadata only* (id, book, name, page range, and a "has text" flag) — no `text_content` at startup. That drops the startup payload from megabytes to kilobytes.
   - A chapter-fetch failure no longer wipes the book list; books stay, chapters retry.

2. **Pull chapter text only when it's actually needed.**
   - `get_chapter_text`, chapter isolation, and auto-tagging fetch the single chapter's text on demand and cache it in memory.

3. **Make `list_books` self-healing.**
   - If the in-memory library is empty when the tool runs, it queries the database directly for the user's books instead of answering "you have no books."
   - Result includes id, title, page count, chapter count, folder, tags, and which book is active, with a clear note when the list came from a fresh fetch.

4. **Remove the silent row caps.**
   - Both the books and chapters queries page through results, so libraries above the API's default row limit still load completely.

5. **Trim the prompt bloat.**
   - The system prompt currently prints every book *and* every chapter of every book (500+ lines here). It will list books with chapter counts, and only expand chapters for the active book — the AI already has `get_book` for the rest.

## Technical notes

- Files: `src/context/AppContext.tsx` (split the load effect, paged queries, lazy chapter text + cache), `src/lib/chatTools.ts` (`list_books` DB fallback, on-demand text in `get_chapter_text` / `isolate_chapter`), `src/lib/buildChatSystemPrompt.ts` (catalog trimming), `src/types/library.ts` (`hasText` flag, `textContent` optional).
- No database migration and no schema change; existing RLS already scopes both tables by owner.
- Realtime insert/delete handlers keep working, adjusted to the metadata-only shape.
