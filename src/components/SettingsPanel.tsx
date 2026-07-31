import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2, Check } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { usePlan } from "@/hooks/usePlan";
import { useChatSettings } from "@/hooks/useChatSettings";
import { useTheme } from "@/context/ThemeContext";
import { openPricing } from "@/components/PricingDialog";
import { openSetupWizard } from "@/components/SetupWizard";
import PromptLibrary from "@/components/PromptLibrary";
import ApiKeyManager from "@/components/ApiKeyManager";
import ImageModelsSettings from "@/components/ImageModelsSettings";
import VideoModelsSettings from "@/components/VideoModelsSettings";
import SplatModelsSettings from "@/components/SplatModelsSettings";
import { useReflexEnabled, setReflexEnabled } from "@/lib/reflex";
import AiPermissionsSettings from "@/components/AiPermissionsSettings";
import MemoryLensSettings from "@/components/MemoryLensSettings";
import ToolFoundrySettings from "@/components/ToolFoundrySettings";
import { getMemoryMode, setMemoryMode, MemoryMode } from "@/lib/knowledgeApi";
import { consumeSettingsSection } from "@/lib/settingsNav";
import { synthesizeSpeech, fetchInworldVoices, type InworldVoice } from "@/lib/inworldTts";
import { isEmbeddingModel } from "@/lib/utils";
import { describeModel, isNvidiaModel, localModelId, modelProvider, providerLabel, NVIDIA_PREFIX } from "@/lib/providers/registry";
import { namespacedNvidiaId, NVIDIA_STARTER_MODEL } from "@/lib/nvidiaCatalog";
import { LEAN_MODES, LEAN_MODE_INFO } from "@/lib/leanMode";
import { validateNvidiaKey } from "@/lib/providers/nvidiaAdapter";
import { FIGURE_MODELS_PAID, FIGURE_MODELS_FREE, DEFAULT_FIGURE_MODEL } from "@/lib/figureModels";

// The Settings tab — every user preference in one place.
//
// Why one hub: settings scattered across tabs fail the "where do I change X?"
// test (NN/g: users look for a single Settings location before anything else).
// Structure follows settings-page research: a single scrollable page (no
// hidden sub-pages — most users change ≤1 setting per visit and abandon
// searches across sub-screens), grouped by user goal rather than by internal
// module, ordered by how often each group is touched. Controls apply
// immediately (modern consensus — no global Save button to forget).
//
// Contextual quick toggles (Read Aloud / Hands-free in Counsel, Recording
// mode in Neuron) intentionally stay where they are — research favors a
// central hub PLUS shortcuts at the point of use, not either/or.

const VOICE_QUICK_SEARCH_KEY = "voice_quick_search";
const VOICE_QUICK_SEARCH_MODEL_KEY = "voice_quick_search_model";
const BARGE_IN_KEY = "hands_free_barge_in";

const SECTIONS = [
  { id: "models", icon: "tune", title: "AI Models & Keys" },
  { id: "voice", icon: "record_voice_over", title: "Voice & Speech" },
  { id: "research", icon: "science", title: "Research & Web Search" },
  { id: "images", icon: "image", title: "Images & Vision" },
  { id: "memory", icon: "neurology", title: "Neuron & Memory" },
  { id: "permissions", icon: "shield_person", title: "AI Permissions" },
  { id: "prompts", icon: "history_edu", title: "Prompts" },
  { id: "appearance", icon: "palette", title: "Appearance" },
  { id: "account", icon: "person", title: "Account & Plan" },
] as const;

/** Section card with an anchor id for the side nav. */
const Section: React.FC<{
  id: string;
  icon: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ id, icon, title, description, children }) => (
  <section id={`settings-${id}`} aria-labelledby={`settings-${id}-h`} className="scroll-mt-24">
    <div className="flex items-center gap-2.5 mb-1">
      <span className="material-symbols-outlined text-primary text-xl" aria-hidden>{icon}</span>
      <h3 id={`settings-${id}-h`} className="font-headline font-bold text-xl text-foreground">{title}</h3>
    </div>
    {description && <p className="text-xs text-on-surface-variant mb-3 ml-0.5">{description}</p>}
    <div className="rounded-2xl bg-surface-container-low border border-outline-variant/10 p-4 md:p-5 space-y-5">
      {children}
    </div>
  </section>
);

const FieldLabel: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({ children, right }) => (
  <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center justify-between gap-2">
    <span>{children}</span>
    {right}
  </label>
);

const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[10px] text-on-surface-variant px-1">{children}</p>
);

/** Toggle row: label state text on the left, switch on the right. */
const ToggleRow: React.FC<{
  text: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  locked?: boolean;
}> = ({ text, checked, onChange, disabled, ariaLabel, locked }) => (
  <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
    <span className="text-sm text-primary flex items-center gap-1.5">
      {locked && <span className="material-symbols-outlined text-sm" aria-hidden>lock</span>}
      {text}
    </span>
    <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={ariaLabel} />
  </div>
);

/** Password-style secret with explicit Save/Remove (keys shouldn't save per keystroke). */
const SecretField: React.FC<{
  value: string;
  placeholder: string;
  icon: string;
  onSave: (v: string) => void;
  saveLabel?: string;
}> = ({ value, placeholder, icon, onSave, saveLabel = "Save" }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <>
      <div className="relative">
        <input
          className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40 transition-all"
          type="password"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(draft); }}
        />
        <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm" aria-hidden>{icon}</span>
      </div>
      <div className="flex gap-2 mt-1">
        <Button size="sm" onClick={() => onSave(draft)}>{saveLabel}</Button>
        {value && <Button size="sm" variant="destructive" onClick={() => { setDraft(""); onSave(""); }}>Remove</Button>}
      </div>
    </>
  );
};

const selectCls =
  "w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40";

/** Saved-model options, provider-labelled. Two providers serve 13 models
 *  under BYTE-IDENTICAL names, so every option carries its provider in the
 *  text — grouping alone is not enough, and an <option> cannot hold a badge.
 *  Labels are never stripped of provenance. `excludeNvidia` is for features
 *  that run server-side on the OpenRouter key only (wiki ops). */
const ModelOptions: React.FC<{ models: string[]; excludeNvidia?: boolean }> = ({ models, excludeNvidia }) => {
  const or = models.filter((m) => !isNvidiaModel(m));
  const nv = excludeNvidia ? [] : models.filter((m) => isNvidiaModel(m));
  if (nv.length === 0) {
    return <>{or.map((m) => (<option key={m} value={m}>{describeModel(m)}</option>))}</>;
  }
  return (
    <>
      <optgroup label="NVIDIA — free, no balance needed">
        {nv.map((m) => (<option key={m} value={m}>{describeModel(m)}</option>))}
      </optgroup>
      <optgroup label="OpenRouter — billed to your OpenRouter balance">
        {or.map((m) => (<option key={m} value={m}>{describeModel(m)}</option>))}
      </optgroup>
    </>
  );
};

/** Provider badge for surfaces that CAN hold markup (chips, rows). */
const ProviderBadge: React.FC<{ id: string }> = ({ id }) => {
  const nv = isNvidiaModel(id);
  return (
    <span
      className={`text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 rounded shrink-0 ${
        nv ? "bg-primary-container/30 text-primary" : "bg-surface-container-highest text-on-surface-variant"
      }`}
    >
      {nv ? "NVIDIA" : "OpenRouter"}
    </span>
  );
};

const SettingsPanel: React.FC = () => {
  const { user } = useAuth();
  const { isPaid, plan } = usePlan();
  const { themeId, setThemeId, themes } = useTheme();
  const {
    apiKey, nvidiaKeyLast4, geminiApiKey, tavilyApiKey, leanMode, savedModels, selectedModel, deepResearchModel, voiceModel, visionModel, ttsRate,
    handsFreeTtsRate, maxReplySentences,
    autoReadReplies, wikiModel, customSystemPrompt, burplexityApiToken,
    inworldApiKey, inworldEnabled, inworldVoiceId, accessAllNeurons, loaded,
    imageExtractionModel, autoExtractFigures,
    saveApiKey, saveNvidiaKey, setGeminiApiKey, setTavilyApiKey, setLeanMode, addModel, removeModel, setSelectedModel, setDeepResearchModel,
    setVoiceModel, setVisionModel, setTtsRate, setHandsFreeTtsRate, setMaxReplySentences, setAutoReadReplies, setWikiModel,
    setCustomSystemPrompt, setBurplexityApiToken, setInworldApiKey,
    setInworldEnabled, setInworldVoiceId, setAccessAllNeurons,
    setImageExtractionModel, setAutoExtractFigures,
  } = useChatSettings();

  const [newModelInput, setNewModelInput] = useState("");
  const [newModelProvider, setNewModelProvider] = useState<"openrouter" | "nvidia">("openrouter");
  const [nvidiaKeyDraft, setNvidiaKeyDraft] = useState("");
  const [testingNvidia, setTestingNvidia] = useState(false);
  const [nvidiaStatus, setNvidiaStatus] = useState<string | null>(null);
  const [orStatus, setOrStatus] = useState<string | null>(null);
  const [orFreeTier, setOrFreeTier] = useState(false);
  // Write-only key UX: once the save lands (last4 appears), drop the
  // plaintext from component state.
  useEffect(() => { if (nvidiaKeyLast4) setNvidiaKeyDraft(""); }, [nvidiaKeyLast4]);

  const activeProviderUsable =
    modelProvider(selectedModel) === "nvidia" ? !!nvidiaKeyLast4 : !!apiKey;

  /** Paste repair: a pasted "nvidia:vendor/model" sets the provider select
   *  and strips the tag, so the routing token is never typed OR retyped. */
  const handleModelInputChange = (raw: string) => {
    if (raw.startsWith(NVIDIA_PREFIX)) {
      setNewModelProvider("nvidia");
      setNewModelInput(raw.slice(NVIDIA_PREFIX.length));
      return;
    }
    setNewModelInput(raw);
  };

  /** Saving an NVIDIA key used to change nothing about which model runs —
   *  the dead end that made a working key look broken. Now it offers the
   *  switch explicitly (never silently), naming the model. */
  const handleSaveNvidiaKey = async () => {
    const ok = await saveNvidiaKey(nvidiaKeyDraft);
    if (!ok) return;
    setNvidiaStatus(null);
    if (modelProvider(selectedModel) === "nvidia") return;
    const starter = namespacedNvidiaId(NVIDIA_STARTER_MODEL);
    const existing = savedModels.find((m) => isNvidiaModel(m)) || starter;
    toast.success("NVIDIA key saved", {
      description: `Chat is still set to ${describeModel(selectedModel)}. Switch it to NVIDIA?`,
      duration: 12000,
      action: {
        label: "Switch",
        onClick: () => {
          if (!savedModels.includes(existing)) addModel(existing);
          else setSelectedModel(existing);
          toast.success(`Chat now runs on ${describeModel(existing)}`);
        },
      },
    });
  };

  const handleTestNvidia = async () => {
    setTestingNvidia(true);
    setNvidiaStatus("Sending a one-token test request to NVIDIA…");
    const nvModel = savedModels.find((m) => isNvidiaModel(m));
    const failure = await validateNvidiaKey(nvModel ? localModelId(nvModel) : undefined);
    setTestingNvidia(false);
    if (failure === null) {
      setNvidiaStatus("✅ NVIDIA answered — your key works.");
      toast.success("NVIDIA key works");
    } else {
      setNvidiaStatus(`❌ ${failure}`);
      toast.error(failure);
    }
  };

  // Every role that can pick its own model, with whether its provider is
  // actually usable right now.
  const roleUsable = (id: string) => (modelProvider(id) === "nvidia" ? !!nvidiaKeyLast4 : !!apiKey);
  const roleRows = [
    { label: "Chat", id: selectedModel },
    { label: "Deep Research", id: deepResearchModel },
    { label: "Voice", id: voiceModel || selectedModel },
    { label: "Vision (image attached)", id: visionModel || selectedModel },
  ].map((r) => ({ ...r, usable: roleUsable(r.id) }));

  const diagnosticsText = [
    `build: ${(import.meta as any).env?.VITE_BUILD_SHA || "dev"}`,
    `openrouter key: ${apiKey ? "saved" : "none"}`,
    `nvidia key: ${nvidiaKeyLast4 ? `saved (…${nvidiaKeyLast4})` : "none"}`,
    ...roleRows.map((r) => `${r.label.toLowerCase()}: ${r.id}${r.usable ? "" : "  ← no key for this provider"}`),
    `wiki: ${wikiModel || "(default)"}`,
    `saved models (${savedModels.length}):`,
    ...savedModels.map((m) => `  ${m}`),
  ].join("\n");

  /** OpenRouter exposes key status to the browser (CORS allows it), so the
   *  "am I out of credit?" question can be answered BEFORE a failed send —
   *  including the trap that costs people the most time: an account under
   *  the ~$10 lifetime threshold can't run even OpenRouter's `:free` models. */
  const checkOpenRouterCredit = useCallback(async () => {
    if (!apiKey) return;
    setOrStatus("Checking…");
    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        setOrStatus(res.status === 401 ? "❌ OpenRouter rejected this key." : `Key check failed (${res.status}).`);
        setOrFreeTier(false);
        return;
      }
      const d = (await res.json())?.data || {};
      const limit = d.limit;
      const usage = typeof d.usage === "number" ? d.usage : 0;
      const free = d.is_free_tier === true;
      setOrFreeTier(free);
      const remaining = typeof limit === "number" ? ` · $${Math.max(0, limit - usage).toFixed(2)} left` : " · no spend cap set";
      setOrStatus(free
        ? `⚠️ Free tier${remaining}. OpenRouter needs a lifetime top-up of about $10 before ANY of its models run — including the ones marked ":free". NVIDIA has no such requirement.`
        : `✅ Key valid${remaining}.`);
    } catch {
      setOrStatus("Couldn't reach OpenRouter to check the key.");
    }
  }, [apiKey]);

  // Check on arrival, not on demand: the whole point is to surface a dead
  // OpenRouter account BEFORE the user spends a message discovering it.
  useEffect(() => {
    if (!apiKey || !loaded) { setOrStatus(null); setOrFreeTier(false); return; }
    void checkOpenRouterCredit();
  }, [apiKey, loaded, checkOpenRouterCredit]);
  const reflexCues = useReflexEnabled();
  const [promptDraft, setPromptDraft] = useState(customSystemPrompt || "");
  useEffect(() => { setPromptDraft(customSystemPrompt || ""); }, [customSystemPrompt]);

  // localStorage-backed toggles shared with Counsel (it re-reads them on mount).
  const [voiceQuickSearch, setVoiceQuickSearch] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_KEY) === "true");
  const [voiceQuickSearchModel, setVoiceQuickSearchModel] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_MODEL_KEY) || "");
  const [bargeInEnabled, setBargeInEnabled] = useState(() => localStorage.getItem(BARGE_IN_KEY) === "true");
  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_KEY, String(voiceQuickSearch)); }, [voiceQuickSearch]);
  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_MODEL_KEY, voiceQuickSearchModel); }, [voiceQuickSearchModel]);
  useEffect(() => { localStorage.setItem(BARGE_IN_KEY, String(bargeInEnabled)); }, [bargeInEnabled]);

  // Memory mode (Supabase-backed; Neuron tab re-reads on mount).
  const [memoryMode, setMemoryModeState] = useState<MemoryMode>("recording");
  const [memoryModeLoading, setMemoryModeLoading] = useState(false);
  useEffect(() => {
    getMemoryMode().then(setMemoryModeState).catch(() => { /* default stands */ });
  }, []);
  const handleMemoryMode = async (recording: boolean) => {
    const next: MemoryMode = recording ? "recording" : "retrieval";
    setMemoryModeLoading(true);
    try {
      await setMemoryMode(next);
      setMemoryModeState(next);
      toast.success(next === "recording" ? "Recording Mode: writes enabled" : "Retrieval Mode: writes disabled");
    } catch (err: any) {
      toast.error(err.message || "Failed to switch mode");
    } finally {
      setMemoryModeLoading(false);
    }
  };

  // ----- Inworld voice management (moved here from Counsel) -----
  const [inworldVoices, setInworldVoices] = useState<InworldVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [testingVoice, setTestingVoice] = useState(false);
  const loadInworldVoices = useCallback(async () => {
    setLoadingVoices(true);
    try {
      const voices = await fetchInworldVoices(inworldApiKey);
      setInworldVoices(voices);
      if (loaded && !inworldVoiceId) setInworldVoiceId(voices[0]?.voice_id || "Ashley");
    } catch (err: any) {
      toast.error(`Could not load Inworld voices: ${err.message}`);
    } finally {
      setLoadingVoices(false);
    }
  }, [inworldApiKey, inworldVoiceId, loaded, setInworldVoiceId]);

  const inworldVoiceLoadedRef = useRef(false);
  useEffect(() => {
    if (!inworldVoiceLoadedRef.current && inworldApiKey) {
      inworldVoiceLoadedRef.current = true;
      loadInworldVoices();
    }
  }, [inworldApiKey, loadInworldVoices]);

  const saveInworldKey = (key: string) => {
    setInworldApiKey(key.trim());
    if (key.trim()) { inworldVoiceLoadedRef.current = true; loadInworldVoices(); }
    else { setInworldEnabled(false); setInworldVoices([]); }
  };

  const testInworldVoice = async () => {
    if (!inworldVoiceId) { toast.error("Pick a voice first"); return; }
    setTestingVoice(true);
    try {
      const buf = await synthesizeSpeech("Testing one, two, three.", inworldApiKey, inworldVoiceId);
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
      const audio = new Audio(url);
      audio.onended = audio.onerror = () => { try { URL.revokeObjectURL(url); } catch { /* no-op */ } };
      await audio.play();
      toast.success("Voice working");
    } catch (err: any) {
      toast.error(`Inworld TTS failed: ${err?.message || err}`);
    } finally {
      setTestingVoice(false);
    }
  };

  const handleAddModel = () => {
    const raw = newModelInput.trim().replace(/^nvidia:/, "");
    if (!raw) return;
    if (newModelProvider === "nvidia" && /:(free|nitro|floor|exacto)$/.test(raw)) {
      toast.error("Suffixes like :free are OpenRouter routing variants — NVIDIA models don't have them.");
      return;
    }
    addModel(newModelProvider === "nvidia" ? namespacedNvidiaId(raw) : raw);
    setNewModelInput("");
  };

  // Deep link from other tabs → scroll to a section after mount.
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  const scrollTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  useEffect(() => {
    const id = consumeSettingsSection();
    // Wait a frame so the layout is committed before scrolling.
    if (id) requestAnimationFrame(() => scrollTo(id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight the section in view (simple scroll-spy).
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActiveSection(e.target.id.replace("settings-", ""));
            break;
          }
        }
      },
      { root, rootMargin: "-10% 0px -70% 0px" },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(`settings-${s.id}`);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Desktop side nav */}
      <nav
        aria-label="Settings sections"
        className="hidden lg:flex w-60 shrink-0 flex-col gap-1 border-r border-outline-variant/10 py-10 px-4 overflow-y-auto"
      >
        <p className="px-3 pb-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Settings</p>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => scrollTo(s.id)}
            aria-current={activeSection === s.id ? "true" : undefined}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-left transition-colors ${
              activeSection === s.id
                ? "bg-primary-container/20 text-primary font-semibold"
                : "text-on-surface-variant hover:bg-surface-container-high hover:text-foreground"
            }`}
          >
            <span
              className="material-symbols-outlined text-lg"
              style={activeSection === s.id ? { fontVariationSettings: "'FILL' 1" } : undefined}
              aria-hidden
            >
              {s.icon}
            </span>
            {s.title}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div ref={mainRef} className="flex-1 overflow-y-auto">
        <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 pb-32 w-full space-y-4">
          <header className="mb-6">
            <h2 className="font-headline font-bold text-4xl md:text-5xl text-primary tracking-tight">Settings</h2>
            <p className="text-on-surface-variant mt-2 text-sm">
              Everything in one place — changes apply instantly.
            </p>
          </header>

          {/* Mobile/tablet section chips */}
          <div className="lg:hidden sticky top-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-background/90 backdrop-blur-md flex gap-1.5 overflow-x-auto hide-scrollbar">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold transition-colors ${
                  activeSection === s.id
                    ? "bg-primary-container text-on-primary-container"
                    : "bg-surface-container-high text-on-surface-variant"
                }`}
              >
                <span className="material-symbols-outlined text-sm" aria-hidden>{s.icon}</span>
                {s.title}
              </button>
            ))}
          </div>

          <div className="space-y-8 pt-2">
            {/* ── AI Models & Keys ── */}
            <Section
              id="models"
              icon="tune"
              title="AI Models & Keys"
              description="The models and API key that power Counsel and everything else."
            >
              {/* Which provider is answering right now — the single most
                  important fact, and the one that used to be invisible. */}
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-surface-container-high">
                <span className="material-symbols-outlined text-primary text-lg" aria-hidden>
                  {activeProviderUsable ? "check_circle" : "error"}
                </span>
                <div className="text-sm">
                  <div className="font-semibold text-foreground">
                    Chat runs on {providerLabel(modelProvider(selectedModel))}
                  </div>
                  <div className="text-xs text-on-surface-variant font-mono">{localModelId(selectedModel)}</div>
                  {!activeProviderUsable && (
                    <div className="text-xs text-destructive mt-1">
                      No {providerLabel(modelProvider(selectedModel))} key saved — pick a model from the other provider, or add the key below.
                    </div>
                  )}
                </div>
              </div>

              <div>
                <FieldLabel>OpenRouter API Key</FieldLabel>
                <div className="mt-1.5">
                  <SecretField value={apiKey} placeholder="sk-or-v1-..." icon="key" onSave={saveApiKey} />
                </div>
                {apiKey && orStatus && (
                  <p className={`text-xs px-1 mt-1 ${orFreeTier ? "text-destructive" : "text-on-surface-variant"}`}>
                    {orStatus}
                    {orFreeTier && !nvidiaKeyLast4 && " Add a free NVIDIA key below to keep chatting."}
                  </p>
                )}
                {orFreeTier && nvidiaKeyLast4 && modelProvider(selectedModel) === "openrouter" && (
                  <Button
                    size="sm"
                    className="mt-1.5"
                    onClick={() => {
                      const target = savedModels.find((m) => isNvidiaModel(m)) || namespacedNvidiaId(NVIDIA_STARTER_MODEL);
                      if (!savedModels.includes(target)) addModel(target);
                      else setSelectedModel(target);
                      toast.success(`Chat now runs on ${describeModel(target)}`);
                    }}
                  >
                    Switch chat to NVIDIA
                  </Button>
                )}
                <Hint>
                  Pays per token, billed to your OpenRouter account. OpenRouter requires a lifetime top-up
                  of about $10 before its models will run — <strong>including the ones labelled <code>:free</code></strong>.
                  NVIDIA below has no such requirement.
                </Hint>
              </div>

              <div>
                <FieldLabel>NVIDIA API Key</FieldLabel>
                <div className="mt-1.5">
                  {nvidiaKeyLast4 ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-mono text-on-surface-variant">nvapi-••••••{nvidiaKeyLast4}</span>
                      <Button size="sm" variant="outline" disabled={testingNvidia} onClick={() => void handleTestNvidia()}>
                        {testingNvidia ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test key"}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => { void saveNvidiaKey(""); }}>Remove</Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder="nvapi-..."
                        value={nvidiaKeyDraft}
                        onChange={(e) => setNvidiaKeyDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void handleSaveNvidiaKey(); }}
                        className="text-sm font-mono bg-surface-container-high border-none"
                      />
                      <Button size="sm" onClick={() => void handleSaveNvidiaKey()}>Save</Button>
                    </div>
                  )}
                </div>
                {nvidiaStatus && <p className="text-xs text-on-surface-variant px-1 mt-1">{nvidiaStatus}</p>}
                <Hint>
                  Free — no balance, no card. Generate one at{" "}
                  <a className="text-primary underline" href="https://build.nvidia.com/settings/api-keys" target="_blank" rel="noreferrer">build.nvidia.com</a>.
                  Usage is governed by rate limits that vary by model and traffic (NVIDIA retired its credit system), so
                  there's no balance to read — "Test key" sends one real request to check. Stored for the relay only; the app never loads it back.
                  Chat, voice and vision can run on NVIDIA; image/video generation and book tools still use your OpenRouter key.
                </Hint>
              </div>

              <div>
                <FieldLabel>Spending</FieldLabel>
                <div className="mt-1.5 grid gap-1.5">
                  {LEAN_MODES.map((m) => {
                    const info = LEAN_MODE_INFO[m];
                    const active = leanMode === m;
                    return (
                      <button
                        key={m}
                        onClick={() => { void setLeanMode(m); }}
                        aria-pressed={active}
                        className={`text-left rounded-lg border px-4 py-3 transition-colors ${
                          active
                            ? "bg-primary-container/20 border-primary-container/50"
                            : "bg-surface-container-high border-outline-variant/10 hover:border-primary-container/30"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={`material-symbols-outlined text-base ${active ? "text-primary" : "text-on-surface-variant/40"}`}
                            aria-hidden
                          >
                            {active ? "radio_button_checked" : "radio_button_unchecked"}
                          </span>
                          <span className={`text-sm font-semibold ${active ? "text-primary" : "text-foreground"}`}>
                            {info.label}
                          </span>
                          {m === "lean" && <span className="text-[10px] text-on-surface-variant">recommended when watching money</span>}
                        </span>
                        <span className="block text-xs text-on-surface-variant mt-0.5 ml-6">{info.summary}</span>
                      </button>
                    );
                  })}
                </div>
                <Hint>
                  Blocked capabilities are removed from the assistant's tools entirely, so it can't offer or
                  attempt them — it will say so once and give you the best free version instead. Anything you've
                  already made stays fully viewable in every mode. Applies to all your devices.
                  {leanMode !== "full" && " Book digests already queued will still finish."}
                </Hint>
              </div>
              <div>
                <FieldLabel>Google Gemini API Key</FieldLabel>
                <div className="mt-1.5">
                  <SecretField
                    value={geminiApiKey}
                    placeholder="AIza..."
                    icon="auto_awesome"
                    onSave={(v) => { setGeminiApiKey(v); toast.success(v ? "Gemini key saved" : "Gemini key removed"); }}
                  />
                </div>
                <Hint>
                  Free chat with a generous daily allowance —{" "}
                  <a className="text-primary underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>.
                  Gemini also generates and edits images, but <strong>image generation needs billing enabled on your Google account</strong> —
                  the free tier is chat and vision only.
                </Hint>
              </div>
              <div>
                <FieldLabel>Active Chat Model</FieldLabel>
                <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className={`${selectCls} mt-1.5`}>
                  <ModelOptions models={savedModels.filter((m) => !isEmbeddingModel(m) || m === selectedModel)} />
                </select>
              </div>

              <div>
                <FieldLabel>Saved Models</FieldLabel>
                {/* Provider is a CHOICE, never something typed: the routing
                    tag can't be forgotten if it can't be typed. */}
                <div className="flex gap-2 mt-1.5">
                  <select
                    value={newModelProvider}
                    onChange={(e) => setNewModelProvider(e.target.value as "openrouter" | "nvidia")}
                    className="bg-surface-container-high border-none rounded-lg text-sm text-primary py-2 px-3 shrink-0"
                    aria-label="Provider for the model being added"
                  >
                    <option value="openrouter">OpenRouter</option>
                    <option value="nvidia">NVIDIA</option>
                  </select>
                  <Input
                    type="text"
                    placeholder="vendor/model"
                    value={newModelInput}
                    onChange={(e) => handleModelInputChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddModel(); }}
                    className="text-sm font-mono bg-surface-container-high border-none"
                  />
                  <Button size="sm" onClick={handleAddModel}>Add</Button>
                </div>
                <Hint>
                  The same model name can exist on both services — pick which one should serve it.
                  Browsing the model list below fills this in for you.
                </Hint>
                {(["nvidia", "openrouter"] as const).map((p) => {
                  const group = savedModels.filter((m) => modelProvider(m) === p);
                  if (group.length === 0) return null;
                  return (
                    <div key={p} className="mt-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 mb-1">
                        {providerLabel(p)}{p === "nvidia" ? " — free" : ""}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {group.map((m) => {
                          const embed = isEmbeddingModel(m);
                          return (
                            <span
                              key={m}
                              title={embed ? "Embedding model — used by Wiki reindex, not Chat" : describeModel(m)}
                              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ${
                                m === selectedModel
                                  ? "bg-primary-container/20 text-primary border border-primary-container/30"
                                  : embed
                                    ? "bg-surface-container-highest/50 text-on-surface-variant/60 italic"
                                    : "bg-surface-container-highest text-on-surface-variant"
                              }`}
                            >
                              <ProviderBadge id={m} />
                              <button
                                onClick={() => {
                                  if (embed) { toast.error("Embedding model — pick it under Neuron & Memory, not Chat."); return; }
                                  setSelectedModel(m);
                                }}
                                className="hover:underline"
                              >
                                {localModelId(m)}{embed ? " (embed)" : ""}
                              </button>
                              <button onClick={() => removeModel(m)} aria-label={`Remove ${m}`} className="hover:text-destructive ml-0.5 material-symbols-outlined text-xs">close</button>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                <button
                  onClick={() => window.open("#/models", "_blank")}
                  className="inline-flex items-center gap-1 mt-2 px-1 text-[11px] font-semibold text-primary hover:underline"
                >
                  <span className="material-symbols-outlined text-sm" aria-hidden>leaderboard</span>
                  Browse top models by category
                </button>
              </div>

              {/* Every model role, in one place. Chat doesn't use ONE model —
                  Deep Research, voice and image turns each swap in their own,
                  and a role still pointing at a provider you can't use fails
                  only on those turns, which reads as random breakage. */}
              <div>
                <FieldLabel>All model roles</FieldLabel>
                <div className="mt-1.5 rounded-xl bg-surface-container-high divide-y divide-outline-variant/10">
                  {roleRows.map((r) => (
                    <div key={r.label} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-xs text-on-surface-variant shrink-0">{r.label}</span>
                      <span className="flex items-center gap-1.5 min-w-0">
                        <ProviderBadge id={r.id} />
                        <span className="text-xs font-mono truncate">{localModelId(r.id)}</span>
                        {!r.usable && (
                          <span className="material-symbols-outlined text-destructive text-sm shrink-0" title={`No ${providerLabel(modelProvider(r.id))} key saved — these turns will fail`}>error</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                {roleRows.some((r) => !r.usable) && (
                  <p className="text-xs text-destructive px-1 mt-1">
                    A role above points at a provider with no key. Those turns will fail even if normal chat works.
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-semibold text-primary hover:underline list-none inline-flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm" aria-hidden>bug_report</span>
                    Diagnostics
                  </summary>
                  <pre className="mt-1.5 text-[10px] bg-surface-container-highest rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap">{diagnosticsText}</pre>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1.5"
                    onClick={() => { void navigator.clipboard?.writeText(diagnosticsText).then(() => toast.success("Diagnostics copied")); }}
                  >
                    Copy
                  </Button>
                </details>
              </div>
            </Section>

            {/* ── Voice & Speech ── */}
            <Section
              id="voice"
              icon="record_voice_over"
              title="Voice & Speech"
              description="How replies sound, and how hands-free conversations behave."
            >
              <div>
                <FieldLabel>Auto-read replies</FieldLabel>
                <div className="mt-1.5">
                  <ToggleRow
                    text={autoReadReplies ? "On — replies will be read aloud" : "Off"}
                    checked={autoReadReplies}
                    onChange={setAutoReadReplies}
                    ariaLabel="Auto-read assistant replies"
                  />
                </div>
                <Hint>Reads each new assistant reply aloud using the voice and speed below.</Hint>
              </div>
              <div>
                <FieldLabel right={<span className="text-primary normal-case tracking-normal">{ttsRate.toFixed(2)}×</span>}>
                  Voice Playback Speed
                </FieldLabel>
                <div className="bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10 mt-1.5">
                  <Slider value={[ttsRate]} min={0.5} max={2} step={0.05} onValueChange={(v) => setTtsRate(v[0])} />
                </div>
              </div>
              <div>
                <FieldLabel right={<span className="text-primary normal-case tracking-normal">{handsFreeTtsRate.toFixed(2)}×</span>}>
                  Hands-Free Speech Speed
                </FieldLabel>
                <div className="bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10 mt-1.5">
                  <Slider value={[handsFreeTtsRate]} min={0.5} max={2} step={0.05} onValueChange={(v) => setHandsFreeTtsRate(v[0])} />
                </div>
                <Hint>Speed for hands-free conversations only — read-aloud buttons use the speed above.</Hint>
              </div>
              <div>
                <FieldLabel>Inworld Voice (TTS upgrade)</FieldLabel>
                <div className="mt-1.5 space-y-2">
                  <ToggleRow
                    text={inworldEnabled ? "Inworld TTS on" : "Browser TTS"}
                    checked={inworldEnabled}
                    onChange={setInworldEnabled}
                    disabled={!inworldApiKey || !inworldVoiceId}
                    ariaLabel="Enable Inworld TTS"
                  />
                  <SecretField value={inworldApiKey} placeholder="Inworld API key…" icon="key" onSave={saveInworldKey} saveLabel="Save & Load Voices" />
                  {inworldApiKey && (
                    <div className="flex items-center gap-2">
                      {loadingVoices ? (
                        <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading voices…
                        </div>
                      ) : inworldVoices.length > 0 ? (
                        <select value={inworldVoiceId} onChange={(e) => setInworldVoiceId(e.target.value)} className={`flex-1 ${selectCls}`}>
                          {inworldVoices.map((v) => (
                            <option key={v.voice_id} value={v.voice_id}>
                              {v.name}{v.tags?.length ? ` (${v.tags.join(", ")})` : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Button size="sm" variant="outline" onClick={loadInworldVoices}>Retry loading voices</Button>
                      )}
                      {inworldVoices.length > 0 && (
                        <Button size="sm" variant="outline" onClick={testInworldVoice} disabled={testingVoice || !inworldVoiceId} title="Play a short test phrase">
                          {testingVoice ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test voice"}
                        </Button>
                      )}
                    </div>
                  )}
                  <Hint>When enabled, read-aloud uses an Inworld character voice instead of the browser's built-in TTS.</Hint>
                </div>
              </div>
              <div>
                <FieldLabel>Voice Model (spoken replies / hands-free)</FieldLabel>
                <select value={voiceModel || ""} onChange={(e) => setVoiceModel(e.target.value)} className={`${selectCls} mt-1.5`}>
                  <option value="">Same as Active model</option>
                  <ModelOptions models={savedModels} />
                </select>
                <Hint>Pick a fast model (e.g. <code>google/gemini-2.5-flash-lite</code>) for snappier spoken replies.</Hint>
              </div>
              <div>
                <FieldLabel>Barge-in (interrupt the assistant)</FieldLabel>
                <div className="mt-1.5">
                  <ToggleRow
                    text={bargeInEnabled ? "On — talk over replies to interrupt" : "Off — turn-based (no echo)"}
                    checked={bargeInEnabled}
                    onChange={setBargeInEnabled}
                    ariaLabel="Enable barge-in"
                  />
                </div>
                <Hint>When on, hands-free keeps listening while the assistant speaks and stops it the moment you start talking. Headphones give the most reliable results.</Hint>
              </div>
            </Section>

            {/* ── Research & Web Search ── */}
            <Section
              id="research"
              icon="science"
              title="Research & Web Search"
              description="Deep Research, live web search, and what Counsel is allowed to read."
            >
              <div>
                <FieldLabel>Neuron access</FieldLabel>
                <div className="mt-1.5">
                  <ToggleRow
                    text={accessAllNeurons && isPaid ? "Reading all neurons at once" : "Reading only the loaded neuron"}
                    checked={accessAllNeurons && isPaid}
                    locked={!isPaid}
                    onChange={(v) => {
                      if (!isPaid) { openPricing("all-neurons"); return; }
                      setAccessAllNeurons(v);
                      toast.success(v ? "Counsel can now read all your neurons" : "Counsel reads only the loaded neuron");
                    }}
                    ariaLabel="Access all neurons at once"
                  />
                </div>
                <Hint>
                  Off = answers draw only on the neuron you've loaded (focused, cheaper, usually more accurate). On = Counsel searches every neuron in your brain at once.{!isPaid && " Pro feature."}
                </Hint>
              </div>
              <div>
                <FieldLabel>Burplexity API Token (web search)</FieldLabel>
                <div className="mt-1.5">
                  <SecretField
                    value={burplexityApiToken}
                    placeholder="pp_..."
                    icon="travel_explore"
                    onSave={(v) => { setBurplexityApiToken(v); toast.success(v ? "Burplexity token saved" : "Burplexity token removed"); }}
                  />
                </div>
                <Hint>Enables the live <code>web_search</code> tool. Generate at your Burplexity app → API Keys.</Hint>
              </div>
              <div>
                <FieldLabel>Tavily API Key (free web search)</FieldLabel>
                <div className="mt-1.5">
                  <SecretField
                    value={tavilyApiKey}
                    placeholder="tvly-..."
                    icon="search"
                    onSave={(v) => { setTavilyApiKey(v); toast.success(v ? "Tavily key saved" : "Tavily key removed"); }}
                  />
                </div>
                <Hint>
                  The free option: 1,000 searches a month, no credit card —{" "}
                  <a className="text-primary underline" href="https://app.tavily.com" target="_blank" rel="noreferrer">app.tavily.com</a>.
                  Used automatically when no Burplexity token is set, so search keeps working without paying for it.
                </Hint>
              </div>
              <div>
                <FieldLabel>Deep Research Model</FieldLabel>
                <select value={deepResearchModel} onChange={(e) => setDeepResearchModel(e.target.value)} className={`${selectCls} mt-1.5`}>
                  <ModelOptions models={savedModels} />
                </select>
                <Hint>Used when Deep Research is ON. Pick a strong reasoning model for best results.</Hint>
              </div>
              <div>
                <FieldLabel>Background Quick Search</FieldLabel>
                <div className="mt-1.5">
                  <ToggleRow
                    text={voiceQuickSearch ? "On" : "Off"}
                    checked={voiceQuickSearch}
                    onChange={setVoiceQuickSearch}
                    disabled={!burplexityApiToken}
                    ariaLabel="Background Quick Search"
                  />
                </div>
                <Hint>
                  {burplexityApiToken
                    ? "When a message looks like a search, results are fetched in the background and added to the chat."
                    : "Requires a Burplexity API token above."}
                </Hint>
              </div>
              <div>
                <FieldLabel>Quick Search Model (lightweight preferred)</FieldLabel>
                <select value={voiceQuickSearchModel || selectedModel} onChange={(e) => setVoiceQuickSearchModel(e.target.value)} className={`${selectCls} mt-1.5`}>
                  <ModelOptions models={savedModels} />
                </select>
              </div>
            </Section>

            {/* ── Images & Vision ── */}
            <Section
              id="images"
              icon="image"
              title="Images & Vision"
              description="How the AI generates images and reads the ones you attach."
            >
              <div>
                <FieldLabel>Vision Model (used when you attach an image)</FieldLabel>
                <select value={visionModel || ""} onChange={(e) => setVisionModel(e.target.value)} className={`${selectCls} mt-1.5`}>
                  <option value="">Same as Active model</option>
                  <ModelOptions models={savedModels} />
                </select>
                <Hint>For best image understanding pick a vision-strong model like <code>google/gemini-2.5-flash</code> (cheap, great at docs/OCR) or <code>google/gemini-2.5-pro</code> (best reasoning). Falls back to your Active model if blank.</Hint>
              </div>
              <div>
                <FieldLabel>Figure Extraction Model (figures from your books)</FieldLabel>
                <select
                  value={imageExtractionModel || ""}
                  onChange={(e) => setImageExtractionModel(e.target.value)}
                  className={`${selectCls} mt-1.5`}
                >
                  <option value="">Default — {DEFAULT_FIGURE_MODEL} (built-in)</option>
                  <optgroup label="Recommended — paid (needs your OpenRouter key)">
                    {FIGURE_MODELS_PAID.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                  </optgroup>
                  <optgroup label="Recommended — free (also needs your OpenRouter key; rate-limited, may train on your data)">
                    {FIGURE_MODELS_FREE.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                  </optgroup>
                  {(() => {
                    const known = new Set([...FIGURE_MODELS_PAID, ...FIGURE_MODELS_FREE].map((m) => m.id));
                    // Figure extraction runs server-side on OpenRouter/gateway
                    // — NVIDIA ids would be forwarded verbatim and 400.
                    const extra = savedModels.filter((m) => !known.has(m) && !isEmbeddingModel(m) && !isNvidiaModel(m));
                    return extra.length > 0 ? (
                      <optgroup label="Your saved models">
                        {extra.map((m) => (<option key={m} value={m}>{m}</option>))}
                      </optgroup>
                    ) : null;
                  })()}
                </select>
                <Hint>
                  Reads the figures pulled out of your uploaded documents (road signs, diagrams, charts…), writes a description for each, and pairs it with the matching neuron so chat can show the real picture while explaining the concept. Runs once per book at digestion — described figures are stored forever and cost nothing to reuse. Free models work but are limited to ~20 requests/min and 50–1000/day on OpenRouter.
                </Hint>
                <div className="mt-3">
                  <ToggleRow
                    text="Extract figures automatically after digesting a book"
                    checked={autoExtractFigures}
                    onChange={setAutoExtractFigures}
                    ariaLabel="Toggle automatic figure extraction after digestion"
                  />
                </div>
              </div>
              <ImageModelsSettings />
              <VideoModelsSettings />
              <SplatModelsSettings />
            </Section>

            {/* ── Neuron & Memory ── */}
            <Section
              id="memory"
              icon="neurology"
              title="Neuron & Memory"
              description="How your knowledge wikis are written to and which model maintains them."
            >
              <div>
                <FieldLabel>Memory Mode</FieldLabel>
                <div className="mt-1.5">
                  <ToggleRow
                    text={memoryMode === "recording" ? "Recording — chats can write new memories" : "Retrieval — memories are read-only"}
                    checked={memoryMode === "recording"}
                    onChange={handleMemoryMode}
                    disabled={memoryModeLoading}
                    ariaLabel="Toggle memory recording mode"
                  />
                </div>
                <Hint>Also toggleable from the Neuron tab toolbar.</Hint>
              </div>
              <div>
                <FieldLabel>Reflex cues</FieldLabel>
                <div className="mt-1.5">
                  <ToggleRow
                    text={reflexCues ? "On — flag contradictions & mark conflicting entries" : "Off"}
                    checked={reflexCues}
                    onChange={setReflexEnabled}
                    ariaLabel="Toggle reflex cues"
                  />
                </div>
                <Hint>A fast salience layer: the assistant proactively points out when something you say contradicts a saved memory (and offers to reconcile it), and neuron cards show an amber marker when an entry is part of an open conflict. A convenience over the existing conflict detection — not a claim about neuroscience.</Hint>
              </div>
              <div>
                <FieldLabel>Wiki Model</FieldLabel>
                <select
                  // An NVIDIA id can only get here via the Admin panel's
                  // free-text field; wiki ops can't run it, so show (and on
                  // any change, save) the default rather than an empty control.
                  value={!wikiModel || isNvidiaModel(wikiModel) ? "__default__" : wikiModel}
                  onChange={(e) => setWikiModel(e.target.value === "__default__" ? "" : e.target.value)}
                  className={`${selectCls} mt-1.5`}
                >
                  <option value="__default__">Default (Gemini Flash)</option>
                  {/* Wiki ops run server-side against OpenRouter only — NVIDIA
                      models are excluded here so a pick can't silently break
                      reindexing. */}
                  <ModelOptions models={savedModels} excludeNvidia />
                </select>
                <Hint>Powers wiki extract and health checks. Custom models use OpenRouter and need your API key above (NVIDIA models aren't available for wiki ops).</Hint>
                {wikiModel && !apiKey && (
                  <p className="text-xs text-destructive px-1 mt-1">
                    No OpenRouter API key found — wiki ops will fall back to the default model.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Link to="/memory-guide" className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline">
                  <span className="material-symbols-outlined text-sm" aria-hidden>menu_book</span>
                  How memory works
                </Link>
                <Link to="/wiki-controls-guide" className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline">
                  <span className="material-symbols-outlined text-sm" aria-hidden>help</span>
                  What the Neuron controls do
                </Link>
              </div>
            </Section>

            {/* ── AI Permissions ── */}
            <Section
              id="permissions"
              icon="shield_person"
              title="AI Permissions"
              description="Exactly which tools the AI is allowed to use on your behalf."
            >
              <AiPermissionsSettings />
            </Section>

            {/* ── Tool Foundry ── */}
            <Section
              id="foundry"
              icon="construction"
              title="Tool Foundry"
              description="The AI's workshop: it forges reusable tools for itself, stored as neurons in its Toolshed — nothing runs without your approval."
            >
              <ToolFoundrySettings />
            </Section>

            {/* ── Prompts ── */}
            <Section
              id="prompts"
              icon="history_edu"
              title="Prompts"
              description="Reusable prompt presets and standing custom instructions."
            >
              <PromptLibrary scopeHint="chat" />
              <div>
                <FieldLabel>Legacy Custom Instructions</FieldLabel>
                <Hint>Used only if no prompt above is active. Prefer the Prompt Library for new prompts.</Hint>
                <Textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={3}
                  placeholder="e.g. Always answer as a no-nonsense literary critic."
                  className="bg-surface-container-high border-none text-sm mt-1.5"
                />
                <div className="flex gap-2 mt-2">
                  <Button size="sm" onClick={() => { setCustomSystemPrompt(promptDraft); toast.success("Saved"); }}>Save</Button>
                  {customSystemPrompt && (
                    <Button size="sm" variant="destructive" onClick={() => { setCustomSystemPrompt(""); setPromptDraft(""); toast.success("Cleared"); }}>Clear</Button>
                  )}
                </div>
              </div>
              <div>
                <FieldLabel
                  right={maxReplySentences > 0
                    ? <span className="text-primary normal-case tracking-normal">≈{maxReplySentences * 7}s of speech</span>
                    : undefined}
                >
                  Max Sentences Per Reply
                </FieldLabel>
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  {[
                    { label: "Off", v: 0 },
                    { label: "Concise · 2", v: 2 },
                    { label: "Normal · 4", v: 4 },
                    { label: "Detailed · 8", v: 8 },
                  ].map((p) => (
                    <Button
                      key={p.label}
                      size="sm"
                      variant={maxReplySentences === p.v ? "default" : "outline"}
                      onClick={() => setMaxReplySentences(p.v)}
                      aria-pressed={maxReplySentences === p.v}
                    >
                      {p.label}
                    </Button>
                  ))}
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      max={12}
                      value={maxReplySentences || ""}
                      placeholder="—"
                      onChange={(e) => setMaxReplySentences(Number(e.target.value) || 0)}
                      className="w-16 h-8 bg-surface-container-high border-none text-sm"
                      aria-label="Custom max sentences per reply (1-12)"
                    />
                    <span className="text-[10px] text-on-surface-variant">custom 1–12</span>
                  </div>
                </div>
                <Hint>A hard limit — the reply is cut at the last full sentence and generation stops there (shorter = cheaper). Bullets count as sentences; code blocks don't. Digest and Deep Research are exempt.</Hint>
              </div>

              <div>
                <FieldLabel>Memory Lens</FieldLabel>
                <div className="mt-1.5">
                  <MemoryLensSettings />
                </div>
              </div>
            </Section>

            {/* ── Appearance ── */}
            <Section id="appearance" icon="palette" title="Appearance" description="Pick a theme — also available from the palette icon in the header.">
              <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {themes.map((t) => {
                  const active = t.id === themeId;
                  return (
                    <button
                      key={t.id}
                      role="radio"
                      aria-checked={active}
                      onClick={() => setThemeId(t.id)}
                      className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all active:scale-[0.98] ${
                        active
                          ? "border-primary/50 ring-1 ring-primary/30 bg-primary-container/10"
                          : "border-outline-variant/20 hover:bg-surface-container-high"
                      }`}
                    >
                      <span className="flex shrink-0 mt-0.5 rounded-md overflow-hidden border border-outline-variant/30">
                        {t.swatch.map((c, i) => (
                          <span key={i} style={{ background: c }} className="w-4 h-8 block" />
                        ))}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="font-medium text-sm text-foreground">{t.name}</span>
                          {active && <Check className="w-3.5 h-3.5 text-primary" />}
                        </span>
                        <span className="block text-xs text-on-surface-variant leading-snug mt-0.5">{t.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>

            {/* ── Account & Plan ── */}
            <Section id="account" icon="person" title="Account & Plan">
              <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">{user?.email || "Signed in"}</p>
                  <p className="text-[11px] text-on-surface-variant capitalize">{isPaid ? `${plan} plan` : "Free plan"}</p>
                </div>
                <Button size="sm" variant={isPaid ? "outline" : "default"} onClick={() => openPricing()}>
                  {isPaid ? "Manage plan" : "Upgrade"}
                </Button>
              </div>
              <div>
                <FieldLabel>Developer API Keys</FieldLabel>
                <Hint>Keys for the Bookworm API (separate from your OpenRouter key above).</Hint>
                <div className="mt-1.5 rounded-xl bg-surface-container-high/40 border border-outline-variant/10 p-4">
                  <ApiKeyManager />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <button onClick={() => openSetupWizard(0)} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline">
                  <span className="material-symbols-outlined text-sm" aria-hidden>school</span>
                  New here? Run the setup helper
                </button>
              </div>
            </Section>
          </div>
        </main>
      </div>
    </div>
  );
};

export default SettingsPanel;
