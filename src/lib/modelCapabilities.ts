// Can the model running THIS turn call functions at all?
//
// One answer for all three providers, because the alternative already
// shipped: the send path capability-checked NVIDIA only, so every OpenRouter
// and Gemini model was assumed tool-capable. A model that cannot call
// functions is handed a roster it can never use, and what comes back is
// prose describing an action nobody ran — the assistant "lying about its
// tools" is usually this, seen from the outside.
//
// Capability facts live in the provider catalogs (declared for NVIDIA and
// Gemini, published by OpenRouter as `supported_parameters`). This module
// only decides which catalog to ask and what to do when none of them knows.

import { GEMINI_FEATURED } from "@/lib/geminiCatalog";
import { NVIDIA_FEATURED } from "@/lib/nvidiaCatalog";
import { cachedOrToolSupport } from "@/lib/openrouterCatalog";
import { localModelId, modelProvider } from "@/lib/providers/registry";

export type ToolSupport = {
  /** Send tools this turn? */
  supportsTools: boolean;
  /** Did a catalog actually tell us, or is this the fail-open default?
   *  Lets a caller distinguish "we checked and it cannot" from "we have not
   *  checked" — only the first is worth putting on screen. */
  known: boolean;
  /** One plain sentence for the UI. */
  why: string;
};

// Curated catalog rows ONLY. nvidiaModelInfo()/geminiModelInfo() never return
// undefined — they synthesise an entry from the id when they have never heard
// of a model, with `tools` inferred from a regex. Reading those would report
// `known: true` for a guess, which is the one thing `known` exists to rule
// out. An id that is not in these maps is genuinely unknown to us.
const NVIDIA_DECLARED_TOOLS = new Map(NVIDIA_FEATURED.map((m) => [m.localId, m.caps.tools]));
const GEMINI_DECLARED_TOOLS = new Map(GEMINI_FEATURED.map((m) => [m.localId, m.caps.tools]));

const WHY_YES = "This model takes tool calls, so your tools go out with your messages.";
const WHY_NO = "This model doesn't do tool calls, so no tools go out with your messages.";
const WHY_UNKNOWN = "We don't have a tool-calling listing for this model yet, so the tools go out with your messages anyway.";

export function modelToolSupport(model: string): ToolSupport {
  const localId = localModelId(model || "");
  let declared: boolean | null = null;

  switch (modelProvider(model || "")) {
    case "nvidia":
      declared = NVIDIA_DECLARED_TOOLS.get(localId) ?? null;
      break;
    case "gemini":
      declared = GEMINI_DECLARED_TOOLS.get(localId) ?? null;
      break;
    case "openrouter":
      // Reads the already-cached catalog; null until a catalog fetch has
      // landed at least once in this browser.
      declared = cachedOrToolSupport(localId);
      break;
  }

  if (declared === true) return { supportsTools: true, known: true, why: WHY_YES };
  if (declared === false) return { supportsTools: false, known: true, why: WHY_NO };

  // FAIL OPEN — LOAD-BEARING, do not "tighten" this.
  //
  // When we do not KNOW, we assume the model is capable and send the tools.
  // Withholding every tool because a catalog fetch had not landed yet would
  // reproduce the exact bug this work exists to remove: an assistant with no
  // hands for a reason that came from our own async state rather than from
  // anything the user configured. The cost of guessing wrong in this
  // direction is one clean provider error the user can read; the cost of
  // guessing wrong in the other direction is an assistant that quietly
  // narrates work it never did.
  return { supportsTools: true, known: false, why: WHY_UNKNOWN };
}
