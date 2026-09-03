import { supabase } from "@/integrations/supabase/client";

// Non-exclusive shelf membership. The book_shelf_members junction is the
// SINGLE store — verified live, and books.folder_id is no longer read or
// written by any path here.
//
// The mirror era is over. folder_id existed as a best-effort single-shelf
// copy so bundles cached before the junction migration kept seeing a coherent
// world; it cost a round trip on every toggle and could only ever represent
// one shelf out of many. Dropping it here is the CLIENT half of the deferred
// column drop — the column itself comes out once bundles carrying this code
// have cycled.
//
// Design laws this module encodes (each earned by a review finding):
//  - Writes are DELTAS (add/remove specific shelves), never replace-the-set:
//    deltas from two rapid toggles commute at the database, so no write can
//    delete a membership another in-flight write just added.
//  - The first membership READ doubles as the availability probe — a
//    missing-schema error caches fallback mode for the session (applying the
//    migration is user-gated; re-asking helps nobody), any other error
//    throws and stays re-probeable. No separate probe round trip, and no
//    HEAD request (HEAD error responses carry no JSON body, so the error
//    code the classifier needs may never arrive).
//  - Junction writes are attempted whenever the junction is not KNOWN
//    missing, so a transient startup read failure cannot stop a session's
//    shelf changes from landing.
//  - Membership has exactly ONE client copy: books[].folderIds in
//    AppContext. This module only talks to the database; AppContext owns
//    the state patch and the toggle semantics.

/** null = unknown, true = junction confirmed live, false = confirmed missing
 *  (sticky for the session — the migration is a user-gated action). */
let junctionCache: boolean | null = null;

/** True when the error means the shelf-membership migration hasn't been
 *  applied yet. PGRST205 = table missing from PostgREST's schema cache,
 *  42P01 = relation does not exist; the column codes guard against a
 *  partially-applied migration. */
function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204";
}

/** Drop the availability cache (used after the migration lands, and by tests). */
export function resetShelfJunctionAvailability(): void {
  junctionCache = null;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 40;

/**
 * All shelf memberships for a user, as bookId → folderIds. Returns null when
 * the junction table is missing — the caller then knows there is nothing to
 * show rather than guessing. Throws on transient failures (network, auth):
 * "the read failed" and "there are no memberships" are different claims, and
 * the caller has to be able to tell them apart.
 *
 * Paged because PostgREST silently caps un-ranged selects at 1000 rows
 * (documented repo lesson), and a junction table crosses that line faster
 * than any base table. Ordered by (book_id, folder_id) — the PK columns, a
 * TOTAL order — because range() paging over a sort with ties can skip or
 * duplicate rows at page boundaries, and the migration's backfill stamps
 * every pre-existing membership with one identical created_at.
 */
export async function fetchShelfMembership(userId: string): Promise<Map<string, string[]> | null> {
  if (junctionCache === false) return null;
  const map = new Map<string, string[]>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await (supabase.from("book_shelf_members" as any) as any)
      .select("book_id, folder_id")
      .eq("user_id", userId)
      .order("book_id", { ascending: true })
      .order("folder_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (isMissingSchema(error)) { junctionCache = false; return null; }
      throw error; // transient — junctionCache stays as-is, next call re-asks
    }
    const batch = (data || []) as { book_id: string; folder_id: string }[];
    for (const row of batch) {
      const list = map.get(row.book_id) || [];
      list.push(row.folder_id);
      map.set(row.book_id, list);
    }
    if (batch.length < PAGE_SIZE) {
      junctionCache = true;
      return map;
    }
  }
  // Never silently truncate: memberships past the cap would show as
  // unshelved. 20k rows is far past any real library, but say so if it hits.
  console.warn(`Shelf membership read hit the ${MAX_PAGES * PAGE_SIZE}-row page cap; some memberships were not loaded.`);
  junctionCache = true;
  return map;
}

export interface ShelfDelta {
  /** Shelf ids to add this book to. */
  adds: string[];
  /** Shelf ids to remove this book from. */
  removes: string[];
}

/**
 * Persist one book's membership delta. Adds land before removes, so a
 * mid-flight failure leaves a superset — never an emptied set.
 *
 * EVERY failure throws now, and that is what removing the mirror forces.
 * While folder_id existed there was a second store to fall back on, so a
 * junction error could be swallowed and the user's change still be recorded
 * somewhere. There is no somewhere else: a write that did not land must reach
 * the caller so the optimistic patch rolls back, rather than leaving the UI
 * showing a membership the database never accepted.
 *
 * A missing-schema error stops being the special case it was, for the same
 * reason. It still caches (so reads stop asking) and now throws as well —
 * with no junction there is nothing left to write to.
 */
export async function applyShelfDelta(
  userId: string,
  bookId: string,
  delta: ShelfDelta,
): Promise<void> {
  const { adds, removes } = delta;

  const onJunctionError = (error: unknown): never => {
    if (isMissingSchema(error)) {
      junctionCache = false;
      throw new Error(
        "Shelves aren't available on this account yet — the shelf-membership table is missing.",
      );
    }
    throw error;
  };

  if (junctionCache !== false && adds.length > 0) {
    // ignoreDuplicates → ON CONFLICT DO NOTHING: re-adding an existing row
    // is a no-op, not a row rewrite, and duplicate conflict targets in one
    // payload can't raise Postgres error 21000.
    const { error } = await (supabase.from("book_shelf_members" as any) as any)
      .upsert(
        adds.map((folder_id) => ({ folder_id, book_id: bookId, user_id: userId })),
        { onConflict: "folder_id,book_id", ignoreDuplicates: true },
      );
    if (error) onJunctionError(error);
  }
  if (junctionCache !== false && removes.length > 0) {
    const { error } = await (supabase.from("book_shelf_members" as any) as any)
      .delete()
      .eq("book_id", bookId)
      .eq("user_id", userId)
      .in("folder_id", removes);
    if (error) onJunctionError(error);
  }
}
