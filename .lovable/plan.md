## Goal
Eliminate the recurring `Unknown voice: undefined not found!` 404 from Inworld TTS and make voice selection reliable.

## Root cause
The edge function and payload shape now match Inworld's official spec (`POST /tts/v1/voice`, camelCase fields, `Basic` auth). The error comes from the **client** calling synth without a `voiceId` — either the user hasn't picked one yet, or the voices list failed to load and there's no fallback.

## Changes

### 1. `src/lib/inworldTts.ts`
- In `synthesizeSpeech`, if the resolved `voiceId` is empty/null/undefined → default to **`"Ashley"`** instead of throwing. (Ashley is one of Inworld's always-available built-in voices per their quickstart.)
- Default `modelId` to `"inworld-tts-2"` when not provided.
- Keep the existing voice-list normalization.

### 2. `src/components/VoiceChat.tsx` (or wherever voice is chosen)
- When the voices list loads, if no voice is currently selected in settings, auto-select the first returned voice (or fall back to `"Ashley"`).
- Persist that selection via `useChatSettings` so subsequent calls always carry a real `voiceId`.

### 3. `supabase/functions/inworld-tts/index.ts`
- Keep the current endpoint and payload. Add a **server-side safety net**: if incoming `voiceId` is empty after normalization, substitute `"Ashley"` and log a warning. Prevents the 404 even if the client regresses.
- Make sure the error response surfaces the actual `voiceId` we sent to Inworld (helps future debugging).

## What I do NOT need from you
- I do not need your runtime API key pasted in chat. Whatever Base64 key you stored as the `INWORLD_API_KEY` secret is already what the edge function reads.

## What I DO need from you (optional, only if Ashley is wrong)
- If you want a specific default voice other than "Ashley" or "Dennis" (e.g. a cloned voice from your workspace), tell me the exact voice ID and I'll use it as the default.

## Verification
- After deploy, call `inworld-tts` via the curl tool with no `voiceId` → must return audio (not 404).
- Open VoiceChat in the preview → voices dropdown populates and first item is auto-selected → synth plays.