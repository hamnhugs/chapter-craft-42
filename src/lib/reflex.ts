import { useSyncExternalStore } from "react";

// "Reflex cues" — the lean salience layer (Phase 2). A UI/behavior preference,
// not knowledge, so it lives in localStorage (no migration) rather than
// user_settings. Default ON. When enabled: the chat assistant proactively flags
// contradictions with saved memory, and neuron cards show a cue when an entry is
// part of an open conflict. This is a convenience surface over the app's real
// conflict-detection mechanism — not a claim about neuroscience.

const KEY = "reflex-cues-enabled";
const listeners = new Set<() => void>();

function read(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}

export function isReflexEnabled(): boolean {
  return read();
}

export function setReflexEnabled(v: boolean): void {
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}

// Stable subscribe identity (module scope) so consumers don't re-subscribe on
// every render — useSyncExternalStore compares the subscribe fn by identity.
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) cb(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

/** Reactive read of the reflex toggle; syncs across tabs via the storage event. */
export function useReflexEnabled(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
