# Read-along recordings and hands-free reading

Research date: 2026-11-25. Web research only; no source code was changed.

How to read this report: each claim is tagged **[verified]** (I read it on the linked page this session), **[inferred]** (my reasoning from verified facts), or **[not confirmed]** (I looked and could not source it). Everything in the last group is collected again at the end.

## Short answer

1. **Recordings.** Keep one clip per chunk, keyed by a hash of what was said and how (text + voice + model + delivery settings), with a small per-page index. Store locally in IndexedDB first; add a private Supabase Storage bucket as a second tier only if recordings must follow the user between devices. Do not concatenate MP3 clips into one page file for playback. Keep playing through the single `<audio>` element.
2. **Hands-free mode.** Screen Wake Lock (re-acquired on `visibilitychange`), a dark overlay rather than real brightness control, the CSS Custom Highlight API for the spoken word with a `<mark>`/span fallback, Media Session for lock-screen and headset controls, and at most about six speaker colours, each paired with a non-colour cue.

One thing found in the repo while checking how audio is played today: `src/lib/readRecordings.ts` already implements a local, content-hashed, per-page clip store in IndexedDB, and `src/hooks/useWakeLock.ts` already exists. The recommendations below agree with that design; the open decisions are the cloud tier, the bitrate, and the hands-free visuals.

---

## Part 1: Recording and caching the TTS audio

### 1.1 What Inworld returns and what it costs

All **[verified]** against Inworld's docs and pricing page on 2026-11-25.

| Item | Fact | Source |
|---|---|---|
| Current models | `inworld-tts-2` and `inworld-tts-2-flash`. The TTS-1 and TTS-1.5 families are deprecated; TTS-1 and TTS-1-Max were discontinued 2026-06-15 | [Models](https://docs.inworld.ai/tts/tts-models.md) |
| Encodings | `LINEAR16`, `MP3` (default), `OGG_OPUS`, `ALAW`, `MULAW`, `FLAC`, `PCM`, `WAV` | [Synthesize speech](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech) |
| Sample rate | 8,000 to 48,000 Hz; default 48,000 (8,000 for μ-law/A-law), capped at the model's native rate | same |
| Bit rate | `bitRate`, MP3 and OGG_OPUS only, default 128,000 bps | same |
| Text limit | 2,000 UTF-16 code units per request (4,000 on HTTP streaming); output up to 16 MB | same |
| Timestamps | `timestampType`: `WORD` or `CHARACTER`. `WORD` returns `timestampInfo.wordAlignment` with `words`, `wordStartTimeSeconds`, `wordEndTimeSeconds`, plus `phoneticDetails`. Enabling alignment "can increase latency (especially for the non-streaming endpoint)" | [Timestamps](https://docs.inworld.ai/tts/capabilities/timestamps.md) |
| Context text | "Context text is not billed: only the `text` field counts toward your character usage." | [Generating speech](https://docs.inworld.ai/tts/best-practices/generating-speech.md) |
| Price per 1M characters | TTS-2: $25 on-demand, $20 Creator, $17.50 Builder, $15 Developer, $12.50 Growth. TTS-2 Flash: $15 / $10 / $9 / $8 / $7. No effective date is shown on the page | [Pricing](https://inworld.ai/pricing) |

The app's edge function currently asks for MP3 at 24,000 Hz on `inworld-tts-2` (seen in `supabase/functions/inworld-tts/index.ts`).

**[inferred]** What a recording saves and what it weighs, assuming a book page of 2,000 to 3,000 characters:

- Cost: $0.05 to $0.075 per page on TTS-2 on-demand, so a 300-page book is roughly $15 to $22 per full listen. A recording removes all of it on the second listen.
- Size: at the default 128 kbps, MP3 is 16 KB per second. A page of about two minutes is about 1.9 MB, and a 300-page book about 580 MB. Speech at 24 kHz mono does not need 128 kbps; setting `bitRate` to 48,000–64,000 would cut storage by half or more. I did not find Inworld guidance on a recommended speech bitrate, and I do not know whether the function sets `bitRate` today.

### 1.2 Where to store

**Quota and eviction [verified]** ([MDN storage quotas, last modified 2026-01-05](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria); [web.dev storage](https://web.dev/articles/storage-for-the-web); [web.dev persistent storage](https://web.dev/articles/persistent-storage)):

- IndexedDB, Cache API and OPFS share **one per-origin quota**. Choosing between them does not change how much can be stored.
- Chrome: an origin can use up to 60% of total disk size. `navigator.storage.estimate()` in Chrome reports 60% of disk size regardless of free space, so "the available quota [can] exceed the actual amount of storage available" and over-quota errors must be caught.
- Eviction in Chrome happens only under storage pressure, least-recently-used origin first, and is all-or-nothing: "all of its data, not parts of it, is deleted at the same time." MDN adds that data is "very rarely deleted by the browser."
- `navigator.storage.persist()` exempts the origin from that eviction. Chrome grants or denies it silently, based on site engagement, whether the site is installed or bookmarked, and whether notifications are granted. Firefox asks the user.
- Safari deletes script-written storage for origins with no user interaction in seven days of browser use; installed home-screen apps are exempt.
- If the user has "clear site data when all windows close" turned on in Chrome, quota drops to about 300 MB.

**The four options:**

| Option | Verified facts | Fit for many small clips |
|---|---|---|
| **IndexedDB** (ArrayBuffer/Blob rows) | web.dev: "For other data, use IndexedDB." Transactions let audio and word timings be written together in one row | **Best fit [inferred].** One row per clip, indexed by page, holds audio plus timings atomically. Already in use in the app |
| **OPFS** | web.dev: for "file-based content". MDN: optimised for "in-place write access"; the fast synchronous handles are worker-only; Baseline widely available since March 2023 ([MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)) | Its strengths are large files and in-place writes, which write-once clips of tens of KB do not need. Timings would need a second store **[inferred]** |
| **Cache API** | web.dev: for "network resources necessary to load your app" | Keyed by request URL. The clips arrive as base64 inside a POST response, so entries would have to be synthetic. Workable, no advantage **[inferred]** |
| **Supabase Storage** | Pro plan: 100 GB included then $0.0213/GB; egress 250 GB then $0.09/GB; cached egress 250 GB then $0.03/GB ([pricing](https://supabase.com/pricing)). Free plan: 1 GB, 50 MB per file ([limits](https://supabase.com/docs/guides/storage/uploads/file-limits)). Signed URLs each carry a unique token so the first request with each is a cache miss; overwrites can take up to 60 seconds to clear the CDN, and Supabase advises "upload the new asset to a different path" ([Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn)) | The only option that crosses devices |

**Two-tier design.** I could not find a primary source that names "local first, cloud second" as the norm for cached TTS, so treat this as **[inferred]**. What I could source: ElevenReader stores offline downloads in the app, drops them on sign-out and expires them after 60 days ([help page](https://elevenlabs.io/docs/help-center/product/mobile-apps/elevenreader/how-do-offline-downloads-work)); Readwise Reader says speech is "generated on request" and cannot be used offline ([docs](https://docs.readwise.io/reader/docs/faqs/text-to-speech)); Inworld's own playground keeps history "locally per device" ([docs](https://docs.inworld.ai/llms-full.txt)).

Content-hashed keys make the cloud tier simple: a clip's path never changes meaning, so the Supabase advice about new paths is met automatically and "record over" never has to fight the CDN.

### 1.3 Cache key design

**[inferred]**, with the supporting facts verified.

- **Content-addressed** (hash of text + voice id + model + delivery/direction + anything else that changes the sound) is the better primary key. A changed voice or edited text produces a different key, so a stale clip can never play; nothing needs to be actively invalidated. A character recast only re-records that character's lines.
- **Positional** (book/page/chunk index) is needed only as an index: which clip keys make up page N, in order. This is what "bundle per page", "delete this page's recording" and "how much is recorded" read from.
- Put a **format version** in the hashed string (encoding, sample rate, bit rate, and a schema number) so a future change of format does not mix old and new clips.
- Inworld's `synthesisContext` (previous text passed for continuity) changes how a clip sounds but is not billed. Leaving it out of the key gives more cache hits at the price of a clip that was voiced with slightly different lead-in. That is a judgement call; I found no guidance.
- **"Record over"** has to bypass the lookup and overwrite the row for the same key, because the key is unchanged. For a cloud copy, overwrite with `upsert` and expect up to 60 seconds of CDN staleness, or add a take number to the path.
- **Hash cost.** `crypto.subtle.digest` supports SHA-256, returns a Promise, needs HTTPS, and takes the whole input in memory with no streaming ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest); Baseline since January 2020). The inputs here are a few hundred bytes of text, so cost is negligible **[inferred; I did not benchmark]**. Hash the text and settings, never the audio.

### 1.4 Granularity: per-chunk clips or one file per page

**Per-chunk clips are the safer choice.** Evidence:

- **MP3 cannot be joined cleanly [verified].** Encoders pad every file: in web.dev's worked example "LAME added exactly 576 padding samples to the end of the file" and the next file starts with 576 more ([web.dev, MSE for audio](https://web.dev/articles/mse-seamless-playback)). The bit reservoir means a frame's data can sit in earlier frames, so cuts at frame boundaries can break audio, and byte-concatenated files make decoders apply the second file's gapless header to the whole stream ([FFmpeg patch thread](https://lists.ffmpeg.org/pipermail/ffmpeg-devel/2014-September/163214.html)). A joined file plays, but with a small silence at every seam, and seek positions and durations may be estimated.
- **Timestamps would drift [inferred].** Inworld's word times are per request. In a joined file each clip's times need an offset equal to the true decoded length of everything before it, padding included. Per-chunk clips avoid the problem.
- **Ogg Opus [partly verified].** A Mozilla bug report says Chromium-based browsers played chained Ogg Opus "just fine" while Firefox stalled at the boundary ([bug 1561291](https://bugzilla.mozilla.org/show_bug.cgi?id=1561291)). That is an anecdote in a bug thread, not a support statement, so I would not build on it.
- **Per-chunk also fits the product [inferred]:** record-over of one paragraph, a recast of one character, and resuming mid-page all touch single clips.

A joined MP3 is fine for a **download/export** file, where a few milliseconds of silence between sentences does not matter. `src/lib/ttsAudioCache.ts` already does this for chat replies.

If a single file per page is ever wanted for cloud transfer (one request instead of twenty), the clean form is a container of separate clips (a zip, or one blob plus a byte-offset index, sliced back into clips on the device), not a continuous audio stream **[inferred]**.

### 1.5 Word timestamps with the audio

**[inferred]** Store the timings in the same record as the audio, written in one transaction, so a clip can never exist without its timings. Keep them as returned (seconds from the start of that clip) and never convert them to page time. Inworld's `words` array "covers every token from the original input in order", including whitespace and punctuation ([Timestamps](https://docs.inworld.ai/tts/capabilities/timestamps.md)); storing start/end as two number arrays alongside the text is compact. The docs do not state the time origin outright; their example starts at 0.

In a cloud tier, store timings as a small JSON object next to the audio object, or as a `jsonb` column in a Postgres row that also holds the storage path. The second is easier to query ("which pages of this book are recorded?") **[inferred]**.

### 1.6 Playback of consecutive short clips on mobile

| Approach | Verified | Assessment |
|---|---|---|
| **One `<audio>` element, blob URL per clip** (today's approach) | `preservesPitch` defaults to `true`, Baseline since December 2023 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch)). Media Session and Chrome's media notification are built around media elements ([web.dev](https://web.dev/articles/media-session)) | **Keep it.** Speed change without chipmunk pitch, lock-screen controls, background audio. A small gap at each clip change, which falls on a sentence or paragraph break |
| **Web Audio `AudioBufferSourceNode`** | Sample-accurate scheduling. `playbackRate` "resamples the audio" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/playbackRate)); the page names no pitch correction. A Firefox bug notes "MediaSession API doesn't support web audio" there ([bug 1706993](https://bugzilla.mozilla.org/show_bug.cgi?id=1706993)) | Speed changes would shift pitch **[inferred from "resamples"]**, and lock-screen control is weaker. Not suitable for a reader with a speed control |
| **MediaSource (MSE)** | True gapless needs each clip's encoder padding trimmed with `appendWindowStart/End` and `timestampOffset`, which means parsing the LAME/Xing header of every clip ([web.dev](https://web.dev/articles/mse-seamless-playback)) | Works with one media element, so rate and lock screen are kept, but it is real complexity for gaps that land on sentence breaks. Only worth it if gaps are audibly a problem |

Cheap ways to shrink the gap while keeping one element **[inferred]**: create the next clip's blob URL before the current one ends, and start `play()` directly in the `ended` handler with no timer in between.

**Background and lock screen on Android:**

- **[verified]** Chrome throttles timers in hidden pages to once a minute only if the page has been hidden over five minutes **and** "silent for at least 30 seconds"; a page that "has made noises in the past 30 seconds" is exempt ([Chrome 88 timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). A reader that is speaking stays exempt; a long pause between pages could trip it.
- **[verified]** "Chrome requests 'full' audio focus to show media notifications only when the media duration is at least 5 seconds" ([web.dev](https://web.dev/articles/media-session)). Many sentence-sized clips are shorter than that. This is a reason to prefer paragraph-sized clips, or to expect the notification to behave inconsistently on very short ones.
- **[not confirmed]** Whether Chrome on Android always allows `play()` on a new `src` from an `ended` handler with the screen locked. One WebKit bug reporter says the same pattern "Works fine in Android/Windows Chrome" while failing on iOS ([WebKit 261554](https://bugs.webkit.org/show_bug.cgi?id=261554)). No Chrome document states it. The app's memory notes say the read-along has not been tested on a real phone; this is the first thing to test.
- **[verified, iOS]** Several WebKit reports describe `play()` on a new source doing nothing once the screen is locked. Hands-free mode keeps the screen on, which sidesteps this.

### 1.7 Inworld's terms on storing generated audio

Reported as written; this is not legal advice.

- **Terms of Service, effective 2025-06-11** ([inworld.ai/terms](https://inworld.ai/terms)) **[verified]**: "Subject to your compliance with our Terms, we assign to you all of our right, title, and interest in Outputs." The licence to use the Services is "solely for your internal business purposes". On ending the agreement: "Upon termination, your license ends, and you must delete all Services, Models and Outputs."
- **Service Specific Terms, last updated 2026-05-14** ([inworld.ai/service-specific-terms](https://inworld.ai/service-specific-terms)) **[verified]**: "you retain all rights in and to your Output"; where download is enabled, "you are permitted to use such Output outside of the Services but always subject to these Terms."
- **Acceptable Use Policy, last updated 2025-06-11** ([inworld.ai/acceptable-use-policy](https://inworld.ai/acceptable-use-policy)) **[verified]**: bars using Output "to train AI or compete with Inworld AI", and says to "clearly and prominently disclose to users they are interacting with AI".
- **None of the three pages mentions caching or storing generated audio**, either to permit or to forbid it. The points that bear on a cache are the output assignment (in favour) and the delete-on-termination clause (a cloud bucket of recordings would have to be deletable if the Inworld account were closed).
- These pages were read through an automated summary of each page, not line by line; a clause could have been missed. An enterprise or master agreement, if one applies, would override them.

---

## Part 2: Hands-free reading mode

### 2.1 Screen Wake Lock

**[verified]** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API); [caniuse, read 2026-11-25](https://caniuse.com/wake-lock); [Chrome docs](https://developer.chrome.com/docs/capabilities/web-apis/wake-lock))

- Support: Chrome 84+, Safari and iOS Safari 16.4+, Firefox 126+, Samsung Internet 14+. Current Chrome for Android (157) and Firefox for Android (160) support it. MDN: Baseline 2025, newly available since March 2025. caniuse global figure: 96.35%.
- iOS home-screen apps: broken from 16.4 until fixed in Safari 18.4 (2025-03-31), "Fixed Wake Lock API for Home Screen Web Apps" ([release notes](https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes.md); [WebKit 254545](https://bugs.webkit.org/show_bug.cgi?id=254545)).
- HTTPS only. The request can be refused, for example on low battery or in power-save mode, so it must be in `try/catch`.
- Hidden tab: the lock "is automatically released when you minimize a tab or window, or switch away". A released sentinel cannot be reused.
- Re-acquire: on `visibilitychange`, when `document.visibilityState === "visible"` and hands-free mode is still on, request a new lock. Listen for the sentinel's `release` event to keep the UI honest.
- A wake lock keeps the screen on. It has no dimming option.

### 2.2 Brightness

- **[verified as far as a negative can be]** No shipped web API sets hardware brightness. The need has been discussed at W3C since 2018; proposals included a brightness option on the wake lock request and a declarative attribute. The most recent messages I found are from April 2024 and show no settled API shape ([W3C list, April 2024](https://lists.w3.org/Archives/Public/public-device-apis-log/2024Apr/0142.html); [CSSWG issue 6990](https://lists.w3.org/Archives/Public/public-css-archive/2024Feb/0379.html)). Those proposals were about raising brightness (for QR codes), not lowering it. I did not find a Recommendation or a shipping implementation, and I did not check the WICG repository's current state directly.
- **What a page can do [inferred]:** render dim. A near-black background with low-luminance body text and one bright highlighted word. On OLED panels a true black (`#000`) pixel is off, so a mostly black screen draws little power; on LCD the backlight stays at the system level and a dark page only looks dimmer.
- **Burn-in [verified from consumer and vendor sources only]:** burn-in is most likely "when parts of a display [remain] static, particularly with high brightness" ([Android Authority](https://www.androidauthority.com/screen-burn-in-801760/)); Google says Pixel screens are designed to minimise it ([Pixel help](https://support.google.com/pixelphone/answer/9128915)). I found no Android developer guidance for apps. **[inferred]** A reader whose text scrolls and whose highlight moves is low-risk; the elements to watch are fixed ones such as a control bar or progress line, which can be faded out after a few seconds or nudged a few pixels now and then.

### 2.3 Media Session

**[verified]** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API); [web.dev](https://web.dev/articles/media-session); [caniuse](https://caniuse.com/mdn-api_mediasession))

- Support: Chrome 73+, Safari and iOS Safari 15+, Firefox 82+, Samsung Internet 7.2+; Firefox for Android 160 is listed as partial. MDN still labels it "not Baseline". caniuse global figure: 97.24%.
- It supplies metadata and action handlers for "hardware keys found on keyboards, headsets, remote controls, and software keys found in notification areas and on lock screens of mobile devices."
- Useful actions for a reader: `play`, `pause`, `previoustrack`, `nexttrack` (map to previous/next paragraph), `seekbackward`, `seekforward`.
- `setPositionState` takes duration, position and `playbackRate`; update it on `ratechange`.
- Set `navigator.mediaSession.playbackState` by hand, because the browser may not consider the page to be playing during the load between clips.
- Artwork target on Chrome for Android is 512×512.
- The 5-second audio-focus rule in section 1.6 applies here.

`src/components/ReadAlong.tsx` already touches `navigator.mediaSession`; I did not audit how completely.

### 2.4 CSS Custom Highlight API

**[verified]** ([MDN API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API); [MDN `::highlight()`](https://developer.mozilla.org/en-US/docs/Web/CSS/::highlight); [caniuse](https://caniuse.com/mdn-api_highlight); [Chrome guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/ui-behaviors/highlight-text-ranges))

- Support: Chrome 105+, Safari and iOS Safari 17.2+, Firefox 140+ (June 2025), Samsung Internet 20+. caniuse global figure: 94.95%. MDN's API page says Baseline 2025 (since June 2025); MDN's `::highlight()` page says Baseline 2026 (since March 2026). The two pages disagree on the date; both say all current browsers support it.
- How it works: build `Range` objects over text nodes, wrap them in a `Highlight`, register with `CSS.highlights.set(name, highlight)`, style with `::highlight(name)`. No DOM changes. One named highlight per speaker gives one colour per speaker.
- Allowed properties only: `color`, `background-color`, `text-decoration` and its longhands, `text-shadow`, and the `-webkit-text-stroke-*` / `-webkit-text-fill-color` properties. `background-image`, `font-size`, `padding`, border radius, transitions and animations are not available.
- Overlap is resolved with the highlight's `priority` property.
- Not exposed to assistive technology: "Custom highlights are purely presentational and are not exposed to the accessibility tree." Chrome's guidance: where a highlight is critical, "fall back to wrapping matched text in `<mark>` elements"; detect with `CSS.highlights`.
- A WebKit bug filed February 2026 reports highlights not rendering inside `display: flex` / `inline-flex` nodes ([WebKit 307455](https://bugs.webkit.org/show_bug.cgi?id=307455)). I did not check whether it is fixed.

**Consequences for the design [inferred]:** the spoken-word highlight cannot have rounded corners, padding, a glow built from `box-shadow`, or a fade between words. `text-shadow` is allowed and can stand in for a glow. If the design calls for a pill-shaped or animated highlight, use a positioned overlay element moved to the word's `Range.getBoundingClientRect()` instead.

**PDF.js text layers [not confirmed]:** I found no PDF.js issue or document about the Custom Highlight API (a search of the `mozilla/pdf.js` tracker for it returned nothing). **[inferred]** The PDF.js text layer is transparent text laid over a canvas image of the page. A `background-color` highlight there paints a tinted box over the drawn glyphs, which works as a marker; a `color` highlight would reveal the hidden text layer's own glyphs on top of the canvas ones, slightly misaligned. PDF.js has long-standing reports of text-layer spans not lining up exactly with the drawn text ([issue 13323](https://github.com/mozilla/pdf.js/issues/13323)), so any highlight on that layer inherits that imprecision. This needs a test in the app's PDF view.

### 2.5 Accessibility of a moving, colour-coded highlight

- **Contrast [verified]:** WCAG 2.2 SC 1.4.11 requires 3:1 against adjacent colours for "visual information required to identify user interface components and states" ([Understanding 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)). The page does not mention text highlights specifically; applying 3:1 to the highlight against the page background is a reasonable reading, not a quoted rule. Text inside the highlight still has to meet the text contrast rule (4.5:1, SC 1.4.3), which Chrome's highlight guidance also cites.
- **Colour alone [verified]:** SC 1.4.1: "Color is not used as the only visual means of conveying information... or distinguishing a visual element." A 3:1 luminance difference between two colours can count as a second cue, but "if content relies on the user's ability to accurately perceive or differentiate a particular color an additional visual indicator will be required" ([Understanding 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)). Telling six speakers apart is exactly that case, so each speaker needs a second cue: the speaker's name shown while they talk, and/or a different underline style (`text-decoration-style` solid, dotted, dashed, wavy, double is allowed inside `::highlight()`).
- **Motion [verified]:** SC 2.2.2 requires a way to "pause, stop, or hide" moving or scrolling content that starts automatically and lasts over five seconds ([Understanding 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)); the pause button covers this. `prefers-reduced-motion: reduce` reports the device setting, Baseline since January 2020 ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)). **[inferred]** With it on: scroll by jumping a line or paragraph at a time rather than smooth scrolling, and consider highlighting the sentence rather than each word.
- **Following the reader [verified]:** Readwise Reader stops auto-following "when Reader detects scrolling input from the user" and offers a return button ([docs](https://docs.readwise.io/reader/docs/faqs/text-to-speech)). That is a good pattern to copy.

**How many speaker colours.** The Okabe–Ito palette is the standard colour-blind-safe categorical set: seven hues plus black ([Okabe and Ito's page](https://jfly.uni-koeln.de/color/), which also says "Do not convey information in color only"; hex values from the [NYU Siegal lab table](https://siegal.bio.nyu.edu/color-palette/); I did not read the hex values off the original figure). Contrast against black, computed by me with the WCAG formula:

| Colour | Hex | vs `#000` | vs `#121212` |
|---|---|---|---|
| Yellow | `#F0E442` | 15.9 | 14.2 |
| Orange | `#E69F00` | 9.3 | 8.3 |
| Sky blue | `#56B4E9` | 9.1 | 8.1 |
| Reddish purple | `#CC79A7` | 6.9 | 6.1 |
| Bluish green | `#009E73` | 6.1 | 5.5 |
| Vermilion | `#D55E00` | 5.4 | 4.8 |
| Blue | `#0072B2` | 4.0 | 3.6 |

**[inferred]** All seven clear 3:1 on black, and black text on any of them as a highlight background clears 4.5:1 except blue (4.0). On a dark screen, use the first six and drop or lighten blue. Six distinguishable speakers plus the narrator in a neutral white or cream is a sensible ceiling; beyond that, reuse colours and rely on the name label.

### 2.6 What other read-aloud products do (sourced only)

| Product | What I could source | Source |
|---|---|---|
| **Kindle Assistive Reader** | "Follow along with the words highlighted as they're read aloud"; play, pause, speed, rewind 30 s. Uses the device's own TTS engine in the apps | [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/TqLHvK6eo6O7DJVQoZ) |
| **Audible Read & Listen / immersion reading** | Text highlighted in real time in sync with human narration; rolled into the Audible app from February 2026 (US test first) | [TechCrunch 2026-02-18](https://techcrunch.com/2026/02/18/audibles-new-read-listen-feature-syncs-your-kindle-ebooks-with-audiobooks/), [Audible help](https://help.audible.com/s/article/what-is-immersion-reading) |
| **ElevenReader** | Offline downloads stored in the app, 2–5 minutes to prepare, expire after 60 days, removed on sign-out, capped at 20 hours/day and 150 hours/month. Text highlighting is listed as a feature on the App Store | [ElevenLabs help](https://elevenlabs.io/docs/help-center/product/mobile-apps/elevenreader/how-do-offline-downloads-work) |
| **Speechify** | A "Highlighting" toggle that highlights the sentence as it reads; dark mode; offline mode that downloads MP3 | [Speechify blog](https://speechify.com/blog/how-do-i-enable-text-highlighting-on-the-computer/), [web app guide](https://speechify.com/blog/ultimate-guide-to-the-speechify-web-app-for-text-to-speech/) |
| **Readwise Reader** | Speech "generated on request", not available offline; auto-follow stops when the user scrolls, with a return button | [Readwise docs](https://docs.readwise.io/reader/docs/faqs/text-to-speech) |
| **Apple (system Speak Screen, used in Books)** | Highlights words, sentences or both, with a choice of underline or background colour and separate colours for words and sentences | [Apple accessibility](https://images.apple.com/ca/accessibility/vision), [AbilityNet iOS 26 guide](https://mcmw.abilitynet.org.uk/how-to-enable-your-device-to-read-aloud-the-text-that-is-on-the-screen-in-ios-26-on-your-iphone-or-ipad) |

Two patterns recur: a two-level highlight (sentence tinted, current word stronger), and a user-selectable highlight style. **None of the sources describes per-character highlight colours or a dimmed keep-awake reading mode**; I could not find a product doing either, which may mean it is uncommon or only that it is undocumented.

---

## Recommended design

**Recordings**

1. **One clip per chunk**, stored with its word timings in a single IndexedDB row. Key = SHA-256 of a canonical string of text, voice id, model, delivery/direction settings and a format version. Keep a per-page index of clip keys in reading order. This is what `src/lib/readRecordings.ts` already does; keep it.
2. **Call `navigator.storage.persist()`** once the user makes a first recording, and show used space from `navigator.storage.estimate()` with a "delete recordings for this book" action. Catch quota errors on every write.
3. **Lower the MP3 bit rate** to around 48–64 kbps at 24 kHz for new recordings, after listening to a sample. Roughly halves storage.
4. **Prefer paragraph-sized clips over sentence-sized** where the 2,000-character request limit allows: fewer seams, and clips stay above Chrome's 5-second threshold for media notifications.
5. **Keep the single `<audio>` element.** Pre-create the next blob URL and call `play()` straight from `ended`. Do not move to Web Audio (pitch shifts with speed). Consider MediaSource only if seam gaps prove audible.
6. **"Record over"** bypasses the cache for the chosen paragraph or page and overwrites the same keys.
7. **Cloud tier, only if cross-device matters:** private Supabase Storage bucket, path `user/<hash>.mp3`, plus a Postgres row per clip (hash, book, page, order, timings as `jsonb`, bytes). Local lookup first, then cloud, then synthesize; upload after synthesis in the background. Keep a delete-all path, given Inworld's delete-on-termination clause.
8. **Do not concatenate clips** for playback. Join only for a download/export file.

**Hands-free mode**

1. **Wake lock** on entering the mode; re-request on `visibilitychange` when visible; release on exit; show a small indicator driven by the sentinel's `release` event. The mode must still work, without the keep-awake, when the request is refused.
2. **Dimming by rendering:** `#000` background, body text at low luminance, the current sentence slightly brighter, the current word in the speaker's colour. Fade the controls out after a few seconds of no touch.
3. **Word highlight:** Custom Highlight API where `CSS.highlights` exists, one registered highlight per speaker; fall back to the existing span approach elsewhere. Use an overlay element instead if the design needs rounded or animated highlights. Test on the PDF view before committing to it there.
4. **Speakers:** narrator in neutral, up to six character colours from Okabe–Ito (yellow, orange, sky blue, reddish purple, bluish green, vermilion), always with the speaker's name on screen and optionally a distinct underline style.
5. **Motion:** auto-scroll that stops when the user scrolls and offers a "back to the voice" button; jump-scroll and sentence-level highlight under `prefers-reduced-motion`.
6. **Media Session:** metadata (book, chapter, cover at 512×512), `play`/`pause`, previous/next paragraph, `setPositionState` updated on rate change, `playbackState` set by hand between clips.

**Test first on a real Android phone:** clip-to-clip advance with the screen locked, the media notification with short clips, and wake-lock re-acquire after switching apps.

## What I could not confirm

- **Chrome on Android, locked screen:** no primary source states that `play()` on a new `src` from an `ended` handler is always allowed. One bug-report comment says it works.
- **Web Audio in the background on Android Chrome:** no current primary source either way.
- **`AudioBufferSourceNode` pitch:** MDN says it "resamples"; the pitch shift is my inference from that, not a quoted statement.
- **Inworld MP3 internals:** whether clips carry a LAME/Xing header with padding values (needed for MSE gapless), the native sample rate of TTS-2, and whether word times include encoder delay. Not stated in the docs; would need a real clip inspected.
- **Inworld terms on caching:** nothing found that permits or forbids it. The legal pages were read via automated page summaries, not line by line.
- **Inworld pricing date:** the pricing page shows no effective date.
- **Two-tier storage as "the norm":** no primary source says so; it is my inference from how the products above behave.
- **IndexedDB versus OPFS speed for small blobs:** no benchmark found or run.
- **`subtle.digest` cost:** not benchmarked; assumed negligible for inputs of a few hundred bytes.
- **Chained Ogg Opus in Chrome:** one bug-thread anecdote only. WebM/Opus appending through MediaSource was not researched to a conclusion.
- **PDF.js and the Custom Highlight API:** no documentation or issue found; behaviour on the transparent text layer is inferred and untested.
- **WebKit bug 307455** (highlights inside flex containers): current status not checked.
- **Screen brightness API:** latest evidence is April 2024 mailing-list traffic; I did not open the WICG repository to see its current state.
- **Burn-in guidance:** consumer and vendor pages only; no developer-facing guidance found.
- **WCAG 1.4.11 and text highlights:** the Understanding page does not mention them; applying 3:1 is an interpretation.
- **Okabe–Ito hex values:** taken from a secondary table, not read from the original figure.
- **Products:** Speechify highlight colours, ElevenReader's highlight behaviour (word or sentence, online or offline), Readwise's highlight granularity, and Apple Books' own read-aloud UI (as distinct from system Speak Screen) could not be sourced. Kindle's speed range is not given on Amazon's help page.
- **Browser version tables on MDN** did not load through the fetch tool; version numbers come from caniuse (read 2026-11-25), whose mobile columns list only the current version.
