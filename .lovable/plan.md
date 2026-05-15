# Fix: UI blank on custom domain

## Problem
The app is configured to be served from a subpath (`/chapter-craft-42/`) because of the GitHub Pages deploy. On `bookwormstudio.com` and `bookwormlibrary.lovable.app`, the app is served from the root (`/`), so the HTML loads but every asset URL (`/chapter-craft-42/assets/...`) 404s — resulting in a blank page.

## Changes

1. **`vite.config.ts`** — change `base: "/chapter-craft-42/"` to `base: "./"` (relative). This makes the same build work at root and at a subpath, so both Lovable hosting and GitHub Pages keep working.

2. **`src/main.tsx`** — update the service-worker registration path from `/chapter-craft-42/sw.js` to `./sw.js` (or `/sw.js` on Lovable). The existing kill-switch SW already unregisters itself, so this is just to avoid a 404 on the custom domain.

3. **`public/manifest.json`** and **`android/app/src/main/res/raw/web_app_manifest.json`** — keep `start_url`/`scope` as `/chapter-craft-42/` only if the Android TWA depends on it. For the web manifest served from the custom domain, change `start_url` and `scope` to `/` so "Install app" works on `bookwormstudio.com`. The Android raw manifest stays pinned to the GitHub Pages URL.

4. **`index.html`** — change `<link rel="manifest" href="/manifest.json" />` (already root-relative, fine) and icon hrefs to relative paths (`./icons/...`) so they resolve on both deployments.

## Result
- `bookwormstudio.com` → loads correctly
- `bookwormlibrary.lovable.app` → loads correctly
- GitHub Pages at `/chapter-craft-42/` → still works
- Android TWA → unchanged (still points to GitHub Pages URL)

## After deploy
You'll need to click **Update** in the Publish dialog for the custom domain to pick up the fix.
