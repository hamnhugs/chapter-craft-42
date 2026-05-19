## Make memory guide link pop + slim down New Wiki button

### 1. Animate the "How the memory system works" link (WikiLibrary.tsx)

Currently it sits as a muted accent link below the quote — easy to miss. Upgrade it to a small pill chip with:
- Background tint (`bg-accent/10`), accent border, slight shadow so it reads as an interactive call-to-attention rather than body text.
- Continuous **subtle pulse glow** (custom keyframe on the ring/shadow) so the eye catches it without being noisy.
- A **gently bouncing/shimmering icon** (HelpCircle or Sparkles) — small horizontal nudge or rotation loop.
- Hover: scale-105 + brighter background (uses existing `hover-scale` utility pattern).
- Respect `prefers-reduced-motion`: animation disabled via Tailwind's `motion-safe:` prefix.

Add one keyframe + animation entry to `tailwind.config.ts` (e.g. `pulse-glow`) since the existing `pulse` class is too aggressive.

### 2. Shrink the "New Wiki" button without shrinking its text

Reduce padding only — keep `font-bold` text at its current `text-sm`-equivalent size:
- `px-6 py-3` → `px-4 py-2`
- Icon `Plus` from `w-5 h-5` → `w-4 h-4`
- Keep label text, shadow, color, active:scale-95 behavior.

### Files touched
- `src/components/WikiLibrary.tsx` — link markup + button padding.
- `tailwind.config.ts` — add `pulse-glow` keyframe + animation.

No features removed. No backend or routing changes.
