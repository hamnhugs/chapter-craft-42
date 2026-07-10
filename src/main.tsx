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

// Supabase auth returns some redirect errors in the URL fragment
// (#error=...&error_description=...). HashRouter would parse that as a route
// and render the 404 page. Rewrite it to #/auth?<params> before the router
// reads the location so the auth page mounts and surfaces the message.
const rawHash = window.location.hash;
if (/^#(?!\/)/.test(rawHash) && /(^#|&)(error|error_code|error_description)=/.test(rawHash)) {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#/auth?${rawHash.slice(1)}`,
  );
}

createRoot(document.getElementById("root")!).render(<App />);
