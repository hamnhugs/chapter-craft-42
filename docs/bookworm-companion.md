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

- Amplitude-driven lip sync is **Inworld-only**. With the browser voice the
  mouth moves on a plausible rhythm that does not match the words. At 64 px,
  driving a 20 px mouth, this is not visible; a motionless mouth would be.
- The worm overlays the bottom-right of the transcript. It is
  `pointer-events: none` so it can never eat a tap, but it can visually overlap
  a long assistant bubble.
- Headless Chromium does not drive `requestAnimationFrame`, so the browser probe
  used during development verified mounting, refs, attribute painting and both
  themes — **not** the animation loop. Loop and settling behaviour are covered
  at unit level in `src/test/bookWorm.test.ts`.
