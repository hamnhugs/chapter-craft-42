// describe-figures: vision-model proxy for book figure extraction.
//
// The client extracts figure crops from the PDF locally (free) and sends a
// small batch here as data URLs, together with the page context and the
// book's neuron titles. One model call describes every figure in the batch
// AND picks the single best-matching neuron per figure (or none) — the
// token-efficient "caption once, store forever" pattern: after this call the
// image never has to pass through a model again.
//
// Provider policy mirrors auto-structure: the user's own OpenRouter key +
// their chosen figure-extraction model when set; otherwise the Lovable AI
// gateway (app credits), which is Pro-gated server-side.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const DEFAULT_MODEL = "google/gemini-3-flash-preview";
const MAX_FIGURES = 6;
const MAX_CANDIDATES = 400;
const MAX_CONTEXT = 800;
const MAX_TITLE = 140;
const MAX_DATA_URL = 3_500_000; // chars (~2.5MB image)
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

interface FigureIn { data_url: string; page: number; context: string }
interface CandidateIn { id: string; title: string }

function buildMessages(bookTitle: string, figures: FigureIn[], candidates: CandidateIn[]) {
  const system = [
    'You analyze figures extracted from a document so they can be attached to the user\'s knowledge notes ("neurons") and shown while learning. Return STRICT JSON only:',
    '{"figures":[{"index":0,"alt":"short label, max 12 words","caption":"2-4 dense sentences describing the figure — include any text or labels readable in it and what it teaches","type":"photo|diagram|chart|sign|map|illustration|table|decorative","concept_id":"<id from CONCEPTS>"|null,"keep":true|false}]}',
    "Rules:",
    "- Exactly one object per input figure, in the same order, with matching index.",
    "- concept_id: the id of the SINGLE concept this figure directly illustrates. Pick one only when the match is clear from the figure and its page text; otherwise use null. Never invent an id.",
    "- keep=false for page furniture with no instructional value: logos, watermarks, decorative borders, publisher marks, author photos, QR codes, cover art.",
    "- Research shows irrelevant images actively harm learning — be strict about both keep and concept_id.",
    "No prose outside the JSON object.",
  ].join("\n");

  const candidateLines = candidates.map((c) => `${c.id} | ${c.title}`).join("\n");
  const content: unknown[] = [{
    type: "text",
    text: `DOCUMENT: "${bookTitle}"\n\nCONCEPTS (id | title):\n${candidateLines}\n\nAnalyze the ${figures.length} figure(s) below. Use each figure's nearby page text to understand what it illustrates.`,
  }];
  figures.forEach((f, i) => {
    content.push({
      type: "text",
      text: `FIGURE ${i} — page ${f.page}.${f.context ? ` Nearby text: ${f.context}` : ""}`,
    });
    content.push({ type: "image_url", image_url: { url: f.data_url } });
  });

  return [
    { role: "system", content: system },
    { role: "user", content },
  ];
}

async function callModel(
  endpoint: string,
  key: string,
  model: string,
  messages: unknown[],
): Promise<Response> {
  const base = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 4000,
  };
  let resp = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, response_format: { type: "json_object" } }),
  });
  // Some models/providers reject response_format — retry once without it.
  if (!resp.ok && resp.status >= 400 && resp.status < 500) {
    const errText = await resp.text();
    if (/response_format|json_object|json_schema|schema/i.test(errText)) {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(base),
      });
    } else {
      return new Response(errText, { status: resp.status });
    }
  }
  return resp;
}

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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));

    const rawFigures = Array.isArray(body?.figures) ? body.figures : [];
    if (rawFigures.length === 0 || rawFigures.length > MAX_FIGURES) {
      return json({ error: `figures must contain 1–${MAX_FIGURES} items` }, 400);
    }
    const figures: FigureIn[] = [];
    for (const f of rawFigures) {
      const dataUrl = String(f?.data_url || "");
      if (dataUrl.length > MAX_DATA_URL || !DATA_URL_RE.test(dataUrl)) {
        return json({ error: "Each figure needs a valid data:image/... URL" }, 400);
      }
      figures.push({
        data_url: dataUrl,
        page: Math.max(1, Number(f?.page) || 1),
        context: String(f?.context || "").slice(0, MAX_CONTEXT),
      });
    }

    const candidates: CandidateIn[] = (Array.isArray(body?.candidates) ? body.candidates : [])
      .slice(0, MAX_CANDIDATES)
      .map((c: any) => ({
        id: String(c?.id || ""),
        title: String(c?.title || "").replace(/\s+/g, " ").slice(0, MAX_TITLE),
      }))
      .filter((c: CandidateIn) => c.id.length > 0 && c.title.length > 0);
    if (candidates.length === 0) return json({ error: "candidates required" }, 400);

    const bookTitle = String(body?.book_title || "Untitled").slice(0, 120);

    // Provider + model resolution (user key → OpenRouter, else gateway).
    // Two queries on purpose: image_extraction_model is a new column, and a
    // combined select would 400 (taking the user's saved key down with it)
    // until the migration applies. supabase-js returns errors, not throws.
    let orKey = "";
    let settingsModel = "";
    {
      const { data } = await supabase
        .from("user_settings")
        .select("openrouter_api_key")
        .eq("user_id", user.id)
        .maybeSingle();
      orKey = (data?.openrouter_api_key || "").trim();
    }
    {
      const { data, error } = await supabase
        .from("user_settings")
        .select("image_extraction_model")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!error) settingsModel = (data?.image_extraction_model || "").trim();
    }

    const requestedModel = (String(body?.model || "").trim() || settingsModel || DEFAULT_MODEL);

    let endpoint: string;
    let key: string;
    let model: string;
    if (orKey) {
      endpoint = "https://openrouter.ai/api/v1/chat/completions";
      key = orKey;
      model = requestedModel;
    } else {
      // Gateway spends the app's credits — Pro feature (admins exempt),
      // mirroring the auto-structure gate.
      const { data: adminFlag } = await supabase.rpc("is_admin");
      if (!adminFlag) {
        const { data: subRow } = await supabase
          .from("subscribers")
          .select("subscribed")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!subRow?.subscribed) {
          return json({ error: "Figure extraction without your own OpenRouter key is a Pro feature — add a key in Settings → AI Models & Keys, or upgrade." }, 402);
        }
      }
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) return json({ error: "AI not configured" }, 500);
      endpoint = "https://ai.gateway.lovable.dev/v1/chat/completions";
      key = LOVABLE_API_KEY;
      // The gateway serves Gemini models only — ":free" variants and other
      // OpenRouter-only IDs would fail every batch, so coerce to the default.
      model = /^google\/gemini-/.test(requestedModel) && !requestedModel.endsWith(":free")
        ? requestedModel
        : DEFAULT_MODEL;
    }

    const messages = buildMessages(bookTitle, figures, candidates);
    const aiResp = await callModel(endpoint, key, model, messages);
    if (!aiResp.ok) {
      const t = await aiResp.text().catch(() => "");
      // Attribute errors to the provider that actually served the request.
      if (orKey) {
        if (aiResp.status === 401) return json({ error: "Your OpenRouter API key was rejected (401) — check it in Settings." }, 401);
        if (aiResp.status === 402) return json({ error: "OpenRouter credits exhausted (402) — top up or switch to a free vision model." }, 402);
      } else {
        if (aiResp.status === 401 || aiResp.status === 402) {
          return json({ error: "The built-in AI service is unavailable right now — add your own OpenRouter key in Settings → AI Models & Keys to keep extracting figures." }, aiResp.status);
        }
      }
      if (aiResp.status === 429) return json({ error: "Rate limited (429) — free vision models allow ~20 requests/min. It will retry automatically." }, 429);
      return json({ error: `Vision model request failed (${aiResp.status}): ${t.slice(0, 300)}` }, 502);
    }

    const aiJson = await aiResp.json();
    const raw: string = aiJson?.choices?.[0]?.message?.content || "{}";
    const jsonText = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsed: any = {};
    try { parsed = JSON.parse(jsonText); } catch {
      // Last resort: pull the first {...} block out of a chatty reply.
      const m = jsonText.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = {}; } }
    }
    const list: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.figures) ? parsed.figures : [];
    if (list.length === 0) {
      return json({ error: "The vision model returned no parseable result — try a different figure extraction model in Settings." }, 502);
    }

    // Normalize model-returned indices: only trust them when they form
    // exactly {0..n-1} (also accepting a uniform 1-based shift); anything
    // else falls back to positional order. A wrong index here would attach a
    // caption and neuron pairing to the WRONG figure — permanently.
    const n = figures.length;
    const rawIdx = list.slice(0, n).map((r: any) => (typeof r?.index === "number" ? r.index : NaN));
    const isPerm = (offset: number) => {
      const seen = new Set<number>();
      for (const v of rawIdx) {
        const x = v - offset;
        if (!Number.isInteger(x) || x < 0 || x >= n || seen.has(x)) return false;
        seen.add(x);
      }
      return true;
    };
    const offset = isPerm(0) ? 0 : isPerm(1) ? 1 : null;

    const validIds = new Set(candidates.map((c) => c.id));
    const results = list.slice(0, n).map((r: any, i: number) => {
      const conceptId = typeof r?.concept_id === "string" && validIds.has(r.concept_id) ? r.concept_id : null;
      const type = typeof r?.type === "string" ? r.type.toLowerCase().slice(0, 20) : "illustration";
      return {
        index: offset === null ? i : (r.index as number) - offset,
        alt: String(r?.alt || "").replace(/\s+/g, " ").slice(0, 160),
        caption: String(r?.caption || "").slice(0, 2000),
        type,
        concept_id: conceptId,
        keep: r?.keep !== false && type !== "decorative",
      };
    });

    return json({ results, model_used: model });
  } catch (e: any) {
    console.error("[describe-figures]", e?.message || e);
    return json({ error: e?.message || "describe-figures failed" }, 500);
  }
});
