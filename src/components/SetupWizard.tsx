import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useChatSettings } from "@/hooks/useChatSettings";
import { supabase } from "@/integrations/supabase/client";
import {
  startOpenRouterConnect,
  completeOpenRouterConnect,
  testOpenRouterKey,
  looksLikeOpenRouterKey,
} from "@/lib/openrouterAuth";
import { useConsentResolved } from "@/components/WelcomeGate";
import { fetchCatalog, isFreeModel, type ORModel } from "@/lib/openrouterCatalog";
import { namespacedNvidiaId, NVIDIA_FEATURED, NVIDIA_STARTER_MODEL } from "@/lib/nvidiaCatalog";
import { useApp } from "@/context/AppContext";
import { beginOnboarding } from "@/lib/onboarding";
import WormSays from "@/components/onboarding/WormSays";

// First-run setup helper, hosted by Bookworm. Three screens:
//
//   0  hello — the three things it takes to get going
//   1  connect an AI — the only real setup there is (models fold in here)
//   2  go — straight to the Library to add a first book
//
// Three, because every screen past the third loses people (Chameleon's
// benchmark: ~72% finish a 3-step tour, ~16% a 7-step one). It no longer
// tours the tabs: Bookworm explains each tab the first time it is opened
// (onboarding/WormCoach), which is when the explanation is of any use.
// Skippable everywhere; re-launchable from Settings → Account.

const DONE_KEY = "setup_wizard_done";
const STEP_COUNT = 3;

let wizState = { open: false, step: 0 };
const listeners = new Set<() => void>();
function setWizState(next: typeof wizState) {
  wizState = next;
  listeners.forEach((l) => l());
}
const subscribeWiz = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getWizState = () => wizState;

export function openSetupWizard(step = 0) {
  setWizState({ open: true, step });
}

/** True while the setup helper is on screen — tab tours wait for it. */
export function useSetupWizardOpen(): boolean {
  return useSyncExternalStore(subscribeWiz, getWizState, getWizState).open;
}

const START_STEPS: { icon: string; title: string; detail: string }[] = [
  { icon: "bolt", title: "Connect an AI", detail: "About a minute, and there are free ones. That's next." },
  { icon: "upload_file", title: "Add a book", detail: "A PDF or EPUB from your device, or a YouTube link." },
  { icon: "forum", title: "Ask me about it", detail: "I answer from the book and keep notes for you." },
];

const SetupWizard: React.FC = () => {
  const { open, step } = useSyncExternalStore(subscribeWiz, getWizState, getWizState);
  const { user } = useAuth();
  const { setActiveTab } = useApp();
  const consentResolved = useConsentResolved();
  const { apiKey, nvidiaKeyLast4, savedModels, selectedModel, addModel, saveApiKey, saveNvidiaKey, loaded: settingsLoaded } = useChatSettings();

  const [keyDraft, setKeyDraft] = useState("");
  const [nvidiaDraft, setNvidiaDraft] = useState("");
  const [showNvidia, setShowNvidia] = useState(false);
  useEffect(() => { if (nvidiaKeyLast4) setNvidiaDraft(""); }, [nvidiaKeyLast4]);
  const nvidiaOnly = !!nvidiaKeyLast4 && !apiKey;
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [popupMode, setPopupMode] = useState(false);
  const [checkingRemote, setCheckingRemote] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [picks, setPicks] = useState<ORModel[] | null>(null);
  const autoOpenedRef = useRef(false);

  // Finish the OAuth round trip if OpenRouter just redirected back with a code.
  useEffect(() => {
    void (async () => {
      try {
        const key = await completeOpenRouterConnect();
        if (key) {
          saveApiKey(key);
          toast.success("OpenRouter connected — you're ready to chat");
          openSetupWizard(1);
        }
      } catch (err: any) {
        toast.error(err.message || "Connection failed — try again");
        openSetupWizard(1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First login with no key configured → offer the walkthrough once.
  // Waits for the privacy/welcome gate so the two dialogs never stack.
  useEffect(() => {
    if (autoOpenedRef.current || open) return;
    if (!user || !settingsLoaded || !consentResolved) return;
    // Someone who has been through this, or who set up before it existed
    // (either provider counts as configured), is never nagged — and gets no
    // tab tours either unless they ask for them in Settings.
    if (localStorage.getItem(DONE_KEY) || apiKey || nvidiaKeyLast4) {
      localStorage.setItem(DONE_KEY, "1");
      beginOnboarding(user.id, "veteran");
      return;
    }
    beginOnboarding(user.id, "new");
    autoOpenedRef.current = true;
    openSetupWizard(0);
  }, [user, settingsLoaded, apiKey, nvidiaKeyLast4, open, consentResolved]);

  // Lazy-load quick picks for the models step: top free models by real usage.
  useEffect(() => {
    if (!open || step !== 1 || !apiKey || picks !== null) return;
    void (async () => {
      try {
        const all = await fetchCatalog({ sort: "top-weekly" });
        const free = all.filter(isFreeModel).slice(0, 2);
        const paid = all.filter((m) => !isFreeModel(m)).slice(0, 2);
        setPicks([...free, ...paid]);
      } catch {
        setPicks([]); // explorer page still available as the fallback
      }
    })();
  }, [open, step, apiKey, picks]);

  const close = (markDone: boolean) => {
    if (markDone) localStorage.setItem(DONE_KEY, "1");
    setWizState({ open: false, step: 0 });
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const mode = await startOpenRouterConnect();
      if (mode === "popup") {
        setPopupMode(true);
        setConnecting(false);
      }
      // "redirected" — this window is navigating away; nothing more to do.
    } catch {
      setConnecting(false);
      toast.error("Couldn't open OpenRouter — use the manual steps below.");
      setShowManual(true);
    }
  };

  // Popup flow: the other tab saved the key to the account; pull it in here.
  const handleCheckRemote = async () => {
    if (!user) return;
    setCheckingRemote(true);
    try {
      const { data } = await supabase
        .from("user_settings")
        .select("openrouter_api_key")
        .eq("user_id", user.id)
        .maybeSingle();
      const k = (data as any)?.openrouter_api_key || "";
      if (k) {
        saveApiKey(k);
        toast.success("Connected!");
      } else {
        toast.error("No key found yet — finish connecting in the other tab first.");
      }
    } finally {
      setCheckingRemote(false);
    }
  };

  const handleManualSave = async () => {
    const key = keyDraft.trim();
    if (!looksLikeOpenRouterKey(key)) {
      toast.error('That doesn\'t look like an OpenRouter key — it starts with "sk-or-".');
      return;
    }
    setTesting(true);
    const result = await testOpenRouterKey(key);
    setTesting(false);
    if (!result.ok) {
      toast.error(result.error || "Key check failed");
      return;
    }
    saveApiKey(key);
    setKeyDraft("");
  };

  // Saving an NVIDIA key during setup must leave the user with a model they
  // can actually run: the default Active model is an OpenRouter id, so an
  // NVIDIA-only user would otherwise finish the wizard and hit a provider
  // mismatch on their very first message.
  const handleSaveNvidia = async () => {
    const ok = await saveNvidiaKey(nvidiaDraft);
    if (!ok) return;
    // A user who ALSO has an OpenRouter key used to fall through here with
    // no NVIDIA model selected — key saved, nothing runs on it, no signal.
    // Now: pick automatically when NVIDIA is their only option, and offer it
    // explicitly when they have both (never silently reroute paid setups).
    const pick = namespacedNvidiaId(NVIDIA_STARTER_MODEL);
    const alreadyNvidia = savedModels.some((m) => m.startsWith("nvidia:"));
    if (!apiKey) {
      if (!savedModels.includes(pick)) addModel(pick);
      return;
    }
    if (alreadyNvidia) return;
    toast.success("NVIDIA key saved", {
      description: "Add an NVIDIA model so your chat can use it?",
      duration: 12000,
      action: { label: "Add", onClick: () => addModel(pick) },
    });
  };

  const next = () => setWizState({ open: true, step: Math.min(step + 1, STEP_COUNT - 1) });
  const back = () => setWizState({ open: true, step: Math.max(step - 1, 0) });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(true); }}>
      {/* Only the step scrolls: the progress dots and Next stay on screen
          however short the window is. */}
      <DialogContent className="max-w-lg w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col gap-3 p-5 sm:p-6">
        <div className="min-h-0 flex-1 overflow-y-auto -mx-1 px-1">
        {step === 0 && (
          <div className="space-y-3">
            <WormSays mood="cheer" size={72}>
              <h2 className="font-headline font-bold text-2xl leading-tight text-foreground">Hi, I'm Bookworm.</h2>
              <p className="mt-1 text-sm text-on-surface-variant">
                I read your books with you, answer questions about them, and keep notes on what you learn.
              </p>
            </WormSays>
            <p className="text-sm font-semibold text-foreground">Getting started takes three things:</p>
            <ol className="space-y-1.5">
              {START_STEPS.map((s, i) => (
                <li key={s.icon} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-surface-container-high">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 font-headline text-sm font-bold text-primary">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-foreground">{s.title}</span>
                    <span className="block text-xs text-on-surface-variant">{s.detail}</span>
                  </span>
                  <span className="material-symbols-outlined text-primary text-[20px]" aria-hidden>{s.icon}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-on-surface-variant">
              No tour to sit through. I'll explain each tab the first time you open it.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <WormSays mood={apiKey || nvidiaKeyLast4 ? "cheer" : "think"} size={64}>
              <h2 className="font-headline font-bold text-2xl leading-tight text-foreground">
                {apiKey || nvidiaKeyLast4 ? "I can think now!" : "I need an AI to think with"}
              </h2>
              <p className="mt-1 text-sm text-on-surface-variant">
                {apiKey || nvidiaKeyLast4 ? (
                  <>That was the only setup there is. Press Next and we'll add your first book.</>
                ) : (
                  <>
                    One <strong>OpenRouter</strong> account unlocks hundreds of AI models. You pay only for what you
                    use, and several are completely free.
                  </>
                )}
              </p>
            </WormSays>

            {apiKey ? (
              <div className="flex items-center gap-2.5 p-3.5 rounded-xl bg-primary-container/15 border border-primary/20">
                <Check className="w-5 h-5 text-primary shrink-0" />
                <span className="text-sm text-foreground">You're connected — your OpenRouter key is saved.</span>
              </div>
            ) : (
              <>
                <Button size="lg" className="w-full gap-2" onClick={handleConnect} disabled={connecting}>
                  {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                  Connect with OpenRouter
                </Button>
                <p className="text-[11px] text-on-surface-variant text-center -mt-2">
                  Opens openrouter.ai — sign in (or create a free account) and a key is made for you automatically.
                </p>
                {popupMode && (
                  <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-surface-container-high text-xs text-on-surface-variant">
                    <span>Finished connecting in the other tab?</span>
                    <Button size="sm" variant="outline" onClick={handleCheckRemote} disabled={checkingRemote}>
                      {checkingRemote ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Check connection"}
                    </Button>
                  </div>
                )}

                <button
                  onClick={() => setShowManual((v) => !v)}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  {showManual ? "Hide manual setup" : "Prefer to paste a key yourself?"}
                </button>
                {showManual && (
                  <div className="space-y-2 p-3 rounded-xl bg-surface-container-high text-xs text-on-surface-variant">
                    <ol className="list-decimal list-inside space-y-1">
                      <li>
                        Create a free account at{" "}
                        <a href="https://openrouter.ai" target="_blank" rel="noreferrer" className="text-primary underline">openrouter.ai</a>
                      </li>
                      <li>
                        Open{" "}
                        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-primary underline">openrouter.ai/keys</a>{" "}
                        and press <strong>Create Key</strong> (name it "Bookworm Studio")
                      </li>
                      <li>Copy the key and paste it here:</li>
                    </ol>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={keyDraft}
                        onChange={(e) => setKeyDraft(e.target.value)}
                        placeholder="sk-or-v1-…"
                        className="flex-1 bg-surface-container-highest border-none rounded-lg text-sm py-2 px-3 focus:ring-1 focus:ring-primary/40"
                      />
                      <Button size="sm" onClick={handleManualSave} disabled={testing || !keyDraft.trim()}>
                        {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save & test"}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="pt-1 border-t border-outline-variant/20">
              <button
                onClick={() => setShowNvidia((v) => !v)}
                className="text-xs font-semibold text-primary hover:underline"
              >
                {showNvidia ? "Hide NVIDIA setup" : "Or use NVIDIA's free models instead"}
              </button>
              {showNvidia && (
                <div className="mt-2 space-y-2 p-3 rounded-xl bg-surface-container-high text-xs text-on-surface-variant">
                  {nvidiaKeyLast4 ? (
                    <div className="flex items-center gap-2.5">
                      <Check className="w-4 h-4 text-primary shrink-0" />
                      <span>NVIDIA connected (key ending {nvidiaKeyLast4}). Add NVIDIA models from the model browser.</span>
                    </div>
                  ) : (
                    <>
                      <ol className="list-decimal list-inside space-y-1">
                        <li>
                          Sign in free at{" "}
                          <a href="https://build.nvidia.com" target="_blank" rel="noreferrer" className="text-primary underline">build.nvidia.com</a>{" "}
                          (free, no balance or card needed)
                        </li>
                        <li>
                          Open{" "}
                          <a href="https://build.nvidia.com/settings/api-keys" target="_blank" rel="noreferrer" className="text-primary underline">Settings → API Keys</a>{" "}
                          and press <strong>Generate API Key</strong>
                        </li>
                        <li>Paste it here (it starts with nvapi-):</li>
                      </ol>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={nvidiaDraft}
                          onChange={(e) => setNvidiaDraft(e.target.value)}
                          placeholder="nvapi-…"
                          className="flex-1 bg-surface-container-highest border-none rounded-lg text-sm py-2 px-3 focus:ring-1 focus:ring-primary/40"
                        />
                        <Button size="sm" onClick={() => { void handleSaveNvidia(); }} disabled={!nvidiaDraft.trim()}>
                          Save
                        </Button>
                      </div>
                      <p>
                        Unlocks DeepSeek V4, Nemotron 3, Kimi K2.6, DiffusionGemma and more. Image and video
                        generation still need an OpenRouter key.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {(apiKey || nvidiaOnly) && (
              <details className="rounded-xl border border-outline-variant/20 px-3 py-2 text-sm">
                <summary className="cursor-pointer select-none text-xs font-semibold text-primary">
                  Choose other AI models (optional)
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-on-surface-variant">
                    Counsel will use <span className="font-mono">{selectedModel}</span>. Add more here, or any time in Settings.
                  </p>
            {/* NVIDIA-only setup: the OpenRouter rankings below are unusable
                      without an OpenRouter key, so offer curated NVIDIA picks
                      instead — adding one here keeps the first chat working. */}
                  {nvidiaOnly ? (
                    <div className="space-y-2">
                      {NVIDIA_FEATURED.filter((m) => m.featured).slice(0, 4).map((m) => {
                        const nsId = namespacedNvidiaId(m.localId);
                        const saved = savedModels.includes(nsId);
                        return (
                          <div key={m.localId} className="flex items-center gap-3 p-3 rounded-xl bg-surface-container-high">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-foreground truncate">{m.label}</span>
                                <span className="px-1.5 py-0.5 rounded bg-primary-container/25 text-primary text-[9px] font-bold uppercase tracking-widest shrink-0">
                                  NVIDIA
                                </span>
                              </div>
                              <div className="font-mono text-[10px] text-on-surface-variant truncate">{m.localId}</div>
                            </div>
                            <Button size="sm" variant={saved ? "outline" : "default"} disabled={saved} onClick={() => addModel(nsId)}>
                              {saved ? <Check className="w-3.5 h-3.5" /> : "Add"}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : picks === null ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="w-5 h-5 animate-spin text-on-surface-variant" />
                    </div>
                  ) : picks.length > 0 ? (
                    <div className="space-y-2">
                      {picks.map((m) => {
                        const saved = savedModels.includes(m.id);
                        return (
                          <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl bg-surface-container-high">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-foreground truncate">{m.name}</span>
                                {isFreeModel(m) && (
                                  <span className="px-1.5 py-0.5 rounded bg-primary-container/25 text-primary text-[9px] font-bold uppercase tracking-widest shrink-0">
                                    Free
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[10px] text-on-surface-variant truncate">{m.id}</div>
                            </div>
                            <Button size="sm" variant={saved ? "outline" : "default"} disabled={saved} onClick={() => addModel(m.id)}>
                              {saved ? <Check className="w-3.5 h-3.5" /> : "Add"}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  <Button variant="secondary" size="sm" className="w-full gap-2" onClick={() => window.open("#/models", "_blank")}>
                    <span className="material-symbols-outlined text-[18px]">leaderboard</span>
                    Browse all top models
                  </Button>
                </div>
              </details>
            )}

            <p className="text-[11px] text-on-surface-variant">
              You can skip this. Your Library and the reader work without it, but I can't answer or take notes until it's done.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <WormSays mood="cheer" size={72}>
              <h2 className="font-headline font-bold text-2xl leading-tight text-foreground">Now give me something to read</h2>
              <p className="mt-1 text-sm text-on-surface-variant">
                Add a book and ask me anything about it. Your next steps stay in the ring at the top of the screen
                until they're done.
              </p>
            </WormSays>
            <Button size="lg" className="w-full gap-2" onClick={() => { close(true); setActiveTab("library"); }}>
              <span className="material-symbols-outlined text-[20px]" aria-hidden>upload_file</span>
              Add my first book
            </Button>
            <button
              onClick={() => { close(true); setActiveTab("chat"); }}
              className="block w-full text-center text-xs font-semibold text-primary hover:underline"
            >
              No book handy? Just start chatting
            </button>
          </div>
        )}

        </div>
        {/* Footer: progress + nav */}
        <div className="shrink-0 flex items-center justify-between pt-2 border-t border-outline-variant/15">
          <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${STEP_COUNT}`}>
            {Array.from({ length: STEP_COUNT }).map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-primary" : "w-1.5 bg-outline-variant/40"}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <Button variant="ghost" size="sm" onClick={back}>Back</Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => close(true)}>Skip for now</Button>
            )}
            {step < STEP_COUNT - 1 ? (
              <Button size="sm" onClick={next}>{step === 0 ? "Let's go" : "Next"}</Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => close(true)}>Close</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SetupWizard;
