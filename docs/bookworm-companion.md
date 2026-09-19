# The BookWorm — a companion sprite in Counsel

Shipped on `new1`. The app has been called BookWorm since the first commit and
has never had one. This is it: a small procedurally-animated caterpillar docked
at the bottom-right of the Counsel transcript that reacts to the conversation,
including to the actual waveform of the text-to-speech voice.

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
| `scripts/worm{Sheet,Film,Moods}.ts` | Offline render harnesses — the drawing loop. |

Touched elsewhere, minimally: one `attachVoiceTap(audio)` in `useReadAloud.ts`
where the audio element is created, one `relative` + one element in
`ChatPanel.tsx`, and a `Companion` row in `CounselToolsSheet.tsx`.

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
- **It is dimmed, not merely shrunk.** `DIM_WORM` overrides the creature's CSS
  variables down to the status glyph's register, with the **contour brighter
  than the fill** — the inverse of the daylight scheme, because on black it is
  the edge that describes the shape, not the mass. Nearly every pixel stays off
  on an OLED, which is what this overlay is protecting. The contact shadow is
  set transparent: it is not standing on anything out there.
- **It stops.** The motion budget runs out 4.8 s after the last event, so a
  phone in a pocket with nothing happening shows a still image with no frame
  loop running.
- **The glyph stays.** The worm is decorative and `aria-hidden`; the
  mic/thinking glyph is the only explicit "is it listening to me" signal on that
  screen, and that is not a question to answer in mime.

Under the worm sits a **caption bubble** showing what is happening right now,
which during hands-free is a different thing in each state: the sentence being
spoken (chunk by chunk, so it advances in step with the voice), the live interim
transcript while the mic is open, or the question waiting on an answer while the
model works. Nothing between turns — a stale line is worse than an empty screen.

The ordering lives in `pocketCaption.ts` so it can be tested, and the bubble
deliberately avoids the app's `.message-bubble-*` classes: those carry per-theme
overrides that paint a 3 px fully-saturated cyan or magenta edge, which is the
one thing this screen exists not to have. It copies the asymmetric corner and
sets every colour itself, at roughly 5.7:1 on black — legible without lighting
up a screen meant to be off. It is `aria-hidden` (ChatPanel's live region behind
the overlay already announces the transcript) and `pointer-events: none`, so it
cannot swallow the double tap either.

The guard itself is now a setting — **Settings → Voice & Speech → Pocket
screen** (`hands_free_pocket_screen`), defaulting **on**, because it shipped
before it was a setting and an absent key has to read as enabled or existing
users silently lose it.

`PocketScreen` reports its armed state up so ChatPanel drops the transcript's
worm while the guard is up — otherwise two animators run, one of them behind an
opaque overlay.

Four colour variables (`--worm-spec`, `--worm-brow`, `--worm-frame`,
`--worm-shadow`) exist for exactly this: on black the defaults collapse, since
the catchlight shares a value with the eye it sits on and the glasses and brows
share one with the pupil.

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
