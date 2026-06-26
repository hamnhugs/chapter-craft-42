# Plan: Library Folders, Smarter Chat Memory, Image-Model Settings, Remove Cleanup UI

Five focused workstreams. Each is isolated so a failure in one doesn't regress the others.  


---

## 1. User-managed Library folders (real folders, not auto-categories)

Today the "Folders" view (`LibraryFolders.tsx`) is virtual — it groups books by the auto-tag `category` field. We keep that auto-tag pipeline intact and add a parallel, user-owned folder system on top.

**Data**

- New table `public.book_folders` — fields: `name`, `parent_id` (nullable, supports nesting one level deep for now), `color`, `sort_index`, plus standard owner/timestamps. RLS by `user_id`, full GRANTs.
- Add `folder_id uuid null` to `public.books` (FK `book_folders` ON DELETE SET NULL).
- Index `(user_id, folder_id)` for fast listing.

**UI (`Library.tsx` + new `LibraryFolders.tsx` rewrite)**

- "Folders" view becomes the real folder tree: create / rename / recolor / delete folders from a toolbar inline menu. Deleting prompts "Move books to Uncategorized or delete with folder?".
- Move books in/out via:
  - Right-click / long-press "Move to folder…" menu on a book card.
  - Multi-select mode (checkbox toolbar) → "Move N books".
  - Drag-and-drop onto folder tiles (HTML5 DnD, no new dep).
- An "Uncategorized" pseudo-folder shows books with `folder_id = null`.
- The legacy auto-tag category view stays available as a separate **"Auto-tags"** chip toggle inside the Folders view so users keep the existing grouping if they want it.

**Bulk-ingest a folder into the active neuron**

- Settings button (gear icon) in the Library toolbar opens a small popover:
  - **Ingest model** picker (lists models from `useChatSettings.savedModels` plus a "Browse models" link).
  - Toggle: "Auto-run Smart Filing after ingest" (default ON).
  - Toggle: "Skip books already ingested" (default ON, tracks via a new `ingested_into_wiki` join table).
- Each folder tile gets a **"Digest into active neuron"** action. It enumerates the folder's books and queues each through the existing `knowledge-ingest` edge function using the chosen model (passed as `model` in the request body — the function already accepts an override; we'll thread it through if missing).
- Progress is shown in a sticky toast with a cancel button. Per-book status (queued / extracting / embedded / failed) is persisted to a new lightweight `ingest_jobs` table so progress survives reloads. Errors are retryable individually.

**Settings persistence**

- `user_settings` gets two new columns: `library_ingest_model text`, `library_ingest_auto_file boolean default true`. Backfilled defaults; admin-list RPC updated to include them.

---

## 2. Chat memory: full read/write/delete, with per-tool permissions

The chat already has read tools (`search_wiki`, `list_conflicts`, etc.) and one mutating tool (`flag_for_cleanup`). We expand to a full CRUD surface and put every mutating tool behind a user-controlled switch.

**New chat tools in `src/lib/chatTools.ts**` (each scoped to the active wiki, owner-checked server-side):

- `create_memory_entry({ title, content, entry_type, tags?, confidence? })`
- `update_memory_entry({ entry_id, title?, content?, tags?, confidence? })`
- `delete_memory_entry({ entry_id })` and `delete_memory_entries({ entry_ids })`
- `link_memory_entries({ source_id, target_id, relationship })`
- `unlink_memory_entries({ source_id, target_id })`
- `move_entry_to_wiki({ entry_id, wiki_id })` (uses existing entry_bridges)
- `summarize_wiki({ wiki_id? })` — read-only, calls existing consolidate flow
- `rescan_cleanup()` and the existing `flag_for_cleanup` are removed (see §5)

All writes go through a new SECURITY DEFINER RPC layer (`memory_entry_upsert`, `memory_entry_delete_bulk` already exists, `memory_edge_upsert`, `memory_edge_delete`) so RLS stays clean and edge functions aren't required. Each RPC re-embeds via the existing `embed-entries` function asynchronously.

**Per-tool permission settings (Counsel → Settings)**

- New `user_settings.chat_tool_permissions jsonb` — shape:
  ```
  { "create_memory_entry": true, "update_memory_entry": true,
    "delete_memory_entry": false, "link_memory_entries": true,
    "move_entry_to_wiki": false, "generate_image": true, ... }
  ```
- Defaults: reads ON, creates ON, edits ON, deletes/moves OFF (safe-by-default).
- A new **"AI Permissions"** section in the Counsel settings panel lists every tool with a switch, short description, and a "Reset to defaults" button. Disabled tools are filtered out of the tools array sent to the model, and `buildChatSystemPrompt` is updated to advertise only the enabled set.
- Server-side: every mutating RPC also checks the same permission map (defense in depth — a leaked tool call still can't write if the user disabled it).

---

## 3. Image-model settings tab + image models in Model Explorer

**New "Images" tab in the Counsel settings dialog**

- Picker for primary image model (default `google/gemini-3-pro-image`) and fallback (default `google/gemini-3.1-flash-image`). Options pulled from a curated allowlist (Lovable AI image models) plus any saved OpenRouter image models.
- Quality preset (low / medium / high) and default size (1024 / 1536 / 1920).
- Saved to `user_settings.image_model_primary`, `image_model_fallback`, `image_quality`, `image_size`. `imageGen.ts` reads from these instead of the hardcoded constants.

**Model Explorer page extension (`src/pages/ModelExplorer.tsx`)**

- Add a top-level mode switch: **Chat models** / **Image models**.
- Image-models mode fetches the OpenRouter catalog filtered to image-output modalities (`output_modalities` includes `image`), reuses the same ranking chips (Top / Newest), shows price-per-image where available, and "Add to my image models" writes into a new `user_settings.saved_image_models jsonb`.
- The Images settings tab pulls from `saved_image_models` so the Explorer is the single source of truth, mirroring the existing chat-model flow.

---

## 4. Counsel settings tab refactor

The Counsel settings dialog gets reorganized into clear tabs (shadcn `Tabs`):

1. **Models** — existing chat/voice/wiki model pickers.
2. **Images** — new (see §3).
3. **AI Permissions** — new (see §2).
4. **API Keys** — existing.
5. **Advanced** — existing misc toggles.

No behavior changes outside the new tabs; existing settings keep working.

---

## 5. Remove the Cleanup feature (UI + chat tool only)

Scope of removal — surgical, nothing else touched:

- Delete `src/components/CleanupPanel.tsx`.
- Remove the CLEANUP button, badge, realtime subscription, and import in `src/components/WikiLibrary.tsx`.
- Remove the red-border / "Cleanup suggested" chip rendering in `src/components/WikiPanel.tsx`. The entry card returns to its pre-cleanup styling.
- Remove the `flag_for_cleanup` tool from `src/lib/chatTools.ts` and any cleanup guidance from `src/lib/buildChatSystemPrompt.ts`.
- Delete `src/lib/cleanupFlags.ts`.
- Keep the `cleanup_flags` table and `scan_cleanup_flags` / `delete_entries_bulk` RPCs in the database — `delete_entries_bulk` is reused by the new `delete_memory_entries` chat tool, and the table is harmless if unused. (Dropping the table is a one-line follow-up if you want it gone later.)

Everything else in WikiLibrary, WikiPanel, ImagesPanel, and the BRAIN toolbar stays exactly as it is.

---

## Technical notes

- **Migrations** (single file): `book_folders` + `books.folder_id` + `ingest_jobs` + `user_settings` new columns + `memory_edge_upsert`/`memory_edge_delete` RPCs. All with GRANTs and RLS.
- **Edge functions touched**: `knowledge-ingest` (accept `model` override and `folder_id` tag), no new functions required.
- **Type regen**: after migration approval, regenerate `src/integrations/supabase/types.ts` before wiring UI.
- **No new npm deps**: drag-and-drop uses native HTML5 DnD; folder tree is one level deep so no tree library needed.

## File touch list (high level)

Created: migration SQL, `src/components/library/FolderManager.tsx`, `src/components/library/IngestSettingsPopover.tsx`, `src/components/counsel/PermissionsTab.tsx`, `src/components/counsel/ImagesTab.tsx`, `src/lib/folderApi.ts`, `src/lib/ingestQueue.ts`, `src/lib/memoryWriteApi.ts`.

Edited: `src/components/Library.tsx`, `src/components/LibraryFolders.tsx`, `src/components/ChatPanel.tsx` (settings dialog tabs + permission gating), `src/lib/chatTools.ts`, `src/lib/buildChatSystemPrompt.ts`, `src/lib/imageGen.ts`, `src/pages/ModelExplorer.tsx`, `src/hooks/useChatSettings.ts`, `src/context/AppContext.tsx`, `src/components/WikiLibrary.tsx`, `src/components/WikiPanel.tsx`.

Deleted: `src/components/CleanupPanel.tsx`, `src/lib/cleanupFlags.ts`.