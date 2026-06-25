## Goal
Make image deletion in the BRAIN → Generated Images panel actually remove images permanently, with clear error feedback when something goes wrong.

## Root causes (most likely)

1. **Single-image delete uses `window.confirm()`** — that native dialog is unreliable inside the Lovable preview iframe (cross-origin sandbox can suppress it), so clicks appear to do nothing.
2. **Bulk delete trusts a silent success** — `.delete().eq("id", id)` resolves without error even when RLS or a stale session causes 0 rows to be affected. The optimistic UI hides the row, then the realtime subscription re-fetches and the row reappears.
3. **Realtime auto-reload races the optimistic update** — `load()` is called immediately on any change event, which can re-show rows during the round-trip.
4. **Storage path removal failures are swallowed silently** — if the bucket object remove fails, we never tell the user; combined with #2 this makes the whole flow look broken.

## Fix plan (frontend only — no schema changes)

### `src/lib/imageGen.ts`
- Change `deleteImageAttachment` to:
  - Call `.delete().eq("id", row.id).select("id")` and throw if the returned array is empty (so we detect 0-row deletes from RLS/session issues).
  - Attempt `storage.remove([row.storage_path])` after the DB delete; log but don't fail the call if storage cleanup errors (the row is what drives the UI).
  - Purge the signed-URL cache entry for that `storage_path` so a stale URL can't render after delete.

### `src/components/ImagesPanel.tsx`
- Replace the native `confirm()` on the per-tile trash button with the existing shadcn `AlertDialog` (reuse the same component used by bulk delete, parameterized for one or many).
- After a successful delete (single or bulk), do NOT call `load()`; trust the optimistic state. Only re-fetch on failure to reconcile.
- Debounce the realtime listener: ignore DELETE events whose `old.id` is already absent from local `rows` (prevents redundant `load()` calls that can race with optimistic state).
- Properly tear down the realtime channel in the effect cleanup (current cleanup only flips `active`, leaking channels across opens).
- Surface specific errors from `deleteImageAttachment` in the toast (`e.message`) instead of a generic message.

### Verification
- Single-tile trash → confirmation dialog opens → confirm → tile disappears and stays gone after panel close/reopen.
- Bulk select → Delete → all selected tiles disappear and stay gone.
- Force an error (e.g., temporarily revoke RLS) → toast shows the real error, rows are restored.

## Out of scope
- No DB migration. RLS DELETE policy is already correct (`auth.uid() = user_id`) and rows are owned by the signed-in user.
- No change to image generation or the `image_attachments` schema.