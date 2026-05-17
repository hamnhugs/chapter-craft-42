# Speed Up Hands-Free Voice Responses

The voice tab feels slow because of four stacked delays:

1. **Silence wait** before sending: 1400–1800 ms after you stop talking.
2. **Full-reply wait** before TTS: the assistant streams tokens, but `submit()` only calls `speak(reply)` after the *entire* answer finishes. So you wait for the slowest sentence even though earlier sentences are already on screen.
3. **TTS synthesis** (Inworld): one HTTP round-trip for the whole reply before a single sound plays.
4. **Restart-mic grace** after TTS: 700 ms.
5. **Model choice**: voice uses the same `selectedModel` as chat — often `gemini-2.5-pro` / deep-research model, which is slow.

The plan reduces each of these without removing any feature.

## Changes

### 1. Sentence-streaming TTS (biggest win)

Today: `ChatContext.sendMessage` resolves with the full reply, then `VoiceChat.submit` calls `speak(reply)`.

New: as `assistantText` grows during streaming, chunk it into sentences (`/[.!?]\s/` or newline) and hand each completed sentence to a small TTS queue. The first sentence starts playing while the model is still generating the rest.

Implementation:
- Add an optional `onDelta?: (full: string) => void` to `sendMessage` in `ChatContext` (fires on each streamed `delta.content`). Existing callers ignore it.
- In `VoiceChat.submit`, pass an `onDelta` that maintains a "spoken-up-to" cursor and enqueues each newly completed sentence into a new `enqueueSpeak()` helper.
- `enqueueSpeak()` plays sentences serially through the existing `speak()` path (Inworld or browser TTS). `isSpeakingRef` stays true across the whole queue so the mic stays muted. After the final sentence ends *and* the network stream is done, run the existing `onEnd` (resume mic).
- Keep the current `speak(reply)` fallback when the reply is short / arrives in one chunk.

Expected: time-to-first-audio drops from "full reply latency" to "first sentence latency" — typically 60–80% faster perceived response.

### 2. Tighter silence window in hands-free

`recognition.onresult` waits 1800 ms (interim) / 1400 ms (final) before flushing.

- Lower to 1100 ms (interim) / 700 ms (final). Still safe against mid-sentence pauses but shaves ~700 ms off every turn.
- Keep the values as named constants at the top of the file so they're easy to tune.

### 3. Shorter post-TTS mic restart

`speak()` waits 700 ms after TTS ends before re-arming the mic. Lower to 400 ms — long enough to absorb speaker tail (the barge-in guards in `onresult` already drop any stray capture).

### 4. Optional fast voice model

Voice replies don't need the same model as Chat. Add an optional `voiceModel` setting (defaulting to `selectedModel` when empty) and pass it through `sendMessage({ voiceMode: true })` → `ChatContext` picks `voiceModel || selectedModel` when `voiceMode` is true and `deepResearch` is off.

- Add a new field to `useChatSettings` + a new column `voice_model` on `user_settings` (nullable text).
- Add a Voice Model selector in the Voice tab settings drawer (reuses `savedModels` list, plus a "Same as Chat model" option).
- Recommend `google/gemini-2.5-flash` or `gemini-2.5-flash-lite` in the helper text — much faster TTFB than Pro.

### 5. Lean voice system prompt

`buildChatSystemPrompt` is called for every turn. In `voiceMode`, skip the heaviest sections (full wiki dump, long book metadata) when not needed and cap retrieved context. Quick win:
- In `buildChatSystemPrompt`, when `voiceMode === true`, halve the retrieved-knowledge token budget and skip the deep-research preamble unless `voiceDeepResearch` is on.

(Will inspect `buildChatSystemPrompt.ts` during implementation to confirm the safest cut points; no feature removed, just smaller prompt in voice turns.)

## Out of scope (untouched)

- Inworld voice selection / fallback, edge function payload, API keys
- Push-to-talk, dictation, settings UI structure, hands-free toggle
- Quick-search intent, voice notes, wiki extract, deep research toggle
- Browser-TTS path, pause-on-tab-hidden, barge-in guards added last turn

## Files to edit

- `src/context/ChatContext.tsx` — add `onDelta` to `sendMessage`, route `voiceModel`
- `src/components/VoiceChat.tsx` — sentence-streaming queue, tightened timers, voice-model selector UI
- `src/hooks/useChatSettings.ts` — new `voiceModel` field + persistence
- `src/lib/buildChatSystemPrompt.ts` — leaner prompt in `voiceMode`
- New migration: add `voice_model text` to `user_settings`

## Verification

1. Hands-free on, ask a long question. First audible word should arrive within ~1–2 s of finishing speaking (vs. ~4–6 s today).
2. Mic shows "Speaking…" continuously across all sentences; no mid-reply mic capture.
3. After last sentence, mic re-arms within ~400 ms.
4. Switching Voice Model to `gemini-2.5-flash-lite` further reduces TTFB; switching back to "Same as Chat" restores prior behavior.
5. Chat tab behavior unchanged (no `onDelta` consumer there).
