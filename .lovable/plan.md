## Goal
1. Add a small "read aloud" button on each chat bubble in the Chat tab so users can have the assistant (or their own) message spoken.
2. Add a TTS speed control to Chat Settings, persist it, and use the same value when speaking in the Voice tab — replacing the current hard-coded `utterance.rate = 1.05`.
3. Preserve every existing feature: hands-free mode, push-to-talk, TTS toggle, Deep Research, model selection, notes/wiki actions, chat history, mobile layout, collapsed controls.

## Changes

### 1. Persisted TTS speed (shared)
- Extend `useChatSettings` with `ttsRate` (default `1.05`, range `0.5–2.0`) plus `setTtsRate`.
- Add a `tts_rate` column to `user_settings` (numeric, default 1.05) via migration, and include it in the load/upsert payload.
- Loading falls back to the default when the column or row is missing so existing users are unaffected.

### 2. Chat Settings UI
- In `ChatPanel`'s Settings drawer, add a "Voice playback speed" slider (uses existing `Slider` component) bound to `ttsRate`, with a small numeric readout (e.g. `1.05×`).
- Place it alongside existing model controls without removing or reordering current settings.

### 3. Read-aloud button on chat bubbles
- Add a tiny icon button (Material icon `volume_up` / `stop`) anchored to the edge of each `ChatPanel` message bubble.
- Click toggles speaking that bubble's text using `window.speechSynthesis`, with `utterance.rate = ttsRate` from settings.
- Clicking another bubble (or the same one again) cancels current speech first; component unmount also cancels.
- Works for both user and assistant bubbles. No layout shift on hover; button is always visible but subtle, sized appropriately for the current 627px viewport.

### 4. Voice tab speed wiring
- In `VoiceChat.speak`, replace the hard-coded `1.05` with `ttsRate` from `useChatSettings`.
- No changes to hands-free logic, transcription buffers, the existing TTS on/off toggle, or any other behavior.

## Technical notes
- A small shared helper `src/lib/speak.ts` exposes `speak(text, rate)` and `stopSpeaking()` wrapping `window.speechSynthesis` to keep `ChatPanel` and `VoiceChat` in sync and avoid duplicated cancellation logic.
- DB migration: `ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS tts_rate numeric NOT NULL DEFAULT 1.05;` (no RLS changes needed).
- No new dependencies.