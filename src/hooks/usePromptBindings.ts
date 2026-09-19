import { useCallback } from "react";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { usePlan } from "@/hooks/usePlan";
import { bookContextStore } from "@/lib/chatBooks";
import { computeLockedWikiIds, MAX_ACTIVE_NEURONS } from "@/lib/neuronAccess";
import type { PromptPreset } from "@/hooks/usePromptPresets";

/**
 * Applying a prompt's context bindings — the part of a switch that changes
 * what the assistant can SEE, not just how it sounds.
 *
 * ONLY EVER FROM A DELIBERATE SWITCH. Not per turn, and never from the router:
 *
 *  - Per turn would fight the user. They load a neuron by hand, send a
 *    message, and the prompt quietly unloads it again.
 *  - From the router it would be worse: retrieval scope would change on the
 *    assistant's own initiative, mid-conversation, and the reply that told you
 *    about it was already written under the new scope. Changing what a model
 *    can see is a different order of thing from changing its tone, and it
 *    should take a human tapping something.
 *
 * So this runs once, on a pick, and announces exactly what it did. Afterwards
 * the loaded neurons are visible in Counsel's own chips and can be changed the
 * ordinary way. Switching REPLACES the loaded set, the same way activating a
 * chain does — so repeated switching cannot accumulate neurons.
 *
 * Nothing is auto-restored when you switch away. Restoring would discard any
 * neuron the user loaded by hand in the meantime, and a switch that silently
 * undid their work would be the more surprising of the two behaviours.
 */
export function usePromptBindings() {
  const { wikis, books, setActiveNeurons } = useApp();
  const { user } = useAuth();
  const { isPaid, loaded: planLoaded } = usePlan();

  /** One line describing what picking this prompt would change, or "" when it
   *  would change nothing. Shown BEFORE the tap, so a switch is never a
   *  surprise. */
  const describeBindings = useCallback((p: Pick<PromptPreset, "neuron_ids" | "book_id">): string => {
    const parts: string[] = [];
    const names = (p.neuron_ids || [])
      .map((id) => wikis.find((w) => w.id === id)?.name)
      .filter((n): n is string => !!n);
    if (names.length > 0) parts.push(names.length === 1 ? `loads ${names[0]}` : `loads ${names.length} neurons`);
    const book = p.book_id ? books.find((b) => b.id === p.book_id) : null;
    if (book) parts.push(`opens ${book.title}`);
    return parts.join(" · ");
  }, [wikis, books]);

  /**
   * Apply the bindings. Returns a human sentence describing what actually
   * happened, or null when nothing did — the caller says it, so the toast
   * describes the outcome rather than the intent.
   */
  const applyBindings = useCallback(async (p: Pick<PromptPreset, "name" | "neuron_ids" | "book_id">): Promise<string | null> => {
    const done: string[] = [];

    const requested = p.neuron_ids || [];
    if (requested.length > 0) {
      // A neuron can be deleted, or locked behind the plan, long after a
      // prompt bound it. Both are dropped silently from the load and reported
      // afterwards — a switch must not fail outright because one member went.
      const locked = computeLockedWikiIds(wikis, isPaid, planLoaded);
      const live = requested.filter((id) => wikis.some((w) => w.id === id) && !locked.has(id));
      const missing = requested.length - live.length;
      if (live.length > 0) {
        try {
          await setActiveNeurons(live.slice(0, MAX_ACTIVE_NEURONS));
          const names = live.slice(0, MAX_ACTIVE_NEURONS)
            .map((id) => wikis.find((w) => w.id === id)?.name)
            .filter(Boolean);
          done.push(`loaded ${names.join(", ")}`);
        } catch (e) {
          toast.error(`Couldn't load the neurons for "${p.name}": ${String((e as Error)?.message || e)}`);
        }
      }
      if (missing > 0) {
        done.push(`${missing} of its neurons ${missing === 1 ? "is" : "are"} gone or locked`);
      }
    }

    if (p.book_id) {
      const book = books.find((b) => b.id === p.book_id);
      if (book) {
        bookContextStore.init(user?.id ?? null);
        bookContextStore.set({ ...bookContextStore.get(), shelfId: null, bookIds: [book.id], excludedIds: [] });
        done.push(`opened ${book.title}`);
      } else {
        done.push("its book is no longer in your library");
      }
    }

    return done.length > 0 ? done.join(" · ") : null;
  }, [wikis, books, isPaid, planLoaded, setActiveNeurons, user]);

  return { applyBindings, describeBindings };
}
