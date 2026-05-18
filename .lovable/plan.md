## Goal

Let the user say things like *"let's go through my wiki contradictions"* or *"resolve that contradiction by keeping entry A"* in chat, and have the AI walk them through open conflicts and apply the resolution to the knowledge wiki when they approve.

This is purely additive — new chat tools + system-prompt guidance. No existing feature is removed.

## What changes

### 1. New chat tools (in `src/lib/chatTools.ts`)

Add four tool definitions + handlers, following the existing `executeChatTool` pattern:

- **`list_conflicts`** — params: `{ status?: "open"|"acknowledged"|"resolved"|"dismissed" (default "open"), limit?: number (default 10) }`. Returns each conflict with `id`, `kind`, `rationale`, and both entries hydrated (`id`, `title`, `content` snippet, `entry_type`, `confidence`, `source_book_id`) so the model can discuss them without a second round-trip.
- **`get_conflict`** — params: `{ conflict_id }`. Returns the full text of both entries plus rationale, for deep discussion of one contradiction.
- **`resolve_conflict`** — params:
  - `conflict_id` (required)
  - `action` (required, enum):
    - `"keep_a_delete_b"` / `"keep_b_delete_a"` — delete the losing entry, mark conflict `resolved`
    - `"merge"` — requires `merged_title` + `merged_content` (+ optional `merged_tags`); writes them into entry A, deletes entry B, marks resolved
    - `"edit_a"` / `"edit_b"` — requires `new_title` and/or `new_content` (+ optional `new_tags`); updates that entry, marks resolved
    - `"acknowledge"` — marks `acknowledged` (both kept, user has seen it)
    - `"dismiss"` — marks `dismissed` (false positive)
  - `require_confirmation` defaults to true; the system prompt instructs the model to never call `resolve_conflict` with a destructive `action` until the user has explicitly approved that exact action in the current turn.
- **`update_conflict_status`** — thin wrapper to set status without editing entries (covers `acknowledge` / `dismiss` quickly).

Implementation uses the existing `fetchConflicts`, `updateConflictStatus`, `deleteKnowledgeEntry`, `updateKnowledgeEntry` helpers in `src/lib/knowledgeApi.ts`, plus a direct `supabase.from("knowledge_conflicts").select(...).eq("id", ...).single()` for `get_conflict`. RLS already restricts every row to the current user.

Each handler returns a `ToolEvent` with a clear summary (e.g. *"Resolved conflict — kept 'Mitochondria are the powerhouse' and deleted duplicate"*), matching how the existing tools surface in the chat UI.

### 2. System prompt update (`src/lib/buildChatSystemPrompt.ts`)

Append a short "Conflict resolution" section to the always-on guidance:

- If the user mentions contradictions, conflicts, wiki cleanup, or asks to "go through" them, call `list_conflicts` first and present them in plain language one at a time.
- For each conflict, summarise both sides, show the AI's reasoning, and propose options (keep one, merge, edit, acknowledge, dismiss).
- **Never** call `resolve_conflict` with a destructive action (`keep_*`, `merge`, `edit_*`) until the user explicitly approves that specific choice for that specific conflict in the current message. `acknowledge` / `dismiss` may be applied after a clear yes.
- After each resolution, briefly confirm what changed and ask whether to move to the next one.

### 3. No DB / no edge function / no UI changes

- The `knowledge_conflicts` table, statuses, and RLS already exist.
- `ConflictNotifier` badge and the Wiki → Conflicts tab keep working unchanged; resolutions made via chat will simply make the badge count drop (it already listens to UPDATEs).
- No edits to `VoiceChat`, `ChatPanel`, `ChatContext`, TTS, hands-free mode, or any other surface.

## Files touched

- `src/lib/chatTools.ts` — add 4 tool definitions + handler cases
- `src/lib/buildChatSystemPrompt.ts` — add ~6 lines of guidance

## Out of scope (explicitly preserved)

Wiki UI conflict view, badge notifier, Inworld TTS persistence work, voice tab behaviour, ingest/lint/sleep-cycle pipelines, knowledge graph edges — all untouched.

## Verification

After implementation: open chat, ask *"are there any contradictions in my wiki?"* → AI calls `list_conflicts`, summarises them. Pick one, say *"merge them, keep the merged version titled X"* → AI calls `resolve_conflict` with `action: "merge"`, conflict disappears from the Wiki → Conflicts tab and the bell badge count drops.