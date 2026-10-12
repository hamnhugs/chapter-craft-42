import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/** Models known to work for chat on a 6 GiB card, in preference order.
 *  Evidence: docs/local-ai/results/. Shown as a pull hint when nothing usable
 *  is installed — the app never pulls on its own (multi-GB downloads). */
const SUGGESTED = ["qwen3.5:4b", "qwen3:8b"];

const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;

const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 rounded bg-surface-container-highest text-on-surface-variant">
    {children}
  </span>
);

/** Settings card for models running on this computer through Ollama. */
const LocalModelsSettings: React.FC = () => {
  const { savedModels, selectedModel, visionModel, addModel, setSelectedModel, setVisionModel } = useChatSettings();
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
    <div className="space-y-3 p-3 rounded-xl bg-surface-container-high">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">
          <div className="font-semibold text-foreground">Models on this computer</div>
          <div className="text-xs text-on-surface-variant">
            {status === null
              ? "Checking for Ollama…"
              : status.ok
                ? `Ollama ${status.version || ""} is running · free, private, works offline`
                : "Ollama isn't reachable. Start it with: systemctl start ollama"}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      {status?.ok && chatModels.length === 0 && (
        <div className="text-xs text-on-surface-variant">
          No chat models installed. In a terminal: <code className="font-mono">ollama pull {SUGGESTED[0]}</code>
        </div>
      )}

      {chatModels.map((m) => {
        const id = namespacedId("ollama", m.name);
        const isChat = selectedModel === id;
        const isVision = visionModel === id;
        const vision = m.capabilities.includes("vision");
        return (
          <div key={m.name} className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-foreground">{m.name}</span>
            <span className="text-[10px] text-on-surface-variant">{gib(m.sizeBytes)}</span>
            {m.capabilities.includes("tools") && <Chip>tools</Chip>}
            {vision && <Chip>vision</Chip>}
            {m.capabilities.includes("thinking") && <Chip>thinking</Chip>}
            <span className="flex-1" />
            <Button size="sm" variant={isChat ? "default" : "outline"} disabled={isChat} onClick={() => use(m, "chat")}>
              {isChat ? "Chat ✓" : "Use for chat"}
            </Button>
            {vision && (
              <Button size="sm" variant={isVision ? "default" : "outline"} disabled={isVision} onClick={() => use(m, "vision")}>
                {isVision ? "Images ✓" : "Use for images"}
              </Button>
            )}
          </div>
        );
      })}

      <details className="text-xs">
        <summary className="cursor-pointer text-on-surface-variant">Connection & memory</summary>
        <div className="mt-2 space-y-2">
          <div className="flex gap-2 items-center">
            <span className="w-28 shrink-0 text-on-surface-variant">Server address</span>
            <Input value={baseDraft} onChange={(e) => setBaseDraft(e.target.value)} placeholder={OLLAMA_DEFAULT_BASE}
              className="text-xs font-mono bg-surface-container border-none h-8" />
            <Button size="sm" onClick={saveBase}>Save</Button>
          </div>
          <div className="flex gap-2 items-center">
            <span className="w-28 shrink-0 text-on-surface-variant">Context (tokens)</span>
            <Input value={ctxDraft} onChange={(e) => setCtxDraft(e.target.value)} placeholder={String(OLLAMA_DEFAULT_NUM_CTX)}
              inputMode="numeric" className="text-xs font-mono bg-surface-container border-none h-8" />
            <Button size="sm" onClick={saveCtx}>Save</Button>
          </div>
          <p className="text-on-surface-variant">
            Bigger contexts remember more of the conversation but use more graphics memory. 16,384 suits a 6 GB card with a 4B model.
          </p>
        </div>
      </details>
    </div>
  );
};

export default LocalModelsSettings;
