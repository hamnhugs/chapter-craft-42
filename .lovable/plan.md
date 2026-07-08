# Add intro video to the login page

Place the provided YouTube video (`1Cgc0kXEv-4`) on `src/pages/Auth.tsx` in a way that feels native to the existing editorial/glass aesthetic, works on mobile and desktop, and follows current embed best practices.

## Best-practice research summary

- **Use `youtube-nocookie.com`** with `rel=0` and `modestbranding=1` — privacy-enhanced mode, no related videos from other channels, cleaner UI. Google/EU GDPR guidance + YouTube's own docs recommend this for sites that embed marketing videos.
- **Do NOT autoplay with sound** (Chrome/Safari block it and WCAG 2.2.2 forbids uncontrolled motion). Autoplay is only acceptable muted; here we'll keep it click-to-play so the login form stays the primary action.
- **Responsive 16:9 wrapper** using Tailwind's `aspect-video` (modern replacement for the old padding-bottom hack).
- **Lazy load** via `loading="lazy"` on the iframe so it doesn't compete with auth JS on first paint.
- **Accessibility**: real `<iframe title>`, `allow` list trimmed to what's actually needed (no `autoplay` since we're not autoplaying), keyboard-focusable, and a visible caption above the frame for screen-reader context.
- **Layout**: on desktop, form stays centered and primary; video sits below the form inside the same glass panel width so the eye lands on Sign In first (F-pattern / primary-action-first, per NN/g login-page guidance). On mobile it stacks naturally under the form.

## Changes

**File:** `src/pages/Auth.tsx`

1. Widen `max-w-md` → `max-w-md` for the form but wrap form + video in a single `max-w-md` column so nothing shifts. (Keeps current visual hierarchy.)
2. Below the existing glass-panel `<section>` (the sign-in card), add a new sibling block:
   - Small uppercase eyebrow label: "Watch the intro".
   - `<div class="aspect-video rounded-xl overflow-hidden border border-outline-variant/10 shadow-lg bg-black">` containing the iframe.
   - Iframe attributes:
     - `src="https://www.youtube-nocookie.com/embed/1Cgc0kXEv-4?rel=0&modestbranding=1"`
     - `title="Bookworm Studio intro"`
     - `loading="lazy"`
     - `referrerPolicy="strict-origin-when-cross-origin"`
     - `allow="clipboard-write; encrypted-media; picture-in-picture; web-share; fullscreen"`
     - `allowFullScreen`
     - `className="w-full h-full"`
3. No changes to auth logic, no new deps, no schema changes.

## Out of scope

- Autoplay, custom thumbnail/lite-youtube-embed component, or moving the video into a two-column split (can revisit if you want it side-by-side on desktop).
