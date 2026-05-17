# Fix: Hands-free mic capturing AI while it speaks

## Why it regressed

The streaming-TTS change made replies start faster, but it shifted **when** the mic gets muted. Before, `speak(reply)` ran once after the full reply arrived and set `isSpeakingRef` synchronously. Now the mic is only muted the moment the **first sentence** is enqueued (`enqueueSpeak` → `muteMicForTts`). That leaves three open windows where the recognizer can be live while the AI is producing/playing audio:

1. **Pre-first-token window** — `submit()` calls `sendMessage`, but the first sentence may not arrive for 500-2000ms. `isLoadingRef.current` is updated by a `useEffect` so there's a one-tick gap where a late `onresult` from the just-stopped recognizer slips past the guard and re-arms a silence timer.
2. **Inter-chunk gaps** — between Inworld sentence chunks the audio's `onended` fires; if the next sentence hasn't arrived yet, `playNextChunk` returns and `ttsPlayingRef` is false. `isSpeakingRef` stays true, but any in-flight `safeStartListening` timeout scheduled earlier (e.g. from `recognition.onend`'s 250ms restart) can still re-check and start listening since its only gates are `isSpeakingRef`/`isLoadingRef`.
3. **Stream-done but queue-not-drained** — `markTtsStreamDone()` is called as soon as `sendMessage` resolves. If the queue is empty for a microsecond between chunks at that moment, the `else` branch schedules `safeStartListening` even though more sentences may still be coming in via Inworld synth.

Result: a `safeStartListening` fires while TTS is mid-reply, the mic transcribes the speaker, the silence timer triggers a new `submit`, and the AI talks over itself.

## Fix

Treat the **whole voice turn** (from `submit()` start through the last queued TTS chunk finishing) as one "do not listen" window, instead of relying on per-chunk speaking state.

### Changes in `src/components/VoiceChat.tsx`

1. **New ref `turnActiveRef`** — set `true` at the very top of `submit()`, cleared inside `finishTtsAndResumeMic()`. Persists across the request, all streamed chunks, inter-chunk gaps, and post-TTS grace.

2. **Mute mic synchronously at submit start** — before calling `sendMessage`:
   - `turnActiveRef.current = true`
   - `isSpeakingRef.current = true` (early, even before any audio)
   - `stopCurrentRecognitionQuietly()` + clear `sendTimerRef` + reset transcript buffers
   This closes the pre-first-token window.

3. **Strengthen `safeStartListening` gate** — additionally bail when any of these are true: `turnActiveRef.current`, `submittingRef.current`, `ttsPlayingRef.current`, `ttsQueueRef.current.length > 0`, or `streamDoneRef.current === false`. This kills any stale 250ms restart timeout from a prior `onend`.

4. **Strengthen `recognition.onresult` and `onend` guards** — also check `turnActiveRef.current`. Closes the React-effect lag on `isLoadingRef`.

5. **`playNextChunk` empty-queue branch** — only call `finishTtsAndResumeMic()` when `streamDoneRef.current === true` *and* `ttsQueueRef.current.length === 0` *and* `ttsPlayingRef.current === false`. (Today it already checks streamDone, but make the triple-check explicit so the inter-chunk pause never resumes the mic.)

6. **`markTtsStreamDone`** — same triple-check before resuming mic. If anything is still queued or playing, do nothing; the audio's `onended` will pick it up.

7. **`finishTtsAndResumeMic`** — set `turnActiveRef.current = false` before scheduling `safeStartListening`. Single source of truth for turn end.

8. **`stopSpeaking()` and `stopHandsFree()`** — also clear `turnActiveRef.current` so manual cancel doesn't leave the mic permanently muted.

9. **Error path in `submit()` `catch`** — clear `turnActiveRef` before the fallback `safeStartListening` so the mic can recover after a failed turn.

### What stays untouched

- Sentence-streaming queue, Inworld voice selection + fallback, voice model selector
- Silence/post-TTS timing constants (`SILENCE_INTERIM_MS`, `SILENCE_FINAL_MS`, `POST_TTS_DELAY_MS`)
- All non-voice paths (Chat tab, dictation, push-to-talk, notes, settings, deep research, quick search, wiki extract, browser TTS fallback)
- `ChatContext`, `useChatSettings`, `buildChatSystemPrompt`, edge functions, migrations

### Verification

1. Hands-free on, ask a long question → mic indicator goes off the instant you stop talking and stays off until the AI's last sentence finishes + ~400ms.
2. During Inworld inter-sentence gaps, mic does not flicker back on.
3. Speaking over the AI does **not** spawn a second response.
4. Tapping the mic stop button or toggling hands-free off mid-reply still cancels cleanly and lets you start a fresh turn.
5. Non-hands-free push-to-talk and the Chat tab behave exactly as before.
