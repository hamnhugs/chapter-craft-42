# Inworld TTS API for multi-voice book narration (state as of 25 November 2026)

Research method: the Inworld documentation pages were downloaded as raw Markdown (`https://docs.inworld.ai/<path>.md`) on 2026-11-25 and read directly, so quotations below are verbatim from those files. Pricing came from `inworld.ai/pricing` through a page summariser (numbers not read raw). The built-in voice list was parsed from the data embedded in `inworld.ai/voices`. Competitor facts came from one fetch or one search each and are less thoroughly checked than the Inworld facts.

Headline for the report writer: the model line-up changed completely during 2026. The current models are `inworld-tts-2` and `inworld-tts-2-flash`; the 1.x models named in the brief are deprecated or discontinued. Inworld now has a first-class multi-speaker request shape called **script synthesis** (`script.utterances[]`, one stored voice per utterance, 1–100 utterances, bounded audio history carried between utterances), which directly answers the "narrator plus character voices in one request" question.

## 1. Which TTS models does Inworld offer, and how do they differ?

### Takeaway
Two current models: `inworld-tts-2` (flagship; the only one with steering, Reasoning, script synthesis, async/batch jobs and professional voice clones; 100 ms P90 TTFB; $25 per 1M characters on-demand) and `inworld-tts-2-flash` (20 ms P90 TTFB; $15 per 1M characters on-demand; no steering). `inworld-tts-1` and `inworld-tts-1-max` were discontinued on 15 June 2026; `inworld-tts-1.5-max` and `inworld-tts-1.5-mini` are deprecated.

### Cited Findings
- Current models and ids: "Realtime TTS-2" = `inworld-tts-2` ("Our most powerful model with natural language steering and the strongest multilingual capabilities — the best choice for production quality"); "Realtime TTS-2 Flash" = `inworld-tts-2-flash` ("Our fastest, most cost-efficient model"). — [TTS models](https://docs.inworld.ai/tts/tts-models.md)
- Deprecation note, verbatim: "Previous-generation models (`inworld-tts-1`, `inworld-tts-1-max`, `inworld-tts-1.5-max`, `inworld-tts-1.5-mini`) are deprecated and not recommended for new projects. `inworld-tts-1` and `inworld-tts-1-max` were discontinued on **June 15, 2026**. Requests to those two models are automatically routed to newer models." — [TTS models](https://docs.inworld.ai/tts/tts-models.md)
- Latency: TTS-2 "100 ms TTFB", TTS-2 Flash "20 ms TTFB, 5× faster than `inworld-tts-2`"; footnote "P90 time to first audio byte, measured server-side — excludes network latency." — [TTS models](https://docs.inworld.ai/tts/tts-models.md)
- Feature matrix (TTS-2 / TTS-2 Flash): instant voice cloning yes/yes; professional voice cloning (Beta) yes/no; inline pronunciation yes/yes; steering yes/no; pause controls yes/yes; timestamp alignment yes/yes; zero data retention yes/yes. — [TTS models](https://docs.inworld.ai/tts/tts-models.md)
- Languages: the TTS-2 models "accept **623 language and locale codes** (BCP-47) in the `language` field, covering **470 languages**"; Tier 1 (most evaluated) is 15 languages: Arabic, Chinese, Dutch, English, French, German, Hebrew, Hindi, Italian, Japanese, Korean, Polish, Portuguese, Russian, Spanish; Tier 2 is 79 more. — [Language support](https://docs.inworld.ai/tts/capabilities/multilingual.md)
- Release history: TTS 1.5 launched 21 January 2026; Realtime TTS-2 launched 5 May 2026; "Steering instructions now persist" behaviour change on 6 August 2026; TTS-2 Flash launched 9 August 2026; OpenAI-compatible `POST /v1/audio/speech` added 11 September 2026. — [TTS release notes](https://docs.inworld.ai/release-notes/tts.md)
- Older-model latency for reference: TTS-1.5 "P90 latency for first audio chunk delivery under 250ms for our Max model and under 130ms for our Mini model". — [TTS release notes](https://docs.inworld.ai/release-notes/tts.md)
- Price per 1M characters (as reported from the pricing page): TTS-2 — On-Demand $25, Creator $20, Builder $17.50, Developer $15, Growth $12.50, Enterprise "As low as $5". TTS-2 Flash — On-Demand $15, Creator $10, Builder $9, Developer $8, Growth $7, Enterprise "Sub-$5". — [Inworld pricing](https://inworld.ai/pricing)
- Plan prices: On-Demand free, Creator $25/mo, Builder $100/mo, Developer $300/mo, Growth $1,500/mo, Enterprise custom; "Paid plans include credits equal to the monthly plan price each billing cycle"; unused credits roll over up to 3 months; "On-Demand accounts include up to 70 minutes of TTS for free." — [Billing](https://docs.inworld.ai/portal/billing.md)
- Batch discount: "The Batch API is metered separately and costs 20% less per character than realtime synthesis. Tier discounts apply in the same way". — [Billing](https://docs.inworld.ai/portal/billing.md)
- What is billed: "Usage counts the text you send for synthesis as written, including spaces, punctuation and any tags in it, such as steering, pause or language tags." UTF-16 code units (emoji count as two). Not counted: `synthesisContext` text and input that produces no audio. Example: "`[whisper] Hello, world!` counts as 23." A voice design prompt sent with a synthesis request "counts once per request." — [Billing](https://docs.inworld.ai/portal/billing.md)
- Maximum input per request (applies to both current models unless noted): 2,000 UTF-16 code units on the synchronous endpoint; 4,000 on HTTP streaming; 2,000 per `sendText` message on WebSocket; 100,000 characters per async job or batch item (`inworld-tts-2` only; 10,000 on the On-Demand plan); 4,000 on the OpenAI-compatible endpoint. — [Synthesize speech (streaming)](https://docs.inworld.ai/tts/synthesize-speech-streaming.md); [Synthesize speech (WebSocket)](https://docs.inworld.ai/tts/synthesize-speech-websocket.md); [Synthesize speech (async)](https://docs.inworld.ai/tts/synthesize-speech-async.md); [OpenAI compatibility](https://docs.inworld.ai/tts/openai-compatibility.md)
- Maximum output: `audioContent` "Maximum output size is 16 MB" on the synchronous endpoint (as reported by the page summariser from the API reference). — [Synthesize speech API reference](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech)
- Third-party price figures for the deprecated 1.5 models conflict ($10, $25 and $50 per 1M characters were all seen in search results for `inworld-tts-1.5-max`). — [Inworld TTS API pricing comparison](https://inworld.ai/resources/tts-api-pricing-comparison); contradicted by [DeepInfra listing](https://deepinfra.com/inworld-ai/inworld-tts-1.5-max)

### Inferences
- For book narration with directed character delivery, `inworld-tts-2` is the only viable choice: steering, Reasoning, script synthesis jobs and async long-form are all limited to it. Flash would only suit a plain single-narrator read.
- Rough cost of an audiobook hour on `inworld-tts-2` at On-Demand rates: if an hour of narration is about 50,000–60,000 characters (my assumption, not an Inworld figure), that is about $1.25–$1.50 per hour, or about $1.00–$1.20 through the Batch API.
- Steering tags are billed as characters, so heavy per-sentence tagging raises cost; Inworld's own billing example shows a 130-character instruction in front of each 120-character sentence more than doubling usage.

### Gaps
- The current pricing page does not list a price for the deprecated 1.5 models, and no primary source for their present price was found.
- The model's native output sample rate is not stated in the pages read (the reference only says the default is "48,000 Hz, capped at the model's native output rate when known").
- No published quality benchmark numbers (word error rate, Elo) for TTS-2 were collected; the docs only say "top-ranked flagship".

## 2. Endpoints, authentication, request fields, response shape, timestamps

### Takeaway
Base URL `https://api.inworld.ai` with `Authorization: Basic <key>`. Five native synthesis surfaces share one request body: unary `POST /tts/v1/voice`, NDJSON streaming `POST /tts/v1/voice:stream`, WebSocket `wss://api.inworld.ai/tts/v1/voice:streamBidirectional`, async `POST /tts/v1/voice:synthesizeAsync` and batch (both preview), plus an OpenAI-compatible `POST /v1/audio/speech`. There is **no pitch parameter**; `temperature` is ignored on `inworld-tts-2` (use `deliveryMode`). Word and character timestamps are available via `timestampType`.

### Cited Findings
- Authentication: `Authorization: Basic <INWORLD_API_KEY>`; "Use the Portal's Base64 credentials unchanged, without encoding them again. Keep the key on your server". JWT / one-time tokens exist for browser and mobile clients. Read permission is needed for GET endpoints, write permission for POST/PATCH/DELETE on the Voice API. — [Synthesize speech (streaming)](https://docs.inworld.ai/tts/synthesize-speech-streaming.md); [Authentication](https://docs.inworld.ai/portal/authentication.md); [Clone a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice.md)
- Regional hosts: default US, plus EU `api.eu.inworld.ai` and India `api.in.inworld.ai`. — [Latency best practices](https://docs.inworld.ai/tts/best-practices/latency.md)
- SDKs: `npm install @inworld/tts`, `pip install inworld-tts`, CLI `npm install -g @inworld/cli`; env var `INWORLD_API_KEY`. — [TTS overview](https://docs.inworld.ai/docs/tts/tts)
- **Unary**: `POST https://api.inworld.ai/tts/v1/voice`. Response is one JSON object (not wrapped in `result`): `audioContent` (base64), `usage.processedCharactersCount`, `usage.modelId`, optional `timestampInfo`, optional `reasoningInstruction`, optional `scriptResult`. — [Synthesize speech API reference](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech)
- **HTTP streaming**: `POST https://api.inworld.ai/tts/v1/voice:stream`. "The JSON response is **newline-delimited JSON (NDJSON)**: one JSON object per line, not SSE (`data:` events) or a single JSON document. Each successful message wraps its payload in `result`. Audio is Base64-encoded inside `result.audioContent`". "Do not call `response.json()` on the whole streaming response or concatenate Base64 strings before decoding." "Timestamp-only messages can arrive after the audio; keep reading until EOF." Oversized text returns `INVALID_ARGUMENT` (code 3) "text length should not exceed 4000 characters." — [Synthesize speech (streaming)](https://docs.inworld.ai/tts/synthesize-speech-streaming.md)
- **WebSocket**: `wss://api.inworld.ai/tts/v1/voice:streamBidirectional`. Client messages carry a `contextId` plus one of `create`, `sendText`, `flushContext`, `closeContext`, `cancelContext`, `updateConfig`; server events include `contextCreated`, `contextUpdated`, `flushCompleted`, `contextClosed`. `create` options include `voiceId`, `modelId`, `autoMode`, `autoModeStrategy` (`CLIENT_SEGMENTED` or `SENTENCE_BOUNDARY`), `synthesisContext`, `language`, `languageSettings.candidates`, `bufferCharThreshold` (default 1000, range 0–2000), `maxBufferDelayMs`, `timestampTransportStrategy` (`SYNC` default, or `ASYNC`). — [Synthesize speech (WebSocket)](https://docs.inworld.ai/tts/synthesize-speech-websocket.md); [WebSocket API reference](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech-websocket.md)
- WebSocket continuity: "Use one context per reply... With `inworld-tts-2`, text in the same context keeps a consistent delivery, so a sentence split across flushes keeps its intonation instead of restarting. A new context starts fresh, so don't open one per sentence." "`inworld-tts-2-flash` and the TTS 1.5 models synthesize each flush on its own." — [Synthesize speech (WebSocket)](https://docs.inworld.ai/tts/synthesize-speech-websocket.md)
- **Async (Preview)**: `POST /tts/v1/voice:synthesizeAsync` "with the same request body as synchronous synthesis". Returns an operation `name` like `workspaces/{workspace}/ttsAsyncJobs/{job}/operations/{operation}`; poll `GET /lro/v1alpha/{name}`; on `done: true` the `response` has `audioUri` and (if requested) `timestampsUri`, pre-signed URLs to fetch **without** an `Authorization` header, expiring "approximately 7 days after completion". Limits: "`inworld-tts-2` only", "100,000 characters. On-Demand accounts are capped at 10,000". Recommended by Inworld "for long-form content such as audiobooks, podcasts, and video voiceovers". — [Synthesize speech (async)](https://docs.inworld.ai/tts/synthesize-speech-async.md)
- Async results can instead be written to your own bucket with `outputConfig.resultsUri` (a pre-signed upload URL); `outputConfig.packaging` is `FILES` or `ZIP`. — [Synthesize speech (async)](https://docs.inworld.ai/tts/synthesize-speech-async.md); [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- **Batch (Preview)**: body `{ "outputConfig": {...}, "items": [ { "customId": "...", "request": { ...same synthesis request... } } ] }`; 1–10,000 items per batch; `inworld-tts-2` only ("An item naming any other model is rejected at submit, and takes the whole batch with it"); 100,000 characters per item; "billed at **20% less** per character"; "a large batch runs for hours rather than minutes"; "We are working toward delivering every batch within 24 hours of acceptance. That is a target... rather than a guarantee". — [Synthesize speech (batch)](https://docs.inworld.ai/tts/synthesize-speech-batch.md); [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- **OpenAI-compatible**: `POST https://api.inworld.ai/v1/audio/speech`; `input` up to 4,000 characters; `response_format` `mp3` (default), `opus`, `flac`, `wav`, `pcm` (`aac` not supported); `speed` 0.5–1.5; `instructions` is a steering instruction for the whole request on `inworld-tts-2` only. Script synthesis and ad-hoc voice design are not available on this endpoint. — [OpenAI compatibility](https://docs.inworld.ai/tts/openai-compatibility.md); [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- **Request body fields** (unary, streaming, async; as listed in the API reference):
  - `text` (string) — required unless `script` is sent; max 2,000 (unary) / 4,000 (stream) UTF-16 code units.
  - `voiceId` (string) — set either `voiceId` or `voiceDesign`, not both; omit when sending `script`.
  - `modelId` (string, required) — `inworld-tts-2` or `inworld-tts-2-flash`.
  - `audioConfig.audioEncoding` — `LINEAR16`, `MP3` (default), `OGG_OPUS`, `ALAW`, `MULAW`, `FLAC`, `PCM`, `WAV`.
  - `audioConfig.bitRate` — default 128000; MP3 and OGG_OPUS only.
  - `audioConfig.sampleRateHertz` — 8000–48000; default 8000 for MULAW/ALAW, otherwise 48000 "capped at the model's native output rate when known"; "If you request a supported rate that differs from the model's native output rate, the service converts the audio to that rate. Conversion may reduce audio quality."
  - `audioConfig.speakingRate` — 0.5–1.5, default 1.0; "We recommend using values above 0.8 to ensure high quality."
  - `language` — BCP-47 (e.g. `en-US`); auto-detected if omitted.
  - `deliveryMode` — `STABLE`, `BALANCED` (default behaviour), `CREATIVE`; `inworld-tts-2` only.
  - `temperature` — range (0, 2], default 1; "Not supported by `inworld-tts-2`".
  - `timestampType` — `WORD` or `CHARACTER`.
  - `applyTextNormalization` — `ON`, `OFF`, or unspecified (automatic).
  - `enhanceGeneration` (boolean, default false) — denoises the generated audio.
  - `synthesisContext.previousRequests[]` (`{text}`) — "At most 5 previous requests, and their texts combined must not exceed 2,000 characters"; not billed.
  - `synthesisContext.reasoning` — `REASONING_ON`; `synthesisContext.reasoningContext` — up to 600 characters.
  - `voiceDesign.designPrompt` — 7–1,024 characters (Preview "ad-hoc voice design").
  - `enableCustomPronunciation` (boolean) or `pronunciationDictionarySettings.dictionaries[]` (1–3 entries, each `{dictionary: "workspaces/{workspace_id}/pronunciationDictionaries/{dictionary_id}"}`) — `inworld-tts-2`, need explicit `language`; do not combine the two.
  - `lipsyncConfig` (`visemeSet: OPENXR`).
  - `script` (`utterances[]`, `voices[]`) and `outputMode` (`COMBINED` default, `PER_UTTERANCE`) — see section 4.
  — [Synthesize speech API reference](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech.md)
- **No pitch field** exists in `audioConfig`; pitch is steered in text (e.g. `[say in a low tone]`, `[say in a high pitch]`). — [Synthesize speech API reference](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech.md); [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Audio format details: MP3 16–48 kHz, 32–320 kbps; `PCM` is raw 16-bit signed little-endian with no header; `WAV` has a header (in HTTP streaming only the first chunk has it, "You can concatenate all chunks in that response directly into a single valid WAV file"); `LINEAR16` puts a WAV header in **every** streamed chunk ("Clients must strip headers when concatenating chunks"); Opus 8–48 kHz, 32–192 kbps. — [Generating audio](https://docs.inworld.ai/tts/capabilities/generating-audio.md)
- **Timestamps**: `timestampInfo.wordAlignment` has `words`, `wordStartTimeSeconds`, `wordEndTimeSeconds`, `phoneticDetails[]` (`wordIndex`, `phones[]` with `phoneSymbol`, `startTimeSeconds`, `durationSeconds`, `visemeSymbol`, `isPartial`); `characterAlignment` has `characters`, `characterStartTimeSeconds`, `characterEndTimeSeconds`. "Timestamp alignment is available in every language the model supports". "Enabling timestamp alignment can increase latency (especially for the non-streaming endpoint)." — [Synthesize speech API reference](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech); [Timestamps](https://docs.inworld.ai/tts/capabilities/timestamps.md)
- Timestamp failure behaviour differs by endpoint: on async and batch, if alignment cannot be produced "the whole operation fails"; "The synchronous and streaming endpoints behave the **opposite** way: they keep the audio and return success with no `timestampInfo` at all." — [Synthesize speech (async)](https://docs.inworld.ai/tts/synthesize-speech-async.md)
- Async timestamps file: "a JSON **array** of timestamp objects in timeline order... Today there is one per chunk of synthesized text (about 1,200 characters), one per SSML break and one per leading steering tag... Every word, character and phone time is measured from the start of the audio." "Zero values are omitted from the JSON". — [Synthesize speech (async)](https://docs.inworld.ai/tts/synthesize-speech-async.md)
- Errors use gRPC-style JSON `{code, message, details}`; e.g. code 3 `INVALID_ARGUMENT`, code 8 `RESOURCE_EXHAUSTED` (HTTP 429), code 7 for insufficient key access. "Branch on `code`, not on message text." — [Job concurrency limits](https://docs.inworld.ai/resources/job-concurrency-limits.md)
- Audio effects (presets such as `PHONE_CALL`, `FAR_FROM_MIC`, `ECHO`, or `<effect>` elements) work on the unary endpoint only; streaming, WebSocket, async and batch return `INVALID_ARGUMENT`. — [Audio effects](https://docs.inworld.ai/tts/capabilities/audio-effects.md)

### Inferences
- For a book pipeline the async endpoint is the natural fit (100,000 characters, server-side chunking and joining, timestamps file), with the unary/streaming endpoints for "play now" previews.
- Code written against the old 1.x API that sends `temperature` will still be accepted but the value has no effect on `inworld-tts-2`; switch to `deliveryMode`.
- Because the stream is NDJSON with base64 audio, an edge function proxy has to decode each line; it cannot pass the body through as an audio stream. The OpenAI-compatible endpoint returns audio in OpenAI's format and may be simpler for single-voice playback, but it cannot do scripts.

### Gaps
- The full server-event schema of the WebSocket API (exact field names inside audio chunk messages) was not read line by line; consult the WebSocket API reference before coding against it.
- Request size ceiling for a batch in bytes was referenced ("the request size above") but the number was not captured.

## 3. Listing voices, voice metadata, and the built-in English voices

### Takeaway
List voices with `GET https://api.inworld.ai/voices/v1/voices` (the older `GET /tts/v1/voices` is deprecated). Each voice carries `voiceId`, `displayName`, `description`, `tags[]`, `gender`, `ageGroup`, `categories[]`, `source`, `languageCode`/`langCode`, `promptLanguages[]`. There is no accent field: accent is expressed through the locale and the free-text description. The public voices page embeds 409 system voices, 202 of them English (195 named voices plus 7 demo designed voices).

### Cited Findings
- Endpoint and query parameters: `GET https://api.inworld.ai/voices/v1/voices`; `filter` (AIP-160 expression), `pageSize` (up to 2,000), `pageToken`, `orderBy` (`display_name`, `created_at`, `gender`, `age_group`, each `asc`/`desc`; default `display_name asc`), legacy `languages` (do not combine with `filter`). — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md)
- Filterable fields: `source` (`SYSTEM`, `IVC`, `TVD`, `PVC`, `OTHER`), `gender` (`male`, `female`, `neutral`), `age_group` (`young`, `middle_aged`, `elderly`), `lang_code` (e.g. `en-US`, `en_US`, or `en`), `tags` (has operator `:`), `categories` (`companions`, `enterprise`, `education_training`, `developer_assistants`, `healthcare`, `interactive_media`), `owned`, `community`. Example: `(gender="female" OR gender="neutral") AND tags:"funny" AND lang_code="en"`. "Quote every value." — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md)
- Example call for system English voices: `filter=source = "SYSTEM" AND lang_code = "en"`, `orderBy=display_name asc`, `pageSize=20`; follow `nextPageToken` until empty. — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md)
- Response voice fields: `voiceId` ("SYSTEM voices use a simple name (e.g. `Alex`); IVC voices are workspace-prefixed (`{workspace}__{voice}`)"), `langCode` (legacy enum, e.g. `EN_US`), `languageCode` (e.g. `en-US`), `displayName`, `description`, `tags[]`, `name` (resource path), `source`, `gender` (`male`/`female`/`neutral`/`""`), `ageGroup` (`young`/`middle_aged`/`elderly`/`""`), `categories[]`, `promptLanguages[]`, `owned`; plus `totalSize` and `nextPageToken`. — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md)
- Example system voice record from the reference: `{"name":"workspaces/inworld/voices/Alex","voiceId":"Alex","langCode":"EN_US","displayName":"Alex","description":"Energetic and expressive mid-range male voice, with a mildly nasal quality","tags":["friendly","expressive"],"categories":["companions"],"source":"SYSTEM","gender":"male","ageGroup":"middle_aged","promptLanguages":["en-US"]}`. — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md)
- Pagination caveat: "Pagination uses offsets and does not provide a stable snapshot... Use `voiceId` as the key for picker entries to remove duplicates." — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md)
- "By default, this endpoint returns your workspace's cloned and designed voices along with Inworld system voices. Voices shared by other users to the community Voice Library are excluded unless you set the `community="true"` filter." — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md)
- Tags vs structured fields: "Tags are **not** where gender, age group, or categories go. Those are separate structured fields with fixed enums (`gender`, `ageGroup`, `categories`)". Typical tags: vocal style (`energetic`, `calm`, `warm`), quality (`smooth`, `expressive`), use-case hints (`narrator`, `announcer`, `character`). — [Voice tags](https://docs.inworld.ai/tts/capabilities/voice-tags.md)
- Accent: "Accent is part of the locale — there is no separate accent field." (stated for cloning and design). — [Clone a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice.md)
- Deprecated listing: `GET https://api.inworld.ai/tts/v1/voices?filter=language=en` returns `languages[]`, `voiceId`, `displayName`, `description`, `tags[]`, `isCustom`; in this older response gender and age appear inside `tags` (e.g. Dennis: `["male","middle-aged","smooth","calm","friendly"]`). — [List voices (deprecated)](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/list-voices.md)
- Free preview audio: `GET https://api.inworld.ai/tts/v1/voice:preview?voice_id=Ashley&model_id=inworld-tts-2` returns `{"audioContent":"<base64-encoded MP3>"}`; "Preview text is selected by the service and cannot be customized. Previews are not billed" but have "stricter rate and concurrency limits than synthesis" — cache them. — [Get voice preview](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/get-voice-preview.md)
- Voice count: the data embedded in the public voices page on 2026-11-25 held 409 voice records; by `languages` value: en 202, es 52, pt 23, ru 21, de 20, tr 17, sv 10, pl 10, ar 9, hi 7, ro 7, zh 6, he 5, fr 4, ja 4, nl 4, it 4, ko 4. A search snippet for the same page said "337" voices, so the catalogue is growing. — [Inworld system voices](https://inworld.ai/voices)
- The public page gives only `voiceId`, `displayName`, `description`, `languages` per voice. Gender, age group and tags come from the API fields above. — [Inworld system voices](https://inworld.ai/voices)
- The 195 named English system voices, with descriptions verbatim (gender, age and accent are stated in the description where Inworld gives them): — [Inworld system voices](https://inworld.ai/voices)
  - `Abby` — Bright, eager American female child voice, ideal for animated characters, upbeat educational content, and lively kids' commercials.
  - `Aditya` — Confident, natural Indian male voice, ideal for customer support, corporate, and education.
  - `Alaric` — Wise, gravelly male voice, ideal for RPG narration, audiobooks, and gaming.
  - `Alex` — Energetic and expressive mid-range male voice, with a mildly nasal quality
  - `Alistair` — Clear, articulate British male voice ideal for educational content and healthcare narration.
  - `Amara` — Warm, professional Nigerian female voice, ideal for customer service, narration, and support.
  - `Amber` — A deep, velvety American voice with an unhurried, composed delivery. Calm and reassuring, it is a natural fit for audiobooks, documentaries, and e-learning modules.
  - `Ambrose` — Distinguished, gentle elderly British male voice, ideal for audiobooks, documentaries, and grandfatherly storytelling.
  - `Amina` — Warm, inviting West African female voice, ideal for community outreach, cultural storytelling, and educational workshops.
  - `Andoy` — Friendly, easygoing Filipino male voice, ideal for customer service, e-learning, and support.
  - `Anjali` — A confident and articulate Indian female voice, ideal for professional training materials.
  - `Aoife` — A melodic young Irish voice with a light rasp and a brisk, sunny delivery. Warm rather than overt in its accent, it suits explainer videos, virtual companions, and social media content.
  - `Archie` — Youthful, spirited British boy's voice, ideal for children's stories, fantasy adventures, and animated characters.
  - `Arjun` — Clear, composed Indian male voice, well-suited for instructional webinars and technology explainers.
  - `Arthur` — A warm and mature male voice with clear articulation and an encouraging, knowledgeable demeanor.
  - `Ashley` — A warm, natural female voice
  - `Avery` — Youthful, performative male voice, suited for gameshow-style hosting, energetic presenter reads, and expressive young character parts.
  - `Banjo` — Laid-back, genial Australian male voice, ideal for lifestyle content, travel, and casual narration.
  - `Beatrice` — Rich, authoritative British female voice, ideal for audiobooks, documentary, and narration.
  - `Bianca` — Deep, controlled female voice, ideal for serious corporate reads, composed documentary segments, and measured authority-led explainers.
  - `Blake` — Rich, intimate male voice, perfect for audiobooks, romantic content, and reassuring narration
  - `Boonleng` — Confident, conversational Singaporean male voice, ideal for e-learning, customer service, and support.
  - `Brandon` — Bold, strident male voice, ideal for structured announcements, news-style reads, and direct promotional messaging.
  - `Brian` — Friendly, encouraging American male voice, ideal for educational tutorials, motivational content, and instructional videos.
  - `Brick` — Playful, bombastic male voice, ideal for game shows, interactive entertainment, and hosting.
  - `Brooke` — A clear, professional young female voice with a polite and helpful delivery.
  - `Bryce` — Confident, energetic young male voice with a dynamic social feel
  - `Callum` — Casual and friendly Australian male voice, ideal for informal instructional content.
  - `Calvin` — Casual, grounded African American male voice, ideal for storytelling, documentaries, and conversational apps.
  - `Camille` — Clear, professional young female voice with a composed delivery
  - `Carla` — A bright, crisp American voice with a no-nonsense but relaxed delivery. Straight to the point, it fits documentary narration, corporate training, and explainer videos.
  - `Carter` — Energetic, mature radio announcer-style male voice, great for storytelling, pep talks, and voiceovers.
  - `Casey` — Laid-back young male voice with a chill, friendly vibe
  - `Cedric` — Crisp, measured male voice, ideal for formal announcements, premium trailer narration, and command-forward presentation scripts.
  - `Celeste` — Soft, whispery female voice, ideal for ASMR videos, soothing lullabies, and gentle mindfulness sessions.
  - `Chioma` — Bright, friendly Nigerian female voice, ideal for customer service, narration, and support.
  - `Chip` — Cheerful, witty male voice, ideal for game shows, interactive entertainment, and hosting.
  - `Chloe` — Thoughtful, introspective youthful female voice, perfect for coming-of-age narratives, personal growth stories, and emotional teen dramas.
  - `Claire` — Warm, gentle Eastern European female voice, ideal for bedtime stories, relaxation podcasts
  - `Clive` — British-accented English-language male voice with a calm, cordial quality
  - `Conrad` — Gruff, weathered male voice, perfect for detective archetypes, hard-edged audiobook roles, and serious investigative narration.
  - `Cooper` — Casual, warm Australian male voice, ideal for lifestyle content, travel, and casual narration.
  - `Cordelia` — Refined, composed British female voice, ideal for audiobooks, documentary, and narration.
  - `Craig` — Older British male with a refined and articulate voice
  - `Curtis` — A deep, mellow American voice with a soothing, calm delivery. Distinctive and trustworthy, it suits meditation apps, audiobooks, and wellness guides.
  - `Dalisay` — Bright, approachable Filipino female voice, ideal for customer service, e-learning, and support.
  - `Damon` — Calm, raspy male voice, suited for moody narration, atmospheric roleplay characters, and grounded meditative reads with subtle tension.
  - `Dana` — A bright, full-bodied American voice with an unassuming, matter-of-fact delivery. Kind and easy to listen to, it works for podcasts, customer support, and explainer videos.
  - `Daniel` — A polite and helpful mid-range male voice with a friendly and reassuring tone, perfect for customer service.
  - `Dante` — Breathy, intimate American male voice, ideal for companion chats, late-night storytelling, and soft-spoken roleplay.
  - `Darlene` — Spirited Southern belle with a rich country drawl, able to shift from warm and reassuring to strong and powerful. Ideal for characters, narration, and regional ads.
  - `Deborah` — Warm, peaceful female voice with a calm tone
  - `Dennis` — Middle-aged man with a smooth, calm and friendly voice
  - `Derek` — Steady, professional, composed American male voice, ideal for banking support, account inquiries, and service escalation calls.
  - `Desmond` — A gravelly British baritone with a laid-back, matter-of-fact manner. Textured and full of character, it suits audiobooks, podcasts, and virtual companions.
  - `Dhruv` — Professional, measured Indian male voice, ideal for customer support, corporate, and education.
  - `Diane` — A husky, rich American voice with a direct, matter-of-fact delivery. Unfussy and grounded, it suits audiobooks, podcasts, and corporate training.
  - `Dominus` — Robotic, deep male voice with a menacing quality. Perfect for villains
  - `Douglas` — A reedy, pleasant American voice with an agreeable, gentle delivery. Genuinely likeable and easy to talk to, it suits customer support, explainer videos, and e-learning modules.
  - `Duncan` — Warm, articulate British male voice for customer support and education.
  - `Edward` — American male with a emphatic, confident and streetwise tone
  - `Eileen` — Gentle, softly breathy elderly female voice with a Belfast accent, ideal for memoirs, bedtime stories, and warm companionship.
  - `Eldrin` — Sage, resonant male voice, ideal for RPG narration, audiobooks, and gaming.
  - `Eleanor` — Polished, approachable British female voice for support and learning.
  - `Elliot` — A calm, steady male voice, suitable for nature documentaries, general informational content, and relaxed narrations.
  - `Emeka` — Warm, conversational Nigerian male voice, ideal for customer service, narration, and support.
  - `Emil` — Bright, upbeat Filipino male voice, ideal for customer service, e-learning, and support.
  - `Ethan` — Assured, precise male voice, perfect for tech tutorials, detailed gadget overviews, and captivating product demonstrations.
  - `Evan` — Friendly, approachable, easygoing male voice, ideal for onboarding calls, retail assistance, and customer check-ins.
  - `Evelyn` — A gentle and intimate female voice, ideal for personal ASMR content, affirmations, and close, calming conversations.
  - `Felix` — Calm, friendly British male voice, ideal for help and tutorials.
  - `Fiona` — A crisp, clean young British voice that stays conversational without losing its polish. Well suited to virtual assistants, customer support, and audiobooks.
  - `Folake` — Clear, approachable Nigerian female voice, ideal for customer service, narration, and support.
  - `Freddie` — Young, casual British male voice, ideal for conversational assistants, podcasts, and narration.
  - `Gareth` — Soothing, gentle male voice, ideal for guided meditations, mindfulness exercises, and relaxation-focused wellness content.
  - `Gavin` — A rich, grounded British voice with a relaxed, steady pace. Polite and approachable, it fits corporate narration, e-learning modules, and podcasts.
  - `Gemma` — A rich, mellow Irish voice with an easygoing, even pace. Calm and unhurried, it fits documentaries, meditation apps, and e-learning modules.
  - `Graham` — Profound, authoritative British male voice, perfect for historical documentaries, luxury brand advertisements, and educational content.
  - `Grayson` — Confident, smooth American male voice with a low, easy delivery, ideal for promos, product showcases, and narration.
  - `Hades` — Commanding and gruff male voice, think an omniscient narrator or castle guard
  - `Hamish` — Friendly and casual Australian male voice, ideal for character-driven roles and upbeat fitness.
  - `Hana` — Bright, expressive young female voice, perfect for storytelling, gaming, and playful content
  - `Hank` — Warm, laid-back Southern male voice, ideal for travel documentaries, heritage storytelling, and down-to-earth podcast ads.
  - `Harold` — Crisp, seasoned older male voice with a trustworthy delivery
  - `Harriet` — A light, airy young British voice with a genuine, gentle warmth. Easy to listen to for long stretches, it suits virtual companions, explainer videos, and language lessons.
  - `Harry` — A pleasant, clean young British voice with a sincere, articulate delivery. Naturally expressive and reassuring, it works for explainer videos, corporate narration, and e-learning modules.
  - `Hazel` — Warm, upbeat female voice with a friendly, engaging tone
  - `Heather` — A sunny, crisp American voice with a composed, upbeat delivery. Cheerful but professional, it suits customer support, corporate narration, and e-learning modules.
  - `Helen` — A radiant, polished British voice with a cheerful warmth that sounds genuinely human. A natural for customer support, commercials, and podcasts.
  - `Huiling` — Bright, approachable Singaporean female voice, ideal for e-learning, customer service, and support.
  - `Imogen` — Refined British female voice with a professional, articulate delivery
  - `Indi` — Bright, casual Australian female voice, ideal for lifestyle content, travel, and casual narration.
  - `Ishaan` — Confident, natural Indian male voice, ideal for customer support, corporate, and education.
  - `James` — Vibrant, expressive male voice, perfect for animated video content, lively event hosting, and captivating children's stories.
  - `Jarrah` — Easygoing, grounded Australian male voice, ideal for lifestyle content, travel, and casual narration.
  - `Jason` — Lucid, engrossing male voice, ideal for tech tips, creative productivity hacks, and supportive user interface tutorials.
  - `Jessica` — Encouraging, articulate American female voice, perfect for self-help audiobooks, warm customer service messages, and clear e-learning modules.
  - `Joanne` — A pleasant, full-bodied American voice with an upbeat, lighthearted delivery. Reassuring without being too soft, it suits e-learning modules, medical narration, and wellness guides.
  - `Jonah` — Soothing, calm male voice, great for tutorial guidance, reassuring support flows, and gentle instructional narration with steady pacing.
  - `Jordan` — A mellow, full-toned young American voice with a personable, soft-spoken delivery. Warm and neighborly, it fits explainer videos, e-learning modules, and virtual companions.
  - `Josh` — Relaxed, welcoming African American male voice, ideal for conversational agents, companion chats, and friendly customer conversations.
  - `Joy` — Gentle, steady female voice, ideal for customer support, sensitive contexts, and help lines.
  - `Judith` — A full-toned, warm British voice with a refined, measured delivery. Eloquent without sounding distant, it suits news reads, corporate training, and phone systems.
  - `Junhao` — Bright, easygoing Singaporean male voice, ideal for e-learning, customer service, and support.
  - `Kabir` — Bright, helpful Indian male voice, ideal for customer support, corporate, and education.
  - `Kelsey` — Warm, empathetic, reassuring female voice, ideal for phone support, appointment confirmations, and customer success calls.
  - `Kenji` — Stylized, low-key male voice, ideal for anime content, gaming, and dubbing.
  - `Kristen` — A velvety, warm American voice with a confident, steady delivery. Courteous and personable, it suits corporate training, news reads, and advertisements.
  - `Kyle` — A soft, breathy young American voice with a sincere, good-natured delivery. Easygoing and welcoming, it suits podcast hosting, character narration, and language lessons.
  - `Lachlan` — Warm, friendly Scottish male voice with a thick Glasgow accent, ideal for storytelling, gaming, and conversational agents.
  - `Lauren` — Confident, friendly American female voice, ideal for corporate presentations, upbeat commercials, and engaging podcasts.
  - `Levi` — Measured, ominous male voice, ideal for suspense narration, dark fantasy storytelling, and composed dramatic monologues.
  - `Liam` — Upbeat, motivating Australian male voice, perfect for energizing workout sessions, lively event promotions, and informal lifestyle content.
  - `Liwa` — Gentle, patient Filipino female voice, ideal for customer service, e-learning, and support.
  - `Loretta` — Inviting, folksy Southern female voice, perfect for cooking shows, heartwarming family tales, and cozy radio ads.
  - `Lucian` — Brooding, foreboding male voice, suited for villainous character arcs, gothic drama scenes, and dark narrative worldbuilding.
  - `Luna` — Calm, relaxing female voice, perfect for meditations, sleep stories, and mindfulness exercises
  - `Maggie` — A sunny, polished American voice with an upbeat, cheerful delivery. Welcoming and easy to follow, it works for language lessons, customer support, and virtual companions.
  - `Maisie` — Engaging young British female voice, perfect for interactive media and casual narration.
  - `Malcolm` — Authoritative, manipulative male voice, perfect for cunning leaders, intense negotiation scenes, and persuasive villain speeches.
  - `Marcus` — Authoritative, empathetic male voice, great for civic campaigns, community outreach explainers, and trustworthy commercial reads with emotional credibility.
  - `Marek` — Gruff, steady Polish-accented male voice, ideal for dramatic characters, documentaries, and serious narration.
  - `Maricel` — Friendly, warm Filipino female voice, ideal for customer service, e-learning, and support.
  - `Mark` — Energetic, expressive man with a rapid-fire delivery
  - `Marlene` — Friendly, relaxed Southern female voice, ideal for home-style cooking tutorials, community event promotions, and downhome commercials.
  - `Matilda` — Friendly, upbeat Australian female voice, ideal for lifestyle content, travel, and casual narration.
  - `Mia` — Youthful, expressive female voice, ideal for adolescent characters, school-age animation dialogue, and bright coming-of-age narrative scenes.
  - `Miranda` — Menacing, cold-hearted female voice, perfect for strategic villains, mysterious narratives
  - `Morgana` — Cold, calculated female voice, ideal for gaming, audiobook villains, and horror.
  - `Mortimer` — Gravelly, aggressive male character voice, ideal for fantasy villains and high-intensity game dialogue.
  - `Nadia` — Personable, lively female voice, perfect for tutorial walkthroughs, friendly support messaging, and engaging narration for creator-led product content.
  - `Naomi` — Warm, grounded female voice, perfect for narrative podcasting, people-first customer guidance, and emotionally real brand storytelling.
  - `Nate` — Conversational, sociable male voice, great for customer support and friendly guidance
  - `Niamh` — A breathy, lilting young Irish voice with a gentle, unhurried delivery. Soft and soothing, it works for meditation apps, audiobooks, and documentary narration.
  - `Nigel` — Formal British male voice with a precise, measured delivery
  - `Nikhil` — Articulate, warm Indian male voice, ideal for customer support, corporate, and education.
  - `Oliver` — Neutral and clear male voice, ideal for public announcements and educational information.
  - `Olivia` — Young, British female with a friendly and helpful tone, conveying confidence and efficiency.
  - `Penelope` — A clear, refined British female voice suited for health and lifestyle assistance.
  - `Piper` — Bright, playful young female voice with an upbeat conversational energy
  - `Pippa` — Friendly and casual Australian female voice, ideal for relaxed instructional content.
  - `Pixie` — High-pitched, childlike female voice with a squeaky quality - great for a cartoon character
  - `Poppy` — Bright, lively British girl's voice, ideal for children's content, animated characters, and educational games.
  - `Rebecca` — A breathy, light Scottish voice with a measured, straightforward way of speaking. Bright in its intonation but never fussy, it works for virtual assistants, e-learning modules, and tutorials.
  - `Reed` — Clear, professional American male voice, well-suited for support and training.
  - `Ren` — Cool, aloof male voice, ideal for anime content, gaming, and dubbing.
  - `Riley` — Playful, youthful female voice, perfect for animated storytelling, upbeat game characters, and high-energy kid-focused digital content.
  - `Ronald` — Confident, British man with a deep, gravelly voice
  - `Rosalind` — Mature, warm British female voice, ideal for audiobooks, documentary, and narration.
  - `Rupert` — Resonant, commanding British male voice, ideal for motivational speeches, epic film trailers, and dynamic corporate presentations.
  - `Russell` — A resonant American baritone with a big, almost booming sound and a genial, unassuming manner. Works well for corporate training, documentary narration, and customer support.
  - `Ryan` — A deep, grounded American voice with an easygoing delivery that gets straight to the point. Works well for corporate presentations, e-learning content, and advertisements.
  - `Saanvi` — Crisp, articulate Indian female voice, ideal for dynamic e-learning modules, articulate documentary narrations, and vibrant travel vlogs.
  - `Sarah` — Fast-talking young adult woman, with a questioning and curious tone
  - `Scott` — An approachable, polished American voice with a direct, articulate delivery. Easy to follow and dependable, it suits news reads, documentary narration, and technical tutorials.
  - `Sebastian` — Intimidating, steely male voice, perfect for ruthless antagonists, strategic power struggles, and chilling monologues.
  - `Selene` — Soft, flirtatious female voice, ideal for companion-style interactions, charming game dialogue, and emotionally playful character-driven story scenes.
  - `Seraphine` — Smoky, low-key Australian female voice, ideal for late-night storytelling, moody narration, and noir characters.
  - `Serena` — Soft, nurturing female voice, perfect for mindfulness sessions, nature-inspired visualizations, and gentle wellness podcasts.
  - `Serene` — Natural, poised Singaporean female voice, ideal for e-learning, customer service, and support.
  - `Shannon` — A bright American voice with a slightly reedy edge and an easygoing, conversational delivery. Casual and relatable, it works for tutorials, podcasts, and game characters.
  - `Shu` — Confident, friendly Singaporean female voice, ideal for e-learning, customer service, and support.
  - `Sienna` — Breathy, playful young Australian female voice, ideal for companion chats, lifestyle content, and easygoing conversation.
  - `Simon` — Articulate, insightful male voice, perfect for corporate presentations, technical tutorials, and steady news reporting.
  - `Snik` — Hoarse, cunning male voice, perfect for devious goblin roles, fantasy heist scenarios, and trickster-themed animations.
  - `Sophie` — Friendly British female voice, great for assistance and knowledge sharing.
  - `Tahlia` — Sunny, easygoing Australian female voice, ideal for lifestyle content, travel, and casual narration.
  - `Tala` — Friendly, warm Filipino female voice, ideal for customer service, e-learning, and support.
  - `Tessa` — Upbeat, conversational Australian female voice, perfect for lifestyle vlogs, playful advertisements, and engaging social media content.
  - `Theodore` — Gravelly male voice, with a time-worn quality
  - `Timothy` — Lively, upbeat American male voice
  - `Tonya` — Professional, direct African American female voice with a friendly warmth, ideal for customer support, business assistants, and narration.
  - `Travis` — A robust, full-bodied American voice with a confident, assured delivery. Rich and steady, it fits corporate announcements, video game characters, and audiobooks.
  - `Trevor` — Punchy, expressive male voice, perfect for energetic promos, announcer-driven reveals, and fast-moving scripted event intros.
  - `Tristan` — Deliberate, controlled male voice, ideal for documentary narration, polished voiceover campaigns, and clear long-form infomercial storytelling.
  - `Tunde` — Grounded, friendly Nigerian male voice, ideal for customer service, narration, and support.
  - `Tyler` — Authoritative, insightful male voice, ideal for tech explainer videos, in-depth software reviews, and dynamic coding guides.
  - `Veronica` — Intimidating, commanding female voice, perfect for ruthless antagonists, high-stakes negotiations, and chilling monologues.
  - `Victor` — Ominous, sinister male voice, ideal for dark conspiracies, eerie suspense scenes, and enigmatic villain roles.
  - `Victoria` — Silky, cunning British female voice, ideal for narrating intricate plots
  - `Vikram` — Professional, measured Indian male voice, ideal for customer support, corporate, and education.
  - `Vincent` — Polished, classy male voice with a smooth, measured delivery
  - `Vinny` — Gritty, assertive New York male voice, perfect for crime dramas, urban documentaries, and no-nonsense character roles.
  - `Wade` — Casual, natural male voice with an easygoing conversational style
  - `Warren` — Mature, resonant male voice with a classic announcer quality
  - `Wei` — Confident, conversational Singaporean male voice, ideal for e-learning, customer service, and support.
  - `Wendy` — Posh, middle-aged British female voice
  - `Whitney` — A resonant, full-toned young American voice with an outgoing, approachable delivery. Upbeat without being overdone, it suits virtual companions, AI assistants, and language lessons.
  - `Winifred` — Mature, warm British female voice, ideal for audiobooks, documentary, and narration.
  - `Winston` — Mature British male voice with a warm storytelling quality
  - `Yash` — Articulate, warm Indian male voice, ideal for customer support, corporate, and education.
  - `Yuki` — Soft, melancholic anime-style female voice, ideal for animated characters, gaming, and wistful storytelling.
  - `Zadie` — Punchy, expressive female voice, ideal for short-form social, UGC, and viral content.
  - `Zherong` — Natural, helpful Singaporean male voice, ideal for e-learning, customer service, and support.
  - `Zoe` — Upbeat, expressive young female voice with a clear, friendly delivery
- Seven further English entries on that page are demo designed voices with ids of the form `inworld_marketing_site_tts_playground__design-voice-xxxxxxxx` (e.g. a British storyteller, a dragon, two elderly women, a cartoon pet); they are not ordinary system voice names. — [Inworld system voices](https://inworld.ai/voices)
- "Regardless of model, a voice delivers the best speaker similarity when synthesizing text in its native language". — [Generating audio](https://docs.inworld.ai/tts/capabilities/generating-audio.md)

### Inferences
- An automatic casting step can filter by `gender`, `age_group` and `lang_code`, then match on `tags` and the free-text `description` (which is where accent, texture and "villain/narrator/child" cues live). Fetch the catalogue once (pageSize up to 2,000) and cache it.
- The catalogue has clear audiobook-oriented voices (e.g. Alaric, Ambrose, Beatrice, Blake, Cordelia, Rosalind, Winifred, Winston) and many character archetypes (villains: Dominus, Lucian, Malcolm, Miranda, Morgana, Mortimer, Sebastian, Veronica, Victor; children: Abby, Archie, Poppy, Pixie; regional: Lachlan, Eileen, Vinny, Darlene, Hank), so a cast can often be built from system voices without designing new ones.

### Gaps
- Per-voice `gender`, `ageGroup` and `tags` for all system voices were not retrieved (needs an authenticated API call); only names and descriptions are listed here.
- Whether every system voice record has `gender`/`ageGroup` populated is not documented ("Empty string if unspecified").

## 4. Multiple speakers in one request, and seamless joins

### Takeaway
Yes — **script synthesis** on `inworld-tts-2`: send `script.utterances[]` (1–100 utterances, each with its own `text` and `voiceConfig.voiceId`) to the unary, HTTP streaming, async or batch endpoint and get either one combined recording or separate per-utterance clips. The model "keeps a bounded audio history within the script to help later utterances follow earlier turns naturally. Separate requests do not share this history." It is not available on WebSocket or the OpenAI-compatible endpoint, and every voice must be a stored voice (no inline voice design).

### Cited Findings
- Definition: "A script is an ordered list of utterances, each with text and a stored voice. One request can produce a conversation between speakers or a monologue with one voice. TTS-2 keeps a bounded audio history within the script to help later utterances follow earlier turns naturally. Separate requests do not share this history." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Availability: "Scripts work with the unary, HTTP streaming, async, and batch APIs. This request shape does not apply to WebSocket or OpenAI-compatible synthesis. Async and batch remain preview APIs." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Request shape, verbatim example:
  ```json
  {
    "modelId": "inworld-tts-2",
    "language": "en-US",
    "audioConfig": {"audioEncoding": "MP3", "speakingRate": 1.0},
    "timestampType": "WORD",
    "outputMode": "PER_UTTERANCE",
    "script": {
      "voices": [
        {"voiceId": "Dennis", "speakingRate": 0.9, "deliveryMode": "STABLE"}
      ],
      "utterances": [
        {"text": "Welcome to the observatory.", "voiceConfig": {"voiceId": "Dennis"}},
        {"text": "The telescope is ready for tonight.", "voiceConfig": {"voiceId": "Ashley"}},
        {"text": "Let us look at the stars.", "voiceConfig": {"voiceId": "Dennis", "speakingRate": 1.1}}
      ]
    }
  }
  ```
  — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Rules: "Send `script` instead of the top-level `text`, `voiceId`, or `voiceDesign`. Use `modelId: "inworld-tts-2"`. Every utterance needs its own `text` and `voiceConfig.voiceId`; inline voice design is not supported inside a script." `script.voices` "is an optional list of defaults keyed by unique `voiceId`. It does not declare speakers". Precedence for `speakingRate` and `deliveryMode`: utterance > `script.voices` entry > request settings. — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Limits: "Scripts accept **1–100 utterances**. The endpoint's text limit applies to the sum of all utterance texts, measured in UTF-16 code units: 2,000 for unary and 4,000 for HTTP streaming; async and batch use their existing job limits. Splitting text into more utterances does not increase the limit. Usage counts the text across the script once." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Shared vs per-utterance settings: "Audio encoding, sample rate, language, model, and timestamp type are shared request settings. Per-utterance controls are `voiceId`, `speakingRate` (0.5–1.5), and `deliveryMode`." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Output modes: "`COMBINED` (default) returns one recording. `PER_UTTERANCE` returns separate utterance recordings and requires `script`. Both modes retain the same generation history." "With separate recordings, timestamps are relative to the start of **each utterance's audio**; combined output uses one cumulative timeline. Separate output requires a script and does not also produce a combined recording." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Unary `PER_UTTERANCE` response: `scriptResult.utterances[]` each `{utteranceIndex, audioContent, timestampInfo}`; "Top-level `audioContent` is empty... Read the top-level `usage` for the whole request." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Streaming `PER_UTTERANCE` response lines: `{"result":{"audioContent":"...","scriptResult":{"utteranceIndex":0}}}`. "Indexes arrive in order. An increment means all audio and timestamp updates for the previous utterance have finished... There is no separate utterance-completed event. An utterance with no audio still emits its index". — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Async/batch `PER_UTTERANCE`: requires `"outputConfig": {"packaging": "ZIP"}`; results document lists `scriptResult.utterances[]` with `audioPath` (e.g. `utterances/0000/audio.mp3`) and `timestampsPath`; "Follow the manifest's paths instead of constructing filenames. Each audio file is independently playable." Batch: "Each script is generated independently; audio history is not shared between batch items." "A failed script item does not return a successful prefix of its utterances." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- A batch "can mix scripts and ordinary single-voice requests." — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Text-only context across separate requests: `synthesisContext.previousRequests` (up to 5 texts, 2,000 characters combined, not billed). "Context is most useful for short phrases... Keep it to the last few turns — a long context can outweigh the text being synthesized and lead to wrong decisions." — [Generating speech best practices](https://docs.inworld.ai/tts/best-practices/generating-speech.md)
- Limit of that context, stated for WebSocket: "`synthesisContext` text helps language detection and normalization only. It doesn't carry delivery over from an earlier context." — [Synthesize speech (WebSocket)](https://docs.inworld.ai/tts/synthesize-speech-websocket.md)
- Audio-conditioned context: "Realtime TTS-2 is trained to condition on the audio of prior conversational turns... This feature is available via the Realtime API." and "Script synthesis retains bounded audio history between utterances within one request." — [Generating audio](https://docs.inworld.ai/tts/capabilities/generating-audio.md)
- Inworld's own stitching guidance for long text (single voice): chunk under the limit preferring paragraph breaks, then line breaks, then sentence endings, then last space ("This ensures audio segments end at natural pauses"); defaults `MIN_CHUNK_SIZE` 500, `MAX_CHUNK_SIZE` 1,600, `MAX_CONCURRENT_REQUESTS` 2, `MAX_RETRIES` 3; Python example writes WAV "with configurable silence between segments" and "prints a splice report"; JavaScript example writes MP3 and "uses **ffmpeg** to merge segments with correct duration metadata. Otherwise, it falls back to raw concatenation." — [Long text input](https://docs.inworld.ai/tts/capabilities/long-text-input.md)
- "**Start with the Async API**, which accepts up to **100,000 characters**... The server splits it into chunks, synthesizes each one, and joins the audio into a single file to download. You do not need to maintain a pipeline or tune the joins between chunks." — [Long text input](https://docs.inworld.ai/tts/capabilities/long-text-input.md)
- Format facts relevant to joining: `PCM` has no header; `WAV` in an HTTP stream has one header in the first chunk; `LINEAR16` repeats a WAV header in every streamed chunk; "MP3 chunks for one index form one recording". — [Generating audio](https://docs.inworld.ai/tts/capabilities/generating-audio.md); [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md)
- Pauses between lines can be written explicitly with `<break time="1s" />` (max 10 s each, max 20 per request). — [Pause controls](https://docs.inworld.ai/tts/capabilities/pause-controls.md)

### Inferences
- Recommended shape for narrator + characters: split a chapter into attributed segments (narration → narrator voice, each quote → that character's voice), then send them as `script.utterances` in order. Steering tags and `<break/>` can be placed inside each utterance's `text` (the docs say inline markup works in synthesis text and that only `voiceId`, `speakingRate`, `deliveryMode` are per-utterance fields; they do not explicitly show a steering tag inside a script utterance, so test this).
- Because the limit is 100 utterances and 2,000/4,000 characters (sync/stream) or 100,000 characters (async) per request, a dialogue-heavy chapter must be split into several script requests. Audio history does **not** cross request boundaries, so place the cuts at scene or paragraph breaks where a prosody reset is least audible, and pass the last few lines as `synthesisContext.previousRequests` (text-only help).
- For gapless assembly of your own, request `PER_UTTERANCE` with `PCM` or `WAV` at one fixed `sampleRateHertz` for every request (sample rate and encoding are request-level, so all utterances in a script already match), concatenate the PCM samples, insert your own silence between speakers, and encode once at the end. Concatenating MP3 files directly risks encoder padding gaps; Inworld's own example uses ffmpeg for that reason.
- `COMBINED` mode gives one finished file with a single cumulative timestamp timeline, which is the simplest path if the app only needs playback plus word highlighting; `PER_UTTERANCE` is better if the app wants to regenerate a single line or cache per line.
- Whether a steering instruction persists from one utterance to the next inside a script (it persists "until you change it" in ordinary text) is not documented; safest is to start each utterance with its own tag or `[reset]`.

### Gaps
- Script synthesis does not appear in the TTS release notes (latest entry 11 September 2026), so its launch date and release stage are not stated; only async and batch are explicitly labelled Preview.
- How much silence the service inserts between utterances in `COMBINED` mode is not documented.
- Whether Reasoning (`synthesisContext.reasoning`) works together with `script` is not documented.
- "Bounded audio history" is not quantified (seconds or number of turns).
- No official statement on recommended crossfade or padding when concatenating separately generated clips.

## 5. Audio markups / inline tags

### Takeaway
On `inworld-tts-2`, anything in square brackets is either a recognised non-verbal sound (`[laugh]`, `[sigh]`, …, produced once at that point) or a free-form natural-language steering instruction (`[whisper in a hushed style]`, `[speak as if barely holding back rage]`) that **persists until another tag or `[reset]`**. Pauses use SSML `<break time="…"/>`. Emphasis uses CAPITALS or `*asterisks*`. `inworld-tts-2-flash` ignores instruction tags but still plays non-verbals. The steering docs are not marked experimental.

### Cited Findings
- Scope: "Steering is supported only on `inworld-tts-2`. On `inworld-tts-2-flash`, steering is not supported — instruction tags are ignored, though non-verbal tags like `[laugh]` work as usual." "Steering instructions must be written in English, even when the input text is in another language." — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Core rule: "**A `[tag]` applies from where you write it until you change it.**" "To end a styled passage, write `[reset]`. To switch to a different style, just write the new tag." Not ended by: end of sentence or paragraph, very long input ("Long input is internally split for synthesis, and every part inherits the instruction in force"), a `<break/>`, a `<lang>` span, or a non-verbal tag. — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Behaviour change on 6 August 2026: "An inline `[tag]` previously affected only the text immediately after it and delivery could revert on its own partway through longer text. A tag now stays in force until you change it." Add `[reset]` where normal delivery should resume. — [TTS release notes](https://docs.inworld.ai/release-notes/tts.md)
- `[reset]`: "is never spoken", "case-insensitive", "removes the instruction, not the voice... returns the voice to itself, not to a flat, emotionless read". "In a run of adjacent tags, the last instruction wins." — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Free-form examples: `[speak as if barely holding back rage forcing every word through gritted teeth]`, `[overwhelmed with excitement and barely able to contain yourself]`, `[slow and hushed with every word weighted by grief]`. — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Single-property examples: articulation `[say with force]` `[articulate clearly]` `[say with deliberate pauses]`; intonation `[say with a falling pitch]` `[say with a rising pitch]`; volume `[very loud]` `[very quiet]`; pitch `[say in a low tone]` `[say in a high pitch]`; range `[say playfully]` `[say with no pitch variation]`; speed `[very fast]` `[very slow]`; vocal style `[sing joyfully]` `[whisper in a hushed style]` `[give a nasal quality]`. — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Non-verbals: "The most reliable non-verbals — and the ones to reach for first — are `[laugh]` `[breathe]` `[clear throat]` `[sigh]` `[cough]` `[yawn]`." Full recognised set: breath/effort `[breathe]` `[sigh]` `[gasp]` `[pant]` `[huff]` `[grunt]` `[groan]` `[moan]`; laughter `[laugh]` `[chuckle]` `[giggle]` `[cackle]` `[snort]` `[scoff]`; distress `[cry]` `[sob]` `[wail]` `[whimper]` `[whine]` `[sniffle]` `[sniff]` `[shriek]` `[squeal]` `[howl]`; throat/chest `[clear throat]` `[cough]` `[sneeze]` `[hiccup]` `[yawn]` `[burp]` `[snore]` `[choke]` `[gag]` `[swallow]` `[gulp]` `[spit]`; mouth `[tongue click]` `[mouth click]` `[mouth sound]` `[lip smack]` `[kiss]` `[shush]` `[raspberry]` `[whistle]` `[bleh]`; eating `[chew]` `[slurp]`; other `[babble]` `[beatbox]` `[growl]`. Matching "ignores case, spacing, and punctuation, and accepts common inflections". — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Key pitfall: "A tag that names a recognized sound is a non-verbal. **Anything else in brackets is treated as an instruction.**" And: "`[shout]`, `[scream]`, `[sing]`, `[hum]`, and `[mumble]` describe *how words are spoken*, so they are instructions, not sounds. Like any instruction, they persist". — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Emphasis: "Capitalize letters within your input text... Fully capitalizing a word stresses the entire word, while capitalizing individual letters within a word emphasizes a specific syllable" (e.g. "AbsoLUTEly"). "Alternatively, wrap a word in single asterisks (`*word*`)." — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md); [Generating speech best practices](https://docs.inworld.ai/tts/best-practices/generating-speech.md)
- Pauses: SSML `<break time="1s" />` or `<break time="1000ms" />`, supported "for streaming, non-streaming, and WebSocket requests, in all languages". Constraints: well-formed tag with slash; case-insensitive; "Up to **20** break tags are supported per request. After the first 20 tags, the remaining ones will be ignored."; "Each break is at most **10 seconds**". "A break never changes delivery." — [Pause controls](https://docs.inworld.ai/tts/capabilities/pause-controls.md)
- Best practices: "avoid capital letters and punctuation in your instructions"; "A bare tag like `[sad]` gives the model one dimension to work with. A fuller instruction like `[say sadly with deliberate pauses in a low voice and hushed style]`... produc[es] a more nuanced and convincing performance."; "Avoid conflicting instructions"; "Match the instruction to the text... A mismatch... may degrade output quality."; "Re-tagging every sentence gives the model less continuity to work with and can make delivery uneven." — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Gotcha: "My [tag] was read aloud instead of interpreted — Check the model... Older models may read them aloud. Also check the spelling of non-verbals — an unrecognized sound name is treated as an instruction instead of producing a sound." — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- **Reasoning** (automatic direction): set `synthesisContext.reasoning: "REASONING_ON"` and "a language model reads your text before synthesis and writes a short instruction for how it should be delivered, such as `[say it with quiet relief]`". Works on unary, streaming and async; "Support for Synthesize speech (batch) is coming soon." `reasoningContext` up to 600 characters (e.g. "Narrator of a psychological thriller audiobook."), "never spoken and is not billed". The applied instruction comes back in `reasoningInstruction` (first message only on streaming). "Your first inline tag ends it." "It never blocks synthesis." It "adds a short step before synthesis starts". To keep a delivery: "put the returned `reasoningInstruction` in brackets at the start of the text and leave `synthesisContext.reasoning` unset." — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- `deliveryMode`: "`STABLE` produces more reliable, predictable speech — best when the output must match the input exactly. `CREATIVE` produces more varied speech with greater emotional range". — [Generating audio](https://docs.inworld.ai/tts/capabilities/generating-audio.md)
- In WebSocket `SENTENCE_BOUNDARY` mode a tag may span messages (`"[whis"` + `"per] Hello."`), but "Incomplete markup at end of input returns `INVALID_ARGUMENT`." — [Synthesize speech (WebSocket)](https://docs.inworld.ai/tts/synthesize-speech-websocket.md)
- Other inline markup exists: `<lang>` spans (language tags), inline IPA pronunciation, verbatim reading, `<effect>` elements (unary only). — [Steering](https://docs.inworld.ai/tts/capabilities/steering.md); [Audio effects](https://docs.inworld.ai/tts/capabilities/audio-effects.md)
- All tags are billed as input characters (`[whisper] Hello, world!` = 23). — [Billing](https://docs.inworld.ai/portal/billing.md)

### Inferences
- The older 1.x fixed emotion tags (e.g. `[happy]`, `[whispering]`) are superseded: on TTS-2 these strings are simply interpreted as free-form instructions, and they now persist. Any existing code that prefixes one emotion tag and expects it to wear off must add `[reset]`.
- Literal square brackets in book text (editorial notes, "[sic]", footnote markers) will be interpreted as instructions or sounds on `inworld-tts-2`; strip or rewrite them before synthesis.
- For novels, a workable pattern is: narrator utterances with no tag or one tag for the scene mood, `deliveryMode: STABLE`; character utterances with a short descriptive tag derived from the dialogue attribution ("she whispered" → `[whisper in a hushed style]`), `deliveryMode: BALANCED` or `CREATIVE`.
- The 20-break limit per request matters for long async jobs (a 100,000-character chapter can only carry 20 `<break/>` tags); rely on punctuation and paragraphing for the rest, or split the job.

### Gaps
- Whether the 20-break limit is per request or per internal chunk on async jobs is not stated beyond "per request".
- No documented escape syntax for literal square brackets was found in the pages read (the "verbatim" capability page was downloaded but not examined in detail).
- Extra cost of Reasoning (if any) is not stated in the billing page.

## 6. Voice design and voice cloning

### Takeaway
Three ways to make a custom voice: **Voice design** (`POST /voices/v1/voices:design` → up to 3 previews → `POST /voices/v1/voices/{voiceId}:publish`), **Instant voice cloning** (`POST /voices/v1/voices:clone`, 3–30 s of audio), and **Professional voice cloning** (Beta; ≥10 minutes of audio; asynchronous training; `inworld-tts-2` only). No per-voice fee was found; limits are plan-based: custom voices 100 (On-Demand) to 30,000 (Growth), and design/clone API calls 2–20 per minute. There is also a Preview "ad-hoc voice design" that speaks with a described voice without saving it.

### Cited Findings
- **Design endpoint**: `POST https://api.inworld.ai/voices/v1/voices:design`. Body: `designPrompt` (required; "Must be in English and up to 1000 characters; descriptions under 30 rarely produce a useful voice"), `previewText` (required; "Must result in audio that is 1-30 seconds", about 50–400 English characters), `languageCode` (e.g. `en-GB`; legacy `langCode`), `voiceDesignConfig.numberOfSamples` (1–3, default 1), `designPromptMode` (`DESIGN_PROMPT_MODE_ASSISTED` default, or `DESIGN_PROMPT_MODE_VERBATIM` for a structured `key: value` profile). Response: `previewVoices[]` each `{voiceId, previewText, previewAudio}` "in DRAFT status". — [Design a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/design-voice.md)
- Structured profile keys (verbatim mode example): `dialect`, `gender`, `age`, `emotion`, `tone`, `pitch`, `volume`, `speed`, `clarity`, `fluency`, `personality`, `texture`, `environment`. — [Design a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/design-voice.md)
- **Publish endpoint**: `POST https://api.inworld.ai/voices/v1/voices/{voiceId}:publish` with optional `displayName`, `description`, `tags[]`; `voiceId` format `{workspace}__{voice}` (e.g. `your_workspace_id__design-voice-38b05df9`). After publishing "You can then use it to synthesize speech like any other voice." — [Publish a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/publish-voice.md)
- SDK equivalents: `tts.designVoice({designPrompt, previewText, numberOfSamples})` then `tts.publishVoice({voice, displayName})` (Node), `design_voice` / `publish_voice` (Python). — [Voice design](https://docs.inworld.ai/tts/voice-design.md)
- "The script will shape the voice that gets generated, as the model will tailor the voice to suit the content it's speaking." — [Design a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/design-voice.md)
- Design best practices: order the description "*Distinctive Qualities → Gender → Language / Accent → Age → Tone → Delivery Style → Pacing → Additional Qualities → Audio Quality*"; use specific age ranges; name a city/region for accents; put texture words in the middle with modifiers like "slight"; end with "Perfect broadcast quality audio."; avoid conflicting descriptors; "Each generation produces slightly different results"; preview script "5-30 seconds of audio (50-400 characters in English)". — [Voice design best practices](https://docs.inworld.ai/tts/best-practices/voice-design.md)
- **Ad-hoc voice design (Preview)**: pass `voiceDesign.designPrompt` (7–1,024 characters) instead of `voiceId` on unary, streaming, async or batch with `inworld-tts-2`. "Each request designs its own voice. Repeating the same description does not guarantee the same voice across requests. To reuse a voice, design and publish it through the Voices API". Not supported on WebSocket or the OpenAI-compatible endpoint, and not inside scripts. The prompt is billed as characters on each request. — [Voice design](https://docs.inworld.ai/tts/voice-design.md); [Billing](https://docs.inworld.ai/portal/billing.md)
- **Instant clone endpoint**: `POST https://api.inworld.ai/voices/v1/voices:clone` (the long form `/voices/v1/workspaces/{workspace}/voices:clone` still works). Body: `displayName` (required), `voiceSamples[]` (required; each `audioData` base64 WAV or MP3, optional `transcription`), `languageCode` (omit or `"auto"` to detect), `description`, `tags[]`, `audioProcessingConfig.removeBackgroundNoise`. Response: `voice` (with `voiceId` like `your_workspace_id__my_voice_clone_demo_20260218_223134z`, `source: "IVC"`) and `audioSamplesValidated[]` (`warnings`, `errors`, `transcription`, `audioData`). — [Clone a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice.md)
- Clone inputs: "from as little as 3 seconds of audio. The longer the sample (up to the 30-second limit), the better the speaker similarity." "The 30-second prompt limit applies to voices cloned on or after August 15, 2026. Voices cloned before that date continue to use their original 15-second prompt". Portal upload: wav, mp3, webm; max 12 MB; one file. — [Instant voice cloning](https://docs.inworld.ai/tts/instant-voice-cloning.md)
- "You cannot set [`gender`, `ageGroup`, `categories`] when cloning. The API silently ignores them here... Set them after cloning with UpdateVoice." — [Clone a voice](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice.md)
- Clone caveat: "Instant voice cloning may not perform well for less common voices, such as children's voices or unique accents." Recording advice: at least 22 kHz / 16-bit, clean audio, varied emotion, no mid-word cuts. — [Voice cloning best practices](https://docs.inworld.ai/tts/best-practices/voice-cloning.md)
- **Professional voice cloning (Beta)**: create draft (`PVC_VOICE_STATE_DRAFT`) → upload samples (max 50 samples, 1 GB total, 10 files per request, at least 10 minutes of audio) → train (states `PVC_VOICE_STATE_QUEUED` → `PVC_VOICE_STATE_TRAINING` → `PVC_VOICE_STATE_READY`); training "typically takes 30–60 minutes"; "Multi-language support for Professional Voice Cloning is experimental. English (`en-US`) is fully supported."; supported on `inworld-tts-2` only. Slots / trainings by plan: On-Demand 2 / 1 per day; Creator 4 / 2 per day; Builder 10 / 4 per day; Developer 25 / 12 per day; Growth 40 / 1 per hour; Enterprise 100 / 4 per hour. "On-Demand accounts also need a payment method on file". — [Professional voice cloning](https://docs.inworld.ai/tts/professional-voice-cloning.md); [TTS models](https://docs.inworld.ai/tts/tts-models.md)
- **Custom voice limit**: "Instant clones, designed voices and voices copied in with a copy token all count toward one limit, shared by every workspace in your organization." Check with `GET https://api.inworld.ai/voices/v1/voices:customVoiceCapacity` → `{"usedCustomVoices": 37, "maxCustomVoices": 500}`. At the limit, clone/design/publish fail with `400` `INVALID_ARGUMENT`: "You have exceeded your plan's maximum number of custom voices (500). Please upgrade to unlock more." Delete private voices to free room. Professional clones use separate slots. — [Instant voice cloning](https://docs.inworld.ai/tts/instant-voice-cloning.md)
- Custom voices per plan (as reported from the pricing page): On-Demand 100, Creator 500, Builder 3,000, Developer 10,000, Growth 30,000, Enterprise custom. — [Inworld pricing](https://inworld.ai/pricing)
- API rate limits for creation: "Voice design API (requests/min)" and "Voice cloning API (requests/min)": On-Demand 2, Creator 3, Builder 5, Developer 10, Growth 20, Enterprise custom. — [Billing](https://docs.inworld.ai/portal/billing.md)
- Storage and reuse: voices are stored server-side in the workspace and referenced by `voiceId` (designed and cloned ids are workspace-prefixed, `{workspace}__{voice}`); list your own with `filter=owned="true"`; filter by provenance with `source="TVD"` (designed) or `source="IVC"` (instant clone). — [List voices in a workspace](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices.md); [Instant voice cloning](https://docs.inworld.ai/tts/instant-voice-cloning.md)
- Terms: the Portal clone flow requires you to "Confirm you have the rights to clone the voice". Publishing a voice to the community Voice Library locks its name/description/tags, grants Inworld a hosting licence under a "Voice Library Addendum", and removal "follows a **2-year notice period**". Terms of service: "Subject to your compliance with our Terms, we assign to you all of our right, title, and interest in Outputs." — [Instant voice cloning](https://docs.inworld.ai/tts/instant-voice-cloning.md); [Voice sharing](https://docs.inworld.ai/tts/voice-sharing.md); [Inworld terms](https://inworld.ai/terms)
- Migration tool: an open-source tool re-clones ElevenLabs voice clones into Inworld (pads samples to 5 s minimum, trims to 30 s). — [Migrate from ElevenLabs](https://docs.inworld.ai/tts/resources/elevenlabs-migration.md)

### Inferences
- For per-book character voices the practical flow is: an LLM writes a `designPrompt` per character from the book's description → `voices:design` with a `previewText` taken from that character's own dialogue (the script shapes the voice) → publish the chosen preview → store the returned `voiceId` against the character → use it in `script.utterances[].voiceConfig.voiceId`. Ad-hoc `voiceDesign` cannot be used for this because it is not allowed inside scripts and is not repeatable.
- The design call itself does not appear to consume the custom-voice limit until a preview is published ("Each saved voice counts toward your plan's custom voice limit"), though the docs also list Design among calls that fail at the limit.
- On the On-Demand plan the 2 design requests per minute and 100 custom voices are the binding constraints: a 20-character cast takes at least 10 minutes of design calls, and a few books' worth of designed voices would fill the 100-voice allowance unless voices are deleted or reused across books.

### Gaps
- No statement was found on whether voice design or instant cloning calls are billed (the pricing page lists them as features without a price). Whether the preview audio generated by `voices:design` is charged as characters is unconfirmed.
- The exact request bodies of the PVC endpoints (create, upload samples, train) and of `UpdateVoice` / `DeleteVoice` were not read.
- The detailed voice-cloning consent clauses in Inworld's terms of service were not located; only the output-ownership sentence was captured.
- How long unpublished DRAFT preview voices persist is not documented in the pages read.

## 7. Rate limits, concurrency, request size limits, latency

### Takeaway
Limits are per account, by plan, and expressed as **concurrent generations** rather than requests per second: 5 (On-Demand), 10 (Creator), 50 (Builder), 150 (Developer), 500 (Growth). Async and batch jobs have separate pools of the same sizes. Published latency is P90 time to first audio byte, server-side: 100 ms for `inworld-tts-2`, 20 ms for `inworld-tts-2-flash`.

### Cited Findings
- Concurrent generations by plan: On-Demand 5, Creator 10, Builder 50, Developer 150, Growth 500, Enterprise custom. "They apply to both HTTP and WebSocket requests. Requests above these limits are best-effort based on available capacity." — [Concurrency limits](https://docs.inworld.ai/resources/concurrency-limits.md)
- Counting: "Each in-flight request counts as one concurrent generation. The slot is held for the duration of the request. Exceeding the limit returns a `429` error." WebSocket contexts count only while active. WebSocket connections are limited to 10× the generation limit (50 / 100 / 500 / 1,500 / 5,000). — [Concurrency limits](https://docs.inworld.ai/resources/concurrency-limits.md); [Billing](https://docs.inworld.ai/portal/billing.md)
- "Rate limits apply per account and are shared across your API keys." — [Rate limits](https://docs.inworld.ai/resources/rate-limits.md)
- Job pools (Preview): concurrent async jobs / concurrent batch jobs / queued batch characters — On-Demand 5 / 5 / 1,000,000; Creator 10 / 10 / 2,000,000; Builder 50 / 50 / 10,000,000; Developer 150 / 150 / 30,000,000; Growth 500 / 500 / 100,000,000. "Realtime generations, async jobs, and batch jobs are counted in three independent pools." "Requests above these limits are rejected rather than queued." — [Job concurrency limits](https://docs.inworld.ai/resources/job-concurrency-limits.md)
- "On-Demand accounts are limited to **10,000 characters per job** — the `text` of an async job, or the total across all items of a batch. Other plans get only the service-wide size ceilings: 100,000 characters per async job, and the same per item within a batch." Oversize returns HTTP 400 code 3: "the request's 25000 characters exceed the current plan's limit of 10000 characters per job; upgrade the plan for larger jobs". — [Job concurrency limits](https://docs.inworld.ai/resources/job-concurrency-limits.md)
- Over-limit errors: HTTP `429` with gRPC code `8` (`RESOURCE_EXHAUSTED`), e.g. "Concurrent async synthesis jobs limit of 5 exceeded". "Because a rejected submit creates nothing, retrying is safe and will not produce duplicate audio." Use exponential backoff with jitter; per-second limits send no `Retry-After`. — [Job concurrency limits](https://docs.inworld.ai/resources/job-concurrency-limits.md); [Rate limits](https://docs.inworld.ai/resources/rate-limits.md)
- Request text limits: 2,000 (unary), 4,000 (HTTP stream and OpenAI-compatible), 2,000 per WebSocket `sendText`, 100,000 per async job / batch item, 1–10,000 items per batch, 1–100 utterances per script, 20 `<break/>` tags per request (10 s each), `synthesisContext` 5 items / 2,000 characters, `reasoningContext` 600 characters, `voiceDesign.designPrompt` 7–1,024 characters. — [Synthesize speech (streaming)](https://docs.inworld.ai/tts/synthesize-speech-streaming.md); [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md); [Pause controls](https://docs.inworld.ai/tts/capabilities/pause-controls.md); [Synthesize speech API reference](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech.md)
- Voice design and voice cloning API: 2 / 3 / 5 / 10 / 20 requests per minute by plan. — [Billing](https://docs.inworld.ai/portal/billing.md)
- Latency: `inworld-tts-2` 100 ms and `inworld-tts-2-flash` 20 ms, "P90 time to first audio byte, measured server-side — excludes network latency." — [TTS models](https://docs.inworld.ai/tts/tts-models.md)
- Things that add latency: timestamps ("can increase latency (especially for the non-streaming endpoint)"), text normalization ("adds slight latency"), Reasoning ("adds a short step before synthesis starts"), waiting for the WebSocket `contextCreated` acknowledgement, new TCP/TLS handshakes (use keep-alive). — [Timestamps](https://docs.inworld.ai/tts/capabilities/timestamps.md); [Latency best practices](https://docs.inworld.ai/tts/best-practices/latency.md); [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Async timing: "Short inputs typically finish within seconds; long inputs can take minutes." Batch: hours; target of 24 hours not guaranteed. — [Synthesize speech (async)](https://docs.inworld.ai/tts/synthesize-speech-async.md); [Synthesize speech (batch)](https://docs.inworld.ai/tts/synthesize-speech-batch.md)
- Inworld's own long-text example defaults to 2 concurrent requests "increase with caution to avoid rate limits". — [Long text input](https://docs.inworld.ai/tts/capabilities/long-text-input.md)

### Inferences
- With 5 concurrent generations on On-Demand, a chapter split into script requests should be generated with a small worker pool (2–4) and backoff on 429.
- An On-Demand account cannot submit a whole chapter as one async job if it exceeds 10,000 characters; either chunk into ≤10,000-character jobs or move to a paid plan (Creator, $25/mo, lifts the cap to 100,000).
- No requests-per-second figure is published for TTS synthesis; concurrency is the only stated control.

### Gaps
- No published end-to-end (client-side) latency or real-time-factor figures for long-form generation were found.
- The stricter limits on the voice preview endpoint are not quantified.

## 8. Official guidance on audiobooks, long-form narration, and multi-character dialogue

### Takeaway
Inworld ships a no-code Portal product, **Audio Studio**, that turns an EPUB/PDF/DOCX/TXT/MD/Fountain file into an audiobook, podcast or drama with either one narrator or automatically cast "Character voices", running on TTS-2. For developers the docs point to the async API with steering, Reasoning with a `reasoningContext` such as "Narrator of a psychological thriller audiobook.", and script synthesis for dialogue.

### Cited Findings
- "Audio Studio turns a manuscript or script into a fully voiced audiobook, podcast episode or drama... Read it with one narrator, or choose **Character voices** to have Audio Studio find who speaks each line and cast a voice for every character... Speech is generated with Inworld TTS-2." "To build the same thing into your own app, use the TTS API with steering instead." — [Audio Studio](https://docs.inworld.ai/tts/audio-studio.md)
- Speaker attribution in Audio Studio: "In a book, a quote goes to the name next to it, as in `"Run," Tessa said` or `said the boy`. Lines Audio Studio can't place go to **Unnamed speaker**, and the narrator reads everything else. For a more reliable result, click **Find speakers with AI**. An AI model reads the work and sets who speaks each paragraph." — [Audio Studio](https://docs.inworld.ai/tts/audio-studio.md)
- Casting in Audio Studio: "For each character, it reads their lines and how the text describes them, including ages in script introductions such as `MAVIS (60s)`, and picks a voice that fits from the voice library." "**Find speakers with AI** and AI casting use your workspace's LLM usage." — [Audio Studio](https://docs.inworld.ai/tts/audio-studio.md)
- Reading-style presets: Audiobook narration ("Polished, even-tempered, like a professional narrator"), Bedtime, Documentary, Dramatic, Podcast conversation, Radio drama, Custom. "Each preset sets the TTS-2 delivery mode, a talking speed and, for every preset except Audiobook narration, a short steering instruction that is sent before each paragraph." — [Audio Studio](https://docs.inworld.ai/tts/audio-studio.md)
- Audio Studio generates "paragraph by paragraph"; "**Scene break length** sets the silence at each break such as `* * *` (0 to 5 seconds, 1.5 by default)"; screenplay parentheticals such as `(whispering)` "become delivery cues"; "Audio that is still up to date is reused, so only new and changed paragraphs are sent to TTS." File limits: EPUB/PDF 50 MB, DOCX/TXT/MD/Fountain 10 MB. — [Audio Studio](https://docs.inworld.ai/tts/audio-studio.md)
- Async API positioning: "Use it for long-form content such as audiobooks, podcasts, and video voiceovers". Reasoning example for long form: "For long-form audio, such as an audiobook chapter or a narrated lesson, send it on a Synthesize speech (async) job" with `"reasoningContext": "Narrator of a psychological thriller audiobook."` — [Synthesize speech (async)](https://docs.inworld.ai/tts/synthesize-speech-async.md); [Steering](https://docs.inworld.ai/tts/capabilities/steering.md)
- Batch positioning: "Best for large libraries generated in one pass — every line of dialogue in a game... Each item carries its own request, so a single batch can mix voices, languages, and audio formats freely." — [Synthesize speech (batch)](https://docs.inworld.ai/tts/synthesize-speech-batch.md)
- Writing-for-speech advice relevant to narration: "Skip fillers for formal applications like narration"; capitalise for emphasis; set `language` explicitly for consistency. — [Generating speech best practices](https://docs.inworld.ai/tts/best-practices/generating-speech.md)
- Official examples repository has long-input scripts (`example_tts_long_input.py`, `example_tts_long_input_compressed.js`), timestamps, streaming, WebSocket, voice clone, and voice design + publish examples. — [inworld-api-examples (tts)](https://github.com/inworld-ai/inworld-api-examples/tree/main/tts)

### Inferences
- Audio Studio is effectively Inworld's reference design for exactly this feature: attribute each paragraph to a speaker (rules first, LLM for reliability), cast from the voice library using the text's description of each character, apply one reading-style instruction per paragraph, generate per paragraph, cache unchanged paragraphs, and insert configurable silence at scene breaks. An app can mirror that design with the API.
- Audio Studio's "one steering instruction sent before each paragraph" approach suggests per-paragraph requests with a leading tag are an Inworld-sanctioned pattern, not only whole-chapter async jobs.

### Gaps
- No script-synthesis example was found in the official examples repository file list (as of 2026-11-25 it had no file named for scripts or dialogue).
- No Inworld blog post specifically about audiobook production was read.
- Audio Studio is Portal-only; no API to drive it was documented.

## 9. How the leading alternatives handle multi-speaker dialogue in one request

### Takeaway
Among hosted APIs, only ElevenLabs (text-to-dialogue) and Inworld (script synthesis) accept an arbitrary list of speaker-tagged lines with any library or custom voice; Google Gemini TTS and Azure's multi-talker voice are limited to 2 speakers, and OpenAI's speech endpoint is one voice per request. On list price Inworld TTS-2 ($25 per 1M characters) is roughly a third of ElevenLabs v3/v4 ($80 per 1M), while Gemini 3.8 Flash TTS is cheaper still by audio-token pricing but only allows two prebuilt voices per request.

### Cited Findings
- **Inworld (for comparison)**: `script.utterances[]`, 1–100 utterances, any stored voice per utterance, 2,000 characters (unary) / 4,000 (stream) / 100,000 (async job) total, `inworld-tts-2`, $25 per 1M characters on-demand (20% less via batch). — [Script synthesis](https://docs.inworld.ai/tts/capabilities/script-synthesis.md); [Inworld pricing](https://inworld.ai/pricing)
- **ElevenLabs text-to-dialogue**: `POST https://api.elevenlabs.io/v1/text-to-dialogue`; body `inputs[]` of `{text, voice_id}`, `model_id` (default `eleven_v3`), `settings.stability`, `seed`, `language_code`, `apply_text_normalization`, pronunciation dictionary locators. Reference states "The maximum number of unique voice IDs is 10." and to "keep the total character count across all `inputs[].text` values at or below 2,000 characters per request." — [ElevenLabs text-to-dialogue API reference](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert)
- ElevenLabs capability page: runs on Eleven v4 and Eleven v3 ("We recommend Eleven v4"); "There is no limit to the number of speakers in a dialogue."; longer text should be split and concatenated by the application; audio tags in brackets such as `[giggling]`, with a warning "This feature is still under active development, actual results may vary." — [ElevenLabs text-to-dialogue overview](https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue.md); the "no limit" on speakers is contradicted by the 10 unique voice ids in the [API reference](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert)
- ElevenLabs API prices per 1K characters: Eleven v4 $0.08, Eleven v3 $0.08, v2 Multilingual $0.08, v3 Conversational $0.04, Flash/Turbo v2.5 $0.04 ("Dollar prices are the same on every plan."); no separate text-to-dialogue price is listed. — [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)
- **Google Gemini TTS**: models listed `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-3.1-flash-tts-preview`, `gemini-2.5-pro-preview-tts`; multi-speaker "up to 2 speakers using prebuilt voices"; "Custom voices in multi-character dialogue require synthesizing each turn separately"; 30 prebuilt voices (Zephyr, Puck, Charon, Kore, Fenrir, Leda, …); output 24 kHz mono 16-bit PCM/WAV; streaming supported; style via natural-language direction and inline tags such as `<laugh>`. — [Gemini speech generation docs](https://aistudio.google.com/docs/speech-generation)
- Gemini 3.8 Flash TTS price (preview, through 31 December 2026): $0.50 per 1M text input tokens and $9.00 per 1M audio output tokens, audio at 25 tokens per second; listed to rise to $1.00 / $18.00 from 1 January 2027. — [Google Cloud Text-to-Speech pricing](https://cloud.google.com/text-to-speech/pricing)
- **OpenAI**: speech endpoint models `gpt-4o-mini-tts` (steerable with an `instructions` field), `tts-1` and `tts-1-hd` (deprecated, shut down 6 January 2027); each request takes a single `voice`; 13 built-in voices listed (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar); custom voices require a consent recording; no multi-speaker request shape is documented. — [OpenAI text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)
- **Microsoft Azure**: `en-US-MultiTalker-Ava-Andrew:DragonHDLatestNeural`, a preview voice for podcast-style speech with two fixed speakers (Ava and Andrew), driven by SSML `<mstts:dialog>` containing `<mstts:turn speaker="ava">` elements (post dated 30 March 2025). General Speech limits: up to 50 `<voice>` tags per SSML document. — [Microsoft Tech Community post](https://techcommunity.microsoft.com/blog/azure-ai-services-blog/-/4398951); [Azure Speech quotas and limits](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)
- **Dia / Dia2 (Nari Labs, open weights)**: transcript uses `[S1]` / `[S2]` speaker tags (two speakers); Dia2 released 19 November 2025 with 1B and 2B checkpoints under Apache 2.0; original Dia-1.6B is English-only; self-hosted, no first-party priced API found. — [Dia README](https://raw.githubusercontent.com/nari-labs/dia/HEAD/README.md)
- **Sesame CSM-1B (open weights)**: no first-party hosted API was found; third-party hosts list it (fal.ai at $0.03 per 1,000 characters with a `speaker_id` and a `context` array of prior turns; OpenRouter via DeepInfra, English, 7 voices). — [fal.ai CSM-1B](https://fal.ai/models/fal-ai/csm-1b/llms.txt); [OpenRouter CSM-1B](https://openrouter.ai/sesame/csm-1b)
- **Hume Octave 2**: launched October 2025 with multi-speaker conversation listed among its features (secondary reporting). Aggregator price figures conflict ($7.60 per 1M characters in one; $50–$150 per 1M overage in another). — [Hume Octave 2 launch post](https://hume.ai/blog/octave-2-launch); price figures from [third-party aggregator](https://anotherwrapper.com/tools/llm-pricing/speech-models/octave-2), contradicted by [another](https://perkstack.co/blog/cheapest-hume-octave-tts-api)

### Inferences
- Like-for-like per 1M characters at list price: Inworld TTS-2 $25 (batch about $20); ElevenLabs v3/v4 $80; Gemini 3.8 Flash TTS roughly $9–$14 if 1M characters yields about 17–20 hours of audio at 25 tokens/s (my conversion, assuming ~55,000 characters per hour), doubling in January 2027.
- For a novel with more than two speaking characters plus a narrator, Gemini (2 speakers, prebuilt voices only in multi-speaker mode) and Azure multi-talker (2 fixed voices) cannot do a full cast in one request; ElevenLabs can (up to 10 voice ids per request per the API reference) and Inworld can (up to 100 utterances, no stated cap on distinct voices).
- Both ElevenLabs and Inworld cap synchronous dialogue requests at about 2,000 characters, so both need application-side chunking for a chapter; Inworld's async job (100,000 characters) is the larger single-request ceiling if scripts are accepted there at full size, which the docs state ("async and batch use their existing job limits") but still within 100 utterances.

### Gaps
- ElevenLabs: whether streaming and with-timestamps variants of text-to-dialogue exist was not confirmed from the pages fetched; the 10-voice vs "no limit" conflict is unresolved.
- Gemini: input token limit for TTS models was not found on the official page (a third-party calculator claims 8,192 input tokens); the multi-speaker config field names reported by the summariser (`speech_config.speakers`) should be verified against the live docs before coding.
- OpenAI: maximum input length and current price for `gpt-4o-mini-tts` were not found in the page fetched.
- Hume: the official TTS documentation was not reached (the fetched URL returned a different product page), so Octave's multi-speaker request shape, limits and official prices are unverified.
- Azure: no price or turn/length limit specific to the multi-talker voice was found; its current status (still preview or not) in late 2026 is unverified.
- Dia2 maximum generation length and Sesame's own hosted availability were not confirmed from primary sources.
