Make Voice tab hands-free and give it richer Wiki access.

## What changes

1. Hands-free conversation mode
   - Add a "Hands-free" toggle next to the existing mic/TTS controls.
   - When ON: start mic once, keep it open continuously. After the user finishes a sentence, send to the model. While the assistant speaks, mic pauses to avoid echo. As soon as TTS finishes, mic auto-resumes — no button press needed.
   - When OFF: current push-to-talk behavior stays exactly as it is today.
   - A clear status pill ("Listening", "Thinking", "Speaking", "Paused") so it's obvious what the app is doing.
   - Auto-recover from common interruptions (no-speech timeouts, transient mic errors) with silent restart; only surface a toast if the mic truly fails.

2. Stronger Wiki brain for the voice agent
   - Voice agent already pulls wiki entries; expand it so the agent always sees the full wiki (not capped at 20) and prioritizes entries related to the active book + recent conversation topics.
   - Include conversation memory summary + key facts (already partially wired) and make sure the system prompt clearly tells the model: "Use the Wiki entries below as your primary knowledge source; cite them by title when relevant."
   - After each voice exchange, optionally auto-extract new knowledge into the wiki (toggle, default OFF, so we don't surprise the user).

3. Small UX safeguards
   - Stop hands-free mode automatically if the tab is hidden / user navigates away.
   - One-tap "Stop" pill that fully ends hands-free mode and silences TTS.
   - Persist the hands-free preference in localStorage.

## Files touched
- `src/components/VoiceChat.tsx` — only file. All logic lives here today; no backend changes required since wiki access already uses `fetchKnowledgeEntries` / `fetchConversationMemory`.

## Out of scope
- No backend/edge function changes.
- No swap of speech engine (keeps Web Speech API). Browser support note stays the same (Chrome/Edge).