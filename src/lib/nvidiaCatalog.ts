// NVIDIA model catalog: curated metadata + junk filters.
//
// NVIDIA's GET /v1/models returns ids only — no context length, no
// modalities, no capability flags. So capabilities are DECLARED here (from
// each model's build.nvidia.com page, checked 2026-07-31), never probed at
// runtime, with conservative defaults for uncurated models. This is the
// industry-standard answer to metadata-poor providers (Continue/Cline/pi's
// curated tables). Refresh manually; nothing scrapes NVIDIA at runtime.

import { NVIDIA_PREFIX } from "@/lib/providers/registry";
import { nvidiaAdapter, relayFetch } from "@/lib/providers/nvidiaAdapter";

export interface NvidiaModelCaps {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

export interface NvidiaModelInfo {
  /** Provider-local id, e.g. "deepseek-ai/deepseek-v4-flash". */
  localId: string;
  label: string;
  contextLength?: number;
  caps: NvidiaModelCaps;
  /** Sent verbatim in the request body (reasoning toggles are per-family and
   *  defaults are undocumented — always send them explicitly). */
  extraBody?: Record<string, unknown>;
  /** NVIDIA's VL playground marks images as disabling tools — when true and
   *  the turn carries image parts, the request omits tools. */
  imagesDisableTools?: boolean;
  featured?: boolean;
  note?: string;
}

/** Curated featured list for a writer's chat app: strong instruction
 *  following + tool calling, plus the user's requested DiffusionGemma. */
export const NVIDIA_FEATURED: NvidiaModelInfo[] = [
  {
    localId: "nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super 120B",
    contextLength: 1_048_576,
    caps: { tools: true, vision: false, reasoning: true },
    extraBody: { chat_template_kwargs: { enable_thinking: true } },
    featured: true,
    note: "NVIDIA's agentic flagship — planning + tool calling, 1M context.",
  },
  {
    localId: "deepseek-ai/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    contextLength: 1_048_576,
    caps: { tools: true, vision: false, reasoning: true },
    extraBody: { chat_template_kwargs: { thinking: false } },
    featured: true,
    note: "Fast daily driver, 1M context. Thinking off for speed.",
  },
  {
    localId: "deepseek-ai/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    contextLength: 1_048_576,
    caps: { tools: true, vision: false, reasoning: true },
    extraBody: { chat_template_kwargs: { thinking: true, reasoning_effort: "high" } },
    featured: true,
    note: "Frontier quality with visible thinking — slower, spends more credits.",
  },
  {
    localId: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    contextLength: 262_144,
    caps: { tools: true, vision: true, reasoning: true },
    featured: true,
    note: "Vision + tools in one model — best fit for chat with images.",
  },
  {
    localId: "google/diffusiongemma-26b-a4b-it",
    label: "DiffusionGemma 26B",
    contextLength: 262_144,
    caps: { tools: true, vision: true, reasoning: false },
    featured: true,
    note: "Diffusion language model — replies arrive in fast bursts after a pause. Tool support on NVIDIA's hosted API is new; disable tools for it in Settings if calls fail.",
  },
  {
    localId: "z-ai/glm-5.2",
    label: "GLM 5.2",
    contextLength: 1_048_576,
    caps: { tools: true, vision: false, reasoning: true },
    featured: true,
    note: "Top agentic benchmarks, 1M context.",
  },
  {
    localId: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    contextLength: 131_072,
    caps: { tools: true, vision: false, reasoning: true },
    featured: true,
  },
  {
    localId: "meta/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B",
    contextLength: 131_072,
    caps: { tools: true, vision: false, reasoning: false },
    featured: true,
    note: "Predictable classic — no thinking overhead.",
  },
  {
    localId: "google/gemma-4-31b-it",
    label: "Gemma 4 31B",
    contextLength: 262_144,
    caps: { tools: true, vision: true, reasoning: false },
    featured: true,
    note: "Reliable fallback while NVIDIA sorts account provisioning; vision too.",
  },
  {
    localId: "nvidia/nemotron-3-nano-30b-a3b",
    label: "Nemotron 3 Nano 30B",
    contextLength: 262_144,
    caps: { tools: true, vision: false, reasoning: true },
    extraBody: { chat_template_kwargs: { enable_thinking: true } },
    featured: true,
    note: "Budget tier — cheap on credits.",
  },
  {
    localId: "nvidia/nemotron-nano-12b-v2-vl",
    label: "Nemotron Nano 12B VL",
    contextLength: 131_072,
    caps: { tools: true, vision: true, reasoning: true },
    imagesDisableTools: true,
    featured: true,
    note: "Vision specialist; NVIDIA disables tools on turns that include images.",
  },
];

const FEATURED_BY_ID = new Map(NVIDIA_FEATURED.map((m) => [m.localId, m]));

/** Auto-selected for a user who onboards with only an NVIDIA key: tools, no
 *  reasoning overhead, no thinking-toggle guesswork — the least surprising
 *  first model. */
export const NVIDIA_STARTER_MODEL = "meta/llama-3.3-70b-instruct";

// Rows a chat picker should never offer (embeddings, safety/reward, OCR,
// translators, code specialists, legacy VLMs that live on a different
// endpoint family). Patterns derived from the live 102-row catalog.
const HIDE_PATTERNS: RegExp[] = [
  /embed|nvclip|bge-|nemoretriever/i,
  /guard|safety|topic-control|-reward\b|content-safety/i,
  /(^|\/)nemotron-parse|riva-translate|detector|deplot|ising-calibration/i,
  /cosmos/i,
  /code(gemma|llama|stral)|starcoder|deepseek-coder|-code-|laguna/i,
];
const HIDE_EXACT = new Set<string>([
  // Legacy multimodal family (served on ai.api.nvidia.com/v1/vlm, not the
  // chat-completions endpoint this integration speaks).
  "nvidia/vila",
  "nvidia/neva-22b",
  "microsoft/kosmos-2",
  "microsoft/phi-3-vision-128k-instruct",
  "adept/fuyu-8b",
  // Bases / tiny / legacy.
  "meta/llama2-70b",
  "meta/codellama-70b",
  "mistralai/mixtral-8x22b-v0.1",
  "google/gemma-2b",
  "google/recurrentgemma-2b",
  "nvidia/nemotron-mini-4b-instruct",
  "aisingapore/sea-lion-7b-instruct",
  "zyphra/zamba2-7b-instruct",
  "thinkingmachines/inkling",
  "nvidia/nemotron-4-340b-reward",
]);

export function isChatworthyNvidiaModel(localId: string): boolean {
  if (FEATURED_BY_ID.has(localId)) return true;
  if (HIDE_EXACT.has(localId)) return false;
  return !HIDE_PATTERNS.some((re) => re.test(localId));
}

/** Caps lookup, namespaced or local id. Uncurated models get conservative
 *  defaults: tools assumed available (most modern chat models have them; a
 *  clean per-request 400 surfaces the exceptions), vision assumed absent
 *  except for obvious "-vl"/"vision" ids, reasoning flagged by family name. */
export function nvidiaModelInfo(id: string): NvidiaModelInfo {
  const localId = id.startsWith(NVIDIA_PREFIX) ? id.slice(NVIDIA_PREFIX.length) : id;
  const curated = FEATURED_BY_ID.get(localId);
  if (curated) return curated;
  const s = localId.toLowerCase();
  return {
    localId,
    label: localId.split("/").pop() || localId,
    caps: {
      tools: true,
      vision: /-vl\b|-vl-|vision|omni/.test(s),
      reasoning: /deepseek|nemotron-3|glm|gpt-oss|reasoning|kimi|minimax/.test(s),
    },
  };
}

/** Model names that exist BYTE-IDENTICALLY on both NVIDIA and OpenRouter
 *  (measured against both live catalogs, 2026-07-31). These are the rows
 *  where "which provider is this?" is genuinely undecidable from the name,
 *  so the UI must say it explicitly and we must never guess on the user's
 *  behalf — the two are billed to different accounts. */
export const SHARED_WITH_OPENROUTER = new Set<string>([
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "google/gemma-4-31b-it",
  "google/gemma-3-12b-it",
  "google/gemma-3-4b-it",
  "moonshotai/kimi-k2.6",
  "z-ai/glm-5.2",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "mistralai/mistral-large",
  "thinkingmachines/inkling",
  "poolside/laguna-xs-2.1",
]);

/** The namespaced id the rest of the app stores and displays. */
export function namespacedNvidiaId(localId: string): string {
  return `${NVIDIA_PREFIX}${localId}`;
}

/** Request extras that pin thinking OFF, for background calls (the rolling
 *  summary) where reasoning tokens are pure waste — a 500-token budget spent
 *  thinking returns empty content, so the summary never advances and the
 *  same call repeats every turn. Toggle names differ per family, so this
 *  only inverts a toggle the curated entry already declares. */
export function nvidiaNoThinkingBody(id: string): Record<string, unknown> | undefined {
  const info = nvidiaModelInfo(id);
  const kw = (info.extraBody as any)?.chat_template_kwargs;
  if (!kw || typeof kw !== "object") return info.extraBody;
  const off = { ...kw };
  if ("thinking" in off) { off.thinking = false; delete off.reasoning_effort; }
  if ("enable_thinking" in off) off.enable_thinking = false;
  return { ...info.extraBody, chat_template_kwargs: off };
}

const CATALOG_CACHE_KEY = "nvidia_catalog_v1";
const CATALOG_TTL_MS = 60 * 60 * 1000;

/** Fetch the live model list through the relay (NVIDIA's CORS wall applies
 *  to /v1/models too), filtered to chat-worthy rows, featured first. */
export async function fetchNvidiaCatalog(): Promise<NvidiaModelInfo[]> {
  let ids: string[] | null = null;
  try {
    const cached = localStorage.getItem(CATALOG_CACHE_KEY);
    if (cached) {
      const { t, data } = JSON.parse(cached);
      if (Date.now() - t < CATALOG_TTL_MS && Array.isArray(data)) ids = data as string[];
    }
  } catch { /* corrupt cache — refetch */ }

  if (!ids) {
    const res = await relayFetch({ action: "models" });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("The NVIDIA relay isn't deployed yet — see Settings → AI Models & Keys for the setup step.");
      }
      const raw = await res.text().catch(() => "");
      let msg = `NVIDIA catalog request failed (${res.status})`;
      try { msg = JSON.parse(raw)?.error?.message || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    const json = await res.json();
    ids = ((json?.data || []) as Array<{ id?: string }>)
      .map((m) => String(m.id || ""))
      .filter(Boolean);
    try {
      localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ t: Date.now(), data: ids }));
    } catch { /* storage full — fine, just uncached */ }
  }

  const live = new Set(ids);
  const featured = NVIDIA_FEATURED.filter((m) => live.size === 0 || live.has(m.localId));
  const rest = ids
    .filter((id) => !FEATURED_BY_ID.has(id) && isChatworthyNvidiaModel(id))
    .sort()
    .map((id) => nvidiaModelInfo(id));
  return [...featured, ...rest];
}

export { nvidiaAdapter };
