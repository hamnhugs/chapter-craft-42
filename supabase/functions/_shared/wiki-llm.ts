// Helper to route wiki LLM calls through OpenRouter (when the user has chosen
// a wiki_model + has an OpenRouter key) or the Lovable AI Gateway by default.

export interface WikiLlmTarget {
  url: string;
  headers: Record<string, string>;
  model: string;
  provider: "openrouter" | "lovable";
}

const DEFAULT_MODEL = "google/gemini-3-flash-preview";

export async function resolveWikiLlm(
  supabase: any,
  userId: string,
): Promise<WikiLlmTarget> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";
  let wikiModel = "";
  let openrouterKey = "";
  try {
    const { data } = await supabase
      .from("user_settings")
      .select("wiki_model, openrouter_api_key")
      .eq("user_id", userId)
      .maybeSingle();
    wikiModel = (data?.wiki_model || "").trim();
    openrouterKey = (data?.openrouter_api_key || "").trim();
  } catch (_e) { /* fall back to defaults */ }

  if (wikiModel && openrouterKey) {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://bookwormstudio.com",
        "X-Title": "Bookworm Wiki",
      },
      model: wikiModel,
      provider: "openrouter",
    };
  }

  return {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    model: DEFAULT_MODEL,
    provider: "lovable",
  };
}
