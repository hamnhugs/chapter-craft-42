# Let the AI rename books in chat

Give the chat assistant full control over book titles in the Library, using the same permission-gated tool pattern the app already uses for chapters.

## What the user gets

- Ask the assistant things like "rename this book to X", "clean up the titles of everything in my Sci-Fi folder", or "fix the placeholder names in my library" and it does it.
- Retitles are instant everywhere: Library grid/list, reader, chat references — one source of truth, saved to the account so it syncs across devices.
- A new switch in Counsel settings ("Rename books") that the user can turn off. Off means the assistant is not even offered the tool.
- Bulk renames are proposed first: the assistant lists the old -> new titles and only applies them after the user says yes.

## How it works

New tool `rename_book` in the chat toolset:
- Inputs: `book_id` (defaults to the active book) and `title`.
- Optional `renames` array so a multi-book cleanup runs as one call instead of many round trips, with a per-call cap and a partial-success report (which succeeded, which failed and why).
- Validation before write: trim whitespace, reject empty titles, cap length, reject titles identical to the current one (no-op), and warn — not block — on duplicate titles.
- Returns the old and new title so the assistant can confirm accurately instead of guessing.

Wiring:
- Add `updateBookTitle` to the chat tool dependencies and pass the existing `AppContext.updateBookTitle` through from `ChatContext` (already persists to the database and updates local state).
- Register `rename_book` in the permission map and add a "Rename books" toggle to the Library group in AI permissions settings, alongside the existing chapter toggles.
- Tool description makes the bulk-confirm rule explicit and tells the model to source ids from `list_books`.

## Technical notes

- Files touched: `src/lib/chatTools.ts` (tool schema + executor), `src/context/ChatContext.tsx` (deps wiring), `src/lib/toolPermissions.ts` (permission id + settings group entry).
- No database migration needed — `books.title` already exists with row-level security scoping updates to the owner, and `updateBookTitle` already handles persistence, local state, and error toasts.
- Permission is enforced at the tool boundary via the existing snapshot mechanism, so the roster the model sees and the executor agree.
- Existing permission-coverage test will pick up the new id automatically; the tool-availability probe list gets `rename_book` added.
