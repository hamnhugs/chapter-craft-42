## Feature

Add an "Auto-read assistant replies" toggle in the Chat tab settings. When ON, every new assistant message is automatically read aloud using the existing TTS engine and the current Voice Playback Speed.

## Changes

1. **Database** — add `auto_read_replies boolean not null default false` to `user_settings`.

2. **`src/hooks/useChatSettings.ts`**
   - Add `autoReadReplies: boolean` to `ChatSettings` (default `false`).
   - Load / save it alongside the other settings (`auto_read_replies` column).
   - Expose `setAutoReadReplies(v: boolean)`.

3. **`src/components/ChatPanel.tsx`**
   - In the settings panel, add a new toggle row right above the Voice Playback Speed slider: label "Auto-read assistant replies", small helper text "Reads each new reply aloud using the speed below."
   - Use a shadcn `Switch` (already in the stack) for consistent styling.
   - Add an effect: when `autoReadReplies` is ON and a new assistant message appears (detect last message role transitioning to "assistant" with a stable id not yet read), call `speak(msg.content, { id, rate: ttsRate })`. Guard against:
     - duplicate reads of the same message id (track a `lastSpokenIdRef`),
     - empty/streaming-in-progress content (only trigger when message is final — `!msg.streaming` if available, else when content length stops growing across renders; in this codebase messages appear finalized when added, so trigger on append).
   - When the toggle is turned OFF mid-playback, call `stopSpeaking()`.

4. **No changes to existing manual read-aloud buttons** — they continue to work as today.

## Verification

- Toggle ON → send a chat message → assistant reply is read aloud automatically at the configured speed.
- Toggle OFF mid-read → playback stops.
- Refresh page → setting persists.
- Manual ▶ on older messages still works.
