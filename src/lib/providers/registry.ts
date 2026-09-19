// Provider resolution — the app's ONLY routing decision.
//
// One rule, zero migrations: OpenRouter ids keep their native "author/slug"
// form (every persisted setting stays valid), and every other provider
// carries a "<provider>:" prefix. The prefix uses a colon because model ids
// contain slashes — and bare ids CANNOT disambiguate: "nvidia/nemotron-nano-
// 12b-v2-vl" is a valid id on BOTH OpenRouter and NVIDIA, and essentially
// every Gemini model name also exists on OpenRouter as "google/<name>".
//
// Adding a provider means adding ONE row to PROVIDERS. Nothing else in the
// app may branch on provider identity — anything that needs to know asks
// through the helpers below, so a new provider can never silently fall
// through to OpenRouter.

import { ChatProviderAdapter, ProviderId } from "./types";
import { openrouterAdapter } from "./openrouterAdapter";
import { nvidiaAdapter } from "./nvidiaAdapter";
import { geminiAdapter } from "./geminiAdapter";

interface ProviderRecord {
  id: ProviderId;
  /** Namespace token stored in model ids, e.g. "nvidia:". Empty for the
   *  default provider, whose ids are stored bare. */
  prefix: string;
  label: string;
  adapter: ChatProviderAdapter;
  /** Which useChatSettings field holds the key the BROWSER must send.
   *  null = the browser never holds one (NVIDIA's key is write-only and read
   *  server-side by the relay). This lives here so key selection is one more
   *  table lookup rather than a branch someone forgets to extend — the exact
   *  omission that shipped Gemini chat authenticating with OpenRouter's key. */
  keyField: "apiKey" | "geminiApiKey" | null;
  /** Where to get a key. Shown in Settings and in "no key" error copy. */
  keyUrl: string;
  /** True when the provider has a genuinely free tier for chat — used to
   *  suggest an escape when a paid provider refuses. */
  freeChatTier: boolean;
}

export const NVIDIA_PREFIX = "nvidia:";
export const GEMINI_PREFIX = "gemini:";

/** Order matters for display only. OpenRouter is last because it is the
 *  bare-id fallback and must be matched by elimination, not by prefix. */
const PROVIDERS: ProviderRecord[] = [
  {
    id: "nvidia",
    prefix: NVIDIA_PREFIX,
    label: "NVIDIA",
    adapter: nvidiaAdapter,
    keyField: null, // write-only; the relay reads it under RLS
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    freeChatTier: true,
  },
  {
    id: "gemini",
    prefix: GEMINI_PREFIX,
    label: "Gemini",
    adapter: geminiAdapter,
    keyField: "geminiApiKey",
    keyUrl: "https://aistudio.google.com/apikey",
    freeChatTier: true,
  },
  {
    id: "openrouter",
    prefix: "", // bare ids — the default
    label: "OpenRouter",
    adapter: openrouterAdapter,
    keyField: "apiKey",
    keyUrl: "https://openrouter.ai/keys",
    freeChatTier: false, // needs a ~$10 lifetime top-up before ANY model runs
  },
];

const DEFAULT_PROVIDER = PROVIDERS[PROVIDERS.length - 1];

function recordFor(id: string): ProviderRecord {
  return PROVIDERS.find((p) => p.prefix && id.startsWith(p.prefix)) ?? DEFAULT_PROVIDER;
}

function recordById(p: ProviderId): ProviderRecord {
  return PROVIDERS.find((r) => r.id === p) ?? DEFAULT_PROVIDER;
}

export function modelProvider(id: string): ProviderId {
  return recordFor(id).id;
}

export function isNvidiaModel(id: string): boolean {
  return modelProvider(id) === "nvidia";
}

export function isGeminiModel(id: string): boolean {
  return modelProvider(id) === "gemini";
}

/** Human label for a provider — used in badges, error copy and the per-reply
 *  attribution line. With providers serving byte-identical model names, this
 *  is the only thing that tells them apart on screen. */
export function providerLabel(p: ProviderId): string {
  return recordById(p).label;
}

export function providerKeyUrl(p: ProviderId): string {
  return recordById(p).keyUrl;
}

/** The settings field holding this provider's browser-side key, or null when
 *  the browser never holds one. */
export function providerKeyField(p: ProviderId): "apiKey" | "geminiApiKey" | null {
  return recordById(p).keyField;
}

/** Does the user have what this provider needs to run a turn? `keys` carries
 *  every client-visible credential; NVIDIA is presence-only (last4). */
export function providerConfigured(
  p: ProviderId,
  keys: { apiKey?: string; geminiApiKey?: string; nvidiaKeyLast4?: string },
): boolean {
  const field = recordById(p).keyField;
  if (field === null) return !!keys.nvidiaKeyLast4;
  return !!keys[field];
}

/** The key string to send for this provider ("" when the browser holds none). */
export function providerKey(
  p: ProviderId,
  keys: { apiKey?: string; geminiApiKey?: string },
): string {
  const field = recordById(p).keyField;
  return field ? (keys[field] || "") : "";
}

/** Providers with a real free chat tier, for "you could switch to…" copy. */
export function freeChatProviders(): ProviderId[] {
  return PROVIDERS.filter((p) => p.freeChatTier).map((p) => p.id);
}

export function allProviders(): ProviderId[] {
  return PROVIDERS.map((p) => p.id);
}

/** "NVIDIA · deepseek-ai/deepseek-v4-flash" — for <option> labels and any
 *  other place that can hold text but not markup. */
export function describeModel(id: string): string {
  return `${providerLabel(modelProvider(id))} · ${localModelId(id)}`;
}

/** Provider-local id — what actually goes in the request body. */
export function localModelId(id: string): string {
  const rec = recordFor(id);
  return rec.prefix ? id.slice(rec.prefix.length) : id;
}

/** Namespaced id for storage, given a provider-local id. */
export function namespacedId(provider: ProviderId, localId: string): string {
  return recordById(provider).prefix + localId;
}

export function resolveModel(id: string): {
  provider: ProviderId;
  adapter: ChatProviderAdapter;
  localId: string;
} {
  const rec = recordFor(id);
  return { provider: rec.id, adapter: rec.adapter, localId: localModelId(id) };
}
