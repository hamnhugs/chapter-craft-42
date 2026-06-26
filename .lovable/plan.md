# Fix: AI cannot actually delete images

## Root cause

The AI claims to delete images because it sees `list_images` and `recall_image_memories` tools, but **no `delete_image*` tool exists** in `src/lib/chatTools.ts`. When asked to delete, the model either hallucinates a success or attempts a non-existent tool. The user-facing `ImagesPanel` deletion works (uses `deleteImageAttachment`) — only the AI path is broken. There is also no user-controlled permission toggle for image deletion.

## What I'll change

### 1. Add two new AI tools in `src/lib/chatTools.ts`

- **`delete_image`** — deletes a generated image (row in `image_attachments` + the file in the `generated-images` bucket). Args: `image_id` (required, the `image_id` returned by `list_images`), `confirm: true` (required, destructive guard). Uses the existing `deleteImageAttachment()` helper so the DB row is removed first, then the storage object, then the signed-URL cache is purged — same atomic order the panel uses. Dispatches an `image-attachments-changed` window event so the chat thumbnails and the Images side-panel refresh immediately.
- **`delete_image_memory`** — deletes an uploaded image the user shared (row in `image_memories` + the storage file). Args: `memory_id` (required, the `memory_id` returned by `recall_image_memories`), `confirm: true`. Ownership-scoped via `auth.uid()` RLS, with best-effort storage cleanup mirroring the attachment helper.

Both executors:
- Refuse with a clear message if the matching permission is `false` in `user_settings.chat_tool_permissions` (consistent with how `delete_wiki` and `delete_memory_entry` already gate themselves).
- Require `confirm: true` — the model is instructed in the tool description to only set this after the user has explicitly approved the deletion in the current turn.
- Verify the row belongs to `auth.uid()` before deleting (defense in depth on top of RLS).
- Return a structured `{ ok, deleted_id }` so the model can confirm precisely what was removed, plus an `event` so the chat timeline shows the destructive action.

### 2. Add a small shared helper for image-memory deletion

Add `deleteImageMemory({ id, storage_path })` to `src/lib/imageGen.ts` that mirrors `deleteImageAttachment` (DB delete → verify a row was actually removed → best-effort storage remove → purge signed-URL cache). Keeping it next to the attachment helper means both deletion paths follow the same battle-tested order.

### 3. Surface permission toggles in `src/components/AiPermissionsSettings.tsx`

Add a new **"Images"** group with four toggles so the user has full granular control in one place:
- Generate images (move existing `generate_image` here from the Generation group)
- Edit images (move existing `edit_image` here)
- **Delete generated images** — new, `danger: true`
- **Delete uploaded image memories** — new, `danger: true`

The Generation group keeps `create_artifact`. Moving generate/edit alongside the new delete toggles keeps every image capability in one place — easier to audit and toggle in one click.

### 4. Update the chat system prompt block that lists tool capabilities

In `src/lib/buildChatSystemPrompt.ts` (the block that tells the model which tools exist), add one short line each for `delete_image` and `delete_image_memory` so the model knows the capability is real, knows it must ask for explicit user confirmation in the same turn, and knows to call the tool with `confirm: true` only after that confirmation. This is the same pattern already used for `delete_wiki`.

## Files touched

- `src/lib/chatTools.ts` — tool definitions + executors
- `src/lib/imageGen.ts` — `deleteImageMemory` helper
- `src/components/AiPermissionsSettings.tsx` — new Images group with 4 toggles
- `src/lib/buildChatSystemPrompt.ts` — two-line capability hint

## Out of scope

- No DB migrations (RLS on `image_attachments` and `image_memories` already restricts to owner).
- No changes to the user-facing `ImagesPanel` deletion path (it already works).
- No changes to bulk-delete behavior in the panel.
