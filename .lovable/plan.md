# Refine the Fruit Stripe theme to match the PRD

Bring the Fruit Stripe theme up to the spec in your uploaded PRD — exact brand colors, mid-century pop typography, and the three signature visual devices (Stripe Bar, Zebra Edge, Printed-Sticker cards).

## Changes

### 1. `src/lib/themes.ts` — update Fruit Stripe tokens
Replace approximate HSL values with the PRD's exact palette:
- Paper White `#FBFAF6` → background
- Ink Black `#111111` → text/borders/ring
- Soft Charcoal `#2A2A2A` → muted-foreground
- Stripe Gray `#E8E6DF` → dividers/muted surfaces
- Cherry Red `#E63946` → primary / destructive
- Orange Zest `#F4844D` → warning accents
- Lemon Yellow `#F4C95D` → selection/hover (accent)
- Lime Green `#6BBF59` → success
- Melon Pink `#EE7B9E` → AI/chat tone, badges

Typography: load `DM Serif Display` (wordmark/hero), `Inter Tight` (UI headings), `Inter` (body), `JetBrains Mono` (mono). Set `--font-headline` to Inter Tight and add `--font-display` for DM Serif Display (used by the Chapter Craft wordmark).

### 2. `src/components/fruit-stripe/StripeBar.tsx` — true diagonal stripe
Rewrite to render 5 equal segments **skewed ~12°** in order Cherry → Orange → Yellow → Lime → Melon (per PRD), with the exact hex values. Use SVG so the skewed segments render crisply at 4px height.

### 3. `src/components/fruit-stripe/ZebraEdge.tsx` — new
2px black-on-white horizontal stripes, 8px tall with 8px gap, configurable height and side (top/bottom/left/right). For empty states and sidebar footers.

### 4. `src/index.css` — Fruit Stripe scoped CSS block
Under `[data-theme="fruit-stripe"]`, add:
- **Printed-Sticker treatment**: `.bg-card`, `[role=dialog]`, popovers, library book cards → `border-radius: 12px`, `border: 1px solid #111`, `box-shadow: 0 2px 0 #111` (cards) and `0 4px 0 #111` (buttons/modals)
- **Button press**: active state translates +2px and collapses shadow
- **Reader body**: 1.65 line-height, 68ch max-width on the prose container
- **Selection**: yellow highlight (`#F4C95D` with ink-black text)
- **Focus ring**: 2px Cherry Red
- **Scrollbar**: ink-black thumb on paper-white track
- **Chat bubbles**: AI bubble gets a 3px Melon Pink left edge; user bubble gets a 3px Cherry Red right edge
- **Progress bar**: rainbow diagonal stripes for loading states
- **Active nav tab**: 4px Stripe Bar underline (replaces the amber bar)
- **Top header**: 1px ink-black bottom border + Stripe Bar below it (already wired via `<StripeBar />` in `Index.tsx`)

### 5. `src/pages/Index.tsx` — minor
- When Fruit Stripe is active, render the new diagonal StripeBar directly under the header (already there, will inherit new visuals).
- Apply `font-display` class to the "Chapter Craft" wordmark so it picks up DM Serif Display in this theme (still falls back to Newsreader in others).

### 6. Tailwind config — `font-display`
Already wires `display` to `var(--font-headline)`. Add a separate `--font-display` variable so the wordmark can use DM Serif Display while UI headings use Inter Tight in Fruit Stripe. Default themes keep both pointing at their existing serif.

## What I'm NOT changing
- Other themes (Amber Editorial, Dexter's Lab) are untouched.
- All non-theme functionality (chapters, chat, voice notes, library, auth) stays as is.
- The ThemeSwitcher dropdown stays the same; only the rendered output of Fruit Stripe changes.

## Result
Switching to Fruit Stripe in the palette dropdown produces the exact PRD aesthetic: paper white canvas, ink black structure, mid-century rainbow Stripe Bar under the header, sticker-shadow cards with crisp 1px borders, DM Serif wordmark, Inter Tight UI, and zebra-edge texture available for empty states.
