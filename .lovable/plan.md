## Goal : if You can instead create an option within the brain tab that would allow me to display all images and delete them from there, i think that would be best, and also allow me to delete multiple images at one time

&nbsp;

Add an **Images** button to the Counsel tab's toolbar (next to Files / Notes). Clicking it slides in a right‑side panel that shows every AI‑generated image from the current user's chats, with select + delete.

## UX (modeled on best practices: Gmail/Notion right‑rail, ChatGPT Library)

- Trigger: small toolbar button labeled `Images (N)` with an `image` icon, toggle state mirrors Files/Notes.
- Slide‑in `Sheet` from the right, width ~420px desktop / full‑width mobile, focus‑trapped, ESC to close, persistent close button.
- Header: title "Generated images", search input (filters by prompt/caption), and a "Select" toggle.
- Body: responsive 2‑col masonry grid of thumbnails using `GeneratedImage` (signed‑URL cached). Each tile shows truncated prompt, model badge, relative time, and hover/long‑press actions: open full‑size, copy prompt, delete.
- Multi‑select mode: checkboxes appear on tiles; sticky footer shows "Delete N" with a confirmation `AlertDialog`. Bulk delete runs in parallel with per‑item error toleration.
- Empty state: friendly illustration + "No images yet — ask Counsel to generate one."
- Loading: skeleton tiles. Error: inline retry.
- Deletes are optimistic with toast undo (5s window) — actual storage + DB removal fires after the undo timer.

## Technical plan

1. **New component** `src/components/ImagesPanel.tsx`
  - Props: `open`, `onOpenChange`, `onCountChange?`.
  - Uses `Sheet` (`side="right"`) from `@/components/ui/sheet` for the slide‑in.
  - Loads rows via existing `searchImages(query, 100)` from `src/lib/imageGen.ts` (already lists `image_attachments` newest‑first, with optional ilike on prompt/caption).
  - Renders thumbnails via the existing `<GeneratedImage storagePath caption />` so signed‑URL caching is reused.
  - Realtime: subscribe to `image_attachments` inserts/deletes for the current user so the panel stays live when Counsel generates new images.
  - Delete path: existing `deleteImageAttachment({ id, storage_path })` — already removes the storage object then the DB row. Bulk = `Promise.allSettled`.
  - Undo: hold a pending‑delete buffer; commit on toast dismiss, restore on click.
2. **Toolbar wiring in `src/components/ChatPanel.tsx**`
  - Add `imagesPanelOpen` state and `imagesCount` (kept fresh by panel callback).
  - Insert a new toolbar button right after the Notes button (~line 1335), matching the same `text-[10px] font-bold uppercase tracking-widest` styling and `aria-pressed` pattern.
  - Render `<ImagesPanel open={imagesPanelOpen} onOpenChange={setImagesPanelOpen} onCountChange={setImagesCount} />` alongside the existing right‑panels.
3. **No schema changes, no edge‑function changes, no new dependencies.** Everything is built on existing tables (`image_attachments`), existing helpers (`searchImages`, `deleteImageAttachment`, `getSignedImageUrl`), and existing shadcn primitives (`Sheet`, `Input`, `Checkbox`, `AlertDialog`, `Button`, toaster).

## Accessibility & polish

- Full keyboard navigation (arrow keys move focus across the grid, Space toggles select in select‑mode, Enter opens full‑size).
- `aria-label`s on every tile action; live region announces "N images selected".
- Respects `prefers-reduced-motion` for the slide animation.
- Uses semantic tokens only (no hardcoded colors), matching the warm cream/amber editorial theme.