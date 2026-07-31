// Provider resolution. One rule, zero migrations: OpenRouter ids keep their
// native "author/slug" form (every persisted setting stays valid), NVIDIA
// ids carry a "nvidia:" prefix. The prefix uses a colon because NVIDIA's own
// ids contain slashes — and bare ids CANNOT disambiguate: e.g.
// "nvidia/nemotron-nano-12b-v2-vl" is a valid model id on BOTH services.

import { ChatProviderAdapter, ProviderId } from "./types";
import { openrouterAdapter } from "./openrouterAdapter";
import { nvidiaAdapter } from "./nvidiaAdapter";

export const NVIDIA_PREFIX = "nvidia:";

export function isNvidiaModel(id: string): boolean {
  return id.startsWith(NVIDIA_PREFIX);
}

export function modelProvider(id: string): ProviderId {
  return isNvidiaModel(id) ? "nvidia" : "openrouter";
}

/** Provider-local id — what actually goes in the request body. */
export function localModelId(id: string): string {
  return isNvidiaModel(id) ? id.slice(NVIDIA_PREFIX.length) : id;
}

export function resolveModel(id: string): {
  provider: ProviderId;
  adapter: ChatProviderAdapter;
  localId: string;
} {
  return isNvidiaModel(id)
    ? { provider: "nvidia", adapter: nvidiaAdapter, localId: localModelId(id) }
    : { provider: "openrouter", adapter: openrouterAdapter, localId: id };
}
