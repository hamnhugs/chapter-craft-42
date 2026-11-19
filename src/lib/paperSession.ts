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
