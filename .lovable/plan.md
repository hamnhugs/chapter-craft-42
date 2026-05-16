## Goal

Stop the voice page from prompting for an OpenRouter API key on a fresh device when the same account already has one saved in text chat. Make the key per-account (synced across devices) instead of per-browser.

## Current behavior

- **Text chat (`ChatPanel`)** already uses `useChatSettings`, which reads/writes `user_settings.openrouter_api_key` in the backend. Same account on a new device → key syncs. Different account → that account has its own key (correct).
- **Voice chat (`VoiceChat`)** reads the key from `localStorage` (`openrouter_api_key`). This is per-browser, not per-account, which is why a new device always prompts even if the account already saved a key in text chat.

## Changes

1. **`src/components/VoiceChat.tsx`** — Replace localStorage-based key/model state with the shared `useChatSettings` hook (same one ChatPanel uses).
   - Remove `OPENROUTER_STORAGE_KEY`, `SAVED_MODELS_KEY`, `SELECTED_MODEL_KEY` constants and their `localStorage.getItem/setItem/removeItem` calls.
   - Replace local `apiKey`, `savedModels`, `selectedModel` state with values from `useChatSettings()`.
   - Replace local `saveApiKey`, `addModel`, `removeModel`, `setSelectedModel` handlers with the hook's equivalents.
   - Keep all existing UI, settings panel, voice features, model picker, and prompts intact — only the storage layer changes.

2. **One-time migration on load (in `VoiceChat`)** — If `useChatSettings` returns an empty `apiKey` *and* `localStorage.getItem("openrouter_api_key")` has a value, call `saveApiKey(localStorageValue)` once so users who already saved a key in the voice page don't lose it. Then clear the localStorage entry.

3. **No DB schema changes.** `user_settings.openrouter_api_key` already exists and is per-user with RLS.

## Result

- Same account on any device: voice page uses the key already saved in text chat — no second prompt.
- Different account on the other device: that account still needs its own key once (expected, since keys are personal). The prompt will only appear on accounts that have never saved one.
- Existing voice-page keys on each device are preserved via the one-time migration.

## Out of scope

No changes to text chat, auth, RLS, or any other feature. No removal of the settings panel, model picker, or voice/STT/TTS behavior.
