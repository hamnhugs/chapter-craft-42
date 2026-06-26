// enqueue-ingest
// =================
// Durable folder-digest pipeline. The Library tab POSTs the list of books it
// wants digested; we validate ownership, insert one row per book into
// public.ingest_jobs (status='queued'), and then kick off a background worker
// via EdgeRuntime.waitUntil. The worker processes jobs one-at-a-time per
// invocation using the SKIP LOCKED claim RPC, so:
//
//   • Closing the tab / refreshing the page does NOT cancel work — the jobs
//     live in Postgres and the edge runtime keeps draining the queue after
//     returning the HTTP response.
//   • If the runtime itself dies mid-job, requeue_stuck_ingest_jobs() (called
//     by any subsequent enqueue call with {resume:true}) puts the orphan back
//     into 'queued' and another invocation picks it up.
//   • Multiple parallel invocations are safe — claim_next_ingest_job uses
//     FOR UPDATE SKIP LOCKED.
//
// Request body:
//   { jobs: [{ book_id, wiki_id?, folder_id?, model? }], resume?: boolean }
//   { resume: true }  // no new jobs, just drain whatever is already queued

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runIngestForBook } from "../_shared/ingest-runner.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// EdgeRuntime is provided by Supabase Edge Runtime; declare so TS doesn't choke.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface IncomingJob {
  book_id: string;
  wiki_id?: string | null;
  folder_id?: string | null;
  model?: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    // Identify the caller against their own JWT
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const incoming: IncomingJob[] = Array.isArray(body?.jobs) ? body.jobs : [];
    const resume: boolean = !!body?.resume;

    // Service-role client for all queue work — the worker runs without a JWT.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Best-effort: requeue anything left running from a dead invocation.
    if (resume || incoming.length > 0) {
      await admin.rpc("requeue_stuck_ingest_jobs").then(() => {}, (e: any) =>
        console.warn("requeue_stuck_ingest_jobs failed:", e?.message));
    }

    // Validate book ownership in one round-trip before insert.
    let enqueued = 0;
    if (incoming.length > 0) {
      const bookIds = Array.from(new Set(incoming.map((j) => j.book_id).filter(Boolean)));
      const { data: owned } = await admin
        .from("books")
        .select("id")
        .eq("user_id", user.id)
        .in("id", bookIds);
      const ownedSet = new Set((owned || []).map((r: any) => r.id));
      const valid = incoming.filter((j) => ownedSet.has(j.book_id));

      // De-dupe against already-queued/running jobs so refresh-spam can't
      // explode the queue.
      const { data: existing } = await admin
        .from("ingest_jobs")
        .select("book_id, wiki_id")
        .eq("user_id", user.id)
        .in("status", ["queued", "running"]);
      const seen = new Set((existing || []).map((r: any) => `${r.book_id}|${r.wiki_id || ""}`));

      const rows = valid
        .filter((j) => !seen.has(`${j.book_id}|${j.wiki_id || ""}`))
        .map((j) => ({
          user_id: user.id,
          book_id: j.book_id,
          wiki_id: j.wiki_id || null,
          folder_id: j.folder_id || null,
          model: j.model || null,
          status: "queued" as const,
        }));

      if (rows.length > 0) {
        const { error } = await admin.from("ingest_jobs").insert(rows);
        if (error) throw new Error(error.message);
        enqueued = rows.length;
      }
    }

    // Fire the background drainer without blocking the HTTP response.
    const drainer = drainQueue(admin, user.id).catch((e) =>
      console.error("drainQueue fatal:", e?.message || e));
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(drainer);
    } else {
      // Local fallback — just don't await.
      void drainer;
    }

    return json({ ok: true, enqueued });
  } catch (e) {
    console.error("enqueue-ingest error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

async function drainQueue(admin: any, userId: string) {
  // Bounded loop so a runaway queue can't pin the runtime forever; the next
  // user action (or a follow-up enqueue with resume=true) will continue.
  const MAX_JOBS_PER_INVOCATION = 25;
  for (let i = 0; i < MAX_JOBS_PER_INVOCATION; i++) {
    const { data: claimed, error: claimErr } = await admin.rpc("claim_next_ingest_job", { _user_id: userId });
    if (claimErr) { console.error("claim_next_ingest_job:", claimErr.message); return; }
    const job = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!job?.id) return; // queue empty

    try {
      await admin.from("ingest_jobs").update({
        progress: "Starting", updated_at: new Date().toISOString(),
      }).eq("id", job.id);

      const result = await runIngestForBook({
        supabase: admin,
        userId,
        bookId: job.book_id,
        wikiId: job.wiki_id,
        model: job.model || undefined,
        onProgress: async (msg) => {
          await admin.from("ingest_jobs").update({
            progress: msg, updated_at: new Date().toISOString(),
          }).eq("id", job.id);
        },
      });

      await admin.from("ingest_jobs").update({
        status: "succeeded",
        progress: `Saved ${result.entries_created} entries`,
        result,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: null,
      }).eq("id", job.id);
    } catch (err: any) {
      const message = err?.message || "Unknown ingest error";
      const attempts = (job.attempts || 0);
      const fatal = attempts >= 3 || /credits exhausted|Book not found|No chapters/i.test(message);
      await admin.from("ingest_jobs").update({
        status: fatal ? "failed" : "queued",
        error: message,
        progress: fatal ? null : "Will retry",
        finished_at: fatal ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      if (!fatal) {
        // Tiny backoff before next claim so we don't hot-loop on a flaky API.
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
