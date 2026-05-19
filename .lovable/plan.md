## Remove Hands-Free + Fix Inworld TTS

Two independent changes in this turn. Everything else in the Voice tab stays exactly as it is.

---

### Part A — Remove Hands-Free mode (Voice tab only)

Surgical removal. The Chat tab and all other voice features are untouched.

**`src/components/VoiceChat.tsx`** — remove only the hands-free pieces:
- `HANDS_FREE_KEY` constant.
- `handsFree` state, `handsFreeRef`, the localStorage round-trip useEffect.
- `toggleHandsFree`, `stopHandsFree` functions.
- The Hands-free toggle button in the controls row.
- The "Hands-free Playback Speed" slider + label + helper text in the settings dialog.
- All `handsFreeRef.current` branches in:
  - the "pause when tab hidden" effect → can be removed entirely.
  - speech-recognition setup: `recognition.continuous = false`, single-turn behavior restored.
  - the streaming `onDelta`/`onDone` paths: collapse to the non-hands-free branch.
  - the silence-timer auto-send block → removed; manual mic + Enter remain.
- Status/placeholder strings ("Hands-free paused", "— say something", "turn on Hands-free…") rewritten to the simple single-turn copy.
- `effectiveTtsRate` simplified to `ttsRate || 1.05`.

**`src/hooks/useChatSettings.ts`** — leave the `hands_free_tts_rate` DB column alone (no migration churn) but drop `handsFreeTtsRate` from the destructure in `VoiceChat.tsx`. The setter still exists for safety; it's just unused.

Net: no other feature touched (mic, text input, TTS toggle, voice model, Inworld toggle, voice picker, book context, prompt presets, system prompt, model picker, etc.).

---

### Part B — Make Inworld TTS reliable

The current edge function already matches the documented `POST /tts/v1/voice` shape. Two real bugs + one UX gap explain why it "doesn't work properly":

**Bug 1 — API key detection is too strict.**
`basicAuth()` uses regex `/^[A-Za-z0-9+/]+=+$/` which **requires `=` padding**. Inworld keys copied from the portal are pre-encoded Base64 but sometimes lack padding, so the function silently double-encodes them and Inworld returns 401.

Fix: detect a `:` in the trimmed key → treat as raw `key:secret` and base64-encode. Otherwise treat as already-Base64 Basic credentials and use verbatim. Strip any leading `Basic ` the user may have pasted.

**Bug 2 — Schema drift to current docs.**
Add the now-recommended fields so TTS-2 behaves correctly:
- `deliveryMode: "BALANCED"` (TTS-2 replaced `temperature` with this).
- `applyTextNormalization: "ON"`.

Keep MP3 / 24 kHz default (browser plays MP3 directly via the existing client path).

**UX gap — no feedback when it fails.**
Add a small **"Test voice"** button in the Inworld settings card of `VoiceChat.tsx`. Calls `synthesizeSpeech("Testing one two three.", …)` and plays the result. On failure it surfaces the raw Inworld error in a toast so the user (and we) can see what's wrong instantly.

**Files touched**
- `supabase/functions/inworld-tts/index.ts` — `basicAuth()` rewrite, add `deliveryMode` + `applyTextNormalization`, keep current error-bubbling.
- `src/components/VoiceChat.tsx` — the Test-voice button in the Inworld settings block.

No DB migrations. No secrets needed (key already lives in `user_settings.inworld_api_key`). No other files changed.
