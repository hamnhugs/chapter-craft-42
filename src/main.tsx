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

createRoot(document.getElementById("root")!).render(<App />);
