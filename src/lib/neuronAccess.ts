// Single source of truth for which neurons are locked on the free plan.
// Mirrors the database rule in accessible_wiki_ids(): free accounts keep
// their OLDEST wiki (created_at, then id, ascending — same tie-break as the
// SQL) and everything newer is locked. Used by the BRAIN tab cards, the ⌘K
// quick switcher, the AI's switch_wiki tool, and chat retrieval scoping, so
// the UI can never disagree with what the database actually allows.
import { OPEN_ACCESS } from "@/lib/openAccess";

export const FREE_NEURON_LIMIT = 1;

interface WikiLike {
  id: string;
  created_at: string;
}

export function computeLockedWikiIds(
  wikis: WikiLike[],
  isPaid: boolean,
  planLoaded: boolean,
): Set<string> {
  if (OPEN_ACCESS) return new Set<string>();
  // Until the plan is known, lock nothing — flashing locks at strangers who
  // already paid is worse than a moment of optimism (the DB enforces anyway).
  if (!planLoaded || isPaid) return new Set<string>();
  const byAge = [...wikis].sort((a, b) => {
    const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
  return new Set(byAge.slice(FREE_NEURON_LIMIT).map((w) => w.id));
}
