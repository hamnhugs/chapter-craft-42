## Goal

Make the Voice page a first-class chat surface: same conversation as the text Chat tab, same Deep Research toggle/model, same full wiki context, plus live tool-calling access to the user's books and the chapter isolator — all without removing any current voice features (mic, hands-free, TTS, notes, long-press save, settings, model picker, save-to-wiki, clear).

## What changes

### 1. Shared conversation with the text Chat tab

Move chat state out of `ChatPanel`/`VoiceChat` local `useState` into a shared `ChatContext` (`src/context/ChatContext.tsx`) backed by the existing `chat_messages` table (already RLS-scoped per user).

- New context exposes: `messages`, `appendMessage`, `updateLastAssistant`, `clearChat`, `isLoading`, `sendMessage(text, { spoken })`.
- On mount, load the latest `chat_messages` for the user (most recent ~100, ordered ascending). Persist new user/assistant messages as they arrive so both pages stay in sync.
- Both `ChatPanel` and `VoiceChat` consume the context instead of their own `messages` state. Switching tabs shows the same thread; clearing in one clears the other.
- A Supabase realtime subscription on `chat_messages` (filtered by `user_id`) keeps two open tabs/devices in sync.

### 2. Deep Research parity on the voice page

- Move the `deepResearch` boolean into `ChatContext` so it's shared too (so a research session started by typing continues when you switch to voice).
- Add a Deep Research toggle button to the voice controls row, next to TTS/Hands-free.
- Add a Deep Research model `<select>` to the voice settings panel (reads/writes `deepResearchModel` from `useChatSettings`, same as ChatPanel).
- When `deepResearch` is on, the request uses `deepResearchModel` and appends `DEEP_RESEARCH_SYSTEM_PROMPT` + `DEEP_RESEARCH_ADVANCED_PROMPT` to the system prompt (same as ChatPanel).

### 3. Full knowledge wiki context

Extract the system-prompt builder into a shared `src/lib/buildChatSystemPrompt.ts` used by both panels. It always uses the "full" version (matches ChatPanel's depth: per-book filter + 30 ranked entries with 200-char snippets, full memory summary, key facts, all books listed, active book's chapter text up to 12k chars). Voice can prepend a short "keep replies spoken-friendly" line when the request is voice-initiated; the underlying knowledge depth is identical.

### 4. Tool-calling: books + chapter isolator

Give the assistant live access to the user's library and the chapter isolator through OpenRouter function-calling.

Tools exposed (executed client-side, no new edge functions needed — they read from `AppContext`/Supabase using the signed-in user, so RLS already protects everything):

- `list_books()` → array of `{ id, title, page_count, chapter_count }`.
- `get_book(book_id)` → full book object incl. chapters and their page ranges.
- `get_chapter_text(chapter_id, max_chars?)` → returns chapter text (truncated).
- `set_active_book(book_id)` → switches the focused book in `AppContext` so subsequent prompts include its chapters.
- `search_wiki(query, limit?)` → keyword search over `knowledge_entries` for the current user.
- `isolate_chapter({ book_id, name, start_page, end_page })` → creates a new chapter row (calls the same logic the manual chapter dialog uses; if a helper doesn't exist, add `src/lib/chapterActions.ts` and reuse from both the dialog and the tool).
- `rename_chapter(chapter_id, name)` / `delete_chapter(chapter_id)` — round out the isolator surface.

Tool loop:
- Send `tools: [...]` and `tool_choice: "auto"` in the OpenRouter request (works on the streaming chat completions endpoint; when a `tool_calls` delta arrives, accumulate, execute locally, append a `role: "tool"` message with the JSON result, and re-call the model until it returns a normal assistant message).
- Capped at 5 tool iterations per turn to avoid runaway loops.
- Each executed tool surfaces a small inline status chip in the chat ("📚 Looked up 'The Republic'", "✂️ Isolated chapter 'Cave Allegory' p.514–532") so the user sees what happened.

### 5. Voice-page UI additions (purely additive)

- Keep mic button, hands-free, TTS, notes panel, long-press save, settings, save-to-wiki, clear — unchanged.
- Add a small text input + send button under the mic row so the user can type during a voice session (typed messages flow through the same `sendMessage`; replies still get spoken if TTS is on).
- Add Deep Research toggle to the controls row and Deep Research model picker to the settings panel.

## Files touched

- `src/context/ChatContext.tsx` *(new)* — shared messages, deepResearch flag, sendMessage with tool loop, Supabase persistence + realtime.
- `src/lib/buildChatSystemPrompt.ts` *(new)* — shared system-prompt builder.
- `src/lib/chatTools.ts` *(new)* — tool definitions + client-side executors for `list_books`, `get_book`, `get_chapter_text`, `set_active_book`, `search_wiki`, `isolate_chapter`, `rename_chapter`, `delete_chapter`.
- `src/lib/chapterActions.ts` *(new or extracted)* — chapter create/rename/delete used by both the dialog and the tool executor.
- `src/components/ChatPanel.tsx` — consume `ChatContext`, drop local `messages` state, use shared prompt builder + tool loop.
- `src/components/VoiceChat.tsx` — consume `ChatContext`, add text input, Deep Research toggle + model picker in settings, use shared prompt builder + tool loop. All existing voice/mic/notes behavior preserved.
- `src/App.tsx` — wrap routes in `<ChatProvider>` inside `<AppProvider>`.

## Out of scope

- No changes to auth, RLS, storage buckets, edge functions, or `chapters-api`.
- No removal of any current voice feature.
- No change to how the OpenRouter API key is stored (still per-account via `useChatSettings`).
- No new tables — `chat_messages` already exists with correct RLS.

## Result

Open the voice page on any device signed into the account and you get: the same ongoing conversation as the Chat tab, the same Deep Research switch, the full wiki + book context, and an assistant that can look up books, read chapter text, isolate new chapters, and search your wiki on demand — by voice or by typing — with every existing voice feature intact.
