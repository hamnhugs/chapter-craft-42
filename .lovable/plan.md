Plan to fix hands-free voice transcription:

1. Stabilize SpeechRecognition buffering
- Replace the current append-only final transcript handling with per-result-index tracking.
- Store finalized recognition chunks by their result index, then rebuild the spoken text from the latest stable chunks instead of blindly appending every final event.
- This prevents Chrome/Edge hands-free mode from duplicating phrases when it re-emits or corrects final results.

2. Keep legitimate repeated words
- Avoid broad same-text blocking that would remove real speech like “very very” or repeated commands.
- Only suppress duplicates when the same recognition result index is emitted again by the browser engine.

3. Separate hands-free session state cleanly
- Reset transcript chunk tracking whenever listening starts, stops, or restarts after the assistant finishes speaking.
- Keep the existing hands-free restart loop, TTS behavior, push-to-talk behavior, notes, settings, Deep Research, Save to Wiki, collapsed controls, and chat history untouched.

4. Safer submit timing
- Keep the silence debounce, but make submission read from the rebuilt stable transcript rather than an append-only buffer.
- Ensure `onend` and the debounce timer cannot submit the same utterance twice.

5. Add lightweight reliability guards
- Normalize spacing before display/submission.
- Keep interim transcript visible while speaking.
- Clear only voice-recognition buffers, not chat, notes, settings, or other page state.