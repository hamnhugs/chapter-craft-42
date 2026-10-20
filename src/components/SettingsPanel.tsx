import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ProgramRunnerSettings from "@/components/ProgramRunnerSettings";
import LocalModelsSettings from "@/components/LocalModelsSettings";
import { Choice, Disclosure, Group, Pill, Row, selectCls } from "@/components/settings/SettingsUI";
import { getMemoryMode, setMemoryMode, MemoryMode } from "@/lib/knowledgeApi";
import { consumeSettingsSection } from "@/lib/settingsNav";
import { synthesizeSpeech, fetchInworldVoices, type InworldVoice } from "@/lib/inworldTts";
import { isEmbeddingModel, isBatchOnlyModel } from "@/lib/utils";
import { isLocalBackend } from "@/lib/localServices";
import { allProviders, describeModel, freeChatProviders, isNvidiaModel, localModelId, modelProvider, namespacedId, providerConfigured, providerLabel } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";
import { namespacedNvidiaId, NVIDIA_STARTER_MODEL } from "@/lib/nvidiaCatalog";
import { LEAN_MODES, LEAN_MODE_INFO } from "@/lib/leanMode";
import { validateNvidiaKey } from "@/lib/providers/nvidiaAdapter";
import { FIGURE_MODELS_PAID, FIGURE_MODELS_FREE, DEFAULT_FIGURE_MODEL } from "@/lib/figureModels";

// The Settings tab — every user preference in one place.
//
// Why one hub: settings scattered across tabs fail the "where do I change X?"
// test (NN/g: users look for a single Settings location before anything else).
//
// Layout (2026-10-15 rework — the old single scroll had grown past 9,000px
// and, on a 956×506 window, showed no setting at all on the first screen):
//  - A sidebar of sections with ONE section shown at a time — the macOS
//    System Settings / Linear / GitHub pattern. On a narrow window the
//    sidebar becomes the first screen and a section opens over it (iOS
//    drill-in), so nothing needs sideways scrolling.
//  - A search box over every setting (VS Code's finding: with many settings,
//    people search rather than browse). A result opens its section and
//    flashes the row.
//  - Grouped rows: label + one short line on the left, control on the right.
//    Long explanations hide behind an ⓘ (progressive disclosure — NN/g:
//    show the few things most people need, keep the rest one obvious click
//    away, no more than two levels).
//  - Grouped by what the user is trying to do: every API key on one page,
//    every "which model does this job" picker in one table.
// Controls apply immediately (no global Save button to forget); secrets keep
// an explicit Save so a half-typed key is never stored.
//
// Contextual quick toggles (Read Aloud / Hands-free in Counsel, Recording
// mode in Neuron) intentionally stay where they are — research favors a
// central hub PLUS shortcuts at the point of use, not either/or.

const VOICE_QUICK_SEARCH_KEY = "voice_quick_search";
const VOICE_QUICK_SEARCH_MODEL_KEY = "voice_quick_search_model";
const BARGE_IN_KEY = "hands_free_barge_in";
/** The pocket screen defaults ON — it is a battery and phantom-tap guard, and
 *  it existed before it was a setting, so absence must read as enabled. */
const POCKET_SCREEN_KEY = "hands_free_pocket_screen";
const LAST_SECTION_KEY = "cc-settings-section";

type SectionId =
  | "models" | "keys" | "voice" | "research" | "images" | "memory" | "prompts" | "appearance" | "account"
  | "permissions" | "foundry" | "programs";

const SECTIONS: { id: SectionId; icon: string; title: string; blurb: string; power?: boolean }[] = [
  { id: "models", icon: "tune", title: "Models", blurb: "Which AI answers, which one does each job, and what it may spend." },
  { id: "keys", icon: "key", title: "API keys", blurb: "The accounts the app uses on your behalf. Keys save only when you press Save." },
  { id: "voice", icon: "record_voice_over", title: "Voice", blurb: "How replies sound, and how hands-free conversations behave." },
  { id: "research", icon: "travel_explore", title: "Research", blurb: "Live web search and what Counsel may read." },
  { id: "images", icon: "image", title: "Images & video", blurb: "Models and defaults for pictures, video and 3D." },
  { id: "memory", icon: "menu_book", title: "Notes & library", blurb: "Whether Counsel saves notes, and how new books are catalogued." },
  { id: "prompts", icon: "edit_note", title: "Replies & prompts", blurb: "Reply length, saved prompts and standing instructions." },
  { id: "appearance", icon: "palette", title: "Appearance", blurb: "Theme and seasonal colour." },
  { id: "account", icon: "person", title: "Account", blurb: "Your plan, developer keys and the setup helper." },
  { id: "permissions", icon: "shield_person", title: "AI permissions", blurb: "Exactly which tools the AI may use on your behalf.", power: true },
  { id: "foundry", icon: "construction", title: "Tool Foundry", blurb: "Reusable tools the AI forges for itself — nothing runs without your approval.", power: true },
  { id: "programs", icon: "dns", title: "Program Foundry", blurb: "Run real programs on your VPS in a sealed sandbox, each one approved by you.", power: true },
];
const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

/** Everything the search box can find. `anchor` matches a Row/Disclosure id;
 *  without one, the result opens the section. `k` holds extra words people
 *  might type for it. */
const SEARCH_INDEX: { s: SectionId; label: string; anchor?: string; k?: string }[] = [
  { s: "models", label: "Chat model", anchor: "chat-model", k: "active model llm provider" },
  { s: "models", label: "Local AI (models on this computer)", anchor: "local-ai", k: "ollama offline gpu private" },
  { s: "models", label: "Voice replies model", anchor: "role-voice", k: "spoken hands-free" },
  { s: "models", label: "Model for pictures you attach", anchor: "role-vision", k: "vision image ocr" },
  { s: "models", label: "Deep Research model", anchor: "role-deep", k: "reasoning" },
  { s: "models", label: "Quick search model", anchor: "role-quick", k: "web" },
  { s: "models", label: "Background summaries model", anchor: "role-utility", k: "utility compaction gists" },
  { s: "models", label: "Notebook upkeep model", anchor: "role-wiki", k: "notebook extract health" },
  { s: "models", label: "Book figures model", anchor: "role-figures", k: "figure extraction images diagrams" },
  { s: "models", label: "Spending", anchor: "spending", k: "lean chat only cost money budget" },
  { s: "models", label: "Studio tools", anchor: "studio", k: "video 3d masters blueprints tokens" },
  { s: "models", label: "Saved models", anchor: "saved-models", k: "add remove model list browse" },
  { s: "models", label: "Diagnostics", anchor: "diagnostics", k: "debug" },
  { s: "keys", label: "OpenRouter key", anchor: "key-openrouter", k: "api credit balance" },
  { s: "keys", label: "NVIDIA key", anchor: "key-nvidia", k: "api free nvapi" },
  { s: "keys", label: "Gemini key", anchor: "key-gemini", k: "google api ai studio" },
  { s: "keys", label: "Tavily key (free web search)", anchor: "key-tavily", k: "search api" },
  { s: "keys", label: "Burplexity token (web search)", anchor: "key-burplexity", k: "search api perplexity" },
  { s: "keys", label: "Inworld key (voices)", anchor: "key-inworld", k: "tts voice api" },
  { s: "voice", label: "Read replies aloud", anchor: "auto-read", k: "tts speak" },
  { s: "voice", label: "Reading speed", anchor: "tts-rate", k: "playback rate" },
  { s: "voice", label: "Inworld voice", anchor: "inworld", k: "tts character voice" },
  { s: "voice", label: "Hands-free speech speed", anchor: "hf-rate", k: "rate" },
  { s: "voice", label: "Interrupt by talking (barge-in)", anchor: "barge-in", k: "echo headphones" },
  { s: "voice", label: "Pocket screen", anchor: "pocket", k: "phone dim battery" },
  { s: "research", label: "Web search", anchor: "web-search", k: "tavily burplexity internet" },
  { s: "research", label: "Background quick search", anchor: "quick-search" },
  { s: "research", label: "Search all notebooks", anchor: "all-neurons", k: "access brain" },
  { s: "images", label: "Image generation", anchor: "gen-images", k: "picture model aspect quality" },
  { s: "images", label: "Video generation", anchor: "gen-video", k: "clip veo cost" },
  { s: "images", label: "3D models", anchor: "gen-3d", k: "splat fal gaussian" },
  { s: "memory", label: "Off the record", anchor: "memory-mode", k: "save notes memory recording private pause" },
  { s: "memory", label: "Point out contradictions", anchor: "reflex", k: "reflex conflict disagree" },
  { s: "memory", label: "Auto-show note images", anchor: "memory-lens", k: "muted images lens memory" },
  { s: "memory", label: "Catalog new books automatically", anchor: "catalog", k: "summaries upload chapters" },
  { s: "prompts", label: "Reply length", anchor: "reply-length", k: "max sentences concise" },
  { s: "prompts", label: "Prompt library", anchor: "prompt-library", k: "presets system prompt" },
  { s: "prompts", label: "Older custom instructions", anchor: "legacy-prompt", k: "system prompt" },
  { s: "appearance", label: "Theme", anchor: "theme", k: "dark light colors" },
  { s: "appearance", label: "Drift with the season", anchor: "seasonal", k: "hemisphere accent" },
  { s: "account", label: "Plan", anchor: "plan", k: "upgrade pro billing email" },
  { s: "account", label: "Developer API keys", anchor: "dev-keys", k: "bookworm api" },
  { s: "account", label: "Setup helper", anchor: "setup", k: "wizard onboarding" },
  { s: "permissions", label: "AI tool permissions", k: "delete allow tools" },
  { s: "foundry", label: "Tool Foundry", k: "toolshed forge" },
  { s: "programs", label: "Program Foundry", k: "vps bash python sandbox" },
];

const PROVIDER_GROUP_LABEL: Record<ProviderId, string> = {
  ollama: "Local — runs on this computer, free and private",
  nvidia: "NVIDIA — free, no balance needed",
  gemini: "Gemini — free tier, billed to Google beyond it",
  openrouter: "OpenRouter — billed to your OpenRouter balance",
};

/** Saved-model options, provider-labelled. Providers serve many models under
 *  BYTE-IDENTICAL names, so every option carries its provider in the text —
 *  grouping alone is not enough, and an <option> cannot hold a badge. Labels
 *  are never stripped of provenance. `openrouterOnly` is for features that
 *  run server-side on the OpenRouter key (wiki ops) — a POSITIVE filter, so
 *  a newly added provider can't leak in by omission. */
const ModelOptions: React.FC<{ models: string[]; openrouterOnly?: boolean }> = ({ models, openrouterOnly }) => {
  const groups = allProviders()
    .map((p) => ({
      provider: p,
      models: openrouterOnly && p !== "openrouter" ? [] : models.filter((m) => modelProvider(m) === p),
    }))
    .filter((g) => g.models.length > 0);
  // One provider in play ⇒ the flat list users saw before groups existed.
  if (groups.length <= 1) {
    return <>{(groups[0]?.models ?? []).map((m) => (<option key={m} value={m}>{describeModel(m)}</option>))}</>;
  }
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.provider} label={PROVIDER_GROUP_LABEL[g.provider]}>
          {g.models.map((m) => (<option key={m} value={m}>{describeModel(m)}</option>))}
        </optgroup>
      ))}
    </>
  );
};

/** Provider badge for surfaces that CAN hold markup (chips, rows). Free-tier
 *  providers get the accent so "this one costs nothing" reads at a glance. */
const ProviderBadge: React.FC<{ id: string }> = ({ id }) => {
  const p = modelProvider(id);
  const free = freeChatProviders().includes(p);
  return (
    <span
      className={`text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 rounded shrink-0 ${
        free ? "bg-primary-container/30 text-primary" : "bg-surface-container-highest text-on-surface-variant"
      }`}
    >
      {providerLabel(p)}
    </span>
  );
};

/** Password-style secret on one line with an explicit Save (keys shouldn't
 *  save per keystroke) and Remove once something is stored. */
const SecretField: React.FC<{
  value: string;
  placeholder: string;
  onSave: (v: string) => void;
  saveLabel?: string;
}> = ({ value, placeholder, onSave, saveLabel = "Save" }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="flex flex-wrap gap-2">
      <Input
        type="password"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSave(draft); }}
        className="flex-1 min-w-[12rem] text-sm font-mono bg-surface-container-high border-outline-variant/15"
      />
      <Button size="sm" onClick={() => onSave(draft)} disabled={draft === value}>{saveLabel}</Button>
      {value && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { setDraft(""); onSave(""); }}>Remove</Button>}
    </div>
  );
};

/** One API key: name, what it's for, saved/not-set at a glance. The editor
 *  opens on demand so a page of six keys reads as six lines, not six forms. */
const KeyRow: React.FC<{
  id: string;
  name: string;
  purpose: React.ReactNode;
  saved: boolean;
  savedText?: string;
  status?: React.ReactNode;
  more?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, name, purpose, saved, savedText = "Saved", status, more, actions, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <Row
      id={id}
      label={<span className="flex items-center gap-2 flex-wrap">{name}{saved ? <Pill tone="ok"><Check className="w-3 h-3" />{savedText}</Pill> : <Pill>Not set</Pill>}</span>}
      description={<>{purpose}{status && <span className="block mt-0.5">{status}</span>}</>}
      more={more}
      after={open ? children : undefined}
    >
      <div className="flex gap-2">
        {actions}
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Close" : saved ? "Change" : "Add key"}
        </Button>
      </div>
    </Row>
  );
};

const SettingsPanel: React.FC = () => {
  const { user } = useAuth();
  const { isPaid, plan } = usePlan();
  const { themeId, setThemeId, themes, season, seasonal, setSeasonal, hemispherePref, setHemispherePref } = useTheme();
  const {
    utilityModel, setUtilityModel, studioTools, setStudioTools,
    apiKey, nvidiaKeyLast4, geminiApiKey, tavilyApiKey, leanMode, savedModels, selectedModel, deepResearchModel, voiceModel, visionModel, ttsRate,
    handsFreeTtsRate, maxReplySentences,
    autoReadReplies, wikiModel, customSystemPrompt, burplexityApiToken,
    inworldApiKey, inworldEnabled, inworldVoiceId, accessAllNeurons, loaded,
    imageExtractionModel, autoCatalogOnUpload,
    saveApiKey, saveNvidiaKey, setGeminiApiKey, setTavilyApiKey, setLeanMode, addModel, removeModel, setSelectedModel, setDeepResearchModel,
    setVoiceModel, setVisionModel, setTtsRate, setHandsFreeTtsRate, setMaxReplySentences, setAutoReadReplies, setWikiModel,
    setCustomSystemPrompt, setBurplexityApiToken, setInworldApiKey,
    setInworldEnabled, setInworldVoiceId, setAccessAllNeurons,
    setImageExtractionModel, setAutoCatalogOnUpload,
  } = useChatSettings();

  const [newModelInput, setNewModelInput] = useState("");
  const [newModelProvider, setNewModelProvider] = useState<ProviderId>("openrouter");
  const [nvidiaKeyDraft, setNvidiaKeyDraft] = useState("");
  const [testingNvidia, setTestingNvidia] = useState(false);
  const [nvidiaStatus, setNvidiaStatus] = useState<string | null>(null);
  const [orStatus, setOrStatus] = useState<string | null>(null);
  const [orFreeTier, setOrFreeTier] = useState(false);
  // Write-only key UX: once the save lands (last4 appears), drop the
  // plaintext from component state.
  useEffect(() => { if (nvidiaKeyLast4) setNvidiaKeyDraft(""); }, [nvidiaKeyLast4]);

  const activeProviderUsable = providerConfigured(modelProvider(selectedModel), { apiKey, geminiApiKey, nvidiaKeyLast4 });

  /** Paste repair: a pasted "nvidia:vendor/model" sets the provider select
   *  and strips the tag, so the routing token is never typed OR retyped. */
  const handleModelInputChange = (raw: string) => {
    const p = modelProvider(raw);
    if (p !== "openrouter") {
      setNewModelProvider(p);
      setNewModelInput(localModelId(raw));
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
  // actually usable right now. Chat doesn't use ONE model — Deep Research,
  // voice and image turns each swap in their own, and a role still pointing
  // at a provider you can't use fails only on those turns, which reads as
  // random breakage.
  const roleUsable = (id: string) =>
    modelProvider(id) === "ollama" ? true : modelProvider(id) === "nvidia" ? !!nvidiaKeyLast4 : !!apiKey;
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
    `notes: ${wikiModel || "(default)"}`,
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
        : `Key valid${remaining}.`);
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

  // localStorage-backed toggles shared with Counsel (it re-reads them when shown).
  const [voiceQuickSearch, setVoiceQuickSearch] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_KEY) === "true");
  const [voiceQuickSearchModel, setVoiceQuickSearchModel] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_MODEL_KEY) || "");
  const [bargeInEnabled, setBargeInEnabled] = useState(() => localStorage.getItem(BARGE_IN_KEY) === "true");
  const [pocketScreen, setPocketScreen] = useState(() => localStorage.getItem(POCKET_SCREEN_KEY) !== "false");
  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_KEY, String(voiceQuickSearch)); }, [voiceQuickSearch]);
  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_MODEL_KEY, voiceQuickSearchModel); }, [voiceQuickSearchModel]);
  useEffect(() => { localStorage.setItem(BARGE_IN_KEY, String(bargeInEnabled)); }, [bargeInEnabled]);
  useEffect(() => { localStorage.setItem(POCKET_SCREEN_KEY, String(pocketScreen)); }, [pocketScreen]);

  // Off the record (user_settings.is_recording_mode, inverted). The notebook
  // view and Counsel re-read it on mount.
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
      toast.success(next === "recording" ? "Saving notes again" : "Off the record — nothing new is saved");
    } catch (err: any) {
      toast.error(err.message || "Couldn't change that setting");
    } finally {
      setMemoryModeLoading(false);
    }
  };

  // ----- Inworld voice management -----
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
    const raw = localModelId(newModelInput.trim());
    if (!raw) return;
    if (newModelProvider !== "openrouter" && /:(free|nitro|floor|exacto)$/.test(raw)) {
      toast.error(`Suffixes like :free are OpenRouter routing variants — ${providerLabel(newModelProvider)} models don't have them.`);
      return;
    }
    addModel(namespacedId(newModelProvider, raw));
    setNewModelInput("");
  };

  // ----- Navigation: one section at a time -----
  const [active, setActive] = useState<SectionId>(() => {
    try {
      const last = localStorage.getItem(LAST_SECTION_KEY);
      if (last && SECTION_IDS.has(last)) return last as SectionId;
    } catch { /* storage blocked */ }
    return "models";
  });
  // Narrow windows: the section list is the first screen; picking one opens it.
  const [narrowList, setNarrowList] = useState(true);
  const [query, setQuery] = useState("");
  const paneRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const go = useCallback((id: string, anchor?: string) => {
    const sid = (SECTION_IDS.has(id) ? id : "models") as SectionId;
    setActive(sid);
    setNarrowList(false);
    try { localStorage.setItem(LAST_SECTION_KEY, sid); } catch { /* storage blocked */ }
    // After the section renders: scroll to the row (and flash it) or to the top.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = anchor ? document.getElementById(`set-${anchor}`) : null;
      if (el) {
        if (el instanceof HTMLDetailsElement) el.open = true;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("cc-set-flash");
        void el.offsetWidth;
        el.classList.add("cc-set-flash");
      } else {
        paneRef.current?.scrollTo({ top: 0 });
      }
    }));
  }, []);

  // Deep link from other tabs (Counsel's "add a key", Neuron's menu, …).
  useEffect(() => {
    const id = consumeSettingsSection();
    if (id) go(id);
  }, [go]);

  // "/" jumps to search, like most apps with a settings search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!searchRef.current || searchRef.current.offsetParent === null) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const title = (s: SectionId) => SECTIONS.find((x) => x.id === s)!.title;
    return SEARCH_INDEX.filter((e) => {
      const hay = `${e.label} ${e.k || ""} ${title(e.s)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 12);
  }, [query]);

  const section = SECTIONS.find((s) => s.id === active)!;
  const webSearchBackend = burplexityApiToken ? "Burplexity" : tavilyApiKey ? "Tavily (free)" : null;
  const goKeys = (anchor: string) => go("keys", anchor);

  const navButton = (s: (typeof SECTIONS)[number]) => {
    const on = s.id === active;
    return (
      <button
        key={s.id}
        data-no-sticker
        onClick={() => go(s.id)}
        aria-current={on ? "page" : undefined}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-left transition-colors ${
          on
            ? "sm:bg-primary-container/20 sm:text-primary sm:font-semibold text-foreground"
            : "text-foreground sm:text-on-surface-variant hover:bg-surface-container-high hover:text-foreground"
        }`}
      >
        <span
          className={`material-symbols-outlined text-[20px] ${on ? "sm:text-primary" : ""} text-on-surface-variant`}
          style={on ? { fontVariationSettings: "'FILL' 1" } : undefined}
          aria-hidden
        >
          {s.icon}
        </span>
        <span className="flex-1 min-w-0 truncate">{s.title}</span>
        <span className="material-symbols-outlined text-lg text-on-surface-variant sm:hidden" aria-hidden>chevron_right</span>
      </button>
    );
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Section list (sidebar; the whole first screen when narrow) ── */}
      <nav
        aria-label="Settings sections"
        className={`${narrowList ? "flex" : "hidden"} sm:flex w-full sm:w-52 lg:w-60 shrink-0 flex-col border-r border-outline-variant/10 overflow-y-auto`}
      >
        <div className="px-3 pt-5 pb-2 sm:pt-6 space-y-3">
          <h2 className="px-1 font-headline font-bold text-2xl text-foreground tracking-tight">Settings</h2>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-lg text-on-surface-variant pointer-events-none" aria-hidden>search</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results[0]) { go(results[0].s, results[0].anchor); setQuery(""); }
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              className="w-full bg-surface-container-high border border-outline-variant/15 rounded-lg text-sm text-foreground py-2 pl-9 pr-3 placeholder:text-on-surface-variant/70 focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
          </div>
        </div>

        <div className="px-3 pb-6 flex-1">
          {query.trim() ? (
            results.length > 0 ? (
              <ul className="space-y-0.5" aria-label="Search results">
                {results.map((r) => (
                  <li key={`${r.s}-${r.label}`}>
                    <button
                      data-no-sticker
                      onClick={() => { go(r.s, r.anchor); setQuery(""); }}
                      className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-surface-container-high transition-colors"
                    >
                      <span className="block text-sm text-foreground">{r.label}</span>
                      <span className="block text-[11px] text-on-surface-variant">{SECTIONS.find((s) => s.id === r.s)!.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2.5 py-2 text-sm text-on-surface-variant">No setting matches “{query.trim()}”.</p>
            )
          ) : (
            <>
              <div className="space-y-0.5">{SECTIONS.filter((s) => !s.power).map(navButton)}</div>
              <p className="px-2.5 pt-5 pb-1.5 text-[11px] font-semibold text-on-surface-variant/80">Power tools</p>
              <div className="space-y-0.5">{SECTIONS.filter((s) => s.power).map(navButton)}</div>
            </>
          )}
        </div>
      </nav>

      {/* ── The open section ── */}
      <div ref={paneRef} className={`${narrowList ? "hidden" : "block"} sm:block flex-1 min-w-0 overflow-y-auto`}>
        <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 sm:pt-7 pb-24 space-y-6">
          <header>
            <button
              data-no-sticker
              onClick={() => setNarrowList(true)}
              className="sm:hidden -ml-1 mb-2 inline-flex items-center gap-0.5 text-sm text-primary"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>chevron_left</span>
              Settings
            </button>
            <h3 className="font-headline font-bold text-2xl text-foreground tracking-tight">{section.title}</h3>
            <p className="text-sm text-on-surface-variant mt-1">{section.blurb}</p>
          </header>

          {/* ── Models ── */}
          {active === "models" && (
            <>
              <Group>
                <Row
                  id="chat-model"
                  label="Chat model"
                  description={
                    activeProviderUsable ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm text-primary" aria-hidden>check_circle</span>
                        Answering on {providerLabel(modelProvider(selectedModel))}
                      </span>
                    ) : (
                      <span className="text-destructive">
                        No {providerLabel(modelProvider(selectedModel))} key saved —{" "}
                        <button data-no-sticker className="underline" onClick={() => goKeys(`key-${modelProvider(selectedModel)}`)}>add it</button> or pick another model.
                      </span>
                    )
                  }
                >
                  <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className={selectCls} aria-label="Chat model">
                    <ModelOptions models={savedModels.filter((m) => (!isEmbeddingModel(m) && !isBatchOnlyModel(m)) || m === selectedModel)} />
                  </select>
                </Row>
              </Group>

              <LocalModelsSettings />

              <Group
                title="Model for each job"
                footer="Each job can run on its own model — a fast one for voice, a strong one for research. “Same as chat” follows the chat model."
              >
                <Row id="role-voice" label="Voice replies" description={!roleUsable(voiceModel || selectedModel) ? <span className="text-destructive">No key for this provider — spoken turns will fail</span> : "Spoken replies and hands-free. A fast model feels snappier."}>
                  <select value={voiceModel || ""} onChange={(e) => setVoiceModel(e.target.value)} className={selectCls} aria-label="Voice replies model">
                    <option value="">Same as chat</option>
                    <ModelOptions models={savedModels.filter((m) => !isBatchOnlyModel(m) || m === voiceModel)} />
                  </select>
                </Row>
                <Row
                  id="role-vision"
                  label="Pictures you attach"
                  description={!roleUsable(visionModel || selectedModel) ? <span className="text-destructive">No key for this provider — image turns will fail</span> : "Reads images you add to a message."}
                  more={<>For best image understanding pick a vision-strong model like <code>google/gemini-2.5-flash</code> (cheap, great at docs/OCR) or <code>google/gemini-2.5-pro</code> (best reasoning).</>}
                >
                  <select value={visionModel || ""} onChange={(e) => setVisionModel(e.target.value)} className={selectCls} aria-label="Vision model">
                    <option value="">Same as chat</option>
                    <ModelOptions models={savedModels.filter((m) => !isBatchOnlyModel(m) || m === visionModel)} />
                  </select>
                </Row>
                <Row id="role-deep" label="Deep Research" description={!roleUsable(deepResearchModel) ? <span className="text-destructive">No key for this provider — research turns will fail</span> : "Used when Deep Research is on. Pick a strong reasoner."}>
                  <select value={deepResearchModel} onChange={(e) => setDeepResearchModel(e.target.value)} className={selectCls} aria-label="Deep Research model">
                    <ModelOptions models={savedModels.filter((m) => !isBatchOnlyModel(m) || m === deepResearchModel)} />
                  </select>
                </Row>
                <Row id="role-quick" label="Quick search" description="Sums up background search results. Lightweight is best.">
                  <select value={voiceQuickSearchModel || selectedModel} onChange={(e) => setVoiceQuickSearchModel(e.target.value)} className={selectCls} aria-label="Quick search model">
                    <ModelOptions models={savedModels.filter((m) => !isBatchOnlyModel(m) || m === voiceQuickSearchModel)} />
                  </select>
                </Row>
                <Row
                  id="role-utility"
                  label="Background summaries"
                  description="Condenses long chats, chapter gists and book summaries."
                  more="Long chats are summarized in the background so older messages don't have to be re-sent. Automatic uses Gemini 2.5 Flash-Lite on OpenRouter or Gemini, and your chat model on NVIDIA or a free model."
                >
                  <select value={utilityModel || ""} onChange={(e) => setUtilityModel(e.target.value)} className={selectCls} aria-label="Background model">
                    <option value="">Automatic (low-cost)</option>
                    <ModelOptions models={savedModels.filter((m) => !isBatchOnlyModel(m) || m === utilityModel)} />
                  </select>
                </Row>
                <Row
                  id="role-wiki"
                  label="Notebook upkeep"
                  description={wikiModel && !apiKey && !isLocalBackend()
                    ? <span className="text-destructive">No OpenRouter key — notebook ops fall back to the default.</span>
                    : "Runs the daily tidy-up and health checks on your notes."}
                  more="Notebook ops run on OpenRouter only, so NVIDIA and local models aren't offered here. Custom models need your OpenRouter key."
                >
                  <select
                    // An NVIDIA id can only get here via the Admin panel's
                    // free-text field; wiki ops can't run it, so show (and on
                    // any change, save) the default rather than an empty control.
                    value={!wikiModel || isNvidiaModel(wikiModel) ? "__default__" : wikiModel}
                    onChange={(e) => setWikiModel(e.target.value === "__default__" ? "" : e.target.value)}
                    className={selectCls}
                    aria-label="Notebook model"
                  >
                    <option value="__default__">Default (Gemini Flash)</option>
                    <ModelOptions models={savedModels.filter((m) => !isBatchOnlyModel(m))} openrouterOnly />
                  </select>
                </Row>
                <Row
                  id="role-figures"
                  label="Book figures"
                  description="Describes diagrams and charts pulled from your books."
                  more={<>Reads the figures pulled out of your uploaded documents, writes a description for each, and files it in your Images tagged with its book, page and chapter — so chat can show the real picture while explaining the concept. Run it from a book card's <span className="material-symbols-outlined text-xs align-middle">image_search</span> button; described figures are stored forever and cost nothing to reuse. Runs on your OpenRouter key; free models are limited to ~20 requests/min and 50–1000/day.</>}
                >
                  <select value={imageExtractionModel || ""} onChange={(e) => setImageExtractionModel(e.target.value)} className={selectCls} aria-label="Figure extraction model">
                    <option value="">Default — {DEFAULT_FIGURE_MODEL}</option>
                    {/* A non-OpenRouter id saved by an older picker must stay
                        VISIBLE (the server ignores it and uses the default) —
                        silently rendering "Default" would hide a setting that
                        still exists and does nothing. */}
                    {imageExtractionModel && modelProvider(imageExtractionModel) !== "openrouter" && (
                      <option value={imageExtractionModel} disabled>
                        {imageExtractionModel} — saved earlier, but figures need an OpenRouter model; pick one below
                      </option>
                    )}
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
                      const extra = savedModels.filter((m) => !known.has(m) && !isEmbeddingModel(m) && modelProvider(m) === "openrouter");
                      return extra.length > 0 ? (
                        <optgroup label="Your saved models">
                          {extra.map((m) => (<option key={m} value={m}>{m}</option>))}
                        </optgroup>
                      ) : null;
                    })()}
                  </select>
                </Row>
              </Group>

              <Group title="Cost">
                <Row
                  id="spending"
                  label="Spending"
                  description={LEAN_MODE_INFO[leanMode].summary}
                  more={<>Blocked capabilities are removed from the assistant's tools entirely, so it can't offer or attempt them — it will say so once and give you the best free version instead. Anything you've already made stays fully viewable in every mode. Applies to all your devices.{leanMode !== "full" && " Figure extraction isn’t covered — it only runs when you queue it from a book card."}</>}
                >
                  <Choice
                    ariaLabel="Spending"
                    value={leanMode}
                    onChange={(m) => { void setLeanMode(m); }}
                    options={LEAN_MODES.map((m) => ({ value: m, label: LEAN_MODE_INFO[m].label }))}
                  />
                </Row>
                <Row
                  id="studio"
                  label="Studio tools"
                  description="Video, 3D, masters, blueprints and stage plans."
                  more="These tools add about 10,000 tokens to every message you send, so by default they join a chat only after you ask for a video, a 3D model or a blueprint (or one is already in the chat), and then stay on for 12 hours."
                >
                  <select value={studioTools} onChange={(e) => setStudioTools(e.target.value as typeof studioTools)} className={selectCls} aria-label="Studio tools">
                    <option value="auto">Auto — when a chat needs them</option>
                    <option value="always">Always on</option>
                    <option value="off">Off</option>
                  </select>
                </Row>
              </Group>

              <Group>
                <Disclosure id="saved-models" icon="list" label="Saved models" summary={`${savedModels.length} saved — the list every picker above chooses from`}>
                  <div className="space-y-3">
                    {/* Provider is a CHOICE, never something typed: the routing
                        tag can't be forgotten if it can't be typed. */}
                    <div className="flex flex-wrap gap-2">
                      <select
                        value={newModelProvider}
                        onChange={(e) => setNewModelProvider(e.target.value as ProviderId)}
                        className="bg-surface-container-high border border-outline-variant/15 rounded-lg text-sm text-foreground py-2 px-3 shrink-0"
                        aria-label="Provider for the model being added"
                      >
                        {allProviders().map((p) => (
                          <option key={p} value={p}>{providerLabel(p)}</option>
                        ))}
                      </select>
                      <Input
                        type="text"
                        placeholder="vendor/model"
                        value={newModelInput}
                        onChange={(e) => handleModelInputChange(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleAddModel(); }}
                        className="flex-1 min-w-[10rem] text-sm font-mono bg-surface-container-high border-outline-variant/15"
                      />
                      <Button size="sm" onClick={handleAddModel}>Add</Button>
                    </div>
                    {(["nvidia", "openrouter"] as const).map((p) => {
                      const group = savedModels.filter((m) => modelProvider(m) === p);
                      if (group.length === 0) return null;
                      return (
                        <div key={p}>
                          <div className="text-xs text-on-surface-variant mb-1.5">{providerLabel(p)}{p === "nvidia" ? " — free" : ""}</div>
                          <div className="flex flex-wrap gap-1.5">
                            {group.map((m) => {
                              const embed = isEmbeddingModel(m);
                              const batchOnly = isBatchOnlyModel(m);
                              return (
                                <span
                                  key={m}
                                  title={
                                    embed
                                      ? "Embedding model — used by Notebook reindex, not Chat"
                                      : batchOnly
                                        ? "Batch-pricing variant — OpenRouter serves it only through the asynchronous Batch API, so no live feature here can run it"
                                        : describeModel(m)
                                  }
                                  className={`inline-flex items-center gap-1 text-xs pl-2 pr-1 py-1 rounded-md ${
                                    m === selectedModel
                                      ? "bg-primary-container/20 text-primary border border-primary-container/30"
                                      : embed || batchOnly
                                        ? "bg-surface-container-highest/50 text-on-surface-variant/60 italic"
                                        : "bg-surface-container-highest text-on-surface-variant"
                                  }`}
                                >
                                  <button
                                    data-no-sticker
                                    onClick={() => {
                                      if (embed) { toast.error("Embedding model — it's used for search, not Chat."); return; }
                                      setSelectedModel(m);
                                    }}
                                    className="hover:underline font-mono"
                                  >
                                    {localModelId(m)}{embed ? " (embed)" : ""}
                                  </button>
                                  <button data-no-sticker onClick={() => removeModel(m)} aria-label={`Remove ${m}`} className="hover:text-destructive material-symbols-outlined text-sm leading-none">close</button>
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    <button
                      data-no-sticker
                      onClick={() => window.open("#/models", "_blank")}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <span className="material-symbols-outlined text-sm" aria-hidden>leaderboard</span>
                      Browse top models by category
                    </button>
                  </div>
                </Disclosure>
                <Disclosure id="diagnostics" icon="bug_report" label="Diagnostics" summary="Which model and key each job is using — copy it when reporting a problem">
                  <div className="rounded-lg bg-surface-container-high divide-y divide-outline-variant/10 mb-2">
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
                  <pre className="text-[10px] bg-surface-container-highest rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap">{diagnosticsText}</pre>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => { void navigator.clipboard?.writeText(diagnosticsText).then(() => toast.success("Diagnostics copied")); }}
                  >
                    Copy
                  </Button>
                </Disclosure>
              </Group>
            </>
          )}

          {/* ── API keys ── */}
          {active === "keys" && (
            <>
              <Group title="AI providers" footer="You need one of these for cloud chat. NVIDIA and Gemini are free.">
                <KeyRow
                  id="key-openrouter"
                  name="OpenRouter"
                  purpose="Hundreds of models, paid per use. Also runs images, video and book tools."
                  saved={!!apiKey}
                  status={apiKey && orStatus ? (
                    <span className={orFreeTier ? "text-destructive" : ""}>
                      {orStatus}
                      {orFreeTier && !nvidiaKeyLast4 && " Add a free NVIDIA key below to keep chatting."}
                    </span>
                  ) : undefined}
                  more={<>Pays per token, billed to your OpenRouter account. OpenRouter requires a lifetime top-up of about $10 before its models will run — <strong>including the ones labelled <code>:free</code></strong>. NVIDIA has no such requirement.</>}
                  actions={orFreeTier && nvidiaKeyLast4 && modelProvider(selectedModel) === "openrouter" ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        const target = savedModels.find((m) => isNvidiaModel(m)) || namespacedNvidiaId(NVIDIA_STARTER_MODEL);
                        if (!savedModels.includes(target)) addModel(target);
                        else setSelectedModel(target);
                        toast.success(`Chat now runs on ${describeModel(target)}`);
                      }}
                    >
                      Switch chat to NVIDIA
                    </Button>
                  ) : undefined}
                >
                  <SecretField value={apiKey} placeholder="sk-or-v1-..." onSave={saveApiKey} />
                </KeyRow>
                <KeyRow
                  id="key-nvidia"
                  name="NVIDIA"
                  purpose={<>Free chat, voice and vision — no card. Get one at <a className="text-primary underline" href="https://build.nvidia.com/settings/api-keys" target="_blank" rel="noreferrer">build.nvidia.com</a>.</>}
                  saved={!!nvidiaKeyLast4}
                  savedText={nvidiaKeyLast4 ? `…${nvidiaKeyLast4}` : undefined}
                  status={nvidiaStatus || undefined}
                  more="Usage is governed by rate limits that vary by model and traffic (NVIDIA retired its credit system), so there's no balance to read — “Test” sends one real request to check. Stored for the relay only; the app never loads it back. Image/video generation and book tools still use your OpenRouter key."
                  actions={nvidiaKeyLast4 ? (
                    <Button size="sm" variant="outline" disabled={testingNvidia} onClick={() => void handleTestNvidia()}>
                      {testingNvidia ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test"}
                    </Button>
                  ) : undefined}
                >
                  {nvidiaKeyLast4 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-mono text-on-surface-variant flex-1">nvapi-••••••{nvidiaKeyLast4}</span>
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { void saveNvidiaKey(""); }}>Remove</Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Input
                        type="password"
                        placeholder="nvapi-..."
                        value={nvidiaKeyDraft}
                        onChange={(e) => setNvidiaKeyDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void handleSaveNvidiaKey(); }}
                        className="flex-1 min-w-[12rem] text-sm font-mono bg-surface-container-high border-outline-variant/15"
                      />
                      <Button size="sm" onClick={() => void handleSaveNvidiaKey()} disabled={!nvidiaKeyDraft}>Save</Button>
                    </div>
                  )}
                </KeyRow>
                <KeyRow
                  id="key-gemini"
                  name="Google Gemini"
                  purpose={<>Free chat with a daily allowance — <a className="text-primary underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a>.</>}
                  saved={!!geminiApiKey}
                  more={<>Gemini also generates and edits images, but <strong>image generation needs billing enabled on your Google account</strong> — the free tier is chat and vision only.</>}
                >
                  <SecretField value={geminiApiKey} placeholder="AIza..." onSave={(v) => { setGeminiApiKey(v); toast.success(v ? "Gemini key saved" : "Gemini key removed"); }} />
                </KeyRow>
              </Group>

              <Group title="Web search" footer="Either one turns on live web search. Tavily is used when no Burplexity token is set.">
                <KeyRow
                  id="key-tavily"
                  name="Tavily"
                  purpose={<>Free — 1,000 searches a month, no card. <a className="text-primary underline" href="https://app.tavily.com" target="_blank" rel="noreferrer">app.tavily.com</a></>}
                  saved={!!tavilyApiKey}
                >
                  <SecretField value={tavilyApiKey} placeholder="tvly-..." onSave={(v) => { setTavilyApiKey(v); toast.success(v ? "Tavily key saved" : "Tavily key removed"); }} />
                </KeyRow>
                <KeyRow
                  id="key-burplexity"
                  name="Burplexity"
                  purpose="Web search plus background quick search. From your Burplexity app → API Keys."
                  saved={!!burplexityApiToken}
                >
                  <SecretField value={burplexityApiToken} placeholder="pp_..." onSave={(v) => { setBurplexityApiToken(v); toast.success(v ? "Burplexity token saved" : "Burplexity token removed"); }} />
                </KeyRow>
              </Group>

              <Group title="Voices" footer="The fal.ai key for 3D lives with the 3D settings in Images & video.">
                <KeyRow id="key-inworld" name="Inworld" purpose="Character voices for reading replies aloud." saved={!!inworldApiKey}>
                  <SecretField value={inworldApiKey} placeholder="Inworld API key…" onSave={saveInworldKey} saveLabel="Save & load voices" />
                </KeyRow>
              </Group>
            </>
          )}

          {/* ── Voice ── */}
          {active === "voice" && (
            <>
              <Group title="Reading aloud">
                <Row id="auto-read" label="Read replies aloud" description="Speaks each new reply as it arrives.">
                  <Switch checked={autoReadReplies} onCheckedChange={setAutoReadReplies} aria-label="Read replies aloud" />
                </Row>
                <Row id="tts-rate" label="Reading speed" stack>
                  <div className="flex items-center gap-3">
                    <Slider className="flex-1" value={[ttsRate]} min={0.5} max={2} step={0.05} onValueChange={(v) => setTtsRate(v[0])} aria-label="Reading speed" />
                    <span className="w-12 text-right text-sm tabular-nums text-foreground">{ttsRate.toFixed(2)}×</span>
                  </div>
                </Row>
                <Row
                  id="inworld"
                  label="Inworld voice"
                  description={inworldApiKey
                    ? "Use an Inworld character voice instead of the browser's."
                    : <>Needs an Inworld key — <button data-no-sticker className="text-primary underline" onClick={() => goKeys("key-inworld")}>add one</button>.</>}
                >
                  <Switch
                    checked={inworldEnabled && !!inworldApiKey}
                    onCheckedChange={setInworldEnabled}
                    disabled={!inworldApiKey || !inworldVoiceId}
                    aria-label="Use Inworld voice"
                  />
                </Row>
                {inworldApiKey && (
                  <Row label="Voice">
                    {loadingVoices ? (
                      <span className="flex items-center gap-2 text-xs text-on-surface-variant"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading voices…</span>
                    ) : inworldVoices.length > 0 ? (
                      <>
                        <select value={inworldVoiceId} onChange={(e) => setInworldVoiceId(e.target.value)} className={`${selectCls} sm:w-52`} aria-label="Inworld voice">
                          {inworldVoices.map((v) => (
                            <option key={v.voice_id} value={v.voice_id}>
                              {v.name}{v.tags?.length ? ` (${v.tags.join(", ")})` : ""}
                            </option>
                          ))}
                        </select>
                        <Button size="sm" variant="outline" onClick={testInworldVoice} disabled={testingVoice || !inworldVoiceId} aria-label="Play a short test phrase">
                          {testingVoice ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span className="material-symbols-outlined text-base">play_arrow</span>}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" onClick={loadInworldVoices}>Retry loading voices</Button>
                    )}
                  </Row>
                )}
              </Group>

              <Group title="Hands-free">
                <Row id="hf-rate" label="Speech speed" description="Hands-free only — read-aloud buttons use the speed above." stack>
                  <div className="flex items-center gap-3">
                    <Slider className="flex-1" value={[handsFreeTtsRate]} min={0.5} max={2} step={0.05} onValueChange={(v) => setHandsFreeTtsRate(v[0])} aria-label="Hands-free speech speed" />
                    <span className="w-12 text-right text-sm tabular-nums text-foreground">{handsFreeTtsRate.toFixed(2)}×</span>
                  </div>
                </Row>
                <Row
                  id="barge-in"
                  label="Interrupt by talking"
                  description={bargeInEnabled ? "Talk over a reply to stop it." : "Turn-based — no echo."}
                  more="When on, hands-free keeps listening while the assistant speaks and stops it the moment you start talking. Headphones give the most reliable results."
                >
                  <Switch checked={bargeInEnabled} onCheckedChange={setBargeInEnabled} aria-label="Interrupt by talking" />
                </Row>
                <Row
                  id="pocket"
                  label="Pocket screen"
                  description="On phones, dims after 12s untouched. Double-tap to wake."
                  more="Hands-free holds the screen awake for the mic, which leaves a bright, touch-live display in your pocket. After 12 seconds untouched this covers it with a near-black layer that swallows stray taps — the BookWorm keeps you company on it."
                >
                  <Switch checked={pocketScreen} onCheckedChange={setPocketScreen} aria-label="Pocket screen" />
                </Row>
              </Group>
            </>
          )}

          {/* ── Research & search ── */}
          {active === "research" && (
            <>
              <Group title="Web search">
                <Row
                  id="web-search"
                  label="Live web search"
                  description={webSearchBackend ? `On — using ${webSearchBackend}.` : "Off — add a free Tavily key to turn it on."}
                >
                  <Button size="sm" variant={webSearchBackend ? "outline" : "default"} onClick={() => goKeys(webSearchBackend ? (burplexityApiToken ? "key-burplexity" : "key-tavily") : "key-tavily")}>
                    {webSearchBackend ? "Keys" : "Set up"}
                  </Button>
                </Row>
                <Row
                  id="quick-search"
                  label="Background quick search"
                  description={burplexityApiToken
                    ? "When a message looks like a search, results are fetched and added to the chat."
                    : "Needs a Burplexity token."}
                >
                  <Switch checked={voiceQuickSearch} onCheckedChange={setVoiceQuickSearch} disabled={!burplexityApiToken} aria-label="Background quick search" />
                </Row>
              </Group>
              <Group title="What Counsel reads" footer={<>Research and search models are picked in <button data-no-sticker className="text-primary underline" onClick={() => go("models", "role-deep")}>Models</button>.</>}>
                <Row
                  id="all-neurons"
                  label={<span className="inline-flex items-center gap-1">{!isPaid && <span className="material-symbols-outlined text-sm" aria-hidden>lock</span>}Search all notebooks</span>}
                  description={accessAllNeurons && isPaid ? "Answers draw on every notebook you have." : `Answers draw only on the loaded notebook — focused and cheaper.${!isPaid ? " Pro feature." : ""}`}
                >
                  <Switch
                    checked={accessAllNeurons && isPaid}
                    onCheckedChange={(v) => {
                      if (!isPaid) { openPricing("all-neurons"); return; }
                      setAccessAllNeurons(v);
                      toast.success(v ? "Counsel can now read all your notebooks" : "Counsel reads only the loaded notebook");
                    }}
                    aria-label="Search all notebooks"
                  />
                </Row>
              </Group>
            </>
          )}

          {/* ── Images & video ── */}
          {active === "images" && (
            <Group footer={<>Which model reads attached pictures and book figures is set in <button data-no-sticker className="text-primary underline" onClick={() => go("models", "role-vision")}>Models</button>.</>}>
              <Disclosure id="gen-images" icon="image" label="Image generation" summary="Model, fallback, quality and shape" defaultOpen>
                <ImageModelsSettings />
              </Disclosure>
              <Disclosure id="gen-video" icon="movie" label="Video generation" summary="Model, cost confirmation, length and identity lock">
                <VideoModelsSettings />
              </Disclosure>
              <Disclosure id="gen-3d" icon="view_in_ar" label="3D models" summary="fal.ai key, model, quality and limits">
                <SplatModelsSettings />
              </Disclosure>
            </Group>
          )}

          {/* ── Memory & library ── */}
          {active === "memory" && (
            <>
              <Group
                title="Notes"
                footer={
                  <Link to="/memory-guide" className="text-primary hover:underline">How notes work</Link>
                }
              >
                <Row
                  id="memory-mode"
                  label="Off the record"
                  description={memoryMode === "recording" ? "Off — Counsel saves notes as you chat." : "On — Counsel reads your notes but saves nothing new."}
                  more="Also in Counsel's tools and at the top of your notebook. Forgetting a note still works while it's on."
                >
                  <Switch checked={memoryMode !== "recording"} onCheckedChange={(off) => handleMemoryMode(!off)} disabled={memoryModeLoading} aria-label="Off the record" />
                </Row>
                <Row
                  id="reflex"
                  label="Point out contradictions"
                  description="Counsel tells you when something you say or read disagrees with one of your notes."
                  more="It names the note and the page it came from, and asks which is right before changing anything. Notes in an open conflict also get an amber marker in the notebook."
                >
                  <Switch checked={reflexCues} onCheckedChange={setReflexEnabled} aria-label="Point out contradictions" />
                </Row>
                <div id="set-memory-lens" className="px-4 py-3 cc-set-row">
                  <MemoryLensSettings />
                </div>
              </Group>
              <Group title="Library">
                <Row
                  id="catalog"
                  label="Catalog new books automatically"
                  description="Summarises each chapter after upload, so the assistant can find its way around."
                  more="Off by default because it uses your own model key — roughly one short call per eight chapters, plus one for the book. You can always catalog a book by hand from the book-context picker in Counsel."
                >
                  <Switch checked={autoCatalogOnUpload} onCheckedChange={setAutoCatalogOnUpload} aria-label="Catalog new books automatically" />
                </Row>
              </Group>
            </>
          )}

          {/* ── Replies & prompts ── */}
          {active === "prompts" && (
            <>
              <Group title="Replies">
                <Row
                  id="reply-length"
                  label="Reply length"
                  description={maxReplySentences > 0 ? `At most ${maxReplySentences} sentences (≈${maxReplySentences * 7}s of speech).` : "No limit."}
                  more="A hard limit — the reply is cut at the last full sentence and generation stops there (shorter = cheaper). Bullets count as sentences; code blocks don't. Digest and Deep Research are exempt."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Choice
                      ariaLabel="Reply length"
                      value={[0, 2, 4, 8].includes(maxReplySentences) ? maxReplySentences : -1}
                      onChange={(v) => setMaxReplySentences(v)}
                      options={[
                        { value: 0, label: "Any" },
                        { value: 2, label: "2" },
                        { value: 4, label: "4" },
                        { value: 8, label: "8" },
                      ]}
                    />
                    <Input
                      type="number"
                      min={1}
                      max={12}
                      value={maxReplySentences || ""}
                      placeholder="#"
                      onChange={(e) => setMaxReplySentences(Number(e.target.value) || 0)}
                      className="w-16 h-9 bg-surface-container-high border-outline-variant/15 text-sm"
                      aria-label="Custom max sentences per reply (1-12)"
                    />
                  </div>
                </Row>
              </Group>
              <Group title="Prompt library">
                <div id="set-prompt-library" className="px-4 py-3 cc-set-row">
                  <PromptLibrary scopeHint="chat" />
                </div>
                <Disclosure
                  id="legacy-prompt"
                  icon="history_edu"
                  label="Older custom instructions"
                  summary={customSystemPrompt ? "Set — used only when no prompt above is active" : "Not set — prefer the library above"}
                >
                  <Textarea
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    rows={3}
                    placeholder="e.g. Always answer as a no-nonsense literary critic."
                    className="bg-surface-container-high border-outline-variant/15 text-sm"
                  />
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" onClick={() => { setCustomSystemPrompt(promptDraft); toast.success("Saved"); }} disabled={promptDraft === (customSystemPrompt || "")}>Save</Button>
                    {customSystemPrompt && (
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { setCustomSystemPrompt(""); setPromptDraft(""); toast.success("Cleared"); }}>Clear</Button>
                    )}
                  </div>
                </Disclosure>
              </Group>
            </>
          )}

          {/* ── Appearance ── */}
          {active === "appearance" && (
            <>
              <div id="set-theme" className="cc-set-row rounded-xl">
                <h4 className="px-1 mb-1.5 text-xs font-semibold text-on-surface-variant">Theme</h4>
                <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {themes.map((t) => {
                    const on = t.id === themeId;
                    return (
                      <button
                        key={t.id}
                        data-no-sticker
                        role="radio"
                        aria-checked={on}
                        onClick={() => setThemeId(t.id)}
                        className={`flex items-center gap-3 p-2.5 rounded-xl border text-left transition-all active:scale-[0.98] ${
                          on
                            ? "border-primary/50 ring-1 ring-primary/30 bg-primary-container/10"
                            : "border-outline-variant/15 bg-surface-container-low hover:bg-surface-container-high"
                        }`}
                      >
                        <span className="flex shrink-0 rounded-md overflow-hidden border border-outline-variant/30">
                          {t.swatch.map((c, i) => (
                            <span key={i} style={{ background: c }} className="w-3.5 h-8 block" />
                          ))}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium text-sm text-foreground truncate">{t.name}</span>
                            {on && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                          </span>
                          <span className="block text-xs text-on-surface-variant leading-snug truncate" title={t.description}>{t.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Seasonal drift is a modifier on whichever theme is chosen,
                  never a theme of its own — so it sits under the picker. */}
              <Group>
                <Row
                  id="seasonal"
                  label="Drift with the season"
                  description={seasonal
                    ? <>Now: <span className="capitalize">{season.season}</span> · {Math.round(season.nextTurn.days)} days until {season.nextTurn.name}.</>
                    : "Warms or cools the accent slightly as the year turns."}
                  more="Nudges the current theme's accent a few degrees warmer or cooler as the year turns, and sets the drift of the Showcase view. Lightness is never changed, so contrast stays exactly where the theme put it."
                >
                  <Switch checked={seasonal} onCheckedChange={setSeasonal} aria-label="Drift with the season" />
                </Row>
                {seasonal && (
                  <Row label="Hemisphere" description={hemispherePref === "auto" ? `Detected: ${season.hemisphere}` : undefined}>
                    <Choice
                      ariaLabel="Hemisphere"
                      value={hemispherePref}
                      onChange={setHemispherePref}
                      options={[{ value: "auto", label: "Auto" }, { value: "north", label: "North" }, { value: "south", label: "South" }]}
                    />
                  </Row>
                )}
              </Group>
            </>
          )}

          {/* ── Account ── */}
          {active === "account" && (
            <Group>
              <Row id="plan" label={user?.email || "Signed in"} description={<span className="capitalize">{isPaid ? `${plan} plan` : "Free plan"}</span>}>
                <Button size="sm" variant={isPaid ? "outline" : "default"} onClick={() => openPricing()}>
                  {isPaid ? "Manage plan" : "Upgrade"}
                </Button>
              </Row>
              <Row id="setup" label="Setup helper" description="Walks through keys, models and voice step by step.">
                <Button size="sm" variant="outline" onClick={() => openSetupWizard(0)}>Run</Button>
              </Row>
              <Disclosure id="dev-keys" icon="code" label="Developer API keys" summary="Keys for the Bookworm API — separate from your AI provider keys">
                <ApiKeyManager />
              </Disclosure>
            </Group>
          )}

          {/* ── Power tools ── */}
          {active === "permissions" && <AiPermissionsSettings />}
          {active === "foundry" && <ToolFoundrySettings />}
          {active === "programs" && <ProgramRunnerSettings />}
        </main>
      </div>
    </div>
  );
};

export default SettingsPanel;
