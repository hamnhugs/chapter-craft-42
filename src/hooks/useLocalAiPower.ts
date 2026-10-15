import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { rememberChatModel, useChatSettings } from "@/hooks/useChatSettings";
import { isLocalBackend } from "@/lib/localServices";
import { localModelId } from "@/lib/providers/registry";
import {
  LOCAL_EMBED_MODEL,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_NUM_BATCH,
  ollamaBaseUrl,
  ollamaNumCtx,
} from "@/lib/providers/ollamaConfig";

// Local AI's power switch. Its state is derived — a local chat model selected
// (useChatSettings().localAi) — so the toggle in Settings, the model picker
// and the edge functions' routing (supabase/functions/_shared/ai-local.ts)
// can never disagree. This hook makes the machine follow it:
//
//   on   GPU held awake with the COMPUTE profile (control.mjs), then the chat
//        model loaded with the exact options chat sends, so the first message
//        doesn't also pay the load and Ollama doesn't reload to switch.
//   off  every model but the CPU embedder unloaded (search keeps working),
//        then the GPU back to stock power management so the card can sleep.
//
// Applied once the settings load, and again on every change.

const CONTROL = "/local/control";

async function control(path: string): Promise<{ ok?: boolean; error?: string } | null> {
  try {
    const r = await fetch(`${CONTROL}${path}`, { method: "POST", headers: { "X-Chapter-Craft": "1" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function unloadChatModels(): Promise<void> {
  try {
    const ps = await fetch(`${ollamaBaseUrl()}/api/ps`).then((r) => r.json());
    const embed = LOCAL_EMBED_MODEL.replace(/:latest$/, "");
    await Promise.all((ps?.models || [])
      .filter((m: any) => String(m?.name || "").replace(/:latest$/, "") !== embed)
      .map((m: any) => fetch(`${ollamaBaseUrl()}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
      }).catch(() => {})));
  } catch { /* Ollama down — nothing loaded */ }
}

/** Load the model with chat's own num_ctx/num_batch (a different value makes
 *  Ollama reload it on the first message). Resolves false when Ollama is down. */
async function loadChatModel(model: string, signal: AbortSignal): Promise<boolean | "missing"> {
  try {
    const r = await fetch(`${ollamaBaseUrl()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { num_ctx: ollamaNumCtx(), num_batch: OLLAMA_NUM_BATCH },
      }),
      signal,
    });
    if (r.status === 404) return "missing";
    return r.ok;
  } catch {
    return false;
  }
}

export function useLocalAiPower(): void {
  const { loaded, localAi, selectedModel } = useChatSettings();
  const applied = useRef<{ on: boolean; model: string } | null>(null);

  useEffect(() => {
    if (loaded && selectedModel) rememberChatModel(selectedModel);
  }, [loaded, selectedModel]);

  useEffect(() => {
    if (!loaded || !isLocalBackend()) return;
    const model = localAi ? selectedModel : "";
    const prev = applied.current;
    if (prev && prev.on === localAi && prev.model === model) return;
    applied.current = { on: localAi, model };
    const ctl = new AbortController();
    const quiet = prev === null; // the state the app opened in: no toasts unless something's wrong

    if (!localAi) {
      void (async () => {
        await unloadChatModels();
        await control("/gpu/release");
        if (!quiet) toast.success("Local AI off — graphics card released");
      })();
      return () => ctl.abort();
    }

    const name = localModelId(selectedModel);
    void (async () => {
      const hold = await control("/gpu/hold");
      if (!hold?.ok) {
        toast.warning("Local AI is on, but the graphics card couldn't be set to full speed", {
          description: hold?.error || "The GPU control service isn't running — restart Chapter Craft.",
        });
      }
      // A model change while on: drop the old one first, or both sit in VRAM.
      if (prev?.on) await unloadChatModels();
      const id = quiet ? undefined : toast.loading(`Starting Local AI — loading ${name}…`);
      const r = await loadChatModel(name, ctl.signal);
      if (ctl.signal.aborted) { if (id !== undefined) toast.dismiss(id); return; }
      if (r === true) {
        if (id !== undefined) toast.success("Local AI ready", { id, description: name });
      } else {
        toast.error(r === "missing" ? `${name} isn't installed` : "Ollama isn't running", {
          ...(id !== undefined ? { id } : {}),
          description: r === "missing" ? `In a terminal: ollama pull ${name}` : "Start it with: sudo systemctl start ollama",
        });
      }
    })();
    return () => ctl.abort();
  }, [loaded, localAi, selectedModel]);
}

/** Mounted once, inside the auth and settings providers. */
export function LocalAiPower(): null {
  useLocalAiPower();
  return null;
}
