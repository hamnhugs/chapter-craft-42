Three scoped fixes, Fruit Stripe theme only. No feature removal.

### 1. Move the rainbow stripe off the mobile menu

In `src/pages/Index.tsx`, the `<StripeBar>` inside the mobile bottom nav is positioned `absolute top-0`, which sits over the menu icons. Move it to render *just above* the mobile nav instead of inside it:

- Remove `<StripeBar>` from inside `<nav data-mobile-nav>`.
- Render `{isFruitStripe && <StripeBar thickness={4} className="md:hidden fixed bottom-20 left-0 right-0 z-50" />}` as a sibling so it sits as a thin band on top of the nav's upper edge without covering icons.

### 2. Make inactive mobile tabs readable on the paper background

In `src/index.css`, under `[data-theme="fruit-stripe"] [data-mobile-nav]`, add overrides so inactive tabs use Soft Charcoal (`#2A2A2A`) and active tab uses Cherry Red on a paper chip — Stripe Gray ink contrasts properly on paper:

```css
[data-theme="fruit-stripe"] [data-mobile-nav] button { color: var(--fs-charcoal); }
[data-theme="fruit-stripe"] [data-mobile-nav] button.bg-accent {
  background: var(--fs-cherry) !important;
  color: #fff !important;
  border: 1px solid var(--fs-ink);
  box-shadow: 0 2px 0 0 var(--fs-ink);
}
```

Also bump the desktop header's inactive `.text-secondary` to charcoal in Fruit Stripe for the same reason.

### 3. Fix dark book-cover placeholders in Library

In `src/components/Library.tsx`, the placeholder gradient is hard-coded dark warm tones plus a `from-black/80` overlay — wrong for paper theme. Make the placeholder theme-aware:

- Add `data-book-card` to the outer card div (also enables the existing rainbow underline hover from `index.css`).
- Replace the inline dark `linear-gradient(...)` with a class-driven background. In Fruit Stripe, scope a paper/stripe-gray placeholder:

```css
[data-theme="fruit-stripe"] [data-book-card] [data-book-cover-placeholder] {
  background: repeating-linear-gradient(135deg,
    var(--fs-paper) 0 14px,
    var(--fs-stripe-gray) 14px 28px) !important;
}
[data-theme="fruit-stripe"] [data-book-card] [data-book-cover-placeholder] .material-symbols-outlined {
  color: var(--fs-ink); opacity: 0.55;
}
[data-theme="fruit-stripe"] [data-book-card] [data-book-cover-overlay] { display: none; }
```

- Add `data-book-cover-placeholder` to the cover wrapper when there is no `coverImageUrl`, and `data-book-cover-overlay` to the dark gradient overlay so Fruit Stripe can hide it. Other themes keep their current dark look untouched.

### What stays the same

- ThemeSwitcher, all routes, upload/EPUB pipeline, chapter logic, chat/wiki/video/voice features — untouched.
- Other themes (Amber Editorial, Dexter's Lab) — unaffected; all changes are scoped under `[data-theme="fruit-stripe"]` or additive markup.
