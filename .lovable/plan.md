# Mobile bottom navigation — redesign

## Problems with the current bar
- 7 equal items overflow on small screens (Voice is clipped at 414px and below).
- Active item uses a wide rounded-pill that expands the cell, breaking equal spacing.
- Labels are uppercase 10px with widest tracking — dated and hard to read.
- No `env(safe-area-inset-bottom)` respect → on iPhones with a home indicator, items sit too low.
- Extra "fruit-stripe" decorative bar on top of nav adds noise.

## Modern bottom-nav references (2025)
- **Material 3 Navigation Bar**: 3-5 destinations, ~80dp tall, pill indicator *behind the icon only* (not the whole item), label below in sentence case (12sp). Items are equal-width. Overflow → secondary surface.
- **Apple HIG Tab Bar**: max 5 tabs; use a "More" tab when there are more destinations; respect safe-area inset; subtle press feedback only.
- **Linear/Arc/Vercel patterns**: blurred floating bar, soft shadow, no harsh borders, single-color active state with a thin top indicator or pill behind icon.

## Plan

### 1. Cap visible items at 5, move the rest to a "More" sheet
Primary tabs (most-used): **Library, Reader, Chapterize, Chat, More**.
"More" opens a bottom Sheet (shadcn `Sheet` from `side="bottom"`) containing **Wiki, Video, Voice** with the same icon+label treatment but larger tap targets. Selecting one closes the sheet and activates the tab.

The 5-item cap is enforced only on the mobile bar; desktop nav stays unchanged (all 7 tabs).

### 2. Replace the item visual
- Equal-width flex children (no scale on active — kills cell width consistency).
- Pill indicator (rounded-full, `bg-accent/15`, h-8 w-14) sits **behind the icon only**, centered.
- Active icon: `text-accent`, FILL=1 (already supported via material-symbols variation).
- Inactive icon: `text-secondary`, no fill.
- Label: sentence case ("Library", "Reader"…), `text-[11px] font-medium`, no uppercase, no tracking-widest, `text-accent` when active, `text-muted-foreground` otherwise.
- Vertical layout: icon row (h-8) + label row, ~4px gap.
- Tap feedback: `active:scale-95` on the icon only, 120ms ease.

### 3. Bar container
- Height auto (~64px) plus `pb-[env(safe-area-inset-bottom)]`.
- Remove `rounded-t-2xl` heavy shadow; use a single soft top border `border-t border-border/60` and `bg-background/85 backdrop-blur-xl` for the floating-glass feel.
- Drop the extra `<StripeBar>` above the nav on mobile (keeps the cleaner look). Theme accent already conveys the brand.
- Keep `z-50` so it sits over content; remove the now-unneeded `bottom-20` stripe.

### 4. "More" sheet
- shadcn `Sheet` opens from the bottom.
- Grid of 3 large tiles (icon top, label below), each 96px tall, rounded-2xl, `bg-card`, active tile gets accent ring.
- Header: "More" with a small grabber bar.

### 5. Files touched
- `src/pages/Index.tsx` — split tabs into `primaryTabs` (4) + `moreTabs` (3), rewrite the `<nav data-mobile-nav>` block, add a `MoreSheet` subcomponent or inline it.
- No new dependencies; `Sheet` already exists at `src/components/ui/sheet.tsx`.
- No changes to `AppContext`, routes, or business logic.

### 6. Verification
- Resize browser to 360, 390, 414, 480px — confirm no clipping, equal-width items, label visible.
- Check active states, More sheet open/close, safe-area padding on a tall viewport.

## Out of scope
- Desktop nav (unchanged).
- Theme switcher / Sign out in the header (unchanged).
- Reordering or renaming tabs beyond the primary/secondary split above — happy to adjust which 4 are primary if you want a different set (e.g. Library / Reader / Chat / Wiki).
