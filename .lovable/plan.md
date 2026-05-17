# Speed up Inworld (API) TTS in the Voice tab

## Goal

Reduce time-to-first-audio and remove dead gaps between sentences when hands-free uses the Inworld API. No changes to the listening/turn-taking workflow already in place.

## Why it's slow today

In `src/components/VoiceChat.tsx` (`playNextChunk`):
1. Synthesis is **strictly serial** — the next chunk's `synthesizeSpeech()` HTTP call only fires after the previous chunk's `audio.onended`. Every sentence eats a full network round-trip before it plays.
2. The edge function (`supabase/functions/inworld-tts/index.ts`) calls Inworld's **non-streaming** `tts/v1/voice` endpoint, waits for the full MP3, base64-decodes it, then returns. First byte to client only after Inworld finishes the whole sentence.
3. MP3 is requested at 48 kHz — larger payload + slower server-side encode than needed for speech.
4. First call after idle hits an edge-function cold start.
5. A fresh `new Audio()` is created per chunk; on some browsers that adds extra setup latency.

## Fix (4 layers, all reversible)

### 1. Client-side TTS prefetch pipeline (biggest win, no API change)

In `playNextChunk` / `enqueueSpeak`, decouple **synthesis** from **playback**:

- Add `ttsAudioQueueRef: { url: string }[]` next to `ttsQueueRef` (text queue).
- New `synthesizeAhead()` worker: while `inFlightCount < 2`, pop the next text chunk, call `synthesizeSpeech`, push the resulting blob URL onto `ttsAudioQueueRef`. Kick it whenever `enqueueSpeak` adds text or a chunk finishes playing.
- `playNextChunk` now pulls from `ttsAudioQueueRef`. If empty but text queue has items and a synth is in flight, just wait — `onended` of the currently-playing audio still drives the next call.
- Cap concurrency at 2 (configurable const `TTS_PREFETCH_CONCURRENCY`) so we don't hammer Inworld.
- Cancellation: `stopSpeaking()` revokes all queued blob URLs and aborts in-flight fetches via an `AbortController` per request.

Result: while sentence N is playing, sentence N+1 (and often N+2) are already synthesized — inter-sentence gap collapses from ~500–1500 ms to near zero.

### 2. True audio streaming from the edge function (first-token win)

Update `supabase/functions/inworld-tts/index.ts` POST handler:

- Switch from `tts/v1/voice` to Inworld's streaming endpoint `tts/v1/voice:stream` (returns NDJSON of base64 audio chunks).
- Return a `ReadableStream` to the client: decode each chunk's base64 → push raw MP3 bytes to the response stream. `Content-Type: audio/mpeg`, `Transfer-Encoding: chunked`.
- Keep the existing non-streaming code path as a fallback if the stream endpoint errors.

Add a new client helper `synthesizeSpeechStream()` in `src/lib/inworldTts.ts` that returns the `Response` so the caller can feed it to `MediaSource` (preferred) or, on Safari/iOS where MSE for MP3 is flaky, fall back to buffering the whole `arrayBuffer()` (current behavior).

In `playNextChunk`, when MSE is supported: create the `<audio>` immediately, attach a `MediaSource`, append bytes as they arrive, and call `audio.play()` as soon as the first chunk is buffered. First audible word now starts within ~150–300 ms of Inworld's first byte instead of waiting for the whole sentence.

### 3. Lighter audio config

In the edge function payload:
- `audioEncoding: "MP3"`, `sampleRateHertz: 24000` (was 48000). 24 kHz is more than enough for speech, halves payload and shortens server-side encode. Keep 48 kHz as a settings-driven override later if anyone complains, but default to 24 kHz.

### 4. Cold-start + connection warmup

- On mount of `VoiceChat`, when hands-free is enabled OR when the user opens the settings sheet, fire a one-time `HEAD`/tiny `GET /voices` to the `inworld-tts` function to warm the isolate. Already implemented partially (`loadInworldVoices`); just make sure it runs once at mount when `inworldEnabled && inworldApiKey && inworldVoiceId` so the very first turn isn't the cold one.
- Add `<link rel="preconnect" href="https://ktzaysdkdkocqhewwtnn.supabase.co" crossorigin>` to `index.html` so the TLS handshake to the functions host is done before the user finishes their first sentence.
- Reuse a single persistent `inworldAudioRef` `<audio>` element across chunks (already mostly the case — just stop re-creating with `new Audio()` and instead set `.src` on the persistent element).

## Files touched

- `src/components/VoiceChat.tsx` — add prefetch queue, persistent audio element, MSE playback path, AbortController wiring. **No changes** to `turnActiveRef`, `safeStartListening`, mic mute/unmute, silence timers, or any submit/onDelta logic.
- `src/lib/inworldTts.ts` — add `synthesizeSpeechStream()` returning the raw `Response`; keep `synthesizeSpeech()` unchanged for fallback and non-streaming callers.
- `supabase/functions/inworld-tts/index.ts` — POST handler: try streaming endpoint, return `ReadableStream`; switch sample rate default to 24000; keep existing non-streaming branch as fallback on error.
- `index.html` — single `<link rel="preconnect">` line.

## Explicitly NOT touched

- Hands-free turn-taking logic (`turnActiveRef`, `safeStartListening`, silence/post-TTS timers, mic mute/unmute).
- Sentence-streaming `onDelta` regex / `enqueueSpeak` call sites.
- Voice model selector, voice ID picker, settings UI, `useChatSettings`, `ChatContext`, `buildChatSystemPrompt`.
- Browser TTS fallback, non-hands-free push-to-talk, Chat tab, dictation, notes, knowledge, migrations.

## Verification

1. Hands-free on, ask a multi-sentence question. First audio should start noticeably sooner (target <800 ms after the first sentence is enqueued vs. current ~1.5–2.5 s).
2. Inter-sentence pauses should be effectively gone — playback feels continuous.
3. Tapping the mic stop button mid-reply still cancels cleanly (no orphan audio, no leaked blob URLs).
4. Mic does not re-arm while TTS is playing (existing `turnActiveRef` guarantees unchanged).
5. If Inworld's streaming endpoint or MSE is unsupported, code falls back to current behavior with zero user-visible regressions.
6. Browser TTS path (Inworld off) behaves exactly as today.
