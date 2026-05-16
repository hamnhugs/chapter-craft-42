## Problems found

In `src/components/VoiceChat.tsx` the previous fix overcorrected and now drops or mangles real speech:

1. **Push-to-talk loses the tail of long sentences.** In non-hands-free mode, the first `isFinal=true` result triggers `flushPendingTranscript` immediately (and stops recognition). Chrome routinely splits one spoken sentence into 2–3 final chunks, so only the first chunk reaches the model — the rest is discarded. This is the main "not transcribing correctly" symptom.
2. **Legitimate repeated words get dropped.** `if (!buf.endsWith(newFinal)) ...` and the `lastFinalSegmentRef` skip throw away segments when the user actually says the same word/phrase twice (common in speech: "yes yes", "wait wait", "no, no I meant…").
3. **2.5 s send-dedupe drops valid short re-sends.** If the user says "next" or "yes" twice in a row, the second one is silently swallowed.
4. **Loop bound is correct**, but the manual segment-skip on top of `event.resultIndex` is redundant and causes #2.

## Fix (scoped, no feature removal)

Edit `src/components/VoiceChat.tsx` only:

1. **Unify debounce across both modes.** After any new final result, set a single idle timer (~700 ms) that flushes when speech pauses. Applies to push-to-talk **and** hands-free. No more immediate flush on first final → fixes truncation.
2. **Trust `event.resultIndex`** to know what's new. Remove `lastFinalSegmentRef` echo skip and remove the `endsWith` append guard. Always append new finals with a single space.
3. **Remove the 2.5 s same-text send guard.** With (1) in place, Chrome echoes don't reach `flushPendingTranscript` separately, so the guard only causes false drops. Keep the fresh-recognition-per-session restart already in place (that was the real anti-duplication win).
4. **Keep everything else untouched:** mic button, hands-free toggle, TTS toggle + post-TTS restart delay (400–600 ms), Deep Research, settings, model picker, notes panel, long-press save, save-to-wiki, clear conversation, shared `ChatContext`, system prompt builder.

## Out of scope
No backend changes, no edge functions, no UI restructure, no swap to ElevenLabs / external STT, no Hermes route changes, no removal of any voice feature.

## Files
- `src/components/VoiceChat.tsx` (only)
