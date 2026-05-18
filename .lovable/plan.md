# Voice + Wiki audit fix plan

Goal: make Voice tab actually resolve wiki conflicts, give it real wiki management tools, and stop the hands-free TTS feedback loop — without touching any working feature.

## 1. Voice can't resolve conflicts (tool exists, model isn't calling it)

The `resolve_conflict` tool works fine when called. Problem is the voice model often *narrates* success ("I've resolved that for you") without ever emitting a `tool_call`, especially smaller "flash-lite" models. The current system prompt also has heavy "NEVER without explicit approval" guarding that's tuned for typed chat and confuses voice replies.

Changes:
- In `buildChatSystemPrompt.ts`, when `voiceMode=true`, append a stricter conflict block:
  - A spoken "yes / keep A / merge / dismiss / etc." IS explicit approval — act on it immediately by calling `resolve_conflict`.
  - You MUST call the tool. NEVER say "done", "resolved", "deleted" unless the previous turn included a successful `resolve_conflict` tool result. If you didn't call the tool, ask again instead of pretending.
  - After a successful tool call, speak one short confirmation, then offer the next conflict.
- Keep the destructive-action guard for typed chat unchanged.

## 2. Voice can't manage the wiki itself

Today the chat tools only expose `search_wiki` + conflict ops. There's no way for the voice agent to list wikis, switch the active one, create one, or report which is active — so any "switch to my Biology wiki" request fails silently.

Add four tools in `src/lib/chatTools.ts` (definitions + executors), backed by existing `src/lib/wikisApi.ts` and `user_settings.active_wiki_id`:
- `list_wikis` → id, name, is_default, is_meta, entry counts.
- `get_active_wiki` → current active wiki id + name.
- `switch_wiki { wiki_id }` → update `user_settings.active_wiki_id`, return new active wiki.
- `create_wiki { name, description? }` → insert + optionally switch to it.

Also scope `search_wiki` and `list_conflicts` to the active wiki (read `active_wiki_id` once at executor entry, filter `knowledge_entries.wiki_id`). Falls back to all-wikis if no active wiki is set, so nothing breaks for legacy users.

Mention the new tools in `buildChatSystemPrompt.ts` so the model knows they exist.

## 3. Hands-free TTS feedback loop (mic records its own playback)

Two root causes:
- The chat-tab TTS speed slider also drives hands-free playback. At slow rates the playback runs long, and on devices without echo cancellation the mic starts catching the speaker before queue/grace timers fully drain.
- 1.1s silence-to-send is too short — mid-sentence pauses get auto-submitted.

Changes (UI surface unchanged, just behavior):
- `useChatSettings.ts`: add a new persisted setting `hands_free_tts_rate` (default `1.0`). Keep `tts_rate` (chat slider) untouched. Migration: new column on `user_settings` defaulted to 1.0 — non-destructive.
- `VoiceChat.tsx`:
  - When `handsFree === true`, all `enqueueSpeak` / `synthesizeSpeech` / `SpeechSynthesisUtterance.rate` / `<audio>.playbackRate` paths use `handsFreeTtsRate`, NOT `ttsRate`. When `handsFree === false`, behavior is identical to today (still uses `ttsRate`).
  - Add a small "Hands-free playback speed" slider inside the Voice settings drawer (only visible when hands-free is on), defaulting to 1.0, range 0.9–1.4. The chat-tab slider keeps its existing scope.
  - Raise hands-free silence timers: `SILENCE_INTERIM_MS` 1100 → 3000, `SILENCE_FINAL_MS` 700 → 3000 (per user request: ~3s). Leave non-hands-free push-to-talk path at current 700ms.
  - Keep all existing barge-in guards (`isSpeakingRef`, `ttsPlayingRef`, queue lengths, `streamDoneRef`) — proven working, do not touch.
  - Add a final safety: after TTS `onend` / audio `ended`, wait `max(POST_TTS_DELAY_MS, 600ms)` before allowing `safeStartListening`, to cover speaker tail.

## 4. Migration

Single migration adds `hands_free_tts_rate numeric NOT NULL DEFAULT 1.0` to `user_settings`. RLS policies already cover the table.

## Out of scope (explicitly NOT changing)

- Chat tab TTS rate slider behavior / default.
- Existing push-to-talk (non-hands-free) timing.
- Inworld TTS server proxy, voice list, or auth.
- Conflict resolution tool semantics (still requires explicit approval; only the voice-mode prompt is tightened).
- Wiki CRUD UI (`WikiLibrary`, `WikiQuickSwitcher`) — untouched.
- Embedding / search-knowledge edge functions.

## Files touched

- `supabase/migrations/<new>.sql` — add `hands_free_tts_rate`.
- `src/hooks/useChatSettings.ts` — load/save new setting.
- `src/components/VoiceChat.tsx` — use new rate in hands-free, longer silence, settings slider.
- `src/lib/chatTools.ts` — 4 new wiki tools, wiki-scoped search/conflicts.
- `src/lib/buildChatSystemPrompt.ts` — voice-mode conflict block, mention new wiki tools.

## Verification

- Voice: "list my wiki conflicts" → tool call fires, items spoken one at a time.
- Voice: say "merge them, title X" → `resolve_conflict` actually invoked, DB row status flips to `resolved`, confirmation only after tool returns ok.
- Voice: "switch to my Biology wiki" → `switch_wiki` updates `user_settings.active_wiki_id`.
- Hands-free: slow chat-slider rate no longer slows playback. Mid-sentence 1–2s pauses no longer auto-send. No infinite self-listen loop on speaker playback.
