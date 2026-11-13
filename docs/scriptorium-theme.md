# Scriptorium — the theme that keeps the hours

Sixth theme (`scriptorium`), added 2026-11-13 on `new1`. A monastery writing
room: vellum, iron-gall ink, vermilion rubrics, lapis, verdigris, gold leaf.
It was built to find out how far a theme can go, so most of it is things the
theme system could not do before. Those are general — any later theme can use
them — and are described first.

## What the theme system gained

| Capability | Where | What it is |
|---|---|---|
| **Living themes** | `ThemeDef.living` in `src/lib/themes.ts`, applied by `src/context/ThemeContext.tsx` | A theme may have more than one *face* (a set of token overrides) and a clock function, asked once a minute, that picks the face and may publish live CSS variables. The active face is `data-face` on `<html>`. The reader can pin a face from the theme menu or Settings → Appearance → Light (`cc-face:<themeId>` in localStorage). The season tints whichever face is showing. |
| **Ambient layer** | `src/components/themes/ThemeAmbient.tsx`, mounted once in `App.tsx` | A per-theme layer over the *whole app* (fixed, `pointer-events: none`, `aria-hidden`), for light and atmosphere that belong to the room rather than to any element. Returns `null` for themes without one. |
| **Theme turn** | `turn()` in `ThemeContext.tsx`, `.cc-theme-turn` in `src/index.css` | Changing theme, or a living theme changing face, is a view transition that opens the new look outward from where the reader last pressed. Applies to all six themes. Falls back to an instant change without the API or with reduced motion. |
| **Theme menu fits short windows** | `src/components/ThemeSwitcher.tsx` | The menu scrolls inside the height Radix reports as free and clamps descriptions to two lines. With five themes its last row was already off the bottom of a 956×506 window; a sixth would have been unreachable. |

## What Scriptorium does with them

- **Two faces, switched by the sun.** Daylight (ink on vellum) and Candle
  (vellum-coloured ink on brown-black). The candle is lit 15 minutes after
  sunset and snuffed 15 minutes before sunrise, from the same mid-latitude day
  length the Aurora theme uses. The faces are switched, never blended: halfway
  between them is grey on grey. The switch happens as a theme turn.
- **The room's light** (`ScriptoriumAmbient.tsx`). By day, sun through a
  two-light lancet window lies across the page, crosses it between sunrise and
  sunset, and goes long and amber toward evening. By night there is one candle
  and the reader carries it: the room is brightest around the pointer (or the
  last touch, or the field being typed in) and returns to rest when the pointer
  leaves the window. Over the reader (`[data-reader-bar]` present) the window,
  the amber and the dark all stand down — a book is not the theme's to light.
- **Gold that answers the light.** Gilded surfaces (primary buttons, the active
  dock tab, the wordmark's initial, switch thumbs, progress) paint a highlight
  fixed in viewport space at the light's position, so it slides across the gold
  as the light passes.
- **The app bar is the day** (`ScriptoriumArt.tsx`). A border vine sketched
  whole in leadpoint and inked by the clock, midnight to midnight, with a
  gilded bud at each of the eight canonical offices as it reaches them (kept in
  temporal hours, so Terce is later by the clock in winter). The sun rides its
  tip by day; by night the moon, in its real phase. The current office is the
  rubric after the wordmark. What the vine carries follows the season the app
  already keeps: blossom, gold and lapis, hips and turning leaves, bare ivy.
- **Typeset replies.** `.prose` has no styles anywhere else (the typography
  plugin is not installed). Here it gets a measure, leading, hedera bullets,
  rubricated numerals, a manicule on quotations, a fleuron for a rule, and a
  versal on replies long enough to have paragraphs. New bubbles are inked in.

## Rules it holds itself to

- **The light may not cost the text.** Every layer lies over the ink, so each
  one's peak alpha is a measured number (`LIGHT` in `scriptoriumHours.ts`), set
  where the faintest ink still clears WCAG AA under it. `src/test/scriptorium
  .test.ts` composites them and checks, and checks the stylesheet still uses
  the same numbers.
- **No property is animated on `:root`.** The first build published the light's
  position as two inherited custom properties on the root: 19 ms of style
  recalculation per frame on the Library. It is now written to the few gilded
  elements within reach of the glint. Measured over 240 pointer moves on the
  Library at 956×506 (dev build): 521 ms of style work by day, 800 ms by night,
  against 559 ms for Aurora. Idle, 114–123 ms per 3.8 s against Aurora's 194 ms.
- **No blend modes**, so nothing beneath the light is isolated into its own
  group. All frieze motion is on composited layers.
- **Reduced motion**: the light does not follow, nothing in the bar moves,
  bubbles are not inked in, and theme turns are instant.

## Looking at it

Dev server, then any lab route with `&hours=` on the query string (the art,
the ambient light and the face all read it; a pinned time does not advance):

    npx vite --port 8093 --strictPort
    http://localhost:8093/?hours=dusk#/arena-lab?library

`hours=day | vespers | dusk | night | matins | HH:MM | <ISO date>`

`#/arena-lab?chat` is new: the Counsel tab with a reply on it that has every
kind of prose in it.

## Files

- `src/lib/themes.ts` — tokens for both faces, `living`, `faceTokens()`
- `src/components/themes/scriptoriumHours.ts` — the horarium (pure) and `LIGHT`
- `src/components/themes/ScriptoriumArt.tsx` — the app-bar vine
- `src/components/themes/ScriptoriumAmbient.tsx` — the light
- `src/styles/themes/scriptorium.css` — the skin, the frieze, the light
- `src/test/scriptorium.test.ts` — hours, both faces' contrast, the light's limits

## Not done / not verified

- Not looked at on a real phone or in Safari. iOS ignores
  `background-attachment: fixed`, so there the glint will sit still or be
  absent and gold is plain leaf — a fallback, not a failure, but unseen.
- The user's own chat bubble (lapis ruled in gold) is styled but was not
  screenshotted: the lab cannot send a message without an API key.
