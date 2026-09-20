# The BookWorm — a companion sprite in Counsel

Shipped on `new1`. The app has been called BookWorm since the first commit and
has never had one. This is it: a small procedurally-animated caterpillar docked
at the bottom-right of the Counsel transcript that reacts to the conversation,
including to the actual waveform of the text-to-speech voice.

> **Redrawn flat.** The first worm was an outlined mint cartoon: dark contour,
> eye-whites, pupils, catchlights, a specular blob, segmentation rings, glasses
> worn permanently. It was cute and it looked like clip-art. The engine
> underneath — springs, lip-sync, blink timing — was untouched; the drawing was
> replaced. See [The flat redraw](#the-flat-redraw).

No new dependencies. **6.2 KB gzipped** for the whole sprite system (geometry +
animator + mood ladder + voice tap); there is no Lottie, no Rive, no
framer-motion, and no image asset.

## Files

| File | What it is |
|---|---|
| `src/lib/sprite/wormGeometry.ts` | Pure, time-free. Numbers in, shapes out. |
| `src/lib/sprite/wormAnimator.ts` | Springs, impulses, blink/gaze scheduling, the mood table. |
| `src/lib/sprite/wormMood.ts` | Pure priority ladder from conversation state to mood. |
| `src/lib/sprite/voiceTap.ts` | `AnalyserNode` on the TTS audio element. |
| `src/components/BookWorm.tsx` | Mounts the SVG once, then paints attributes. |
| `src/components/PocketScreen.tsx` | The hands-free guard; hosts a dimmed second worm. |
| `src/lib/sprite/pocketCaption.ts` | Pure: which line the pocket screen shows. |
| `src/hooks/useBookWorm.ts` | Wires it to ChatPanel; owns all edge detection. |
| `scripts/worm{Sheet,Film,Moods,Sizes,Reel}.ts` | Offline render harnesses — the drawing loop. |

Touched elsewhere, minimally: one `attachVoiceTap(audio)` in `useReadAloud.ts`
where the audio element is created, one `relative` + one element in
`ChatPanel.tsx`, and a `Companion` row in `CounselToolsSheet.tsx`.

## The flat redraw

One clay colour in two tones, one dark ink, nothing else. No outline, no
gradient, no highlight, no eye-whites.

- **No contour.** The old outline existed so a mint body would survive both a
  near-black and a paper theme. A mid-luminance terracotta sits about as far
  from one as from the other, so the silhouette survives with nothing drawn
  round it — and losing the outline is most of the distance from clip-art to
  something that looks designed.
- **The eye is one dark pill** — a round-capped stroke, two points and a width.
  The old eye was a 5 px white disc, a 3 px pupil and a 1 px catchlight: three
  shapes fighting over nine pixels. The pill loses no acting. Gaze moves the
  whole eye, surprise makes it taller *and* a touch wider, a squint shortens it,
  a blink collapses it into a curved lash line that bends with the smile.
- **The head is a squircle** (superellipse, n = 2.7), slightly landscape, so the
  eyes can sit far apart. A circle is a ball on a stick.
- **The segments moved into the silhouette.** Six overlapping beads in
  alternating tones, like cut paper, replace rings inked over a tube. A
  0.74-radius core tube underneath stops daylight opening between beads on the
  outside of a hard curl.
- **The glasses are a gesture.** They come out for `read` and `watch` and are
  pushed down from the forehead on the file's one deliberately *underdamped*
  spring (ζ = 0.62), so they overshoot and seat. The lens tint is drawn *under*
  the eyes and the frames over them, so the eyes stay the darkest ink.
- **A brow bug surfaced.** The brow's sign was backwards from its own doc
  comment, so `listen` — brows *raised* — had been rendering as a furious V
  since it shipped. Thin strokes on a busy face hid it. A frown now tilts, a
  raise *lifts*, and a small raise is not drawn at all.

### The body is a delay line

The one thing here nobody could hand-animate. The smoothed voice envelope that
drives the jaw is also written into a 120 Hz ring buffer, and each bead reads it
back later than the one in front — 45 ms at the neck, 320 ms at the tail, fading
as it goes. A spoken syllable leaves the mouth and then visibly *travels down
the body*: the worm is a slow oscilloscope of its own voice, and the shape it
makes is different for every sentence it will ever say.

- Fixed-rate writes, so the wave's speed does not depend on refresh rate
  (tested at 120 / 60 / 30 fps).
- A hard floor returns **exactly** zero below 0.004, or the tail of the
  exponential release would stop a settled worm ever being byte-identical frame
  to frame and the rAF loop would never stop.
- `think` sends slow pulses the *other* way, tail to head — a thought arriving
  rather than one leaving. They are multiplied by the motion budget directly;
  easing them out through a spring overran SC 2.2.2's five seconds by 700 ms,
  and the settle test caught it.
- Zero under reduced motion; clamped where consumed, so a clipped sample cannot
  inflate a bead.

### On the pocket screen, the face costs no light

With no contour to brighten, the dim palette inverted: the body is a dim ember
(`#3B2117`) and the eyes and mouth are pure `#000` cut out of it — on an OLED,
literally unlit pixels. Every other feature on that screen spends brightness to
be seen; the face spends none and is the most legible thing on it. Frames go
*lighter* than the body, because they overhang the head and a black frame on a
black screen is no frame.

## The three decisions that shaped it

### 1. It is a still drawing that reacts, not a loop that runs

WCAG 2.2 **SC 2.2.2 Pause, Stop, Hide (Level A)** requires a mechanism to pause,
stop or hide motion that starts automatically, lasts more than five seconds and
sits in parallel with other content. A mascot beside a chat transcript is the
textbook case, and the "essential" exemption does not reach it — the same warmth
is achievable with static art, which defeats the second clause of the
definition. 2.2.2 is a **non-interference** criterion: failing it fails the whole
page. `prefers-reduced-motion` alone does **not** satisfy it ([w3c/wcag#3766](https://github.com/w3c/wcag/issues/3766)).

So every oscillation is multiplied by a motion budget that reaches exactly zero
**4.8 s** after the last conversational event. `WormAnimator.isSettled()` then
lets the component stop scheduling `requestAnimationFrame` outright.

Two research findings say this is also simply the better design:

- **Abrams & Christ (2003)**, *Psych Science* 14(5) — motion *onset* captures
  attention; continuous motion does not. A companion that moves only at real
  conversational beats costs the reader less than one that idles forever.
- **Simola et al. (2011)**, *J Exp Psych: Applied* — animated content beside a
  text column measurably damages reading, and proximity to the text makes it
  worse. **Zhang (2000)**, *JAIS* 1(1) — *brightly coloured* animation hurts
  more than dull, which is why the palette is desaturated.

There is also a persisted, keyboard-reachable **Companion** toggle in the tools
sheet, because Android derives `prefers-reduced-motion` from one OS switch that
pre-Android-9 devices never report at all.

### 2. The mouth is driven by the real audio

Counsel has two speech engines. The Inworld path decodes MP3 into a single
long-lived `<audio>` element fed from a same-origin `blob:` URL — not
CORS-tainted, so `createMediaElementSource` + `AnalyserNode` can read the
samples. `speechSynthesis` output never enters the page's audio graph at all
(open WICG issue), and its `boundary` events are broken on Android Chrome
(crbug 40715888), so that path falls back to a synthetic syllable envelope.

- `fftSize` **1024** (21 ms window, 47 Hz bins), `smoothingTimeConstant` **0.1**,
  not the 0.8 default — which is a ~75 ms EMA at 60 fps and would put the mouth
  ~96 ms behind the sound before a pixel moved.
- Jaw from **RMS of the time domain** — no FFT needed. Mouth *width* from the
  ratio of 1500–4000 Hz to 300–1500 Hz energy, every other frame.
- Envelope follower: **20 ms attack, 90 ms release**. Symmetric smoothing turns
  speech into one sustained mumble.
- No visual anticipation. ITU-R BT.1359 puts detection at 125 ms for a *late*
  mouth but 45 ms for an *early* one, and Android output latency (up to ~150 ms)
  already pushes this tap toward early.

### On the browser voice, word events drive the mouth

`speechSynthesis` output never enters the page's audio graph, so there is
nothing to measure — but there *is* something to listen for. `useReadAloud` was
binding `u.onboundary` straight to a heartbeat bump and dropping the events.
They now feed `noteWordBoundary(charLength)`, which pins the mouth to real word
onsets: you notice a mouth that opens at the wrong *time* long before you notice
one making the wrong *shape*.

`charLength` is the only hint the event gives about how long a word takes to
say, so it sets how long the mouth stays busy — "a" and "extraordinarily" should
not produce the same shape. Inside a word, a ~5.4 Hz carrier articulates the
syllables; after it, a fast decay and then silence, which is what makes the gaps
between words read as gaps. Sentence boundaries are skipped, or the worm would
gape once per sentence.

It degrades in one step. Boundary events are reliable on desktop Chrome, broken
on Android Chrome (crbug 40715888), and absent on network voices — so if none
has arrived in 1.5 s the envelope falls back to a free-running syllable rhythm.
That decision is made from whether an event actually showed up, never from
sniffing the browser.

### On the pocket screen

`PocketScreen` is the hands-free touch guard: a near-black full-screen overlay
that arms after 12 s untouched, for a phone sitting in a pocket with the mic
live. The worm appears there too, mapped straight off the hands-free FSM
(`listening → listen`, `thinking → think`, `speaking → speak`), with the mouth
still driven by the live voice and an acknowledgement blink at each spoken
clause.

Four things make it defensible on a screen whose entire job is to be dark and
inert:

- **It cannot eat the double tap.** No `onPet` is passed, so no shape opts into
  hit testing and every touch reaches the overlay's own handler. That gesture is
  the only way out of the guard; a worm that swallowed it would strand the user
  on a black screen.
- **It is dimmed, not merely shrunk — and opaque.** `DIM_WORM` overrides the
  creature's CSS variables down to a dim ember with the **face cut out in pure
  black** (see above). The contact shadow is set transparent: it is not
  standing on anything out there.

  Those values are flat hex, not `rgba()`. They started as rgba at 0.15 alpha,
  which made the head a piece of tinted glass — the body tube ran visibly
  straight through the face, because the head is a separate ellipse drawn over
  it and a see-through fill occludes nothing. **The offline render harness never
  showed it**, because that harness composites colours over black to build its
  SVG: the thing being looked at was opaque while the thing shipping was not.
  Flattening them against this screen's black is exact (the overlay is `#000`)
  and costs an OLED nothing — a dark opaque pixel and a dark translucent one
  over black draw the same power.
- **It stops.** The motion budget runs out 4.8 s after the last event, so a
  phone in a pocket with nothing happening shows a still image with no frame
  loop running.
- **The glyph stays.** The worm is decorative and `aria-hidden`; the
  mic/thinking glyph is the only explicit "is it listening to me" signal on that
  screen, and that is not a question to answer in mime.

> **The bubble is gone.** The caption was a grey rounded box with an accent
> stripe, in a cold blue-grey unrelated to the clay worm above it. On a pure
> black screen a box is a second, slightly-less-black rectangle: lit pixels
> spent drawing a container round text that needed none. The text now sits on
> the black itself in a warm ink from the worm's own hue (~6.4:1), its edges are
> two fades, the state is said in a word beside the avatar ("Speaking") rather
> than only as a glyph, and the way out is said once at the foot. The user's
> own line is set right, dimmer, with one hairline on the text. Everything
> below about *behaviour* — persistence, drag-scroll, the double tap — is
> unchanged.

Under the worm sits a **caption**, and its job is reading — you hear an
answer and then read it back without unlocking the phone and returning to the
app. So the reply **persists**: it stays up until the next turn genuinely
replaces it, and it is the whole message.

The first version showed only the sentence currently being spoken. It advanced
prettily with the voice and was wrong — it vanished the instant the audio ended,
which is the exact moment you want to read it. The ladder (in `pocketCaption.ts`,
pure and tested) is now:

| State | Bubble |
|---|---|
| listening | the live interim transcript |
| thinking | the question waiting on an answer |
| otherwise | the newest assistant message, **in full** — covers speaking *and* every quiet moment after |
| no reply yet | the user's own last line |

Details that matter:

- **It is not clamped, and it owns the screen.** With a reply up the layout
  switches: the worm shrinks from 132 px to an 84 px avatar at the top, the way
  a name sits above a message, and the bubble becomes a full-height scroll box
  at 16 px with relaxed leading. Centring the reading layout on a big worm spent
  half a phone on decoration while the text scrolled in a letterbox.
- **A chevron appears when there is more below.** Drag-scrolling is invisible by
  default, so the screen has to say so; it goes away at the end.
- **Markdown is rendered readable** by `plainText()`, deliberately *not*
  `stripMarkdownForTts` — that one flattens every newline to `". "`, which is
  right for a speech engine and destructive for something being read.
- **Drag to scroll, by hand.** The overlay is `touch-none` and `touch-action`
  cannot be re-enabled by a descendant, so native scrolling is unavailable in
  there; `scrollTop` is moved from `pointermove` instead. A press that travels
  less than 8 px still counts as a tap, so the bubble never becomes a dead zone
  where the double-tap escape stops working.
- **It follows a streaming reply only while already at the bottom**, so dragging
  up to re-read stops the following, and dragging back down resumes it — no
  "user took control" flag to fall out of sync.
- **Keyed on the message id, not the text.** Keying on the text replayed the
  entrance fade on every streamed token, which strobed the whole bubble.

It deliberately avoids the app's `.message-bubble-*` classes: those carry
per-theme overrides that paint a 3 px fully-saturated cyan or magenta edge,
which is the one thing this screen exists not to have. It copies the asymmetric
corner and sets every colour itself, at roughly 5.7:1 on black — legible without
lighting up a screen meant to be off. It is `aria-hidden` (ChatPanel's live
region behind the overlay already announces the transcript).

The guard itself is now a setting — **Settings → Voice & Speech → Pocket
screen** (`hands_free_pocket_screen`), defaulting **on**, because it shipped
before it was a setting and an absent key has to read as enabled or existing
users silently lose it.

`PocketScreen` reports its armed state up so ChatPanel drops the transcript's
worm while the guard is up — otherwise two animators run, one of them behind an
opaque overlay.

Four colour variables (`--worm-spec`, `--worm-brow`, `--worm-frame`,
`--worm-shadow`) exist for exactly this: on black the defaults collapse, since a
near-black frame vanishes wherever it overhangs the head and a paper-coloured
lens flash is the brightest thing on a screen meant to be off.

### Tap to pet

The worm reacts to being touched: a squash, a nod, a blink on contact, and a
brief smile-and-squint laid over whatever pose it is already in. Three taps
inside 2.5 s earn a bigger reaction than three spread out — the difference
between being greeted and being fussed over.

Two details carry it:

**It is a reaction, not a mood.** Petting is a moment. Routing it through the
mood ladder would mean it outranked whatever the conversation was actually
doing; as a stack of impulses, the worm can be delighted while still thinking.

**Only its own ink is tappable.** The `<svg>` and its wrapper are
`pointer-events: none` and exactly two fills — body and head — opt back in, so
the target is the creature's silhouette rather than its bounding box. A tap one
pixel outside goes through to the message behind it, and so does a tap on the
eyes or glasses, which stay `none` and let the hit fall through to the head.
This leaves a target under SC 2.5.8's 24×24, which is a deliberate trade: the
only way to enlarge it is to start swallowing taps meant for the transcript,
which is the worse harm and falls on everybody rather than on a hidden extra.

The tap fires on **pointer-up past a movement threshold**, never on pointer-down
— this repo has paid for that lesson once already, in the composer's prompt
switcher, and the worm sits exactly where a thumb lands to start a scroll.

> **`createMediaElementSource` reroutes the element.** From that call its audio
> reaches the speakers only through the graph you build. `voiceTap.ts` connects
> `ctx.destination` *first*, before the analyser exists, so a later failure
> costs a still mouth and never silent audio. There is a test asserting that
> order.

### 3. The idle behaviour is measured, not invented

| Behaviour | Value | Source |
|---|---|---|
| Blink rate: rest / speaking / reading | 17 / 26 / 5 per min | Bentivoglio et al. 1997, *Mov Disord* 12(6), n=150 |
| Inter-blink interval | log-normal, not Poisson | ibid.; Cruz et al. 2010 |
| Lid phases | open 2–3× slower than close | Kwon et al. 2013, *J R Soc Interface*, 600 fps |
| Blink at a clause end | +20–50 ms, ~15% long (≥410 ms), long ones paired with a nod | Hömke, Holler & Levinson 2017, *RLSI* 50(1) |
| Blink after a topic change | 400–600 ms | Nakano et al. 2009, *Proc R Soc B* 276 |
| Blink on being touched | immediate | people blink when touched; so does this |
| Breathing | 0.24–0.31 Hz, inhale:hold:exhale ≈ 1.2:0.5:1.0 | Live2D `CubismBreath`; TalkingHead |
| Non-looping idle | incommensurate oscillator periods (6.5345 s, 3.5345 s…) | Live2D |

The worm therefore blinks **least** while reading a streaming reply and **most**
while speaking, which is backwards from intuition and correct. Microsaccades are
deliberately *not* simulated: under one degree is sub-pixel here, and faking them
needs a flicker rate above where sway stops reading as sway.

## Two bugs worth remembering

**The springs exploded.** Semi-implicit Euler diverges once
`dt > 2 / (ω(ζ + √(ζ²+1)))`. For the gaze spring (k = 2600) that threshold is
**16.2 ms**, and a 60 fps frame is 16.67 ms — unstable on every single frame,
with `lookX` reaching 6e11. Invisible in a filmstrip because the pupil offset
clamps. Caught only by asserting the animator comes to rest. `Spring.to()` now
substeps to a provably stable `h`.

**Reduced motion had a warm-up.** The wave spring was seeded at the mood's
amplitude and eased to zero, showing a reduced-motion user about a second of
undulation they had asked not to see. It is now zero from frame one, and
`setReduced(true)` mid-session cancels what is in flight rather than easing out.

## How it was drawn

`scripts/wormSheet.ts`, `wormFilm.ts` and `wormMoods.ts` render poses and
filmstrips straight from the shipped `poseWorm`, to SVG, rasterised with
`rsvg-convert`. That loop is why the first version — a smooth tapered tube — was
thrown away: with one continuous silhouette there is no neck, so there is no
head, so there is no character, only a vegetable with eyes. The head is now a
separate, deliberately oversized ball.

`wormSizes.ts` renders every mood at the four sizes that actually ship (52, 64,
84, 132 px) on the darkest and lightest grounds — a drawing that only works
zoomed in does not work. `wormReel.ts` steps the real animator through a whole
scripted turn in both the daylight and pocket palettes, for the things that
only exist over seconds: the travelling syllable, the glasses going on.

`wormMoods.ts silhouette` renders the moods as flat black shapes. At 64 px the
face is 20 px and nobody reads an expression — they read a shape, and that test
is brutal about which moods are actually distinguishable.

## Known limitations

- Amplitude-driven lip sync is **Inworld-only**. The browser voice gets
  word-onset timing from `boundary` events instead, which is accurate in *when*
  the mouth moves but not in *what shape* it makes — and on Android Chrome,
  where those events are broken, it falls back to a plausible rhythm that does
  not match the words at all. At 64 px, driving a 20 px mouth, none of this is
  visible; a motionless mouth would be.
- Petting has no keyboard equivalent. It is decorative and `aria-hidden`, and
  nothing is conveyed or achieved by it, so there is nothing to miss.
- The worm overlays the bottom-right of the transcript. It is
  `pointer-events: none` so it can never eat a tap, but it can visually overlap
  a long assistant bubble.
- Headless Chromium does not drive `requestAnimationFrame`, so the browser probe
  used during development verified mounting, refs, attribute painting and both
  themes — **not** the animation loop. Loop and settling behaviour are covered
  at unit level in `src/test/bookWorm.test.ts`.
