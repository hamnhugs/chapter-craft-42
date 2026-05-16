# Restore the Theme picker dropdown

## What happened
The full theme system (registry + dropdown switcher) was deleted at some point. My last change only added a basic dark/light icon — that's the "what the hell is that" you're seeing. I'll rebuild the original Theme menu.

## What I'll restore

1. **`src/lib/themes.ts`** — registry of stock themes with HSL tokens, fonts, and Google Fonts URLs. Restored themes:
   - **Dexter's Laboratory** — burnt red canvas, neon orange primary, CRT teal, Bungee + Space Grotesk
   - **Fruit Stripe (Chapter Craft)** — paper white, ink black, rainbow accents, DM Serif Display + Inter + JetBrains Mono
   - **Amber Editorial** — current default (warm cream/amber, Playfair + Inter) as the baseline so nothing visually regresses

2. **`src/context/ThemeContext.tsx`** — `ThemeProvider` that writes CSS variables + `data-theme` to `:root`, loads the theme's Google Fonts, and persists the selection to `localStorage` (key `cc-theme`).

3. **`src/components/ThemeSwitcher.tsx`** — header dropdown (palette icon) listing each theme with a color swatch + name + description; check mark on the active one.

4. **`src/App.tsx`** — wrap the app in `<ThemeProvider>`.

5. **`src/pages/Index.tsx`** — replace the sun/moon button I just added with `<ThemeSwitcher />` next to Sign out. Nothing else in the header changes; Sign out, nav tabs, and mobile bottom nav stay exactly as they are.

6. **`tailwind.config.ts` / `src/index.css`** — wire `fontFamily` and tokens to CSS variables so theme swaps actually change colors and fonts app-wide. Existing Fruit Stripe scoped CSS block (sticker shadows, rainbow stripe bar, etc.) will be re-added under `[data-theme="fruit-stripe"]`.

7. **`src/components/fruit-stripe/StripeBar.tsx`** + **`ZebraEdge.tsx`** — rebuilt so the Fruit Stripe theme renders its signature rainbow accent under the header.

## Result
Palette icon in the header → dropdown opens → pick a theme → entire app instantly re-skins (colors + fonts). Selection persists across reloads. No existing features removed.

## Note
The earlier "Containment Lab" and "Dee Dee's Room" themes were intentionally removed by you in April and will stay out. If you want them back too, say the word and I'll add them.
