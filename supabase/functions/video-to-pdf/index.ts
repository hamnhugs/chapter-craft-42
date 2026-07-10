// Video caption extraction & HTML generation edge function.
// Routes:
//   POST /video-to-pdf/submit        -> Submit video URL for caption extraction
//   GET  /video-to-pdf/status/{id}   -> Poll job status
//   GET  /video-to-pdf/download/{id} -> On-demand HTML transcript download
//
// Proxies to VPS-hosted VideoCaptionEngine at PORT 8000.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { resolveWikiLlm } from "../_shared/wiki-llm.ts";

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
      const { videoUrl, formatForChapterize } = await req.json();
      if (!videoUrl?.trim()) return json({ error: "videoUrl required" }, 400);

      // Restrict to YouTube hosts — the engine's fetcher would otherwise be
      // pointed at arbitrary/internal URLs (SSRF). The client-side check is
      // UX only; this is the real boundary.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(videoUrl.trim());
      } catch {
        return json({ error: "Invalid URL" }, 400);
      }
      const ALLOWED_HOSTS = new Set([
        "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
      ]);
      if (
        !/^https?:$/.test(parsedUrl.protocol) ||
        !ALLOWED_HOSTS.has(parsedUrl.hostname.toLowerCase())
      ) {
        return json({ error: "Only YouTube URLs are supported" }, 400);
      }

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

      await supabase.from("video_jobs").insert({
        id: job_id,
        user_id: user.id,
        video_url: videoUrl,
        status,
        metadata: { format_for_chapterize: !!formatForChapterize },
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

      title = title || (job.video_url as string) || "Video Transcript";
      const htmlContent = buildHtml(title, transcript);

      return new Response(htmlContent, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="transcript-${jobId}.html"`,
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
        // Guard: already processed — return cached data without re-running anything
        if (job.status === "completed") {
          return json({
            status: "completed",
            url: job.pdf_url || engineStatus.url,
            word_count: job.word_count || 0,
            metadata: job.metadata || null,
          });
        }

        const storedMeta = (job.metadata as Record<string, unknown>) || {};
        const mergedMetadata = { ...storedMeta, ...(engineStatus.metadata || {}) };
        const formatForChapterize = !!storedMeta.format_for_chapterize;

        // Step 1: Format transcript first, before saving anything
        let finalTranscript = (engineStatus.transcript as string) || "";
        let formattedSuccessfully = false;
        if (formatForChapterize && finalTranscript) {
          try {
            finalTranscript = await formatTranscriptForChapterization(supabase, user.id, finalTranscript);
            formattedSuccessfully = true;
          } catch (e) {
            console.error("Transcript formatting failed, using raw:", e);
          }
        }

        // Step 2: Persist to video_jobs with formatted transcript + merged metadata
        await supabase.from("video_jobs").update({
          status: "completed",
          pdf_url: engineStatus.url,
          transcript: finalTranscript || null,
          title: (engineStatus.metadata && engineStatus.metadata.title) || null,
          metadata: mergedMetadata,
          word_count: engineStatus.word_count || 0,
          error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", jobId);

        const meta = engineStatus.metadata || {};
        const docTitle = (meta.title as string) || (job.video_url as string) || "Video Transcript";
        const channel = (meta.channel as string) || "Unknown";
        const durationSecs = meta.duration_seconds as number | undefined;
        const duration = durationSecs
          ? `${Math.floor(durationSecs / 60)}m ${Math.round(durationSecs % 60)}s`
          : "";

        // Step 3: Auto-save to wiki (deduped by source_url)
        if (finalTranscript) {
          const { data: existingWiki } = await supabase
            .from("wiki_entries")
            .select("id")
            .eq("user_id", user.id)
            .eq("source_url", job.video_url)
            .maybeSingle();

          if (!existingWiki) {
            const pdfLink = engineStatus.url
              ? `**[Download Transcript](${engineStatus.url})**\n\n---\n\n`
              : "";
            const tags = formattedSuccessfully
              ? ["video", "transcript", "chapterized"]
              : ["video", "transcript"];

            await supabase.from("wiki_entries").insert({
              user_id: user.id,
              title: docTitle,
              content: pdfLink + finalTranscript,
              summary: `Video transcript — ${channel}${duration ? ` · ${duration}` : ""}`,
              subject: "Video Transcript",
              kind: "video",
              maturity: "note",
              tags,
              source_url: job.video_url,
            });
          }
        }

        // Step 4: Auto-save HTML book to library (deduped by file_name)
        if (finalTranscript) {
          try {
            const fileName = `video-${jobId}.html`;
            const { data: existingBook } = await supabase
              .from("books")
              .select("id")
              .eq("user_id", user.id)
              .eq("file_name", fileName)
              .maybeSingle();

            if (!existingBook) {
              const htmlContent = buildHtml(docTitle, finalTranscript);
              const htmlBytes = new TextEncoder().encode(htmlContent);
              const bookId = crypto.randomUUID();
              const storagePath = `${user.id}/${bookId}.html`;

              const { error: upErr } = await supabase.storage
                .from("book-pdfs")
                .upload(storagePath, htmlBytes, { contentType: "text/html; charset=utf-8", upsert: true });

              if (upErr) {
                console.error("HTML library upload failed:", upErr);
              } else {
                const { data: bookRow, error: insErr } = await supabase
                  .from("books")
                  .insert({ id: bookId, user_id: user.id, title: docTitle, file_name: fileName, page_count: 0 })
                  .select("id")
                  .single();

                if (insErr) {
                  console.error("HTML library insert failed:", insErr);
                  await supabase.storage.from("book-pdfs").remove([storagePath]);
                } else if (bookRow) {
                  // Auto-create chapters from <h2> headings
                  const sections = extractHtmlSections(htmlContent);
                  await Promise.all(
                    sections.map((section, i) =>
                      supabase.from("chapters").insert({
                        id: crypto.randomUUID(),
                        book_id: bookRow.id,
                        user_id: user.id,
                        name: section.title,
                        start_page: i + 1,
                        end_page: i + 1,
                        text_content: section.textContent,
                      })
                    )
                  );
                }
              }
            }
          } catch (libErr) {
            console.error("HTML library auto-save error:", libErr);
          }
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

// ── Transcript formatting ────────────────────────────────────────────────────

async function formatTranscriptForChapterization(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  transcript: string,
): Promise<string> {
  const llm = await resolveWikiLlm(supabase, userId);

  const systemPrompt = `You are a transcript formatter that prepares raw video transcripts for chapter detection.

Your job:
1. Read the transcript and identify 4–12 major topic shifts (depending on length).
2. Insert a markdown heading (## Section Title) at each transition with a clear, descriptive title.
3. Group the surrounding text into readable paragraphs under each heading.
4. Remove filler words (um, uh, you know, like, right?) when they don't affect meaning — preserve all substantive content.
5. Add a "## Table of Contents" section at the very top that lists every heading with a one-sentence description.
6. Do NOT summarize, paraphrase, or omit any substantive content.
7. Return ONLY the formatted transcript — no preamble, no explanation.

Output format:
## Table of Contents
- Chapter Title: One-sentence description
...

---

## Chapter Title
[formatted content]

## Next Chapter Title
[formatted content]`;

  const res = await fetch(llm.url, {
    method: "POST",
    headers: llm.headers,
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Format this video transcript for chapterization:\n\n${transcript}` },
      ],
      max_tokens: 12000,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM call failed (${res.status}): ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  const formatted = data?.choices?.[0]?.message?.content;
  if (!formatted) throw new Error("Empty response from LLM");
  return formatted;
}

// ── HTML generation ──────────────────────────────────────────────────────────

function buildHtml(title: string, transcript: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  type Section = { id: string; title: string; rawLines: string[] };
  const lines = transcript.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  const preambleLines: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (current) sections.push(current);
      current = { id: `section-${sections.length + 1}`, title: h2[1].trim(), rawLines: [] };
    } else if (current) {
      current.rawLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);

  const isTocSection = (s: Section) => /^table of contents/i.test(s.title);
  const contentSections = sections.filter((s) => !isTocSection(s));

  let tocHtml = "";
  if (contentSections.length > 1) {
    const items = contentSections
      .map((s) => `      <li><a href="#${s.id}">${esc(s.title)}</a></li>`)
      .join("\n");
    tocHtml = `<nav class="toc">\n    <p class="toc-label">Contents</p>\n    <ol>\n${items}\n    </ol>\n  </nav>`;
  }

  const sectionsHtml = contentSections
    .map(
      (s) =>
        `<section id="${s.id}">\n    <h2>${esc(s.title)}</h2>\n    ${linesToBodyHtml(s.rawLines)}\n  </section>`,
    )
    .join("\n\n  ");

  const preambleHtml = preambleLines.length > 0 ? linesToBodyHtml(preambleLines) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 16px;
      line-height: 1.75;
      color: #1c1c1e;
      background: #f9f9f7;
      max-width: 800px;
      margin: 0 auto;
      padding: 2.5rem 1.5rem 5rem;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #e8e8e0; }
      a { color: #7eb8f7; }
      .toc { background: #1c1c1e; border-color: #2c2c2e; }
      h2 { border-color: #2c2c2e; }
      hr { border-color: #2c2c2e; }
    }
    h1 { font-size: 2rem; font-weight: 700; line-height: 1.2; margin-bottom: 1.5rem; }
    h2 { font-size: 1.25rem; font-weight: 700; margin-top: 0; padding-bottom: 0.4rem; border-bottom: 1px solid #e5e5e3; }
    p { margin: 0.8rem 0; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    hr { border: none; border-top: 1px solid #e5e5e3; margin: 2rem 0; }
    section { margin-top: 2.5rem; }
    .toc { background: #f3f3f1; border: 1px solid #e5e5e3; border-radius: 10px; padding: 1.2rem 1.5rem; margin: 1.5rem 0 2rem; }
    .toc-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 0.6rem; }
    .toc ol { padding-left: 1.2rem; }
    .toc li { margin: 0.3rem 0; font-size: 0.95rem; }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  ${tocHtml}
  ${preambleHtml}
  ${sectionsHtml}
</body>
</html>`;
}

function linesToBodyHtml(lines: string[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const applyInline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>");

  const paras: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    paras.push(`<p>${applyInline(buf.join(" "))}</p>`);
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
    } else if (trimmed === "---") {
      flush();
      paras.push("<hr>");
    } else {
      buf.push(trimmed);
    }
  }
  flush();
  return paras.join("\n    ");
}

function extractHtmlSections(html: string): Array<{ title: string; textContent: string }> {
  const sections: Array<{ title: string; textContent: string }> = [];
  const re = /<section[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = m[1].replace(/<[^>]+>/g, "").trim();
    const body = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (title) sections.push({ title, textContent: body });
  }
  return sections;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
