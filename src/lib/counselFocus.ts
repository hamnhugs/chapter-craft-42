// Counsel's FOCUS — what the assistant is discussing — as one pure reducer.
//
// Three layers make up the focus: the loaded BOOKS (a shelf or a hand-picked
// set, in bookContextStore), the READER's book (activeBookId — the Read tab),
// and the loaded NEURONS (activeWikiIds). Until docs/library-agent.md they
// had three unrelated writers, and "Chat with this shelf" left the previously
// opened book in the prompt, in the reading tools' scope and on screen while
// the block quietly omitted it — the user's report 1.
//
// Laws (docs/library-agent.md §1):
//  L1  A load REPLACES the loaded books. Loading a shelf or a set of books
//      swaps the selection. Loading a book from the Vault either replaces the
//      selection (the default) or opens the book ALONGSIDE it (the reader
//      only) — the user picks in the dialog; nothing is replaced silently.
//  L1' The READER is not the focus. A shelf load never closes the book the
//      user is reading; instead every read door derives the book Counsel
//      discusses through `focusBookId`: the reader's book when nothing is
//      loaded or when it is a member of the EFFECTIVE selection (excludedIds
//      honoured), else null. That is what keeps the prompt, the tools' scope
//      and the chips from ever carrying a book the block does not.
//  L3  Replacement is act-and-undo. Every writer bumps a focus EPOCH; an undo
//      captured at one epoch is refused once the epoch has moved, because a
//      snapshot restore over a later change would clobber it.
//  L4  ONE selector. The dialog, the picker's shelf switch, and the AI tool
//      all call `applyLoad`; they write each layer through its owner.
//
// The reducer is deliberately synchronous and pure (no store, no React): the
// callers own the async neuron write and its failure handling.

import {
  EMPTY_BOOK_SELECTION, isEmptySelection, selectContextBooks,
  type BookContextSelection,
} from "@/lib/chatBooks";
import type { BookDocument } from "@/types/library";

export interface FocusState {
  selection: BookContextSelection;
  activeBookId: string | null;
  /** Loaded neurons, primary first. */
  wikiIds: string[];
}

/** What the caller chose for the neuron layer. `keep` = the dialog's Skip. */
export type NeuronChoice =
  | { kind: "keep" }
  | { kind: "wiki"; id: string }
  | { kind: "chain"; ids: string[] };

export type LoadAction =
  | { kind: "shelf"; shelfId: string; neurons: NeuronChoice }
  | { kind: "books"; bookIds: string[]; neurons: NeuronChoice }
  /** A book from the Vault. `alongside` keeps the loaded books and only
   *  opens the reader; otherwise the selection is replaced (cleared — the
   *  reader's book rides on its own, out of the block, as it does today). */
  | { kind: "book"; bookId: string; neurons: NeuronChoice; alongside?: boolean }
  /** Unload everything Counsel discusses (the reader is untouched). */
  | { kind: "none"; neurons: NeuronChoice }
  /** A book was deleted: drop it from every layer it can appear in. */
  | { kind: "remove"; bookId: string };

export interface LoadOutcome {
  next: FocusState;
  /** Which layers actually changed — the toast and the tool narrate these. */
  changed: { selection: boolean; activeBookId: boolean; wikiIds: boolean };
}

/** Empty membership that CARRIES the mode (docs/library-agent.md §1:
 *  "mode survives an empty selection"). */
function emptyKeepingMode(prev: BookContextSelection): BookContextSelection {
  return prev.mode ? { ...EMPTY_BOOK_SELECTION, mode: prev.mode } : { ...EMPTY_BOOK_SELECTION };
}

function withMode(next: BookContextSelection, prev: BookContextSelection): BookContextSelection {
  return prev.mode && !("mode" in next) ? { ...next, mode: prev.mode } : next;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameSelection(a: BookContextSelection, b: BookContextSelection): boolean {
  return a.shelfId === b.shelfId && sameIds(a.bookIds, b.bookIds) && sameIds(a.excludedIds, b.excludedIds) && (a.mode ?? null) === (b.mode ?? null);
}

function nextWikis(prev: string[], choice: NeuronChoice): string[] {
  if (choice.kind === "keep") return prev;
  if (choice.kind === "wiki") return [choice.id];
  const ids = Array.from(new Set(choice.ids)).filter(Boolean);
  return ids.length > 0 ? ids : prev;
}

/** Which layers differ between two states — the shape `applyLoad` reports,
 *  reused by Undo (which restores `prev` over `next`). */
export function focusChanged(a: FocusState, b: FocusState): { selection: boolean; activeBookId: boolean; wikiIds: boolean } {
  return {
    selection: !sameSelection(a.selection, b.selection),
    activeBookId: a.activeBookId !== b.activeBookId,
    wikiIds: !sameIds(a.wikiIds, b.wikiIds),
  };
}

/**
 * The one reducer. Pure: returns the next state and which layers changed;
 * never touches a store. The caller writes each changed layer through its
 * owner (bookContextStore.set / setActiveBookId / applyActiveSet).
 */
export function applyLoad(prev: FocusState, action: LoadAction): LoadOutcome {
  let selection = prev.selection;
  let activeBookId = prev.activeBookId;
  let wikiIds = prev.wikiIds;

  switch (action.kind) {
    case "shelf":
      selection = withMode({ shelfId: action.shelfId, bookIds: [], excludedIds: [] }, prev.selection);
      wikiIds = nextWikis(prev.wikiIds, action.neurons);
      break;
    case "books": {
      const ids = Array.from(new Set(action.bookIds)).filter(Boolean);
      selection = ids.length > 0
        ? withMode({ shelfId: null, bookIds: ids, excludedIds: [] }, prev.selection)
        : emptyKeepingMode(prev.selection);
      wikiIds = nextWikis(prev.wikiIds, action.neurons);
      break;
    }
    case "book":
      activeBookId = action.bookId;
      if (!action.alongside) selection = emptyKeepingMode(prev.selection);
      wikiIds = nextWikis(prev.wikiIds, action.neurons);
      break;
    case "none":
      selection = emptyKeepingMode(prev.selection);
      wikiIds = nextWikis(prev.wikiIds, action.neurons);
      break;
    case "remove": {
      const id = action.bookId;
      if (activeBookId === id) activeBookId = null;
      if (prev.selection.bookIds.includes(id) || prev.selection.excludedIds.includes(id)) {
        const bookIds = prev.selection.bookIds.filter((x) => x !== id);
        const excludedIds = prev.selection.excludedIds.filter((x) => x !== id);
        selection = withMode(
          bookIds.length === 0 && !prev.selection.shelfId
            ? emptyKeepingMode(prev.selection)
            : { ...prev.selection, bookIds, excludedIds },
          prev.selection,
        );
      }
      break;
    }
  }

  const next: FocusState = { selection, activeBookId, wikiIds };
  return {
    next,
    changed: {
      selection: !sameSelection(prev.selection, selection),
      activeBookId: prev.activeBookId !== activeBookId,
      wikiIds: !sameIds(prev.wikiIds, wikiIds),
    },
  };
}

/**
 * The book Counsel is DISCUSSING, derived — never stored. Null means "no
 * single book is in focus" (a shelf is loaded and the reader's book is not
 * on it, or nothing is open). Every read door — the prompt's Currently
 * Active Book section, get_chapter_text's scope, the Now-discussing chip —
 * reads this, so the invariant "the focus book is in the effective selection
 * or the selection is empty" holds at read time regardless of writer races.
 */
export function focusBookId(
  books: BookDocument[],
  selection: BookContextSelection,
  activeBookId: string | null,
): string | null {
  if (!activeBookId) return null;
  if (isEmptySelection(selection)) return activeBookId;
  const effective = selectContextBooks(books, selection, activeBookId);
  return effective.some((b) => b.id === activeBookId) ? activeBookId : null;
}

/** Is the reader's book on the loaded set? Distinguishes "discussing the
 *  shelf you're reading from" from "reading X while discussing shelf Y". */
export function readerIsInFocus(
  books: BookDocument[],
  selection: BookContextSelection,
  activeBookId: string | null,
): boolean {
  return !!activeBookId && focusBookId(books, selection, activeBookId) === activeBookId;
}

// ── Focus epoch ─────────────────────────────────────────────────────────────
// A monotone counter every focus writer bumps. An Undo captured at epoch N
// runs only while the epoch is still N; otherwise something else moved the
// focus in between (a picker toggle, a second load, a tool call, a realtime
// delete) and restoring a snapshot would clobber it.

let epoch = 0;
const epochListeners = new Set<() => void>();

export const focusEpoch = {
  current(): number { return epoch; },
  bump(): number {
    epoch += 1;
    for (const l of [...epochListeners]) l();
    return epoch;
  },
  subscribe(fn: () => void): () => void {
    epochListeners.add(fn);
    return () => epochListeners.delete(fn);
  },
  /** Tests only. */
  _reset(): void { epoch = 0; },
};

/** One sentence naming what a load replaced and kept — shared by the toast
 *  and the tool result so the two can never disagree (L4). */
export function describeLoad(
  prev: FocusState,
  outcome: LoadOutcome,
  names: { shelf: (id: string) => string; book: (id: string) => string; wiki: (id: string) => string },
): string {
  const parts: string[] = [];
  const { next, changed } = outcome;
  if (changed.selection) {
    const was = prev.selection.shelfId
      ? `shelf "${names.shelf(prev.selection.shelfId)}"`
      : prev.selection.bookIds.length > 0
        ? `${prev.selection.bookIds.length} hand-picked book${prev.selection.bookIds.length === 1 ? "" : "s"}`
        : null;
    const now = next.selection.shelfId
      ? `shelf "${names.shelf(next.selection.shelfId)}"`
      : next.selection.bookIds.length > 0
        ? `${next.selection.bookIds.length} hand-picked book${next.selection.bookIds.length === 1 ? "" : "s"}`
        : null;
    if (now && was) parts.push(`Loaded ${now}, replacing ${was}`);
    else if (now) parts.push(`Loaded ${now}`);
    else if (was) parts.push(`Unloaded ${was}`);
  }
  if (changed.activeBookId) {
    parts.push(next.activeBookId ? `Opened "${names.book(next.activeBookId)}" in the reader` : "Closed the reader");
  }
  if (changed.wikiIds) {
    const list = next.wikiIds.map(names.wiki).join(", ");
    parts.push(next.wikiIds.length > 1 ? `Loaded neurons: ${list}` : `Switched to neuron "${list}"`);
  } else if (next.wikiIds.length > 0 && (changed.selection || changed.activeBookId)) {
    parts.push(`Kept neuron "${names.wiki(next.wikiIds[0])}"${next.wikiIds.length > 1 ? ` (+${next.wikiIds.length - 1})` : ""}`);
  }
  return parts.length > 0 ? parts.join(". ") + "." : "Nothing changed.";
}
