# Mobile-friendly Voice settings

## Problem

In `src/components/VoiceChat.tsx`, the settings panel (lines 464–526) is rendered as an inline `<div>` shoved between the toolbar and the messages list. On mobile (647px viewport):
- No close button — the only way to dismiss is to scroll back up and tap the gear icon again.
- It pushes the chat content out of view.
- Inputs and the model list overflow horizontally on narrow widths.
- No safe-area padding, no drag affordance, no backdrop.

## Solution: bottom-sheet pattern (2026 best practice)

Modern mobile settings UIs use a **bottom sheet** with: drag handle, sticky header with title + close (X), scrollable body, safe-area inset padding, swipe-down-to-dismiss, and a scrim/backdrop. On desktop, the same content stays as a side panel or modal.

The project already ships `vaul` via `src/components/ui/drawer.tsx`, which is the standard React bottom-sheet primitive (used by shadcn). We'll reuse it.

### Changes to `src/components/VoiceChat.tsx`

1. **Replace the inline `{showSettings && (...)}` block** with a `<Drawer open={showSettings} onOpenChange={setShowSettings}>`:
   - `DrawerContent` already provides the drag handle (the small pill at the top) and swipe-to-close via vaul.
   - Wrap with a `DrawerHeader` containing:
     - `DrawerTitle`: "Settings"
     - A `DrawerClose` button rendered as an icon button (X) in the top-right — explicit close affordance, large 44×44 hit target.
   - Body: keep the existing three sections (API key, Model, Deep Research, Custom Instructions) but inside a scrollable container with `max-h-[85vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]`.
   - On desktop (≥`md`), the drawer still works but we cap width: add `md:max-w-2xl md:mx-auto` to `DrawerContent`.

2. **Responsive grid tweaks** inside the sheet:
   - Change the API-key/model grid from `grid-cols-1 lg:grid-cols-2` to single column on mobile (already is) but reduce padding (`p-3` instead of `p-4`) and ensure `min-w-0` so long model strings wrap.
   - Make the model chip list use `flex-wrap` + `break-all` to prevent overflow.

3. **Escape-key + backdrop dismiss** come for free from vaul.

4. **No behavior change** to the rest of the Voice page; the gear button still toggles `showSettings`.

## Technical notes

- Import the existing primitives:
  `import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerClose } from "@/components/ui/drawer";`
- Close button: `<DrawerClose asChild><Button variant="ghost" size="icon" aria-label="Close settings"><X className="h-5 w-5" /></Button></DrawerClose>`, positioned absolute top-right inside the header.
- The drag handle in `drawer.tsx` is already rendered automatically.
- Keep all existing state (`promptDraft`, `apiKey`, `selectedModel`, etc.) untouched — only the wrapper changes.
- No CSS/token changes; the sheet uses `bg-background` which already matches the editorial theme.

## Out of scope

- Chat tab settings panel (already has its own close fix from previous turn).
- No changes to the actual settings fields or persistence.
