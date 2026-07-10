import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

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
