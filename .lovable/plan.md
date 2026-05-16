## Goal
Remove the text input/send field from the Voice page. Keep everything else.

## Change
In `src/components/VoiceChat.tsx`:
- Remove the text input row (the `<input>` + send button added under the mic).
- Remove its local state (`textInput`) and handlers (`handleTextSend`, related key handler).
- Leave all other features untouched: mic, hands-free toggle, TTS toggle, settings (API key, model picker), Deep Research toggle + model picker, tool event chips, notes, long-press save-to-wiki, clear conversation, shared `ChatContext` history, message rendering.

## Out of scope
No backend, no ChatPanel changes, no removal of shared chat state — the text Chat tab still has its full input. Only the duplicate input on the Voice page is removed.

## Files
- `src/components/VoiceChat.tsx`
