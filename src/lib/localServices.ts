// Addresses of the local edition's services. The values live in
// /local-services.json so the CSP (vite.config.ts), these clients and
// scripts/local-up.sh can never disagree about a port.
import services from "../../local-services.json" with { type: "json" };

export interface LocalServices {
  ollama: string;
  supabase: string;
  searxng: string;
  tts: string;
  stt: string;
  images: string;
  /** The craft bridge (scripts/local-ai/craft-bridge.mjs). */
  crafts: string;
  /** GPU power for Local AI (scripts/local-ai/control.mjs). */
  control: string;
}

export const LOCAL_SERVICES: LocalServices = services as unknown as LocalServices;

/** True when this build talks to a Supabase running on this machine. */
export function isLocalBackend(): boolean {
  const url = String(import.meta.env.VITE_SUPABASE_URL || "");
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
}
