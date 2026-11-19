# Paper books: read a physical book with the app

2026-11-19 · branch `new1`

Hold a paper book, snap the page you are on, and either have it read aloud or
talk it over with Counsel. Every page you add builds the book in the Library,
filed under **Unfinished** with its own card, and you can pick it up again
from any device.

## What it does

| Where | What |
| --- | --- |
| Read tab | A paper book that is still being scanned opens on the **scanning desk** instead of the reader. Three controls under the thumb: **Listen · Snap page · Ask**. |
| Start | Read tab with no book ("Read a paper book"), the reader's **More** menu, or Library → the arrow beside Add books → **Scan a paper book…**. |
| Listen | Reads the page aloud in the voice Counsel uses, highlights the word, and keeps going as new pages arrive. A sentence that runs over the page turn is held and spoken whole when the next page lands. At the end of what is scanned it says "Turn the page and snap the next one" and the shutter pulses. |
| Ask | Takes the book so far to Counsel with a draft "About p. 47 of “Title”: ". Counsel gets a **Snap the next page** strip above the composer, so pages can be added without leaving the chat. |
| Library | A pinned **Unfinished** tab (only there when something is unfinished). The card has a stitched frame, loose sheets behind it, an "Unfinished" ribbon, a camera badge and "12 pages · last p. 57". Its menu says **Keep scanning**. |
| Many at once | **Upload** beside Snap (and "Upload several photos at once" on the start screen) takes any number of photos. They wait in a queue, three are read at a time, and one row shows "Reading page 4 of 12…" with **Cancel the rest**. Pages are filed in the order the photos were taken, whichever read finishes first. |
| Resume | Opening an unfinished book lands on its last page. The start screen lists other unfinished books under "Pick up where you left off". |
| Finish | Book options → **Finish this book**: it leaves Unfinished and opens in the normal reader (Contents lists every page, highlights and Listen work). More → **Add more pages** reopens it. |

## Photos are thrown away

A page photo is one in-memory JPEG from the shutter until its words have been
read off it. It is released when the page is committed, when the model says it
is unreadable, when the reader discards it, and on leaving the screen. The one
case where it is kept past its first read is a failure the reader can retry
(no connection, a busy provider), because then it still has a use.

Nothing is uploaded to storage and nothing is written to the device. The page
model has no field that could hold a photo. Three tests in
`src/test/paperBook.test.ts` ("photos are never stored") fail if a later edit
adds storage to the engine or an image upload to the save layer.

The single image a paper book can keep is a small cover thumbnail, and only
when the reader photographs the cover on purpose. The photo itself goes to the
vision model of the reader's own key (Gemini or OpenRouter) and nowhere else.

## How it is built

| File | Role |
| --- | --- |
| `src/lib/paperBook.ts` | The model, pure: page shape, where a new page goes, the book file, chapters, speech across the page turn. |
| `src/lib/pagePhoto.ts` | Camera file → one in-memory JPEG (2000 px long edge) + a sharpness/exposure reading. |
| `src/lib/pageTranscribe.ts` | The prompt, the model pick, and the parser for the model's JSON. |
| `src/lib/paperStore.ts` | Saving: book file, chapter rows, book row. `PaperIOContext` swaps it out in the lab. |
| `src/hooks/usePaperScan.ts` | The engine: photo queue, ordered commits, serial saves, photo lifetime. |
| `src/components/PaperCamera.tsx` | The camera inside the app. |
| `src/components/PaperDesk.tsx` | The desk. `ReadTab.tsx` chooses desk or reader. `PaperScanChip.tsx` is the shutter in Counsel. |
| `src/lib/paperSession.ts` | "Start a paper book" / "add pages to a finished one" signals. |
| `src/styles/arena.css` | "Paper books" block: the card and the desk. |

No migration and no edge function. A paper book is an ordinary `.html` book
whose `books.source_context` is `{kind:"paper", status:"open"|"done", pages,
last_printed, author, total_pages}`. The HTML file is the one stored copy of
the pages (a `<section id="section-N">` each, which the reader's Contents
already scrolls to); the desk parses it back.

## Decisions and what they rest on

**The camera is inside the app.** The first version opened the phone's own
camera app for each page, on the grounds that it returns the sharpest still
([web.dev](https://web.dev/articles/media-capturing-images)). In use on
Android that failed the same day: with the camera app in front the browser is
in the background, the phone discarded the tab, and the reader came back to a
reloaded app on the Counsel tab with the photo gone. A live preview in the
page (`PaperCamera.tsx`) never leaves the page, so there is nothing to reload,
and it is one tap a page instead of three. It stays open between shots; pages
are read while the next one is framed. Where the browser can take a real still
(`ImageCapture.takePhoto`, Chrome Android only —
[caniuse](https://caniuse.com/imagecapture)) it does; elsewhere it takes a
frame of the preview, requested at up to 3840×2160. The lens is released when
the camera closes and whenever the app goes to the background.

The phone's camera app is still offered ("Use the phone's camera"), and is the
automatic fallback when the site's camera permission is blocked. Because that
route can still reload the app, the trip is marked in `sessionStorage`; a
reload in the middle of one lands back on the Read tab with a line saying the
photo was lost and a "Snap it again" button. The marker holds a timestamp, not
the photo. With a mouse the same button is a file picker ("Add a page photo");
drag and drop works.

**Verbatim transcription with named exceptions.** Vision models tidy what
they read. DAISY's 317-page test found silent typo and grammar fixes and one
changed surname, and a fidelity prompt cut that but did not end it
([DAISY](https://daisy.org/activities/projects/ai-special-interest-group/can-a-vision-llm-faithfully-transcribe-two-million-words/)).
The prompt here follows theirs: "verbatim, character for character", with the
only allowed departures listed (rejoin line-end hyphens, drop running heads
and page numbers, footnotes and figures reported separately, columns left
first). Unreadable text is written `[unclear]`, never guessed; the desk marks
it and offers a retake. A reply that is not the JSON asked for becomes "no
text found", not a page of the model's prose.

**Structured output, one consumer each.** Speech reads the body only. Counsel
also gets figure notes and footnotes, with a `[p. 47]` marker it can cite. The
page number orders the book and labels the card.

**One chapter row per page, never rewritten.** The app's rule is that chapter
text does not change under its id, because saved cards point into it by
offset (`docs/stage2-card-pointers.md`, `chapterImmutability.test`). So a
page's id is its chapter row's id: adding a page is one insert, a retake is a
new row replacing the old one, and a card made from page 47 still points
there after page 300. Cost: a long book has a long chapter list.

**A queue, three at a time.** A photo waiting in line is only the reader's
own file handle; it is decoded when its turn comes. Three are in flight at
once because each decoded photo is about half a megabyte and each read is a
model call: fifty at once would be fifty megabytes and a rate limit. A "busy"
answer from the provider is waited out (4 s, 10 s, 20 s) before the reader is
told anything. A photo that fails the blur check steps out of the line and
waits for "Use anyway" or "Retake"; the rest go on.

**Order.** Capture order, except: the same printed number again is a retake
and replaces in place; a lower number than one already in the book is filed
before it. Small skipped runs are mentioned ("Not scanned: p. 43–44").

**Warn, do not block.** Blur is the variance of a 3×3 Laplacian on a 640 px
copy; published thresholds run from 100 to 400
([pyimagesearch](https://pyimagesearch.com/2015/09/07/blur-detection-with-opencv/),
[Dynamsoft](https://dynamsoft.com/codepool/quality-evaluation-of-scanned-document-images.html)),
so this one is set low (60) and always offers "Use anyway". Dark frames and
glare are caught the same way. The threshold has not been tuned on real pages.

**No dewarping or cropping.** OpenCV.js is about 30 MB for a four-corner
crop, and no browser library flattens a curved page. Whether vision models
make it unnecessary is unproven; it was left out until real pages say
otherwise.

**No percentage unless the length is known.** The card shows pages in and the
last page number. Book options → Name and length takes the book's page count,
and only then does a meter appear (Material and Apple both reserve determinate
progress for measurable work).

**Messages above the bar, not toasts.** The app's toasts rise from the bottom
of the screen, which on the desk is the shutter.

Copyright: the start screen says "For your own use, with books you own." This
is not legal advice; personal format-shifting is treated differently by
country.

## Checked

- `npx tsc -p tsconfig.app.json --noEmit` clean; `npx vite build` builds.
- `npx vitest run`: 123 files, 2,750 tests pass. `src/test/paperBook.test.ts`
  (35) covers ordering, retakes, the HTML round trip, chapter planning, speech
  across the page turn, the parser, the model pick, the photo checks and the
  no-storage guards.
- `node docs/paper-books/shoot.mjs` drives the real desk through the lab
  (`#/arena-lab?paper`, `&resume`) in headless Chromium at 360×740, 956×506
  and 476×506: 21 checks each, all passing (`shots/results.json`). It covers
  the blurry warning, first page, three pages landing in order, a spread, an
  offline retry, an unreadable shot, the cover naming the book, the Library
  tab and card, Keep scanning, Ask and the Counsel strip, Finish, and resume.

- `node docs/paper-books/shoot-camera.mjs` drives the in-app camera with
  Chromium's fake camera: Snap opens it without a file chooser, two shots in a
  row both become pages, the page never reloads, and a forced reload in the
  middle of a camera-app trip shows the recovery line once.
- `node docs/paper-books/shoot-batch.mjs`: twelve photos at once give one
  progress row, never more than three reads in flight, twelve pages in the
  order given although the reads finish out of order, and "Cancel the rest"
  keeps what is in. Sorting a scrambled pick by time taken is unit-tested.

## Not checked

- **A real page through a real model.** The lab uses a stand-in that returns
  fixture pages. The prompt, the JSON it returns and how well it reads a
  curved or badly lit page have not been tried against Gemini or OpenRouter.
- **The in-app camera on a real phone**: focus, sharpness of the result, the
  light button, and iOS.
- **Signed in.** Creating the book, the storage write, chapter rows and
  `source_context` have only run against the lab's in-memory stand-in.
- **Real speech.** Headless Chromium has no voice. Word highlight timing and
  the carried sentence were tested as text, not heard.

## Not built

- Auto-capture when the page is steady, and edge detection in the live preview.
- How sharp a preview frame is on an iPhone, where there is no real still to take.
- Editing a page's text by hand.
- Reordering pages by hand, or scanning from a document feeder PDF.
- Keeping page photos, by design.
