import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// auto-tag: assigns one category (fixed taxonomy) and 3-6 free-form tags to a
// batch of library books, for the library mind-map graph and search.
//
// Token-efficient by design (research-backed):
//  - The client never sends full books — only title, chapter names, and ~3
//    short excerpts (start/middle/end). Genre/topic signal saturates within
//    the first ~1k tokens, so a whole novel adds cost, not accuracy.
//  - Books are batched (several per request) so the shared system prompt is
//    paid once, and the model sees sibling books in one context — which makes
//    it naturally reuse tags across them.
//  - The category is a closed enum enforced by the response schema (an open
//    category field fragments the graph); tags are open-vocabulary but the
//    prompt injects the library's existing tags so the model reuses "science
//    fiction" instead of coining "sci-fi" — shared tags are what create edges.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Same provider defaults as auto-structure (this is "the chapterize model").
const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.5-flash";
const OPENROUTER_FALLBACK_MODELS = [
  "google/gemini-3-flash-preview",
  "deepseek/deepseek-v4-flash",
];
const LOVABLE_DEFAULT_MODEL = "google/gemini-3-flash-preview";

const MAX_BOOKS = 10;
const MAX_EXCERPTS = 3;
const MAX_EXCERPT_CHARS = 1200;
const MAX_CHAPTER_TITLES = 40;
const MAX_EXISTING_TAGS = 150;

// Fixed taxonomy — compressed from BISAC's major subjects to a graph-friendly
// size. Single-select; the enum below is enforced by the response schema.
const CATEGORIES = [
  "fiction",
  "sci-fi & fantasy",
  "mystery & thriller",
  "romance",
  "history",
  "biography & memoir",
  "science & nature",
  "technology & computing",
  "business & economics",
  "self-improvement",
  "philosophy & religion",
  "politics & society",
  "arts & culture",
  "health & psychology",
  "reference & education",
  "poetry & essays",
  "other",
] as const;

const TAG_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          tags: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
        },
        required: ["id", "category", "tags"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

interface BookInput {
  id: string;
  title: string;
  chapterTitles: string[];
  excerpts: string[];
}

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

// Hard format rules kill most tag duplication (case/plural/punctuation
// variants); the existing-tags lookup below catches the rest.
function normalizeTag(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9&\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function buildPrompt(books: BookInput[], existingTags: string[]): { system: string; user: string } {
  const system = `You are a librarian cataloging a personal book library. For each book you receive, assign:
1. "category" — exactly ONE value from this fixed list (pick the best fit; use "other" only when nothing fits):
${CATEGORIES.map((c) => `   - ${c}`).join("\n")}
2. "tags" — 3 to 6 short topic tags describing the book's subject, themes, or setting (never quality judgments like "great" or formats like "pdf").

Tag rules (follow exactly):
- lowercase, singular, 1-3 words, letters/digits/hyphens only
- REUSE a tag from the existing-tags list whenever one fits; only coin a new tag when nothing in the list matches. Shared tags connect books in a graph, so consistency matters more than novelty.
${existingTags.length ? `\nExisting tags in this library (reuse these):\n${existingTags.join(", ")}` : ""}

Example: a book titled "Dune" → category "sci-fi & fantasy", tags ["space opera", "desert planet", "politics", "ecology"].

Respond with ONLY this JSON, no prose:
{"results": [{"id": "<book id>", "category": "<one category>", "tags": ["...", "..."]}]}
Include every book exactly once, keyed by its id.`;

  const user = books
    .map((b) => {
      const parts = [`### Book id: ${b.id}`, `Title: ${b.title}`];
      if (b.chapterTitles.length) parts.push(`Chapters: ${b.chapterTitles.join(" | ")}`);
      b.excerpts.forEach((ex, i) => parts.push(`Excerpt ${i + 1}: ${ex}`));
      return parts.join("\n");
    })
    .join("\n\n");

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

    const body = await req.json().catch(() => ({}));
    const rawBooks: any[] = Array.isArray(body?.books) ? body.books : [];
    if (rawBooks.length === 0) return json({ error: "No books provided" }, 400);

    const books: BookInput[] = rawBooks.slice(0, MAX_BOOKS).map((b: any) => ({
      id: String(b?.id || ""),
      title: String(b?.title || "Untitled").replace(/\s+/g, " ").trim().slice(0, 200),
      chapterTitles: (Array.isArray(b?.chapterTitles) ? b.chapterTitles : [])
        .slice(0, MAX_CHAPTER_TITLES)
        .map((t: any) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 120))
        .filter((t: string) => t.length > 0),
      excerpts: (Array.isArray(b?.excerpts) ? b.excerpts : [])
        .slice(0, MAX_EXCERPTS)
        .map((e: any) => String(e || "").replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS))
        .filter((e: string) => e.length > 0),
    })).filter((b) => b.id);
    if (books.length === 0) return json({ error: "No valid books provided" }, 400);

    const existingTags = (Array.isArray(body?.existingTags) ? body.existingTags : [])
      .map((t: any) => normalizeTag(t))
      .filter((t: string) => t.length > 0)
      .slice(0, MAX_EXISTING_TAGS);

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
    const { system, user: userMsg } = buildPrompt(books, existingTags);
    const messages = [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ];

    let aiResponse: Response;
    if (openrouterKey) {
      const model = requestedModel || OPENROUTER_DEFAULT_MODEL;
      const fallbacks = [model, ...OPENROUTER_FALLBACK_MODELS.filter((m) => m !== model)];
      const orHeaders = {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://bookwormstudio.com",
        "X-Title": "Bookworm Auto-Tag",
      };
      aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: orHeaders,
        body: JSON.stringify({
          model,
          models: fallbacks,
          messages,
          temperature: 0,
          max_tokens: 4096,
          // Classification needs no deep reasoning; output tokens cost 6x input.
          reasoning: { effort: "low" },
          response_format: {
            type: "json_schema",
            json_schema: { name: "tagging", strict: true, schema: TAG_SCHEMA },
          },
        }),
      });
      // Some providers reject response_format; retry once without it.
      if (!aiResponse.ok && aiResponse.status >= 400 && aiResponse.status < 500) {
        const errText = await aiResponse.text();
        if (/response_format|json_schema|schema/i.test(errText)) {
          aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: orHeaders,
            body: JSON.stringify({
              model,
              models: fallbacks,
              messages,
              temperature: 0,
              max_tokens: 4096,
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
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 4096 }),
      });
    }

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("auto-tag AI error:", aiResponse.status, errText.slice(0, 500));
      if (aiResponse.status === 429) return json({ error: "AI rate limit reached. Try again shortly." }, 429);
      return json({ error: `AI request failed (${aiResponse.status})` }, 502);
    }

    const completion = await aiResponse.json();
    const content: string = completion?.choices?.[0]?.message?.content || "";
    const parsed = parseLenientJson(content);
    if (!parsed || !Array.isArray(parsed.results)) {
      console.error("auto-tag parse failure:", content.slice(0, 500));
      return json({ error: "AI returned unreadable tags. Try again." }, 502);
    }

    // Server-side sanity pass: only echo back ids we sent, valid categories,
    // and normalized tags mapped onto the existing vocabulary when they match.
    const sentIds = new Set(books.map((b) => b.id));
    const validCategories = new Set<string>(CATEGORIES);
    const canonical = new Map(existingTags.map((t) => [t, t]));
    const results = parsed.results
      .filter((r: any) => typeof r?.id === "string" && sentIds.has(r.id))
      .map((r: any) => {
        const tags: string[] = [];
        for (const raw of Array.isArray(r.tags) ? r.tags : []) {
          const norm = normalizeTag(raw);
          if (!norm) continue;
          const tag = canonical.get(norm) ?? norm;
          if (!tags.includes(tag)) tags.push(tag);
          canonical.set(norm, tag); // later books in the batch reuse it too
          if (tags.length >= 6) break;
        }
        return {
          id: r.id,
          category: validCategories.has(r.category) ? r.category : "other",
          tags,
        };
      })
      .filter((r: any) => r.tags.length > 0);

    return json({
      results,
      categories: CATEGORIES,
      model_used: completion?.model || requestedModel || (openrouterKey ? OPENROUTER_DEFAULT_MODEL : LOVABLE_DEFAULT_MODEL),
      provider: openrouterKey ? "openrouter" : "lovable",
    });
  } catch (e) {
    console.error("auto-tag error:", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});
