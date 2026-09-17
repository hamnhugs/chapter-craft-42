// Wiki Drift Check — detects wikis that need a split or rename.
// Per-user invocation via auth header.
//
// Split signal: silhouette of k=2 split on the wiki's entry embeddings > 0.35,
//               wiki has ≥30 entries
// Rename signal: cosine(centroid, embedding(name + " " + description)) drift > 0.25
//
// For each finding we write a row into wiki_health_alerts (unique while pending).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MIN_ENTRIES_FOR_SPLIT = 30;
const SILHOUETTE_THRESHOLD = 0.35;
const RENAME_DRIFT_THRESHOLD = 0.25;
const MAX_VECTORS = 200; // perf cap per wiki

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { data: wikis } = await supabase
      .from("wikis")
      .select("id, name, description")
      .eq("user_id", user.id);
    if (!wikis || wikis.length === 0) return json({ checked: 0, alerts: 0 });

    // name_embedding(_source): cache from migration 20260917130600; absent
    // before it (42703) → no cache, embed every run as before.
    let nameCache = true;
    const withCache = await supabase
      .from("wiki_centroids")
      .select("wiki_id, centroid, entry_count, name_embedding, name_embedding_source")
      .eq("user_id", user.id);
    let centroids: any[] | null = withCache.data as any[] | null;
    if (withCache.error && (withCache.error as any).code === "42703") {
      nameCache = false;
      const plain = await supabase
        .from("wiki_centroids")
        .select("wiki_id, centroid, entry_count")
        .eq("user_id", user.id);
      centroids = plain.data as any[] | null;
    }
    const centroidMap = new Map(
      (centroids || []).map((c: any) => [c.wiki_id, c]),
    );

    let alerts = 0;
    let checked = 0;

    for (const w of wikis as any[]) {
      checked++;
      const c = centroidMap.get(w.id) as any;
      if (!c || (c.entry_count ?? 0) < MIN_ENTRIES_FOR_SPLIT) continue;

      // Pull entry embeddings — straight off the RPC with a narrowed select
      // (the old path fetched every full row, vectors included, just to take
      // ids, then re-selected the vectors by id).
      const { data: rows, error: rowsErr } = await supabase
        .rpc("entries_for_wiki", { target_wiki_id: w.id })
        .select("id, title, embedding_v2")
        .not("embedding_v2", "is", null)
        .order("updated_at", { ascending: false })
        .limit(MAX_VECTORS);
      if (rowsErr || !rows) continue;

      const vectors: { id: string; title: string; vec: number[] }[] = [];
      for (const r of rows as any[]) {
        const v = parseVector(r.embedding_v2);
        if (v && v.length === 1536) vectors.push({ id: r.id, title: r.title, vec: v });
      }
      if (vectors.length < MIN_ENTRIES_FOR_SPLIT) continue;

      // ── Split check: k=2 kmeans then silhouette ────────────────────────
      const split = kmeans2(vectors.map((v) => v.vec));
      if (split) {
        const sil = silhouette(vectors.map((v) => v.vec), split.assignments);
        if (sil >= SILHOUETTE_THRESHOLD) {
          // Sample titles per cluster for the proposal
          const t0 = vectors.filter((_, i) => split.assignments[i] === 0).slice(0, 4).map((v) => v.title);
          const t1 = vectors.filter((_, i) => split.assignments[i] === 1).slice(0, 4).map((v) => v.title);

          const names = await proposeTwoNames(w.name, t0, t1);
          const ok = await writeAlert(supabase, user.id, w.id, "split",
            `"${w.name}" looks like two distinct themes (silhouette ${sil.toFixed(2)}).`,
            {
              silhouette: sil,
              name_a: names?.[0] ?? null,
              name_b: names?.[1] ?? null,
              titles_a: t0,
              titles_b: t1,
            },
          );
          if (ok) alerts++;
        }
      }

      // ── Rename check: centroid vs (name + description) embedding ───────
      const text = `${w.name}. ${w.description || ""}`.trim();
      // Names rarely change: reuse the cached vector when it was computed from
      // exactly this text, otherwise embed and refresh the cache (best-effort).
      const cachedVec = nameCache && c.name_embedding_source === text ? parseVector(c.name_embedding) : null;
      let titleVec: number[] | null = cachedVec && cachedVec.length === 1536 ? cachedVec : null;
      if (!titleVec) {
        titleVec = await embed(text);
        if (titleVec && nameCache) {
          const { error: cacheErr } = await supabase
            .from("wiki_centroids")
            .update({ name_embedding: `[${titleVec.join(",")}]`, name_embedding_source: text })
            .eq("wiki_id", w.id);
          if (cacheErr) console.warn("wiki-drift-check: name embedding cache write failed:", cacheErr.message);
        }
      }
      const centroidVec = parseVector(c.centroid);
      if (titleVec && centroidVec && centroidVec.length === titleVec.length) {
        const drift = 1 - cosine(titleVec, centroidVec);
        if (drift >= RENAME_DRIFT_THRESHOLD) {
          const newName = await proposeRename(w.name, vectors.slice(0, 8).map((v) => v.title));
          if (newName && newName.toLowerCase() !== w.name.toLowerCase()) {
            const ok = await writeAlert(supabase, user.id, w.id, "rename",
              `Contents have drifted from the wiki's name (drift ${drift.toFixed(2)}).`,
              { current_name: w.name, proposed_name: newName, drift },
            );
            if (ok) alerts++;
          }
        }
      }
    }

    return json({ checked, alerts });
  } catch (e) {
    console.error("wiki-drift-check error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * One pending alert per (wiki, kind), refreshed in place on re-runs.
 *
 * The uniqueness is a PARTIAL index (… WHERE status = 'pending'), which
 * PostgREST's upsert can't target — the old `.upsert(onConflict:
 * "user_id,wiki_id,kind")` failed with 42P10 on every call and the error was
 * ignored, so no drift alert was ever stored. upsert_wiki_health_alert
 * (migration 20260917130400) does ON CONFLICT … WHERE status = 'pending'.
 * Before that migration: update the pending row if there is one, else insert.
 * Returns true when an alert row was written.
 */
async function writeAlert(
  supabase: any,
  userId: string,
  wikiId: string,
  kind: "split" | "rename",
  rationale: string,
  suggestion: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("upsert_wiki_health_alert", {
    p_wiki_id: wikiId, p_kind: kind, p_rationale: rationale, p_suggestion: suggestion,
  });
  if (!error) return !!data;
  const code = (error as any).code;
  if (code !== "PGRST202" && code !== "42883") {
    console.error("upsert_wiki_health_alert failed:", error.message);
    return false;
  }
  const { data: existing, error: selErr } = await supabase
    .from("wiki_health_alerts")
    .select("id")
    .eq("user_id", userId)
    .eq("wiki_id", wikiId)
    .eq("kind", kind)
    .eq("status", "pending")
    .limit(1);
  if (selErr) {
    console.error("wiki_health_alerts lookup failed:", selErr.message);
    return false;
  }
  const row = (existing || [])[0] as { id: string } | undefined;
  const { error: writeErr } = row
    ? await supabase.from("wiki_health_alerts").update({ rationale, suggestion }).eq("id", row.id)
    : await supabase.from("wiki_health_alerts").insert({
      user_id: userId, wiki_id: wikiId, kind, rationale, suggestion, status: "pending",
    });
  if (writeErr) {
    console.error("wiki_health_alerts write failed:", writeErr.message);
    return false;
  }
  return true;
}

async function embed(text: string): Promise<number[] | null> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return null;
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
        dimensions: 1536,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

async function proposeTwoNames(currentName: string, titlesA: string[], titlesB: string[]): Promise<[string, string] | null> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return null;
  const system = `You split a knowledge wiki named "${currentName}" into two halves. Propose two short (1-3 word, Title Case) names for the halves. Reply JSON {"a":"...","b":"..."}.`;
  const user = `Half A titles:\n${titlesA.map((t) => "- " + t).join("\n")}\n\nHalf B titles:\n${titlesB.map((t) => "- " + t).join("\n")}`;
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    if (parsed.a && parsed.b) return [parsed.a, parsed.b];
  } catch (e) {
    console.error("proposeTwoNames failed:", e);
  }
  return null;
}

async function proposeRename(currentName: string, sampleTitles: string[]): Promise<string | null> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return null;
  const system = `A wiki named "${currentName}" no longer matches its contents. Propose ONE replacement name (1-3 words, Title Case). Reply JSON {"name":"..."}.`;
  const user = `Recent entries in this wiki:\n${sampleTitles.map((t) => "- " + t).join("\n")}`;
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    return parsed.name || null;
  } catch (e) {
    console.error("proposeRename failed:", e);
    return null;
  }
}

// Lightweight k=2 kmeans on cosine geometry (init by farthest pair)
function kmeans2(vecs: number[][]): { assignments: number[]; centers: [number[], number[]] } | null {
  if (vecs.length < 4) return null;
  // init: pick two far-apart points
  let p0 = 0, p1 = 1, best = Infinity;
  for (let i = 0; i < Math.min(vecs.length, 50); i++) {
    for (let j = i + 1; j < Math.min(vecs.length, 50); j++) {
      const s = cosine(vecs[i], vecs[j]);
      if (s < best) { best = s; p0 = i; p1 = j; }
    }
  }
  let cA = vecs[p0].slice();
  let cB = vecs[p1].slice();
  const assignments = new Array(vecs.length).fill(0);
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let i = 0; i < vecs.length; i++) {
      const a = cosine(vecs[i], cA);
      const b = cosine(vecs[i], cB);
      const next = a >= b ? 0 : 1;
      if (assignments[i] !== next) { assignments[i] = next; changed = true; }
    }
    if (!changed && iter > 0) break;
    cA = mean(vecs.filter((_, i) => assignments[i] === 0));
    cB = mean(vecs.filter((_, i) => assignments[i] === 1));
    if (cA.length === 0 || cB.length === 0) return null;
  }
  return { assignments, centers: [cA, cB] };
}

function silhouette(vecs: number[][], labels: number[]): number {
  // Simplified: avg over samples of (b - a) / max(a, b) in cosine-distance space
  let total = 0, n = 0;
  const a = vecs.filter((_, i) => labels[i] === 0);
  const b = vecs.filter((_, i) => labels[i] === 1);
  if (a.length < 2 || b.length < 2) return 0;
  for (let i = 0; i < vecs.length; i++) {
    const own = labels[i] === 0 ? a : b;
    const other = labels[i] === 0 ? b : a;
    const ownDist = avgDist(vecs[i], own, i);
    const otherDist = avgDist(vecs[i], other, -1);
    const s = (otherDist - ownDist) / Math.max(ownDist, otherDist || 1e-9);
    total += s;
    n++;
  }
  return n > 0 ? total / n : 0;
}

function avgDist(v: number[], group: number[][], skipIdx: number): number {
  let sum = 0, n = 0;
  for (let i = 0; i < group.length; i++) {
    if (i === skipIdx) continue;
    sum += 1 - cosine(v, group[i]);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function mean(vs: number[][]): number[] {
  if (vs.length === 0) return [];
  const dim = vs[0].length;
  const m = new Array(dim).fill(0);
  for (const v of vs) for (let i = 0; i < dim; i++) m[i] += v[i];
  for (let i = 0; i < dim; i++) m[i] /= vs.length;
  return m;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseVector(raw: any): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      const t = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
      return t.split(",").map((x) => parseFloat(x));
    } catch { return null; }
  }
  return null;
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
