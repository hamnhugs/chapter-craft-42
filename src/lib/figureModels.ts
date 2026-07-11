// Curated OpenRouter vision models for figure extraction (describing document
// figures + pairing them with neurons). IDs verified against the live
// openrouter.ai/api/v1/models catalog, July 2026. The Settings picker merges
// these with the user's saved models; "" means the built-in default below.

export const DEFAULT_FIGURE_MODEL = "google/gemini-3-flash-preview";

export interface FigureModelPick {
  id: string;
  label: string;
}

export const FIGURE_MODELS_PAID: FigureModelPick[] = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash — best value, top OCR (~$0.50/M in)" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro — max quality ($2/M in)" },
  { id: "qwen/qwen3-vl-235b-a22b-instruct", label: "Qwen3-VL 235B — cheapest strong doc model ($0.20/M in)" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 — best relevance judgment ($2/M in)" },
];

export const FIGURE_MODELS_FREE: FigureModelPick[] = [
  { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (free) — fast, most reliable JSON" },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free) — strongest free vision model" },
  { id: "nvidia/nemotron-nano-12b-v2-vl:free", label: "Nemotron Nano 12B VL (free) — document specialist" },
];
