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
import AiPermissionsSettings from "@/components/AiPermissionsSettings";
import { getMemoryMode, setMemoryMode, MemoryMode } from "@/lib/knowledgeApi";
import { consumeSettingsSection } from "@/lib/settingsNav";
import { synthesizeSpeech, fetchInworldVoices, type InworldVoice } from "@/lib/inworldTts";
import { isEmbeddingModel } from "@/lib/utils";
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

const SettingsPanel: React.FC = () => {
  const { user } = useAuth();
  const { isPaid, plan } = usePlan();
  const { themeId, setThemeId, themes } = useTheme();
  const {
    apiKey, savedModels, selectedModel, deepResearchModel, voiceModel, visionModel, ttsRate,
    autoReadReplies, wikiModel, customSystemPrompt, burplexityApiToken,
    inworldApiKey, inworldEnabled, inworldVoiceId, accessAllNeurons, loaded,
    imageExtractionModel, autoExtractFigures,
    saveApiKey, addModel, removeModel, setSelectedModel, setDeepResearchModel,
    setVoiceModel, setVisionModel, setTtsRate, setAutoReadReplies, setWikiModel,
    setCustomSystemPrompt, setBurplexityApiToken, setInworldApiKey,
    setInworldEnabled, setInworldVoiceId, setAccessAllNeurons,
    setImageExtractionModel, setAutoExtractFigures,
  } = useChatSettings();

  const [newModelInput, setNewModelInput] = useState("");
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
    const m = newModelInput.trim();
    if (!m) return;
    addModel(m);
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
              <div>
                <FieldLabel>OpenRouter API Key</FieldLabel>
                <div className="mt-1.5">
                  <SecretField value={apiKey} placeholder="sk-or-v1-..." icon="key" onSave={saveApiKey} />
                </div>
              </div>
              <div>
                <FieldLabel>Active Chat Model</FieldLabel>
                <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className={`${selectCls} mt-1.5`}>
                  {savedModels.filter((m) => !isEmbeddingModel(m) || m === selectedModel).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel>Saved Models</FieldLabel>
                <div className="flex gap-2 mt-1.5">
                  <Input
                    type="text"
                    placeholder="provider/model-name"
                    value={newModelInput}
                    onChange={(e) => setNewModelInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddModel(); }}
                    className="text-sm font-mono bg-surface-container-high border-none"
                  />
                  <Button size="sm" onClick={handleAddModel}>Add</Button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {savedModels.map((m) => {
                    const embed = isEmbeddingModel(m);
                    return (
                      <span
                        key={m}
                        title={embed ? "Embedding model — used by Wiki reindex, not Chat" : undefined}
                        className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ${
                          m === selectedModel
                            ? "bg-primary-container/20 text-primary border border-primary-container/30"
                            : embed
                              ? "bg-surface-container-highest/50 text-on-surface-variant/60 italic"
                              : "bg-surface-container-highest text-on-surface-variant"
                        }`}
                      >
                        <button
                          onClick={() => {
                            if (embed) { toast.error("Embedding model — pick it under Neuron & Memory, not Chat."); return; }
                            setSelectedModel(m);
                          }}
                          className="hover:underline"
                        >
                          {m}{embed ? " (embed)" : ""}
                        </button>
                        <button onClick={() => removeModel(m)} aria-label={`Remove ${m}`} className="hover:text-destructive ml-0.5 material-symbols-outlined text-xs">close</button>
                      </span>
                    );
                  })}
                </div>
                <button
                  onClick={() => window.open("#/models", "_blank")}
                  className="inline-flex items-center gap-1 mt-2 px-1 text-[11px] font-semibold text-primary hover:underline"
                >
                  <span className="material-symbols-outlined text-sm" aria-hidden>leaderboard</span>
                  Browse top models by category
                </button>
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
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
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
                <FieldLabel>Deep Research Model</FieldLabel>
                <select value={deepResearchModel} onChange={(e) => setDeepResearchModel(e.target.value)} className={`${selectCls} mt-1.5`}>
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
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
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
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
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
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
                    const extra = savedModels.filter((m) => !known.has(m) && !isEmbeddingModel(m));
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
                <FieldLabel>Wiki Model</FieldLabel>
                <select
                  value={wikiModel || "__default__"}
                  onChange={(e) => setWikiModel(e.target.value === "__default__" ? "" : e.target.value)}
                  className={`${selectCls} mt-1.5`}
                >
                  <option value="__default__">Default (Gemini Flash)</option>
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
                </select>
                <Hint>Powers wiki extract and health checks. Custom models use OpenRouter and need your API key above.</Hint>
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
