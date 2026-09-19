// Bounded input for knowledge-lint's single LLM call.
//
// knowledge-lint used to paste EVERY entry (title + 200 chars) and EVERY edge
// into one prompt — unbounded tokens that grow with the library, and past a
// few hundred entries the model skims anyway. The audit is only useful on the
// entries most likely to have problems, so we pick ≤ `budget` of those,
// prioritized by the issue types the lint reports:
//
//   1. likely duplicates  — same normalized title, or same first 6 title words
//   2. low confidence     — ascending confidence
//   3. orphans            — no edge in either direction
//   4. stale              — least recently updated
//
// Quotas are taken in that order (each bucket gets at most `budget / 4`, a
// duplicate group is kept together), then any remaining budget is filled from
// the buckets round-robin. Pure — no Deno/network references (unit tested in
// src/test/lintSample.test.ts).

export interface LintEntryLite {
  id: string;
  title: string;
  confidence?: number | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface LintSample {
  ids: string[];
  reasons: Record<string, "duplicate" | "low_confidence" | "orphan" | "stale">;
}

export function normalizeTitleKey(title: string): string {
  return (title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function selectLintSample(
  entries: LintEntryLite[],
  connectedIds: Set<string>,
  budget = 150,
): LintSample {
  const reasons: LintSample["reasons"] = {};
  const picked: string[] = [];
  const take = (id: string, why: LintSample["reasons"][string]) => {
    if (reasons[id] || picked.length >= budget) return false;
    reasons[id] = why;
    picked.push(id);
    return true;
  };
  if (entries.length <= budget) {
    // Everything fits — keep the audit exhaustive, still label the reasons.
    for (const e of entries) picked.push(e.id);
    return { ids: picked, reasons };
  }
  const quota = Math.max(1, Math.floor(budget / 4));

  // 1. Duplicate groups (full key, then 6-word prefix key).
  const groups = new Map<string, LintEntryLite[]>();
  for (const e of entries) {
    const key = normalizeTitleKey(e.title);
    if (!key) continue;
    for (const k of [`t:${key}`, `p:${key.split(" ").slice(0, 6).join(" ")}`]) {
      const g = groups.get(k);
      if (g) g.push(e); else groups.set(k, [e]);
    }
  }
  const dupGroups = [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length);
  const dupBucket: string[] = [];
  const seenDup = new Set<string>();
  for (const g of dupGroups) {
    for (const e of g) if (!seenDup.has(e.id)) { seenDup.add(e.id); dupBucket.push(e.id); }
  }

  const ts = (e: LintEntryLite) => Date.parse(e.updated_at || e.created_at || "") || 0;
  const conf = (e: LintEntryLite) => (typeof e.confidence === "number" ? e.confidence : 1);
  const lowConfBucket = entries.filter((e) => conf(e) < 1).sort((a, b) => conf(a) - conf(b)).map((e) => e.id);
  const orphanBucket = entries.filter((e) => !connectedIds.has(e.id)).sort((a, b) => ts(a) - ts(b)).map((e) => e.id);
  const staleBucket = [...entries].sort((a, b) => ts(a) - ts(b)).map((e) => e.id);

  const buckets: Array<[string[], LintSample["reasons"][string]]> = [
    [dupBucket, "duplicate"],
    [lowConfBucket, "low_confidence"],
    [orphanBucket, "orphan"],
    [staleBucket, "stale"],
  ];
  const cursors = buckets.map(() => 0);

  // Quota pass.
  buckets.forEach(([bucket, why], bi) => {
    let n = 0;
    while (cursors[bi] < bucket.length && n < quota && picked.length < budget) {
      if (take(bucket[cursors[bi]++], why)) n++;
    }
  });
  // Fill pass, round-robin.
  let progressed = true;
  while (picked.length < budget && progressed) {
    progressed = false;
    buckets.forEach(([bucket, why], bi) => {
      while (cursors[bi] < bucket.length && picked.length < budget) {
        if (take(bucket[cursors[bi]++], why)) { progressed = true; break; }
      }
    });
  }
  return { ids: picked, reasons };
}
