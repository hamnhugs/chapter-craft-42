# Paper books: speed audit (2026-11-19)

Why scanning feels laggy, what was measured, and what to change. Nothing in
the app was changed by this audit.

## Built so far (2026-11-19, branch new1)

Findings 1 to 5. Findings 6 to 8 and the experiments are not started.

- **1, the freeze:** each page's own doubts and its squashed text are worked
  out once and kept; twins are found through a map. Per-page cost at 500
  pages went from about 5 s to under 5 ms on the dev machine. Covered by a
  400-page timing test in `paperBook.test.ts`.
- **2, pages waiting on saves:** a page shows as soon as it is read; its save
  trails behind and queued saves collapse into the newest. An engine opening
  a book waits for saves still in flight, so it cannot load a stale copy.
- **3, one request per moved row:** position updates go eight at a time. It
  is still one request per row (no bulk update is possible without touching
  `text_content` or adding a server function), so a delete near the front of
  a 200-page book is about 25 rounds instead of 197.

- **4, thinking first:** the page call now asks each provider for no
  thinking, or the least it allows (`quickReadBody`): Gemini 2.5 Flash off,
  Gemini 3 "minimal" (Google's docs say it cannot be turned off there),
  OpenRouter the matching `reasoning.effort`. A model that rejects the
  setting is asked again without it and not asked that way again.
- **5, silence until done:** the call is streamed, and the words of the page
  being read show under "Reading the page…" as they arrive. The page that is
  kept is still parsed from the finished reply. Speaking the first sentence
  early (Listen) is not built.

4 and 5 are tested against a fake streamed reply only
(`pageTranscribeStream.test.ts`). Whether thinking really switches off, and
how much time it saves, has NOT been checked against a real model.

Checked with the lab only (stand-in reader and store): type-check, 2,769
tests, build, and the four headless walkthroughs. Not run signed-in.

## How it was measured

- Pure functions timed with `vite-node` on the dev machine, and again in
  headless Chromium with the CPU throttled 4x (a rough stand-in for a
  mid-range phone, not a real one).
- Photo preparation timed in the same throttled browser on a synthetic
  3000x4000 "page" JPEG (4.2 MB).
- Network steps were counted from the code, not timed: there is no signed-in
  test account and no model key on this machine.
- Model latency figures come from published sources, not from our own calls.

Not measured anywhere: a real phone, a real Gemini call, real Supabase saves,
the live camera preview.

## Findings, worst first

### 1. The app freezes on every page, and the freeze grows with the book (measured)

Every time a page lands, two things each compare every page against every
other page to look for duplicates (`pageDoubts` → `squash` of both texts):

- the `doubts` memo in `PaperDesk.tsx`, and
- `chaptersForPages` in the save (`needsLook` per page, for the poor-scan name).

Freeze per page added, browser at 4x CPU throttle:

| Pages in book | Freeze per new page |
|---|---|
| 25 | 0.1 s |
| 50 | 0.3 s |
| 100 | 1.0 s |
| 200 | 3.7 s |
| 300 | 7.9 s |

The same freeze happens on "It is fine", delete, undo and rename, because
they all change `pages` or save. Uploading 100 photos into an empty book
adds roughly 30 s of frozen screen in total.

Fix: squash each page once (cache by page object; pages are never mutated),
find twins with a map, and cache each page's own doubts. That makes the cost
proportional to the one page that changed. Expected: under 5 ms at 300 pages.

### 2. Each page waits for the previous page's save (from the code)

`apply()` awaits `persist()`, and commits are chained, so page N+1 cannot
appear until page N has finished saving. A save is at least three round
trips in series: upload the whole book file, upsert the chapter row, update
the book row. In a batch, pages reach the screen at the speed of the saves,
not the speed of the reads, and "Listen" waits with them.

Fix: show the page as soon as it is read and let saving trail behind.
Collapse queued saves so only the newest state is written (ten pages arriving
in a burst need one or two saves, not ten).

### 3. Deleting or inserting a page sends one request per later page (measured count)

A chapter row stores its position, so removing page 3 of 200 changes 197
rows, and they are updated one request at a time, in series. Measured plan:
47 updates for a 50-page book, 197 for 200. At ~150 ms each that is about
30 s of "Saving…" for one delete, during which finding 2 blocks everything
else. Filing a missed page into the middle does the same.

Fix: send the moves as one bulk upsert of `id, name, start_page, end_page`
(needs checking against the chapter-immutability rule: it must not touch
`text_content`), or run them in parallel chunks.

### 4. The model is probably thinking before it reads (from the code + sources)

The transcriber sends no reasoning setting. Google's docs say thinking is on
by default for Gemini 2.5 Flash and that a budget of 0 gives the lowest
latency. The other default, `google/gemini-3-flash-preview` on OpenRouter,
also reasons by default. A transcription needs none of it.

Fix: turn thinking off (or to minimum) for this one call on both routes, and
log the thinking-token count once to confirm it took. Forum reports say the
setting is ignored on some model versions, so it has to be verified.

### 5. Nothing shows until the whole page is written (from the code + sources)

The call is non-streaming. Published speeds for 2.5 Flash are about 0.5 s to
the first token and about 220 tokens/s, so a 600-900 token page is 3-4 s of
silence before anything appears. `streamChat` already exists in both adapters.

Fix: stream, put `body` early in the JSON, and show the text as it arrives.
With Listen on, speak the first full sentence while the rest is still coming.

### 6. Photos are bigger than the model can use (measured size + sourced formula)

A 2000 px page is a 1.09 MB data URL in the test (a noisy synthetic image, so
treat it as an upper bound). On phone upload speeds that is 1-3 s per page.
Gemini's documented tiling shows a 3:4 page costs the same 1,032 tokens at
1536 px as at 2000 px, and the model sees about 1536 px on the long side
either way. At 1536 px and quality 0.8 the same photo was 446 KB.

Fix: 1536 px, quality about 0.8. Needs an accuracy check on real small-print
pages before it ships; the published floor for dense text is around 150 ppi,
and 1536 px on a 6x9 in page is about 170.

### 7. Preparing a photo blocks the screen for a moment (measured)

`preparePagePhoto` decodes, scales, encodes and blur-checks on the main
thread: 355 ms total with a 220 ms freeze per photo at 4x throttle, and three
run back to back in a batch. Trying the "modern" calls on the main thread was
no better (1,053 ms, 279 ms freeze), so the gain only comes from a real Web
Worker.

Fix: move it into a worker (`createImageBitmap` with resize → `OffscreenCanvas`
→ `convertToBlob`). The photo still never leaves memory.

### 8. The camera asks for a 4K preview (from the code, not measured)

`PaperCamera` requests 3840x2160 video, then uses `takePhoto` for the still
where it exists. Chrome's docs say `takePhoto` interrupts the stream and
reconfigures the camera, which is the slow path, and a 4K live preview is
heavy for a phone to draw. If 1536 px is enough for the model (finding 6), a
1080p-1440p stream and a grabbed frame would be instant.

Fix: try a lower preview resolution with frame grab, and compare sharpness
against `takePhoto` on a real phone before choosing.

### Smaller things

- The whole book file is re-uploaded on every save: 163 KB at 100 pages,
  487 KB at 300. Finding 2's save collapsing removes most of this.
- `AppContext`'s value is a new object on every render, so each save
  re-renders every mounted `useApp()` consumer. Only matters in Counsel.
- Retries after a rate limit wait a fixed 4/10/20 s; the provider's own
  retry hint is not used.

## Experimental ideas

| Idea | Evidence | Verdict |
|---|---|---|
| Auto-shutter: watch the preview, fire when the page turn settles | CamScanner and ScanSnap do this; an arXiv paper (2411.00576) does it on-device | Worth a prototype. Frame differencing on a tiny frame is cheap. Hands-free scanning is the biggest possible speed-up |
| Two-page spread, split in the app, read as two parallel calls | Each page gets half the pixels; gutter curve is worst | Try only with full-resolution stills |
| Hedged request: if no first token by the usual worst case, fire a second call and take the winner | "The Tail at Scale": large tail-latency cut for ~2% extra calls | Cheap to add once streaming exists; spends the reader's tokens |
| Flash-Lite as a "fast" reader | ~20% faster output; one informal test found extra character errors | Opt-in only, after a test on real pages |
| OCR-specialist models (PaddleOCR-VL, olmOCR, Mistral OCR) | Lead the photographed-document benchmarks, far ahead of general models | Promising for accuracy; hosting and browser access with the reader's own key are unconfirmed |
| On-device OCR draft (Tesseract.js, PaddleOCR.js) | No phone timings; reports of 3.5-10 s a page | Slower than a streamed cloud reply. Skip as a draft; maybe as a legibility check |
| Several pages in one model call | ReadBench: double-digit accuracy drops | Do not |

## Suggested order

1. Findings 1, 2, 3: pure code, no accuracy risk, testable in the lab. These
   are the lag that gets worse the longer someone scans.
2. Findings 4 and 5: thinking off, then streaming. Need one real key to verify.
3. Findings 6, 7, 8: need a real phone and real pages to judge.
4. Auto-shutter prototype.

## Sources

- Gemini image tokens, thinking, media resolution, caching: aistudio.google.com/docs (image-understanding, thinking, media-resolution, caching)
- Output speed: artificialanalysis.ai/models/comparisons/gemini-2-5-flash-lite-vs-gemini-2-5-flash
- Thinking budget ignored: discuss.ai.google.dev/t/…/80149 and …/106422
- OCR vs resolution: arxiv.org/abs/2503.23667, arxiv.org/html/2603.23511v1
- OCR model benchmarks: arxiv.org/pdf/2606.03264, arxiv.org/html/2510.19817v1, arxiv.org/html/2605.07492
- Models rewriting what they read: alphaxiv.org/abs/2607.21617
- Multi-page accuracy drop: arxiv.org/html/2505.19091v1
- takePhoto vs grabFrame: developer.chrome.com/blog/imagecapture
- Page-turn capture: blog.camscanner.com (2025-11-10), arxiv.org/html/2411.00576v1
- Hedged requests: research.google/pubs/pub40801
- Response-time limits: nngroup.com/topic/response-time; streaming wait study: arxiv.org/pdf/2604.06183
