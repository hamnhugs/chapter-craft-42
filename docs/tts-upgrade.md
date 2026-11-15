# Text to speech: direction, flow, and a faster engine

Shipped 2026-11-15 on `new1`. The Inworld voice now performs what it reads
instead of reciting it, and each sentence carries on from the last.

## Turning it on

The app already works with this change deployed — the new options simply do
nothing until the server side is updated. Paste this into Lovable's chat:

> Please run the repo migration `supabase/migrations/20261115120000_inworld_voice_style.sql`
> exactly as written, without modifications (it is idempotent and additive:
> three `ADD COLUMN IF NOT EXISTS` on `user_settings`). Then redeploy the edge
> function `supabase/functions/inworld-tts` from the repo, exactly as written.

Until the migration runs, the three new settings work but reset on reload.
Until the function is redeployed, Direction, Expressiveness and the
sentence-to-sentence flow are ignored (the Engine choice already works).

## What changed

All of it is in Settings → Voice, under the Inworld voice picker, and applies
everywhere the Inworld voice speaks: read-aloud buttons, hands-free, and
Read Along.

| Setting | What it does | Inworld feature |
|---|---|---|
| **Direction** | Plain, Voice decides, Storyteller, Calm, Upbeat, Dramatic, Whisper, or your own sentence | Steering tag `[…]` in front of the text; "Voice decides" is Reasoning (`synthesisContext.reasoning`) |
| **Expressiveness** | Steady / Balanced / Expressive | `deliveryMode` STABLE / BALANCED / CREATIVE |
| **Engine** | TTS-2 (flagship) or TTS-2 Flash (fastest, cheapest, takes no direction) | `modelId` |

Not a setting, always on: **flow between sentences**. A reply is spoken as
sentence-sized requests so audio starts quickly, which used to mean every
sentence was performed cold. Each request now carries the two chunks before
it (`synthesisContext.previousRequests`), so pace and tone continue across
the joins. Inworld does not bill context text.

The play button next to the voice picker now speaks a line with some feeling
in it, using the current settings, so a direction can be heard before it is
used.

## How it is built

- `src/lib/inworldTts.ts` — `VoiceStyle`, the direction presets,
  `contextBefore()` (which chunks to send as context) and `styleFields()`
  (style → request body). The stored direction is the sentence itself; the
  value `auto` means "Voice decides".
- `supabase/functions/inworld-tts/index.ts` — builds the Inworld request. The
  direction is a separate field, not part of the text, because the text has
  its brackets stripped (so nothing on the page can be mistaken for a tag).
  If Inworld refuses a request that carries context, it is retried once
  without it — a rejected nicety never costs the read. When word timing is
  requested, the direction's own words are dropped from the front of it so
  Read Along's highlighting still lines up with the page.
- `useReadAloud`, `readAlongPlayer`, `ReadAlong` — pass the style and the
  preceding chunks with each request. The style is fixed when a read starts.
- Settings persist in `user_settings.inworld_model`, `inworld_delivery`,
  `inworld_direction`.

## Not verified

No Inworld key is available outside a signed-in session, so nothing here has
been heard. The request shapes follow Inworld's API reference and the edge
function was exercised against a stub; tests, typecheck and build pass. Worth
listening for after the redeploy:

- that a direction is not spoken aloud as words;
- Read Along highlighting with a direction set (the one place a direction
  could disturb timing);
- "Voice decides" start-up delay — it runs a short reasoning step before the
  first sound, and Inworld bills its reasoning output.

## Looked at, not built

- **Streaming synthesis** (`/tts/v1/voice:stream`). First audio would arrive
  a little sooner, but the sentence pipeline already bounds that to one short
  request, and streaming MP3 would mean rebuilding seek, pause and the
  download cache.
- **A neural voice that runs in the browser** (Kokoro, Piper, Kitten,
  Supertonic) as a free replacement for the device voice. Promising, but it
  is a 25–90 MB download and sits near real-time on phones; it needs
  measuring on a real phone first.
- **Voice design / cloning** (a new voice from a written description or a
  15-second sample) and **multi-voice scripts** (a different voice per
  character). Both exist in the Inworld API and would be features of their
  own.
- **Other providers** (ElevenLabs v3, Cartesia Sonic, Hume Octave). None is a
  clear step up from Inworld TTS-2 for this use, and each costs more or would
  need a second key.
