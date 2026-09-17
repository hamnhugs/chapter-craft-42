import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_STATS, type ReadAlongStats } from "@/lib/readAlong";

/**
 * Read-along XP/streak stats, per user, in localStorage (device-local: this
 * is a first cut of reading gamification, not synced across devices yet).
 * Writes are throttled — credit arrives a word at a time.
 */
const keyFor = (userId: string | null) => `cc_read_along_stats_${userId ?? "anon"}`;

function load(userId: string | null): ReadAlongStats {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return EMPTY_STATS;
    return { ...EMPTY_STATS, ...(JSON.parse(raw) as Partial<ReadAlongStats>) };
  } catch {
    return EMPTY_STATS;
  }
}

export function useReadAlongStats(userId: string | null) {
  const [stats, setStats] = useState<ReadAlongStats>(() => load(userId));
  const latest = useRef(stats);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      localStorage.setItem(keyFor(userId), JSON.stringify(latest.current));
    } catch {
      // Storage unavailable: stats last for this session only.
    }
  }, [userId]);

  useEffect(() => {
    const s = load(userId);
    latest.current = s;
    setStats(s);
  }, [userId]);

  useEffect(() => () => flush(), [flush]);

  const update = useCallback(
    (next: ReadAlongStats) => {
      latest.current = next;
      setStats(next);
      if (timer.current === null) timer.current = window.setTimeout(flush, 2000);
    },
    [flush],
  );

  return { stats, latest, update, flush };
}
