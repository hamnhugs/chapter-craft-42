/**
 * "Start a paper book" — the one bit of state that says the Read tab should
 * show the scanning desk even though no paper book is open yet. A module
 * store rather than app state because three unrelated places raise it (the
 * Library's add menu, the reader's empty state and its More menu) and one
 * place reads it.
 */
let starting = false;
/** The book a "new paper book" just became. Held so the desk that made it
 *  stays mounted while the app catches up and makes it the open book. */
let adopted: string | null = null;
/** A finished paper book the reader asked to add pages to. */
let resume: string | null = null;
const listeners = new Set<() => void>();

export const paperSession = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  isStarting: () => starting,
  adoptedId: () => adopted,
  start() { if (!starting || adopted) { starting = true; adopted = null; listeners.forEach((l) => l()); } },
  /** The new book exists: one change, so no render ever sees neither. */
  adopt(bookId: string) { starting = false; adopted = bookId; listeners.forEach((l) => l()); },
  resumeId: () => resume,
  /** Reopen a finished paper book on the desk. */
  resume(bookId: string) { resume = bookId; listeners.forEach((l) => l()); },
  clearResume() { if (resume !== null) { resume = null; listeners.forEach((l) => l()); } },
  end() { if (starting || adopted) { starting = false; adopted = null; listeners.forEach((l) => l()); } },
};

/**
 * A trip to the phone's own camera app.
 *
 * While that app is in front the browser is in the background, and a phone
 * short on memory may discard the tab: the reader comes back to a freshly
 * loaded app. The photo cannot be saved from that (and must not be stored
 * anyway), but the reader can at least be put back where they were and told
 * what happened. The marker lives in sessionStorage, which survives exactly
 * this kind of reload and nothing longer.
 */
const TRIP_KEY = "cc_paper_camera_trip";
const TRIP_MAX_MS = 15 * 60_000;
let lostShot = false;

export const cameraTrip = {
  begin(starting: boolean) {
    try { sessionStorage.setItem(TRIP_KEY, JSON.stringify({ at: Date.now(), starting })); } catch { /* no storage */ }
  },
  /** The page is still here, so the trip ended normally. */
  end() { try { sessionStorage.removeItem(TRIP_KEY); } catch { /* no storage */ } },
  /** Was the app reloaded in the middle of a trip? Does not clear it. */
  pending(): { starting: boolean } | null {
    try {
      const raw = sessionStorage.getItem(TRIP_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw) as { at?: number; starting?: boolean };
      if (!t.at || Date.now() - t.at > TRIP_MAX_MS) { sessionStorage.removeItem(TRIP_KEY); return null; }
      return { starting: !!t.starting };
    } catch { return null; }
  },
  /** Run once at startup: put the desk back and remember to say why. */
  recover(): boolean {
    const trip = cameraTrip.pending();
    if (!trip) return false;
    cameraTrip.end();
    lostShot = true;
    if (trip.starting) paperSession.start();
    return true;
  },
  /** True once, for the desk's "that photo was lost" line. */
  takeLostShot(): boolean { const v = lostShot; lostShot = false; return v; },
};
