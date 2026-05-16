# Prismatic Lab — Dexter's Lab Theme Overhaul

Replace the current Dexter's Lab theme (burnt red walls / Bungee headlines) with the "Prismatic Lab" direction from the attached `DESIGN.md` + `screen-2.png`. Deep violet canvas, Space Grotesk, holo-gradient accents, chunky 3px violet ink outlines, rivet panels, hazard stripes.

All changes are scoped under `[data-theme="dexters-lab"]` — no other theme is touched, no features removed.

## What changes

**1. `src/lib/themes.ts` — retune the `dexters-lab` token block**
- Keep `id`, `name`, `description` (description reworded to match new aesthetic).
- Swatch → `["#1a0b2e", "#bd00ff", "#00eefc"]`.
- Fonts → Space Grotesk for headline + body + display (single font load, drop Bungee).
- HSL tokens remapped to the Prismatic palette:
  - background `#1a0b2e`, foreground `#eddcff`
  - card / popover `#27183b`, surface ladder `#150629 → #3d2e52`
  - primary `#ecb2ff` (with `--primary-container` `#bd00ff`)
  - secondary `#d3fbff` (with `--secondary-container` `#00eefc`)
  - accent → magenta `#e7006e` (tertiary-container) for danger/CTA pops
  - destructive `#ffb4ab`, border `#150629` (deep-violet ink), ring `#00eefc`
  - `--viewer-bg` `#1a0b2e`, `--toolbar-bg` `#150629`, `--book-spine` `#bd00ff`

**2. `src/index.css` — add a `[data-theme="dexters-lab"]` scoped block** (mirrors the fruit-stripe pattern)
- CSS custom props for the palette + the holo-gradient + hazard stripe:
  - `--dl-ink: #150629`, `--dl-violet: #bd00ff`, `--dl-cyan: #00eefc`, `--dl-magenta: #e7006e`, `--dl-lemon: #f8d878`
  - `--dl-holo: linear-gradient(135deg, #bd00ff 0%, #00eefc 50%, #f8d878 100%)`
  - `--dl-hazard: repeating-linear-gradient(45deg, #bd00ff 0 10px, #150629 10px 20px)`
- Cards / surface containers / dialogs / popovers → 3px solid `--dl-ink` border, `4px 4px 0 var(--dl-ink)` block shadow, slight `backdrop-filter: blur(12px)`, rounded 0.25rem. Heavier shadow for dialogs.
- Buttons:
  - Primary / accent / destructive get the holo-gradient fill, 3px violet ink border, uppercase, cyan glow on hover (`0 0 18px rgba(0,238,252,0.45)`), press-down translate (active: `translate(2px,2px); box-shadow:none`).
  - Default buttons get the chunky outlined treatment.
- Inputs / textareas / selects → `#27183b` bg, 1px cyan bottom border, on `:focus` expand to 3px wrapping border in cyan.
- Top app header → `#150629` bg, 3px violet-ink bottom border, replace amber active-tab underline with a 4px holo-gradient bar (matches existing fruit-stripe `::after` technique).
- Mobile bottom nav → `#150629` bg, 3px violet-ink top border. Active tab uses magenta `#e7006e` chip with white text + 3px ink border + block shadow. Inactive uses `--on-surface-variant` (`#d4c0d7`) for readable contrast.
- Book card placeholders (`[data-book-card] [data-book-cover-placeholder]`) → hazard-stripe pattern, ink bottom border; icon tint cyan. `[data-book-cover-overlay]` stays visible but tinted violet so dark gradient blends with the theme instead of clashing.
- Chat bubbles → AI bubble left edge cyan `#00eefc`, user bubble right edge magenta `#e7006e`.
- Progress bars → holo-gradient with the same shimmer keyframes as fruit-stripe.
- Selection → `#bd00ff` bg, white text. Focus ring → 2px cyan, offset 2px. Scrollbar thumb → violet on `#150629` track, magenta on hover.
- Wordmark / `.font-display` → Space Grotesk 700, uppercase, `-0.04em` tracking, text-fill via holo-gradient with cyan drop-shadow for the "neon" headline treatment.
- Loading prose: keep default reader prose untouched (no width clamp for this theme — only fruit-stripe constrains it).

**3. No component edits required.** All existing markup hooks (`data-app-header`, `data-mobile-nav`, `data-book-card`, `data-book-cover-placeholder`, `data-book-cover-overlay`, `data-wordmark`, `.message-bubble-ai/user`, `[role="progressbar"]`, etc.) were already added during the fruit-stripe pass, so the new theme rides on the same selectors. Index.tsx, Library.tsx, ChatPanel.tsx, etc. are not modified.

## Out of scope
- Fruit Stripe and Amber Editorial themes — untouched.
- No new components, no feature additions/removals, no auth/db work.

## Verification after build
- Switch to Dexter's Lab via the palette switcher and visually confirm: header gradient active-tab, holo CTA buttons with press-down, magenta active mobile tab readable, library placeholders show hazard stripes, chat bubble edge colors, focus ring is cyan, no leftover Bungee references.
- Switch back to Amber Editorial and Fruit Stripe to confirm zero regression.
