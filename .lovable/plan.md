Switch to the canonical Web Speech API pattern that the MDN reference uses, which is the most reliable way to avoid duplicates in continuous/hands-free mode. The current per-index Map approach still mishandles how Chrome emits `event.results` in continuous mode, which is causing the regression.

## What I will change in `src/components/VoiceChat.tsx`

1. **Replace per-index Map with a canonical full-rebuild on every event**
   - In `recognition.onresult`, loop over the entire `event.results` array (from 0, not `event.resultIndex`).
   - Build two strings on every event: `finalText` from `isFinal` results, `interimText` from the rest.
   - Store `finalText` in a single `finalTextRef` (string), overwriting it each event. This is what MDN recommends and what Chrome's continuous mode is designed for — re-emits and corrections naturally overwrite, so duplication is impossible.
   - Drop `finalChunksRef` (the Map) and `buildStableTranscript()`. Keep `submittingRef` and the debounce timer.

2. **Detect "new final" correctly**
   - Track previous final length in a ref. If `finalText.length > prevFinalLen`, that's a new final → reset the 700ms silence-debounce timer.
   - This avoids resetting the timer on pure interim updates while still flushing after the user stops talking.

3. **Flush uses the single ref**
   - `flushPendingTranscript` reads `finalTextRef.current.trim()`, sets `submittingRef = true`, clears `finalTextRef`, clears interim, stops recognition, submits.
   - Keep the existing guard so `onend` cannot double-submit while `submittingRef` is true.

4. **Hands-free session boundaries**
   - In `safeStartListening`, `startListening`, and `stopListening`: reset `finalTextRef`, `submittingRef`, interim, and the debounce timer before constructing a new `SpeechRecognition` instance. This guarantees the new session starts with a clean slate so the next utterance can't be prefixed by stale text.
   - Keep the existing hands-free restart loop, TTS, push-to-talk, visibility-pause behavior, and all UI/feature wiring untouched.

5. **Defensive guard against overlapping recognition instances**
   - Before assigning a new `recognitionRef.current`, null out the old one's `onresult`/`onend` handlers so a late event from a stopped session cannot write into the new session's buffers.

6. **Keep interim transcript display behavior**
   - `setInterimTranscript` continues to show `finalText + " " + interimText` (normalized), so the user still sees live partial words.

## Out of scope (will not touch)

- Collapsible controls, swipe handle, mini mic, Notes, Wiki, Deep Research, settings, TTS, push-to-talk button, chat history, message UI, long-press to save, selection capture.
- `ChatContext`, `useChatSettings`, edge functions, Supabase calls.

## Why this fixes the regression

The per-index Map relies on `event.resultIndex` being a stable identifier across events. In Chrome's continuous mode that index can shift when partials get split/merged across results, so different finals can land in the same slot or the same final can land in two slots — both producing the duplicated words the user is seeing. Rebuilding the full transcript from `event.results` on every event mirrors MDN's reference implementation and is the only pattern that's robust to those re-emits.
