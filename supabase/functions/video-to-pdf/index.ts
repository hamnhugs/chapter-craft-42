// Video caption extraction & PDF generation edge function.
// Routes:
//   POST /video-to-pdf/submit  -> Submit video URL for caption extraction
//   GET  /video-to-pdf/status/{job_id} -> Poll job status
//
// Proxies to VPS-hosted VideoCaptionEngine at PORT 8000.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const VIDEO_ENGINE_URL = Deno.env.get("VIDEO_ENGINE_URL") || "http://93.188.166.152:8000";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(null, 200);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing auth" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supabase.auth.getUser();
    const user = userData.user;
    if (!user) return json({ error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/video-to-pdf/, "") || "/";
    const segments = path.split("/").filter(Boolean);

    // ── POST /submit ────────────────────────────────────────────────────────
    if (req.method === "POST" && segments[0] === "submit") {
      const { videoUrl } = await req.json();
      if (!videoUrl?.trim()) return json({ error: "videoUrl required" }, 400);

      const submitRes = await fetch(`${VIDEO_ENGINE_URL}/video/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl }),
      });

      if (!submitRes.ok) {
        const txt = await submitRes.text();
        return json({ error: `Engine error: ${txt.slice(0, 200)}` }, 502);
      }

      const { job_id, status, message } = await submitRes.json();

      // Persist job reference in Supabase
      await supabase.from("video_jobs").insert({
        id: job_id,
        user_id: user.id,
        video_url: videoUrl,
        status: status,
      });

      return json({ job_id, status, message });
    }

    // ── GET /download/{job_id} ──────────────────────────────────────────────
    if (req.method === "GET" && segments[0] === "download" && segments[1]) {
      const jobId = segments[1];

      const { data: job } = await supabase
        .from("video_jobs")
        .select("id, transcript, title, video_url, metadata")
        .eq("id", jobId)
        .eq("user_id", user.id)
        .single();

      if (!job) return json({ error: "Job not found" }, 404);

      // Try stored transcript; fall back to refetching from engine
      let transcript = job.transcript as string | null;
      let title = (job.title as string | null) || "";
      if (!transcript) {
        try {
          const r = await fetch(`${VIDEO_ENGINE_URL}/video/${jobId}`);
          if (r.ok) {
            const eng = await r.json();
            transcript = eng.transcript || null;
            title = title || eng?.metadata?.title || "";
          }
        } catch { /* ignore */ }
      }

      if (!transcript) {
        return json({ error: "Transcript not available yet — try again in a moment." }, 404);
      }

      title = title || job.video_url || "Video transcript";
      const pdfBytes = await buildPdf(title, transcript);

      return new Response(pdfBytes, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="transcript-${jobId}.pdf"`,
          "Cache-Control": "private, max-age=0",
        },
      });
    }

    // ── GET /status/{job_id} ────────────────────────────────────────────────
    if (req.method === "GET" && segments[0] === "status" && segments[1]) {
      const jobId = segments[1];

      const { data: job } = await supabase
        .from("video_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("user_id", user.id)
        .single();

      if (!job) return json({ error: "Job not found" }, 404);

      const statusRes = await fetch(`${VIDEO_ENGINE_URL}/video/${jobId}`);
      if (!statusRes.ok) {
        return json({
          job_id: job.id,
          status: job.status,
          url: job.pdf_url || "",
          metadata: job.metadata || null,
          word_count: job.word_count || 0,
        });
      }

      const engineStatus = await statusRes.json();

      if (engineStatus.status === "completed" && engineStatus.url) {
        // Update video_jobs (persist transcript for on-demand PDF generation)
        await supabase.from("video_jobs").update({
          status: "completed",
          pdf_url: engineStatus.url,
          transcript: engineStatus.transcript || null,
          title: (engineStatus.metadata && engineStatus.metadata.title) || null,
          metadata: engineStatus.metadata || null,
          word_count: engineStatus.word_count || 0,
          error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", jobId);

        // Auto-save to wiki library — deduped by source_url
        const { data: existing } = await supabase
          .from("wiki_entries")
          .select("id")
          .eq("user_id", user.id)
          .eq("source_url", job.video_url)
          .maybeSingle();

        if (!existing && engineStatus.transcript) {
          const meta = engineStatus.metadata || {};
          const title = meta.title || job.video_url;
          const channel = meta.channel || "Unknown";
          const duration = meta.duration_seconds
            ? `${Math.floor(meta.duration_seconds / 60)}m ${Math.round(meta.duration_seconds % 60)}s`
            : "";

          // PDF link at top + full raw transcript below (NO AI summary)
          const pdfLink = engineStatus.url
            ? `**[Download Transcript PDF](${engineStatus.url})**\n\n---\n\n`
            : "";
          const content = pdfLink + engineStatus.transcript;
          const summary = `Video transcript — ${channel}${duration ? ` · ${duration}` : ""}`;

          await supabase.from("wiki_entries").insert({
            user_id: user.id,
            title: title,
            content: content,
            summary: summary,
            subject: "Video Transcript",
            kind: "video",
            maturity: "note",
            tags: ["video", "transcript"],
            source_url: job.video_url,
          });
        }
      } else if (engineStatus.status === "failed") {
        await supabase.from("video_jobs").update({
          status: "failed",
          error: engineStatus.error || "Unknown error",
          updated_at: new Date().toISOString(),
        }).eq("id", jobId);
      }

      return json(engineStatus);
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error("video-to-pdf error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
