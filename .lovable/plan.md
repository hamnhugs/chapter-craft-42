## What's actually broken

Two independent bugs in `src/components/VoiceChat.tsx` produce the symptom "Inworld settings don't persist and randomly switch to default TTS mid-chat":

### Bug 1 — Silent fallback to browser TTS on a single synth failure
In `pumpSynth()` (lines ~376–396), if any single sentence's call to `synthesizeSpeech()` rejects (transient 5xx from Inworld, brief network blip, edge cold-start timeout, abort race), the catch block speaks that chunk via `SpeechSynthesisUtterance` (the OS/browser default voice). The rest of the reply then continues in Inworld, so the user hears the AI suddenly switch voices mid-sentence and assumes the Inworld setting flipped off.

### Bug 2 — `inworldEnabled` and `inworldVoiceId` are localStorage-only
- `inworldApiKey` lives in `user_settings` (DB, persistent across devices/sessions). ✅
- `inworldEnabled` and `inworldVoiceId` live **only** in `localStorage` (keys `inworld_tts_enabled`, `inworld_voice_id`). ❌

Consequences:
- Cleared site data, private window, new device, or PWA cache eviction → both revert to defaults (`enabled=false`, `voiceId=""`).
- On every fresh mount, `inworldApiKey` is `""` until `useChatSettings` finishes its DB round-trip. If a reply starts streaming during that window, `enqueueSpeak`'s gate `inworldEnabled && inworldApiKey && inworldVoiceId` is false and the whole reply uses browser TTS, looking like the setting "switched."
- Voice ID also gets auto-reassigned to `voices[0]?.voice_id || "Ashley"` inside `loadInworldVoices` whenever `inworldVoiceId` is falsy at load time — which can clobber the user's choice if local storage is ever empty at boot.

## Fix

### 1. Move Inworld toggle + voice ID into `user_settings`

Add two columns to `user_settings` via migration:
- `inworld_enabled boolean NOT NULL DEFAULT false`
- `inworld_voice_id text NOT NULL DEFAULT ''`

Extend `src/hooks/useChatSettings.ts`:
- Read both fields in the load block.
- Add to the upsert payload.
- Expose `inworldEnabled`, `inworldVoiceId`, `setInworldEnabled`, `setInworldVoiceId`.
- Keep defaults in the `defaults` object.

Update `src/components/VoiceChat.tsx`:
- Replace the two local `useState` + `localStorage` effects with the hook values.
- Remove the `INWORLD_VOICE_ID_KEY` / `INWORLD_ENABLED_KEY` constants and their persistence effects.
- One-time migration: on mount, if hook values are empty and legacy localStorage keys exist, copy them into the hook (via setters) and `removeItem` from localStorage. Mirrors the existing legacy-API-key migration already in the file.
- In `loadInworldVoices`, only auto-pick `voices[0]` when `inworldVoiceId` is empty **and** there's no saved value coming from the DB (i.e. after `settingsLoaded` is true and the field is still ""). Never overwrite a saved selection.

### 2. Stop silently falling back to browser TTS mid-reply

In `pumpSynth()`'s `.catch` (lines ~376–396):
- Remove the inline `SpeechSynthesisUtterance` fallback.
- Replace with: retry the same chunk once (re-push to the front of `ttsQueueRef`, increment a per-chunk retry counter stored in a `WeakMap`/parallel `Map<string, number>`, cap at 2 retries). If it still fails, drop the chunk, log to console, and surface a single throttled `toast.error("Inworld TTS hiccup — skipping a sentence")` per turn.
- Reasoning: a one-off transient error should never silently change the voice. Retrying covers the cold-start / network-blip case; skipping a sentence is far less jarring than a voice swap and keeps Inworld as the only voice for the whole turn.

### 3. Defer first chunk until settings have loaded

In `enqueueSpeak` (line ~447):
- If `!settingsLoaded`, push the chunk to `ttsQueueRef` and an `awaitingSettingsRef` flag; on the `settingsLoaded` transition, run `pumpSynth()` / `pumpPlay()` once.
- This eliminates the "first turn after refresh uses browser TTS because the DB hadn't responded yet" race.

### 4. Keep everything else exactly as-is

Not touched: hands-free turn-taking (`turnActiveRef`, `safeStartListening`, silence timers, mic mute), sentence streaming `onDelta`, `submit()`, voice model selector, `ttsRate`, browser-TTS path for users who haven't enabled Inworld (still works as a deliberate, user-chosen mode), settings UI layout, `ChatContext`, `buildChatSystemPrompt`, edge function, `inworldTts.ts` client.

## Files touched

- `supabase/migrations/<new>.sql` — add two columns to `user_settings`.
- `src/hooks/useChatSettings.ts` — load/save/expose `inworldEnabled` + `inworldVoiceId`.
- `src/components/VoiceChat.tsx` — swap localStorage for hook values, add legacy-key migration, remove silent browser-TTS fallback in `pumpSynth` (replace with retry + skip), defer `enqueueSpeak` until `settingsLoaded`.

## Verification

1. Enable Inworld + pick a voice. Hard-refresh. Toggle and voice still selected before any DB request resolves (they hydrate from DB, plus optimistic localStorage migration covers the legacy case).
2. Sign in on a second device/browser → Inworld toggle + voice carry over.
3. Throttle network in DevTools and ask a multi-sentence question. Voice stays Inworld throughout; no mid-reply switch to system voice. If a sentence truly can't synthesize after retry, you see one toast and that sentence is skipped — every other sentence is still Inworld.
4. First message after a cold page load uses Inworld (not browser TTS) because `enqueueSpeak` waits for `settingsLoaded`.
5. Browser-TTS-only users (Inworld off) behave identically to today.