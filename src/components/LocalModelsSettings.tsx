import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { listOllamaModels, pingOllama, type OllamaModelInfo } from "@/lib/providers/ollamaAdapter";
import {
  OLLAMA_DEFAULT_BASE,
  OLLAMA_DEFAULT_NUM_CTX,
  ollamaBaseUrl,
  ollamaNumCtx,
  setOllamaBaseUrl,
  setOllamaNumCtx,
} from "@/lib/providers/ollamaConfig";
import { namespacedId } from "@/lib/providers/registry";
import { Disclosure, Group, Pill, Row } from "@/components/settings/SettingsUI";

/** Models known to work for chat on a 6 GiB card, in preference order.
 *  Evidence: docs/local-ai/results/. Shown as a pull hint when nothing usable
 *  is installed — the app never pulls on its own (multi-GB downloads). */
const SUGGESTED = ["hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K", "qwen3:4b-instruct-2507-q4_K_M", "qwen3.5:4b", "qwen3:8b"];

const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;

const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 rounded bg-surface-container-highest text-on-surface-variant">
    {children}
  </span>
);

/** Settings group for models running on this computer through Ollama. */
const LocalModelsSettings: React.FC = () => {
  const { savedModels, selectedModel, visionModel, addModel, setSelectedModel, setVisionModel, localAi, setLocalAi } = useChatSettings();
  const [status, setStatus] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [baseDraft, setBaseDraft] = useState(ollamaBaseUrl());
  const [ctxDraft, setCtxDraft] = useState(String(ollamaNumCtx()));

  const refresh = useCallback(async () => {
    setLoading(true);
    const s = await pingOllama();
    setStatus(s);
    setModels(s.ok ? await listOllamaModels() : []);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const chatModels = models.filter((m) => m.capabilities.includes("completion") || m.capabilities.length === 0);

  const use = (m: OllamaModelInfo, role: "chat" | "vision") => {
    const id = namespacedId("ollama", m.name);
    if (!savedModels.includes(id)) addModel(id);
    if (role === "chat") setSelectedModel(id);
    else setVisionModel(id);
    toast.success(`${m.name} now handles ${role === "chat" ? "chat" : "image turns"}`);
  };

  const saveBase = () => {
    if (!setOllamaBaseUrl(baseDraft)) {
      toast.error("Only this computer's address is allowed (127.0.0.1 or localhost).");
      return;
    }
    setBaseDraft(ollamaBaseUrl());
    void refresh();
  };

  const saveCtx = () => {
    setOllamaNumCtx(Number(ctxDraft));
    setCtxDraft(String(ollamaNumCtx()));
    toast.success(`Context size set to ${ollamaNumCtx().toLocaleString()} tokens`);
  };

  return (
    <Group title="On this computer">
      <Row
        id="local-ai"
        label="Local AI"
        description={localAi
          ? "On — chat and background jobs run here. The graphics card stays awake for speed."
          : "Off — your cloud model answers and the graphics card is left alone. Search still runs here."}
      >
        <Switch checked={localAi} onCheckedChange={setLocalAi} aria-label="Local AI" />
      </Row>

      <Disclosure
        icon="memory"
        label={`Installed models${chatModels.length ? ` (${chatModels.length})` : ""}`}
        summary={status === null
          ? "Checking for Ollama…"
          : status.ok
            ? `Ollama ${status.version || ""} · free, private, works offline`
            : "Ollama isn't reachable. Start it with: systemctl start ollama"}
        defaultOpen={localAi}
      >
        <div className="flex justify-end -mt-1 mb-1">
          <Button size="sm" variant="ghost" data-no-sticker className="h-7 text-xs gap-1" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="material-symbols-outlined text-base">refresh</span>}
            Refresh
          </Button>
        </div>
        {status?.ok && chatModels.length === 0 && (
          <div className="text-xs text-on-surface-variant">
            No chat models installed. In a terminal: <code className="font-mono">ollama pull {SUGGESTED[0]}</code>
          </div>
        )}
        {chatModels.length > 0 && (
          <ul className="-mx-2">
            {chatModels.map((m) => {
              const id = namespacedId("ollama", m.name);
              const isChat = selectedModel === id;
              const isVision = visionModel === id;
              const vision = m.capabilities.includes("vision");
              return (
                <li key={m.name} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-container-high/50">
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-xs text-foreground truncate" title={m.name}>{m.name}</span>
                    <span className="flex items-center gap-1 mt-0.5">
                      <span className="text-[10px] text-on-surface-variant mr-0.5">{gib(m.sizeBytes)}</span>
                      {m.capabilities.includes("tools") && <Chip>tools</Chip>}
                      {vision && <Chip>vision</Chip>}
                      {m.capabilities.includes("thinking") && <Chip>thinking</Chip>}
                    </span>
                  </span>
                  {isChat ? (
                    <Pill tone="ok">Chat</Pill>
                  ) : (
                    <button data-no-sticker className="text-xs font-medium text-primary hover:underline px-1.5" onClick={() => use(m, "chat")}>Use for chat</button>
                  )}
                  {vision && (isVision ? (
                    <Pill tone="ok">Images</Pill>
                  ) : (
                    <button data-no-sticker className="text-xs font-medium text-primary hover:underline px-1.5" onClick={() => use(m, "vision")}>Use for images</button>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </Disclosure>

      <Disclosure icon="settings_ethernet" label="Connection & memory" summary={`${ollamaBaseUrl()} · ${ollamaNumCtx().toLocaleString()} tokens of context`}>
        <div className="space-y-2 text-xs">
          <div className="flex gap-2 items-center">
            <span className="w-28 shrink-0 text-on-surface-variant">Server address</span>
            <Input value={baseDraft} onChange={(e) => setBaseDraft(e.target.value)} placeholder={OLLAMA_DEFAULT_BASE}
              className="text-xs font-mono bg-surface-container-high border-outline-variant/15 h-8" />
            <Button size="sm" onClick={saveBase}>Save</Button>
          </div>
          <div className="flex gap-2 items-center">
            <span className="w-28 shrink-0 text-on-surface-variant">Context (tokens)</span>
            <Input value={ctxDraft} onChange={(e) => setCtxDraft(e.target.value)} placeholder={String(OLLAMA_DEFAULT_NUM_CTX)}
              inputMode="numeric" className="text-xs font-mono bg-surface-container-high border-outline-variant/15 h-8" />
            <Button size="sm" onClick={saveCtx}>Save</Button>
          </div>
          <p className="text-on-surface-variant">
            Bigger contexts remember more of the conversation but use more graphics memory. 16,384 suits a 6 GB card with a 4B model.
          </p>
        </div>
      </Disclosure>
    </Group>
  );
};

export default LocalModelsSettings;
