import { useSyncExternalStore } from "react";

/**
 * The link to Equilibrium, Manny's calendar.
 *
 * Equilibrium works out a "health" number, 10 to 100, from how much of the
 * schedule is actually getting done, and its worm wears it: sparkling when it
 * is high, in a slouched cap with stubble when it is low. This reads the same
 * number so the worm here looks exactly as it does there.
 *
 * It is one HTTP GET with a key the person pasted in. Nothing is sent to
 * Equilibrium but that key, and nothing of this app's is shared with it. The
 * link lives in this browser only (localStorage), like the other per-device
 * preferences; with no link the worm is simply its plain self.
 */

const LINK_KEY = "cc.equilibrium.link";
const HEALTH_KEY = "cc.equilibrium.health";
/** Health moves over days, so a few minutes stale is nothing. */
const REFRESH_MS = 5 * 60 * 1000;
/** A number older than this is not shown: better a plain worm than a wrong one. */
const STALE_MS = 3 * 24 * 60 * 60 * 1000;

export interface EquilibriumLink {
  /** Equilibrium's address, no trailing slash. */
  url: string;
  key: string;
}
export interface WormHealth {
  health: number;
  label: string;
  at: number;
}

/** Read a pasted link code: `eqw1.` then base64url of {"u": address, "k": key}. */
export function parseLinkCode(code: string): EquilibriumLink | null {
  const m = /^eqw1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const raw = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { u?: unknown; k?: unknown };
    if (typeof raw.u !== "string" || typeof raw.k !== "string") return null;
    const url = new URL(raw.u);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    if (!/^eq_[A-Za-z0-9_-]{8,}$/.test(raw.k)) return null;
    return { url: url.origin, key: raw.k };
  } catch {
    return null;
  }
}

function read<T>(k: string): T | null {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

let cached: WormHealth | null = read<WormHealth>(HEALTH_KEY);
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getLink(): EquilibriumLink | null {
  return read<EquilibriumLink>(LINK_KEY);
}

export function setLink(link: EquilibriumLink | null): void {
  try {
    if (link) localStorage.setItem(LINK_KEY, JSON.stringify(link));
    else {
      localStorage.removeItem(LINK_KEY);
      localStorage.removeItem(HEALTH_KEY);
    }
  } catch {
    /* private window */
  }
  if (!link) cached = null;
  emit();
  if (link) void refreshHealth();
}

/** Ask Equilibrium now. Resolves to an error sentence, or null when it worked. */
export async function refreshHealth(): Promise<string | null> {
  const link = getLink();
  if (!link) return "Not linked.";
  if (inFlight) return null;
  inFlight = true;
  try {
    const res = await fetch(`${link.url}/api/v1/health`, { headers: { authorization: `Bearer ${link.key}` } });
    if (res.status === 401) return "Equilibrium did not accept the code. Make a new one there.";
    if (!res.ok) return `Equilibrium answered ${res.status}.`;
    const body = (await res.json()) as { health?: unknown; label?: unknown };
    if (typeof body.health !== "number") return "Equilibrium sent no health number.";
    cached = { health: body.health, label: typeof body.label === "string" ? body.label : "", at: Date.now() };
    try {
      localStorage.setItem(HEALTH_KEY, JSON.stringify(cached));
    } catch {
      /* private window */
    }
    emit();
    return null;
  } catch {
    return "Could not reach Equilibrium.";
  } finally {
    inFlight = false;
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!timer && typeof window !== "undefined") {
    void refreshHealth();
    timer = setInterval(() => void refreshHealth(), REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && (!cached || Date.now() - cached.at > 60_000)) void refreshHealth();
    });
  }
  return () => listeners.delete(l);
}

const snapshot = () => cached;

/** What Equilibrium last said, or null when unlinked or too old to trust. */
export function useEquilibriumHealth(): WormHealth | null {
  const v = useSyncExternalStore(subscribe, snapshot, () => null);
  return v && Date.now() - v.at < STALE_MS ? v : null;
}

/** The number to hand the worm: undefined leaves it plain. */
export function useWormHealth(): number | undefined {
  return useEquilibriumHealth()?.health;
}

/** `#eq=<code>` on arrival: Equilibrium's "Open Bookworm Studio with it" button. */
export function takeLinkFromHash(hash: string): boolean {
  const m = /^#eq=(eqw1\.[A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return false;
  const link = parseLinkCode(m[1]);
  if (link) setLink(link);
  return !!link;
}
