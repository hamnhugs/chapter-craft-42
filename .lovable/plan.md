# Fix: Hands-free mic picking up AI's own voice

## Problem
In hands-free mode, when the assistant's reply is being spoken (Inworld or browser TTS), the SpeechRecognition stream stays active. The microphone hears the speaker output and transcribes it as a new user turn (e.g. "Knot Magic by Tylluan…" → "not Magic by till"), which then gets submitted as the next prompt.

## Root cause
In `src/components/VoiceChat.tsx`:
- `speak()` flips `isSpeaking` to true, but it does **not** stop the active `SpeechRecognition`. The recognizer keeps running through TTS playback.
- `recognition.onresult` has no guard against `isSpeakingRef.current`, so chunks captured during playback flow into `finalTranscriptRef` and the silence timer fires `flushPendingTranscript()`.
- `recognition.onend` already guards on `isSpeakingRef`, but onresult does not — and onend rarely fires mid-playback because `continuous = true`.

## Fix (minimal, preserves every existing feature)

All changes are localized to `src/components/VoiceChat.tsx`. No feature, button, setting, or flow is removed.

1. **Hard mute the recognizer the moment TTS starts.**
   In `speak()`, before kicking off Inworld synth or browser `SpeechSynthesisUtterance`:
   - Set `isSpeakingRef.current = true` synchronously (don't wait for the state effect).
   - Clear `sendTimerRef` and reset `finalTranscriptRef` / `previousFinalLengthRef` / `interimTranscript` so any partial capture from the user's just-finished turn isn't re-submitted.
   - Call `stopCurrentRecognitionQuietly()` so the mic stream is released during playback (best echo isolation; works even without hardware AEC).
   - Existing `onEnd` already restarts listening via `safeStartListening()` after a 400–600 ms grace — keep that, just bump the post-TTS delay to ~700 ms to absorb speaker tail.

2. **Defense in depth: ignore recognition results while speaking.**
   At the top of `recognition.onresult`, early-return when `isSpeakingRef.current || isLoadingRef.current` is true. This protects against the small window between TTS start and the recognizer actually stopping, and against any race where a stale recognizer instance delivers a final chunk.

3. **Don't auto-restart when TTS is still playing.**
   In `recognition.onend`, the existing guard `!isSpeakingRef.current` is already there — keep it. Also in the `setTimeout(... safeStartListening, 250)` branch, wrap the call so it re-checks `!isSpeakingRef.current && !isLoadingRef.current` at fire time (covers the case where TTS started during the 250 ms wait).

4. **Inworld branch parity.**
   The Inworld code path constructs an `Audio` element. Add `audio.onplay = () => { isSpeakingRef.current = true; setIsSpeaking(true); }` so the speaking flag is true *before* the first sample is emitted (today it's set right after `synthesizeSpeech` is called, which is fine — but onplay is the canonical signal and avoids a gap if synth is slow).

## Out of scope (intentionally not touched)
- Inworld voice selection / fallback (`Ashley`) — left as-is.
- Edge function payload — left as-is.
- Browser TTS path, dictation hook, push-to-talk, settings UI, voice search intent — all untouched.
- Hands-free toggle, pause-on-tab-hidden, error handling, model/API key flows — untouched.

## Files
- `src/components/VoiceChat.tsx` — only file modified.

## Verification
- Toggle hands-free on, ask "list my books", let the assistant speak a long reply, confirm the recognizer status shows "Speaking…" (not "Listening…") throughout playback, and that no spurious user turn is created. Then verify the mic auto-resumes after the reply ends.
