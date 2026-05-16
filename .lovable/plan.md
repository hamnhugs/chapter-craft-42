## Problem

Hands-free mode produces duplicated and messy text. Root causes in `src/components/VoiceChat.tsx`:

1. **Recognition instance is reused across sessions.** `safeStartListening` calls `recognitionRef.current?.start()` on the same `SpeechRecognition` object created in `startListening`. After `stop()` + `start()`, Chrome can re-emit already-finalized chunks, so `finalBufferRef` accumulates the same words again.
2. **No dedupe guard between flushes.** If `onresult`'s 900 ms timer fires and `onend` also flushes, or if Chrome emits the same final segment twice across restarts, the same phrase gets sent twice.
3. **Mic restarts too quickly after TTS** (`~200 ms`), so the tail of the spoken reply leaks into the next transcript, producing extra words.
4. **No segment-level dedup** when appending to `finalBufferRef` — repeated identical finals concatenate verbatim ("hello hello hello").

## Fix (scoped to VoiceChat.tsx, no feature removal)

1. Refactor `startListening` into a `createRecognition()` factory. `safeStartListening` builds a **fresh** `SpeechRecognition` each restart in hands-free mode instead of calling `.start()` on the old one. All handlers (`onresult`, `onend`, `onerror`, `onstart`) reattached per instance.
2. Track `lastFinalSegmentRef` (string) per active session: when a new final segment arrives, skip it if it equals the previous final segment (Chrome echo). Reset on session start and on flush.
3. Track `lastSentTextRef` + `lastSentAtRef`: in `flushPendingTranscript`, if the trimmed text equals the last sent text within 2.5 s, drop it instead of submitting.
4. Append finals with a small dedupe: collapse if `finalBufferRef` already ends with the same trimmed segment.
5. Increase post-TTS restart delay from 200 ms to ~450 ms (and post-error to 600 ms) to stop speaker bleed-through. Hands-free, TTS toggle, settings, Deep Research, text input, save-to-wiki, long-press, notes, clear, model picker — all untouched.
6. In `onend` hands-free branch, only flush if buffer is non-empty AND it differs from `lastSentTextRef`; otherwise just rebuild a fresh recognition and start.

## Out of scope
No backend, no edge function, no UI/visual changes, no removal of mic / hands-free / TTS / text input / Deep Research / tools / notes / settings features. Web Speech API stays — no swap to ElevenLabs.

## Files
- `src/components/VoiceChat.tsx` (only)
