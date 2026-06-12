import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// auto-structure: turns a numbered list of candidate heading lines (extracted
// client-side from an uploaded book/paper PDF) into a clean chapter/section
// structure. Token-efficient by design: the client never sends the full book —
// only short candidate lines — and the model answers with INDICES into that
// list, so it cannot hallucinate page numbers.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Long-context defaults (all ≥1M ctx). Primary per user preference; fallbacks
// are cheaper models OpenRouter falls through to on errors/rate limits.
const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.5-flash";
const OPENROUTER_FALLBACK_MODELS = [
  "google/gemini-3-flash-preview",
  "deepseek/deepseek-v4-flash",
];
const LOVABLE_DEFAULT_MODEL = "google/gemini-3-flash-preview";

const MAX_CANDIDATES = 500;
const MAX_CANDIDATE_TEXT = 140;
const MAX_TOC_TEXT = 6000;

interface Candidate {
  i: number;
  page: number;
  level?: number;
  text: string;
}

const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    doc_type: { type: "string", enum: ["book", "paper", "other"] },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          title: { type: "string" },
          level: { type: "integer" },
          kind: {
            type: "string",
            enum: ["part", "chapter", "section", "front_matter", "back_matter"],
          },
        },
        required: ["i", "title", "level", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["doc_type", "entries"],
  additionalProperties: false,
};

// Lenient JSON extraction: strip code fences, find the outermost object.
function parseLenientJson(raw: string): any | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPrompt(
  docType: string,
  candidates: Candidate[],
  pageCount: number,
  tocText: string,
): { system: string; user: string } {
  const system = `You identify the structure of documents from candidate heading lines.

You receive a numbered list of candidate lines extracted from a ${pageCount}-page document. Each candidate has an index, the page it appears on, and its raw text. Many candidates are noise: running headers/footers, figure captions, table rows, sentence fragments, or table-of-contents lines (often with dot leaders like "....  12").

Select ONLY the candidates that are true structural headings, in reading order:
- For books: parts and chapters (including named ones like Prologue, Epilogue, Introduction). Do not include sub-headings inside chapters.
- For research papers / reports without chapters: top-level sections (Abstract, Introduction, Methods, Results, Discussion, Conclusion, References, Appendix, ...) and numbered subsections like "2.1 ..." as level 2.
- If a heading's text repeats on many pages (a running header), choose only its first true occurrence.

Rules:
- NEVER invent entries. Only reference indices that exist in the list.
- Clean each title: collapse whitespace, remove trailing page numbers and dot leaders, fix obvious OCR letter-spacing (e.g. "C H A P T E R  O N E" -> "Chapter One"). Keep the original wording otherwise.
- level: 1 = top-level (part/chapter/main section), 2 = subsection, 3 = sub-subsection.
- kind: "part" | "chapter" | "section" | "front_matter" (title page, copyright, dedication, table of contents) | "back_matter" (references, bibliography, index, appendix, acknowledgments at the end).
- Selected entries must be in strictly non-decreasing page order.

Respond with ONLY this JSON, no prose:
{"doc_type": "book" | "paper" | "other", "entries": [{"i": <candidate index>, "title": "...", "level": 1, "kind": "chapter"}]}`;

  const lines = candidates
    .map((c) => `[${c.i}] p.${c.page}${c.level ? ` L${c.level}` : ""}: ${c.text}`)
    .join("\n");

  let user = `Document type hint: ${docType || "unknown"}\nTotal pages: ${pageCount}\n\nCandidate lines:\n${lines}`;
  if (tocText) {
    user += `\n\nFor cross-checking only — text from the document's printed table-of-contents pages (do NOT select headings from here; select from the candidate list above):\n${tocText}`;
  }
  return { system, user };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    // Auto-chapterize is a paid feature — verify the plan server-side so a
    // tampered client can't bypass the gate. Admins are exempt (the RPC
    // re-checks the role in the database); everyone else needs an active
    // subscription. RLS lets the user read own row.
    const { data: adminFlag } = await supabase.rpc("is_admin");
    if (!adminFlag) {
      const { data: subRow } = await supabase
        .from("subscribers")
        .select("subscribed")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!subRow?.subscribed) {
        return json({ error: "Auto-chapterize is a Pro feature. Upgrade to detect chapters automatically." }, 402);
      }
    }

    const body = await req.json().catch(() => ({}));
    const rawCandidates: Candidate[] = Array.isArray(body?.candidates) ? body.candidates : [];
    if (rawCandidates.length === 0) return json({ error: "No candidates provided" }, 400);

    const pageCount = Math.max(1, Number(body?.pageCount) || 1);
    const docType = typeof body?.docType === "string" ? body.docType : "unknown";
    const tocText = typeof body?.tocText === "string" ? body.tocText.slice(0, MAX_TOC_TEXT) : "";

    const candidates: Candidate[] = rawCandidates
      .slice(0, MAX_CANDIDATES)
      .map((c: any, idx: number) => ({
        i: typeof c.i === "number" ? c.i : idx,
        page: Math.max(1, Number(c.page) || 1),
        level: typeof c.level === "number" ? c.level : undefined,
        text: String(c.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CANDIDATE_TEXT),
      }))
      .filter((c) => c.text.length > 0);

    // Resolve provider: OpenRouter if the user has a key (sent in body or saved
    // in settings), otherwise the Lovable AI gateway.
    let openrouterKey = (body?.openrouterApiKey || "").trim();
    if (!openrouterKey) {
      try {
        const { data } = await supabase
          .from("user_settings")
          .select("openrouter_api_key")
          .eq("user_id", user.id)
          .maybeSingle();
        openrouterKey = (data?.openrouter_api_key || "").trim();
      } catch (_e) { /* fall through to Lovable */ }
    }

    const requestedModel = (body?.model || "").trim();
    const { system, user: userMsg } = buildPrompt(docType, candidates, pageCount, tocText);
    const messages = [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ];

    let aiResponse: Response;
    if (openrouterKey) {
      const model = requestedModel || OPENROUTER_DEFAULT_MODEL;
      const fallbacks = [model, ...OPENROUTER_FALLBACK_MODELS.filter((m) => m !== model)];
      aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://bookwormstudio.com",
          "X-Title": "Bookworm Auto-Structure",
        },
        body: JSON.stringify({
          model,
          models: fallbacks,
          messages,
          temperature: 0,
          max_tokens: 16384,
          // TOC extraction needs no deep reasoning; output tokens cost 6x input.
          reasoning: { effort: "low" },
          response_format: {
            type: "json_schema",
            json_schema: { name: "structure", strict: true, schema: STRUCTURE_SCHEMA },
          },
        }),
      });
      // Some providers reject response_format; retry once without it.
      if (!aiResponse.ok && aiResponse.status >= 400 && aiResponse.status < 500) {
        const errText = await aiResponse.text();
        if (/response_format|json_schema|schema/i.test(errText)) {
          aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${openrouterKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://bookwormstudio.com",
              "X-Title": "Bookworm Auto-Structure",
            },
            body: JSON.stringify({
              model,
              models: fallbacks,
              messages,
              temperature: 0,
              max_tokens: 16384,
              reasoning: { effort: "low" },
            }),
          });
        } else {
          return json({ error: `AI request failed (${aiResponse.status}): ${errText.slice(0, 400)}` }, 502);
        }
      }
    } else {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) return json({ error: "AI service not configured" }, 500);
      const model =
        requestedModel && (requestedModel.startsWith("google/") || requestedModel.startsWith("openai/"))
          ? requestedModel
          : LOVABLE_DEFAULT_MODEL;
      aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 16384 }),
      });
    }

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("auto-structure AI error:", aiResponse.status, errText.slice(0, 500));
      if (aiResponse.status === 429) return json({ error: "AI rate limit reached. Try again shortly." }, 429);
      return json({ error: `AI request failed (${aiResponse.status})` }, 502);
    }

    const completion = await aiResponse.json();
    const content: string = completion?.choices?.[0]?.message?.content || "";
    const parsed = parseLenientJson(content);
    if (!parsed || !Array.isArray(parsed.entries)) {
      console.error("auto-structure parse failure:", content.slice(0, 500));
      return json({ error: "AI returned an unreadable structure. Try again." }, 502);
    }

    // Server-side sanity pass; the client validates again with full context.
    const byIndex = new Map(candidates.map((c) => [c.i, c]));
    const entries = parsed.entries
      .filter((e: any) => typeof e?.i === "number" && byIndex.has(e.i))
      .map((e: any) => ({
        i: e.i,
        title: String(e.title || byIndex.get(e.i)!.text).replace(/\s+/g, " ").trim().slice(0, 200),
        level: Math.min(3, Math.max(1, Number(e.level) || 1)),
        kind: ["part", "chapter", "section", "front_matter", "back_matter"].includes(e.kind)
          ? e.kind
          : "section",
        page: byIndex.get(e.i)!.page,
      }));

    return json({
      doc_type: ["book", "paper", "other"].includes(parsed.doc_type) ? parsed.doc_type : "other",
      entries,
      model_used: completion?.model || requestedModel || (openrouterKey ? OPENROUTER_DEFAULT_MODEL : LOVABLE_DEFAULT_MODEL),
      provider: openrouterKey ? "openrouter" : "lovable",
    });
  } catch (e) {
    console.error("auto-structure error:", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});
