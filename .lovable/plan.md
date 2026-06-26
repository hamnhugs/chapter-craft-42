## Goal
Give the chat AI the ability to delete a wiki (neuron) when the user explicitly asks, since this tool is currently missing — that's why deletes from chat don't work.

## Changes

### 1. `src/lib/chatTools.ts` — add `delete_wiki` tool
- New tool definition after `create_wiki`:
  - Args: `wiki_id` (required), `confirm` (boolean, required).
  - Description states: destructive, never call without `confirm: true`, and never call until the user has explicitly approved deletion of that exact wiki in the current turn.
- New executor case `delete_wiki`:
  - Permission gate via `chat_tool_permissions.delete_wiki` (defaults ON, like every other tool).
  - Require `confirm === true`; otherwise return a refusal result instructing the AI to ask the user first.
  - Verify the wiki exists and belongs to the current user (`select id, name, is_default … eq("user_id", uid)`).
  - Refuse if it's the user's only remaining wiki (would leave them with none) or if `is_default` is true — return a clear message telling the AI to ask the user to pick a different default first.
  - `supabase.from("wikis").delete().eq("id", wid).eq("user_id", uid)` — RLS already enforces ownership; the explicit `user_id` filter is defense in depth.
  - If the deleted wiki was the active one, clear `user_settings.active_wiki_id` (set to the user's oldest remaining wiki, or `null`).
  - Dispatch `window.dispatchEvent(new CustomEvent("wiki-active-changed"))` so WikiPanel / WikiLibrary refresh.
  - Return `{ ok: true, deleted_id, name }` with a summary event.

### 2. `src/components/AiPermissionsSettings.tsx` — expose the toggle
- Add to the "Wikis (Neurons)" group:
  - `{ id: "delete_wiki", label: "Delete wikis", description: "Allow the AI to permanently delete a neuron after you confirm.", danger: true }`

No DB migration needed — `wikis` already has user-scoped RLS and ON DELETE CASCADE on its child tables, so deletion cleans up entries/edges/etc. automatically.

## Technical detail
- Pattern mirrors the existing `resolve_conflict` safeguard: destructive action requires an explicit `confirm` arg, and the executor returns a structured refusal when missing so the model re-asks the user.
- Defaults: tool ON unless the user toggles it off, matching every other entry in `chat_tool_permissions`.