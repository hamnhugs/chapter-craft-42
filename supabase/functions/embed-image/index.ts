// embed-image: when a new image_memories row is created, this function asks
// Gemini Flash (via the Lovable AI gateway) for a structured caption + OCR
// pass, then writes the results back so the assistant can recall the image
// later via search_images / list_recent_images.
//
// v1 keeps storage cheap: we rely on the row's `tsv` GENERATED COLUMN
// (caption + ocr_text → tsvector) for hybrid retrieval, no per-image vector.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CAPTION_MODEL = "google/gemini-2.5-flash";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const memoryId: string | undefined = body?.memory_id;
    if (!memoryId) {
      return new Response(JSON.stringify({ error: "memory_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: row, error: fetchErr } = await supabase
      .from("image_memories")
      .select("id, user_id, storage_path, mime_type")
      .eq("id", memoryId)
      .single();
    if (fetchErr || !row || row.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Signed URL → fetch bytes → data URL for the model
    const signed = await supabase.storage
      .from("generated-images")
      .createSignedUrl(row.storage_path, 60 * 10);
    if (!signed.data?.signedUrl) throw new Error("Could not sign storage URL");
    const imgResp = await fetch(signed.data.signedUrl);
    if (!imgResp.ok) throw new Error(`Image fetch ${imgResp.status}`);
    const buf = new Uint8Array(await imgResp.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const b64 = btoa(bin);
    const mime = row.mime_type || "image/jpeg";
    const dataUrl = `data:${mime};base64,${b64}`;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sys = `You analyze a single image and return STRICT JSON:
{
 "caption": "1-2 dense sentences describing the image so it can be retrieved later by keyword search. Include any obvious subject, objects, setting, mood, art style, colors.",
 "ocr": "All readable text in the image, verbatim, in reading order. Empty string if none.",
 "tags": ["3-8","short","keywords"]
}
No prose outside the JSON object.`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CAPTION_MODEL,
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: [
              { type: "text", text: "Caption + OCR this image. Return only the JSON object." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
      }),
    });
    if (!aiResp.ok) {
      const t = await aiResp.text();
      throw new Error(`Caption API ${aiResp.status}: ${t.slice(0, 300)}`);
    }
    const aiJson = await aiResp.json();
    const raw: string = aiJson?.choices?.[0]?.message?.content || "{}";
    const jsonText = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsed: { caption?: string; ocr?: string; tags?: string[] } = {};
    try { parsed = JSON.parse(jsonText); } catch { parsed = { caption: raw.slice(0, 600) }; }

    const caption = (parsed.caption || "").slice(0, 2000);
    const ocr = (parsed.ocr || "").slice(0, 4000);
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === "string").slice(0, 12) : [];

    const { error: updErr } = await supabase
      .from("image_memories")
      .update({ caption, ocr_text: ocr, tags })
      .eq("id", memoryId);
    if (updErr) throw updErr;

    return new Response(JSON.stringify({ ok: true, caption, ocr_len: ocr.length, tags }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[embed-image]", e?.message || e);
    return new Response(JSON.stringify({ error: e?.message || "Embed failed" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
