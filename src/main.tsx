import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
// Workspace stylesheets. These are NOT cosmetic and each one fails silently if
// it is missing — no console error, no build error, just a broken layout:
//   viewport   → `.h-app` (Index.tsx's height authority) and the `--cc-vvh` /
//                `--cc-vv-top` :root defaults. Missing ⇒ `height: auto` and the
//                soft keyboard covers the drawer.
//   resize     → the splitter's hit area and hairline. Missing ⇒ a 0 px target.
//   overlay    → safe-area insets, the `--cc-ws-w` pre-JS default, scroll
//                containment. Missing ⇒ controls under a landscape sensor
//                housing and pull-to-refresh reachable behind the drawer.
//   typography → the 78ch measure cap and the report heading hierarchy.
//                Missing ⇒ widening the panel only grows the line length.
// They load after index.css on purpose: index.css is the Tailwind entry, and
// these override utilities from it.
import "./styles/workspace-viewport.css";
import "./styles/workspace-resize.css";
import "./styles/workspace-overlay.css";
import "./styles/workspace-typography.css";

/**
 * `ResizeObserver loop completed with undelivered notifications` is benign per
 * spec — the observation is simply retried on the next frame — but browsers
 * dispatch it as a window `error` event at ERROR severity. That trips catch-all
 * handlers, surfaces a red overlay in dev, and has been observed to abort an
 * in-progress pointer drag. Both WorkspaceShell and WorkspacePanel run a
 * ResizeObserver, so swallow it here.
 *
 * Installed FIRST, before anything else registers an `error` listener, because
 * `stopImmediatePropagation` only outranks listeners added after this one.
 *
 * It is swallowed, not ignored: a runaway loop is a real bug, so the count is
 * kept and a warning still lands once the noise passes the threshold.
 */
// cc:ro-loop-filter:start
// Deliberately plain JavaScript between these two markers — no type
// annotations, no `as`. `src/test/workspaceIntegration.test.ts` extracts this
// exact region and EXECUTES it against a fake window, which is the only way to
// prove the filter swallows what it should and passes through what it should
// not. Keep it TypeScript-syntax-free or that test stops being able to run it.
function installResizeObserverLoopFilter(target, warn) {
  const RO_LOOP = /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/;
  const WARN_AFTER = 5;
  let count = 0;
  target.addEventListener(
    "error",
    (event) => {
      const message = event && typeof event.message === "string" ? event.message : "";
      if (!RO_LOOP.test(message)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      count += 1;
      // Once on crossing the threshold, then sparsely: enough to expose a
      // genuine runaway without re-creating the spam we are here to stop.
      if (count === WARN_AFTER + 1 || count % 100 === 0) {
        warn(
          "ResizeObserver loop notifications swallowed " +
            count +
            "x - a resize handler may be writing layout synchronously.",
        );
      }
    },
    true,
  );
  return function resizeObserverLoopCount() {
    return count;
  };
}
// cc:ro-loop-filter:end
installResizeObserverLoopFilter(window, (m) => console.warn(m));

// Service worker handling: skip in Lovable preview/iframe contexts to avoid stale shells.
if ("serviceWorker" in navigator) {
  const isInIframe = (() => {
    try { return window.self !== window.top; } catch { return true; }
  })();
  const host = window.location.hostname;
  const isPreviewHost =
    host.includes("lovableproject.com") ||
    host.includes("lovable.app") ||
    host.includes("id-preview--");

  if (isInIframe || isPreviewHost) {
    // Unregister any previously installed SWs and clear their caches.
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister().catch(() => {}));
    });
    if (window.caches) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
  } else {
    // Production: load the kill-switch SW so previously-cached devices recover.
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("sw.js")
        .catch((err) => console.warn("SW registration failed:", err));
    });
  }
}

// Supabase OAuth can return either tokens or errors in the URL fragment.
// HashRouter would interpret those fragments as routes and render 404,
// so normalise them BEFORE the router reads location.
const rawHash = window.location.hash;
if (/^#(?!\/)/.test(rawHash)) {
  const body = rawHash.slice(1);
  const params = new URLSearchParams(body);

  if (params.get("access_token") && params.get("refresh_token")) {
    // Implicit-flow token return (e.g. Google sign-in landing on the custom
    // domain). Hand tokens to Supabase, then clean the URL to #/ so the app
    // renders the authenticated landing page instead of 404.
    const access_token = params.get("access_token")!;
    const refresh_token = params.get("refresh_token")!;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
    import("@/integrations/supabase/client").then(({ supabase }) => {
      supabase.auth.setSession({ access_token, refresh_token }).catch((err) => {
        console.warn("Failed to hydrate session from URL fragment:", err);
      });
    });
  } else if (/(^|&)(error|error_code|error_description)=/.test(body)) {
    // Surface OAuth errors on the auth page instead of 404.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#/auth?${body}`,
    );
  }
}

createRoot(document.getElementById("root")!).render(<App />);
