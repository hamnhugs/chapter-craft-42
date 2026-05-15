I checked the preview at desktop and mobile sizes: the UI is rendering now, but the browser is reporting a broken manifest path with a duplicated `/chapter-craft-42/` segment. This project also registers a service worker unconditionally, which can leave phones stuck on a stale or blank cached shell.

Plan:

1. Stop preview/mobile cache lockups
   - Update the service-worker registration so it does not register inside Lovable preview/iframe contexts.
   - Unregister any existing service workers in preview so stale cached shells stop being served.

2. Clean up stale installed caches safely
   - Replace `public/sw.js` with a temporary kill-switch service worker that clears old caches, refreshes open clients, and unregisters itself.
   - This is the safest way to recover devices that already registered the old worker.

3. Fix the manifest path error
   - Change the manifest/icon references so they resolve to the correct base path instead of `/chapter-craft-42/chapter-craft-42/...`.
   - Keep the app install metadata intact, but avoid paths that break the preview.

4. Verify after changes
   - Check desktop and mobile preview again.
   - Confirm there are no blank screens and no manifest/service-worker errors blocking the UI.