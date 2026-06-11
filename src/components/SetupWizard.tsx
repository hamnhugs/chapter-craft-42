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
import { fetchCatalog, isFreeModel, type ORModel } from "@/lib/openrouterCatalog";

// First-run setup helper. Research-backed shape: 4 steps max (completion
// roughly halves per extra step), skippable everywhere, teaches the
// brain/neuron metaphor with one labeled diagram-style screen, and ends by
// pointing at a real first task instead of a dead "you're done" screen.
// Re-launchable from Counsel → Settings.

const DONE_KEY = "setup_wizard_done";
const STEP_COUNT = 4;

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

const TOUR_ROWS: { icon: string; name: string; metaphor: string; real: string }[] = [
  { icon: "archive", name: "The Vault", metaphor: "Your bookshelf.", real: "Upload PDFs and EPUBs — they live here." },
  { icon: "psychology", name: "Counsel", metaphor: "Your reading companion.", real: "Chat (or talk) with an AI about any book." },
  { icon: "menu_book", name: "Neurons", metaphor: "Pockets of knowledge.", real: "As you chat and save, the AI builds a neuron — its memory of a topic." },
  { icon: "collections_bookmark", name: "The BRAIN", metaphor: "All your neurons together.", real: "Switch which neuron is active anytime." },
];

const SetupWizard: React.FC = () => {
  const { open, step } = useSyncExternalStore(subscribeWiz, getWizState, getWizState);
  const { user } = useAuth();
  const { apiKey, savedModels, selectedModel, addModel, saveApiKey, loaded: settingsLoaded } = useChatSettings();

  const [keyDraft, setKeyDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [popupMode, setPopupMode] = useState(false);
  const [checkingRemote, setCheckingRemote] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [picks, setPicks] = useState<ORModel[] | null>(null);
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const autoOpenedRef = useRef(false);

  // Finish the OAuth round trip if OpenRouter just redirected back with a code.
  useEffect(() => {
    void (async () => {
      try {
        const key = await completeOpenRouterConnect();
        if (key) {
          saveApiKey(key);
          toast.success("OpenRouter connected — you're ready to chat");
          openSetupWizard(2);
        }
      } catch (err: any) {
        toast.error(err.message || "Connection failed — try again");
        openSetupWizard(1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First login with no key configured → offer the walkthrough once.
  useEffect(() => {
    if (autoOpenedRef.current || open) return;
    if (!user || !settingsLoaded) return;
    if (localStorage.getItem(DONE_KEY)) return;
    if (apiKey) {
      // Existing user who set up before the wizard existed — never nag them.
      localStorage.setItem(DONE_KEY, "1");
      return;
    }
    autoOpenedRef.current = true;
    openSetupWizard(0);
  }, [user, settingsLoaded, apiKey, open]);

  // Lazy-load quick picks for the models step: top free models by real usage.
  useEffect(() => {
    if (!open || step !== 2 || picks !== null) return;
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
  }, [open, step, picks]);

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

  const next = () => setWizState({ open: true, step: Math.min(step + 1, STEP_COUNT - 1) });
  const back = () => setWizState({ open: true, step: Math.max(step - 1, 0) });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(true); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Step content */}
        {step === 0 && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="font-headline font-bold text-3xl text-foreground">Welcome to Bookworm</h2>
              <p className="text-sm text-on-surface-variant">
                Read books, talk them over with an AI, and grow a brain of everything you learn. Here's the
                whole loop in four pieces:
              </p>
            </div>
            <div className="space-y-2.5">
              {TOUR_ROWS.map((row) => (
                <div key={row.name} className="flex items-start gap-3 p-3 rounded-xl bg-surface-container-high">
                  <span className="material-symbols-outlined text-primary text-[22px] mt-0.5">{row.icon}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-foreground">
                      {row.name} <span className="font-normal italic text-on-surface-variant">— {row.metaphor}</span>
                    </div>
                    <div className="text-xs text-on-surface-variant mt-0.5">{row.real}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-on-surface-variant text-center">
              Vault → Counsel → Neurons. Read, talk, remember.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="font-headline font-bold text-3xl text-foreground">Power up the AI</h2>
              <p className="text-sm text-on-surface-variant">
                Bookworm's AI runs through <strong>OpenRouter</strong> — one account that unlocks hundreds of
                AI models. You bring your own key, pay only for exactly what you use, and several models are
                completely free.
              </p>
            </div>

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
                        and press <strong>Create Key</strong> (name it "Bookworm")
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
            <p className="text-[11px] text-on-surface-variant">
              You can skip this — your Vault works without it — but Counsel and Neurons need a key to think.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="font-headline font-bold text-3xl text-foreground">Pick your thinkers</h2>
              <p className="text-sm text-on-surface-variant">
                A "model" is the AI brain Counsel uses. You already have a great all-rounder
                (<span className="font-mono text-xs">{selectedModel}</span>) — add more if you like.
                Switching later is one tap in Settings.
              </p>
            </div>
            {picks === null ? (
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
            <Button
              variant="secondary"
              className="w-full gap-2"
              onClick={() => window.open("#/models", "_blank")}
            >
              <span className="material-symbols-outlined text-[18px]">leaderboard</span>
              Browse all top models by category
            </Button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="font-headline font-bold text-3xl text-foreground">You're set 🎉</h2>
              <p className="text-sm text-on-surface-variant">Three good first moves, in order:</p>
            </div>
            <div className="space-y-2.5">
              {[
                { icon: "upload_file", text: "Drop a PDF or EPUB into the Vault." },
                { icon: "forum", text: "Open Counsel and ask anything about it." },
                { icon: "history_edu", text: 'Press "Save to Wiki" after a good chat — and watch your first neuron grow.' },
              ].map((s, i) => (
                <div key={s.icon} className="flex items-center gap-3 p-3 rounded-xl bg-surface-container-high">
                  <span className="font-headline font-bold text-primary">{i + 1}</span>
                  <span className="material-symbols-outlined text-primary text-[20px]">{s.icon}</span>
                  <span className="text-sm text-foreground">{s.text}</span>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2.5 text-xs text-on-surface-variant cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              Don't show this walkthrough again (you can rerun it anytime from Counsel → Settings)
            </label>
          </div>
        )}

        {/* Footer: progress + nav */}
        <div className="flex items-center justify-between pt-2 border-t border-outline-variant/15">
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
              <Button size="sm" onClick={next}>Next</Button>
            ) : (
              <Button size="sm" onClick={() => close(dontShowAgain)}>Finish</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SetupWizard;
