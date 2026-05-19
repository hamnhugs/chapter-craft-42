// Incubator Sweep — clusters pending incubator entries and proposes new wikis.
// Per-user invocation via auth header. Safe to call repeatedly (idempotent).
//
// Steps:
//   1. Cold-start gate (≥2 wikis with ≥10 entries each)
//   2. Pull pending incubator entries; mark expired ones
//   3. Greedy cosine clustering (min cluster size 5, sim threshold 0.62)
//   4. For each cluster: self-consistency naming (n=5, Gemini Flash); keep names
//      surviving ≥3 runs AND failing the 0.82 cosine collision gate with existing wikis
//   5. Insert wiki_proposals; mark cluster members 'clustered'

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const COLD_START_MIN_WIKIS = 2;
const COLD_START_MIN_ENTRIES = 10;
const CLUSTER_MIN_SIZE = 5;
const CLUSTER_SIM_THRESHOLD = 0.62;
const NAME_COLLISION_THRESHOLD = 0.82;
const SELF_CONSISTENCY_N = 5;
const SELF_CONSISTENCY_MIN = 3;
const PROPOSAL_CAP_PER_USER = 5;

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

    // Cold-start gate
    const { data: wikis } = await supabase
      .from("wikis")
      .select("id, name")
      .eq("user_id", user.id);
    if (!wikis || wikis.length < COLD_START_MIN_WIKIS) {
      return json({ skipped: "cold_start_wikis" });
    }
    const { data: centroids } = await supabase
      .from("wiki_centroids")
      .select("wiki_id, centroid, entry_count")
      .eq("user_id", user.id);
    const qualified = (centroids || []).filter((c: any) => c.entry_count >= COLD_START_MIN_ENTRIES).length;
    if (qualified < COLD_START_MIN_WIKIS) {
      return json({ skipped: "cold_start_entries" });
    }

    // Expire stale pending rows
    await supabase
      .from("incubator_entries")
      .update({ status: "expired" })
      .eq("user_id", user.id)
      .eq("status", "pending")
      .lt("expires_at", new Date().toISOString());

    // Proposal cap
    const { count: existingProposals } = await supabase
      .from("wiki_proposals")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "pending");
    if ((existingProposals ?? 0) >= PROPOSAL_CAP_PER_USER) {
      return json({ skipped: "proposal_cap" });
    }

    // Pull pending incubator entries (cap at 200 for perf)
    const { data: pending } = await supabase
      .from("incubator_entries")
      .select("id, entry_id, embedding")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .limit(200);

    if (!pending || pending.length < CLUSTER_MIN_SIZE) {
      return json({ pending: pending?.length ?? 0, clusters: 0, proposals: 0 });
    }

    // Parse embeddings
    type Row = { id: string; entry_id: string; vec: number[] };
    const rows: Row[] = [];
    for (const p of pending as any[]) {
      const v = parseVector(p.embedding);
      if (v && v.length === 1536) rows.push({ id: p.id, entry_id: p.entry_id, vec: v });
    }
    if (rows.length < CLUSTER_MIN_SIZE) {
      return json({ pending: rows.length, clusters: 0, proposals: 0 });
    }

    // Greedy clustering: seed with first unclaimed row, attach all rows with cosine ≥ threshold
    const claimed = new Set<number>();
    const clusters: Row[][] = [];
    for (let i = 0; i < rows.length; i++) {
      if (claimed.has(i)) continue;
      const seed = rows[i];
      const cluster: Row[] = [seed];
      claimed.add(i);
      for (let j = i + 1; j < rows.length; j++) {
        if (claimed.has(j)) continue;
        if (cosine(seed.vec, rows[j].vec) >= CLUSTER_SIM_THRESHOLD) {
          cluster.push(rows[j]);
          claimed.add(j);
        }
      }
      if (cluster.length >= CLUSTER_MIN_SIZE) clusters.push(cluster);
    }

    if (clusters.length === 0) {
      return json({ pending: rows.length, clusters: 0, proposals: 0 });
    }

    // Existing wiki name embeddings for collision gate (compute via centroids if available,
    // else embed names via Lovable AI). Fall back to centroid embeddings.
    const wikiNames = (wikis as any[]).map((w) => w.name);

    let proposalsMade = 0;
    const remainingSlots = PROPOSAL_CAP_PER_USER - (existingProposals ?? 0);

    for (const cluster of clusters.slice(0, remainingSlots)) {
      const entryIds = cluster.map((r) => r.entry_id);
      // Fetch sample titles + content snippets for the LLM
      const { data: entryRows } = await supabase
        .from("knowledge_entries")
        .select("id, title, content")
        .in("id", entryIds)
        .limit(20);
      if (!entryRows || entryRows.length === 0) continue;

      const titles = (entryRows as any[]).map((e) => e.title).filter(Boolean);
      const snippets = (entryRows as any[])
        .slice(0, 10)
        .map((e: any) => `- ${e.title}: ${(e.content || "").slice(0, 180)}`)
        .join("\n");

      // Self-consistency naming
      const nameVotes = await proposeWikiName(snippets, wikiNames);
      if (!nameVotes) continue;

      const { name, rationale, votes } = nameVotes;
      if (votes < SELF_CONSISTENCY_MIN) continue;

      // Name-collision gate: embed proposed name and compare to wiki names
      const collides = await nameCollides(name, wikiNames);
      if (collides) continue;

      // Insert proposal
      const sampleTitles = titles.slice(0, 6);
      const { data: prop, error: propErr } = await supabase
        .from("wiki_proposals")
        .insert({
          user_id: user.id,
          proposed_name: name,
          rationale,
          sample_titles: sampleTitles,
          member_entry_ids: entryIds,
        })
        .select("id")
        .single();

      if (propErr) {
        console.error("wiki_proposal insert failed:", propErr);
        continue;
      }

      // Mark incubator rows as clustered
      await supabase
        .from("incubator_entries")
        .update({ status: "clustered", cluster_id: prop.id })
        .in("id", cluster.map((r) => r.id));

      proposalsMade++;
    }

    return json({ pending: rows.length, clusters: clusters.length, proposals: proposalsMade });
  } catch (e) {
    console.error("incubator-sweep error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────

async function proposeWikiName(
  snippets: string,
  existingNames: string[],
): Promise<{ name: string; rationale: string; votes: number } | null> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return null;

  const system =
    "You name knowledge wikis. Given a set of related notes, propose ONE short wiki name (1-3 words, Title Case) that captures the common theme. Avoid names too close to: " +
    existingNames.map((n) => `"${n}"`).join(", ") +
    ". Reply with strict JSON: {\"name\":\"...\",\"rationale\":\"one sentence\"}";

  const userMsg = `Notes in this cluster:\n${snippets}\n\nPropose the wiki name now.`;

  const counts = new Map<string, { count: number; rationale: string }>();

  for (let i = 0; i < SELF_CONSISTENCY_N; i++) {
    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
          ],
          response_format: { type: "json_object" },
          temperature: 0.8,
        }),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const raw = j.choices?.[0]?.message?.content;
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const key = (parsed.name || "").trim();
      if (!key) continue;
      const norm = key.toLowerCase();
      const prev = counts.get(norm);
      counts.set(norm, {
        count: (prev?.count ?? 0) + 1,
        rationale: prev?.rationale || parsed.rationale || "",
      });
    } catch (e) {
      console.error("naming run failed:", e);
    }
  }

  if (counts.size === 0) return null;
  let best: { name: string; rationale: string; votes: number } | null = null;
  for (const [norm, v] of counts.entries()) {
    if (!best || v.count > best.votes) {
      // Re-cap the display name with title case from original casing — use the lowercase as fallback
      best = { name: titleCase(norm), rationale: v.rationale, votes: v.count };
    }
  }
  return best;
}

async function nameCollides(name: string, existingNames: string[]): Promise<boolean> {
  if (existingNames.length === 0) return false;
  // Lightweight: lowercase substring check first
  const low = name.toLowerCase().trim();
  for (const e of existingNames) {
    const el = e.toLowerCase().trim();
    if (el === low) return true;
    if (el.includes(low) || low.includes(el)) {
      if (Math.min(el.length, low.length) / Math.max(el.length, low.length) > 0.6) return true;
    }
  }
  // Semantic: embed and cosine compare
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return false;
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: [name, ...existingNames],
        dimensions: 512,
      }),
    });
    if (!res.ok) return false;
    const j = await res.json();
    const vecs = (j.data as any[]).map((d) => d.embedding as number[]);
    const probe = vecs[0];
    for (let i = 1; i < vecs.length; i++) {
      if (cosine(probe, vecs[i]) >= NAME_COLLISION_THRESHOLD) return true;
    }
  } catch (e) {
    console.error("collision embed failed:", e);
  }
  return false;
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
    } catch {
      return null;
    }
  }
  return null;
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
