import React, { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import { executeQuickSearch } from "@/lib/chatTools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { extractKnowledge } from "@/lib/knowledgeApi";
import { Loader2, StickyNote, BookmarkPlus, X } from "lucide-react";
import VoiceNotesPanel, { appendVoiceNote } from "./VoiceNotesPanel";
import { useChatSettings } from "@/hooks/useChatSettings";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerClose } from "@/components/ui/drawer";
import { speak as ttsSpeak, stopSpeaking as ttsStop, subscribeSpeaking as ttsSubscribe, getSpeakingId as ttsGetId } from "@/lib/speak";
import PromptLibrary from "@/components/PromptLibrary";
import { synthesizeSpeech, fetchInworldVoices, type InworldVoice } from "@/lib/inworldTts";

const LEGACY_OPENROUTER_STORAGE_KEY = "openrouter_api_key";
const VOICE_ENABLED_KEY = "voice_tts_enabled";
const HANDS_FREE_KEY = "voice_hands_free";
const NOTES_PANEL_OPEN_KEY = "voice_notes_panel_open";
const VOICE_QUICK_SEARCH_KEY = "voice_quick_search";
const VOICE_QUICK_SEARCH_MODEL_KEY = "voice_quick_search_model";
const INWORLD_API_KEY_KEY = "inworld_api_key";
const INWORLD_VOICE_ID_KEY = "inworld_voice_id";
const INWORLD_ENABLED_KEY = "inworld_tts_enabled";

const SEARCH_INTENT_RE =
  /\b(search|look up|look for|find|google|what is|what are|who is|who are|tell me about|research|check online|latest|current|news about)\b/i;

// Tunable latency knobs for hands-free voice flow
const SILENCE_INTERIM_MS = 1100; // wait after last interim chunk before sending
const SILENCE_FINAL_MS = 700;    // wait after a final result before sending
const POST_TTS_DELAY_MS = 400;   // mic restart grace after TTS ends
const MIN_SENTENCE_LEN = 14;     // don't ship tiny fragments to TTS

const stripMarkdownForTts = (s: string) =>
  s.replace(/[#*_`~[\]()>|]/g, "").replace(/\n+/g, ". ").replace(/\s+/g, " ").trim();

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const VoiceChat: React.FC = () => {
  const { books, activeBookId } = useApp();
  const {
    messages, isLoading, voiceDeepResearch, setVoiceDeepResearch, sendMessage, injectDisplayMessage, clearChat,
  } = useChat();

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem(VOICE_ENABLED_KEY) !== "false");
  const [handsFree, setHandsFree] = useState(() => localStorage.getItem(HANDS_FREE_KEY) === "true");
  const [notesPanelOpen, setNotesPanelOpen] = useState(() => localStorage.getItem(NOTES_PANEL_OPEN_KEY) === "true");
  const [voiceQuickSearch, setVoiceQuickSearch] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_KEY) === "true");
  const [voiceQuickSearchModel, setVoiceQuickSearchModel] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_MODEL_KEY) || "");
  const [pendingSearchCount, setPendingSearchCount] = useState(0);

  // Inworld TTS state (API key, toggle, and voice ID all live in useChatSettings -> Supabase)
  const [inworldVoices, setInworldVoices] = useState<InworldVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const inworldAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { localStorage.setItem(NOTES_PANEL_OPEN_KEY, String(notesPanelOpen)); }, [notesPanelOpen]);
  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_KEY, String(voiceQuickSearch)); }, [voiceQuickSearch]);
  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_MODEL_KEY, voiceQuickSearchModel); }, [voiceQuickSearchModel]);
  const [selectionCapture, setSelectionCapture] = useState<{ text: string; top: number; left: number } | null>(null);
  

  // Long-press to save chat bubble as a voice note
  const longPressTimer = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);
  const startLongPress = (text: string) => {
    longPressFiredRef.current = false;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(async () => {
      longPressFiredRef.current = true;
      const note = await appendVoiceNote(text);
      if (note) {
        try { (navigator as any).vibrate?.(30); } catch {}
        toast.success("Saved to voice notes");
        setNotesPanelOpen(true);
      }
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const saveBubbleToNotes = async (text: string) => {
    const note = await appendVoiceNote(text);
    if (note) { toast.success("Saved to voice notes"); setNotesPanelOpen(true); }
  };
  const [interimTranscript, setInterimTranscript] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [controlsCollapsed, setControlsCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("voice_controls_collapsed") === "1";
  });
  useEffect(() => {
    localStorage.setItem("voice_controls_collapsed", controlsCollapsed ? "1" : "0");
  }, [controlsCollapsed]);
  const touchStartYRef = useRef<number | null>(null);
  const handleHandleTouchStart = (e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  };
  const handleHandleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartYRef.current;
    touchStartYRef.current = null;
    if (start == null) return;
    const end = e.changedTouches[0]?.clientY ?? start;
    const dy = end - start;
    if (dy > 30) setControlsCollapsed(true);
    else if (dy < -30) setControlsCollapsed(false);
  };

  const {
    apiKey, savedModels, selectedModel, deepResearchModel, voiceModel, ttsRate, customSystemPrompt, burplexityApiToken, inworldApiKey, inworldEnabled, inworldVoiceId, loaded: settingsLoaded,
    saveApiKey: persistApiKey, setSelectedModel, setDeepResearchModel, setVoiceModel, setCustomSystemPrompt, setBurplexityApiToken, setInworldApiKey, setInworldEnabled, setInworldVoiceId: setInworldVoiceIdState,
    addModel: addModelToSettings, removeModel: removeModelFromSettings,
  } = useChatSettings() as any;
  const [newModelInput, setNewModelInput] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  useEffect(() => { setPromptDraft(customSystemPrompt || ""); }, [customSystemPrompt, showSettings]);
  const [bubbleSpeakingId, setBubbleSpeakingId] = useState<string | null>(ttsGetId());
  useEffect(() => ttsSubscribe(setBubbleSpeakingId), []);
  useEffect(() => () => ttsStop(), []);
  const replayBubble = (id: string, text: string) => {
    if (bubbleSpeakingId === id) { ttsStop(); return; }
    ttsSpeak(text, { id, rate: ttsRate });
  };

  const recognitionRef = useRef<any>(null);
  const synthRef = useRef(window.speechSynthesis);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const handsFreeRef = useRef(handsFree);
  const isLoadingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const isListeningRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const previousFinalLengthRef = useRef(0);
  const submittingRef = useRef(false);
  const sendTimerRef = useRef<number | null>(null);
  const stoppedByUserRef = useRef(false);
  const lastSpokenIndexRef = useRef<number>(-1);
  const lastSentTextRef = useRef<string>("");
  const lastSentAtRef = useRef<number>(0);

  const normalizeTranscript = (value: string) => value.replace(/\s+/g, " ").trim();
  const mergeTranscriptPieces = (pieces: string[]) => {
    const merged: string[] = [];
    pieces.map(normalizeTranscript).filter(Boolean).forEach((piece) => {
      const next = piece.split(" ");
      let overlap = Math.min(merged.length, next.length);
      while (overlap > 0) {
        const tail = merged.slice(-overlap).join(" ").toLowerCase();
        const head = next.slice(0, overlap).join(" ").toLowerCase();
        if (tail === head) break;
        overlap -= 1;
      }
      merged.push(...next.slice(overlap));
    });
    return merged.join(" ").trim();
  };
  const resetTranscriptBuffers = () => {
    finalTranscriptRef.current = "";
    previousFinalLengthRef.current = 0;
    submittingRef.current = false;
    if (sendTimerRef.current) { window.clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
  };
  const detachRecognitionHandlers = (recognition: any) => {
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  };
  const stopCurrentRecognitionQuietly = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    detachRecognitionHandlers(recognition);
    try { recognition.stop(); } catch {}
    recognitionRef.current = null;
    isListeningRef.current = false;
    setIsListening(false);
  };

  useEffect(() => { handsFreeRef.current = handsFree; localStorage.setItem(HANDS_FREE_KEY, String(handsFree)); }, [handsFree]);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { localStorage.setItem(VOICE_ENABLED_KEY, String(ttsEnabled)); }, [ttsEnabled]);

  // One-time migration: localStorage -> account-synced setting
  const migratedRef = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || migratedRef.current) return;
    migratedRef.current = true;
    const legacyOR = localStorage.getItem(LEGACY_OPENROUTER_STORAGE_KEY);
    if (legacyOR && !apiKey) persistApiKey(legacyOR);
    if (legacyOR) localStorage.removeItem(LEGACY_OPENROUTER_STORAGE_KEY);
    const legacyInworld = localStorage.getItem(INWORLD_API_KEY_KEY);
    if (legacyInworld && !inworldApiKey) setInworldApiKey(legacyInworld);
    if (legacyInworld) localStorage.removeItem(INWORLD_API_KEY_KEY);
  }, [settingsLoaded, apiKey, persistApiKey, inworldApiKey, setInworldApiKey]);

  // Load Inworld voices once the key is known
  const inworldVoiceLoadedRef = useRef(false);
  useEffect(() => {
    if (!inworldVoiceLoadedRef.current && inworldApiKey) {
      inworldVoiceLoadedRef.current = true;
      loadInworldVoices(inworldApiKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inworldApiKey]);


  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const container = messagesContainerRef.current;
      if (!text || !range || !container?.contains(range.commonAncestorContainer)) {
        setSelectionCapture(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelectionCapture({
        text,
        top: Math.max(88, rect.top - 42),
        left: Math.min(window.innerWidth - 190, Math.max(12, rect.left + rect.width / 2 - 95)),
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("resize", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("resize", onSelectionChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      stoppedByUserRef.current = true;
      try { recognitionRef.current?.stop(); } catch {}
      synthRef.current.cancel();
      if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current);
    };
  }, []);

  // Pause hands-free when tab is hidden
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && handsFreeRef.current) {
        stopHandsFree("Paused (tab hidden)");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const saveApiKey = (key: string) => { persistApiKey(key); setShowSettings(false); };

  const loadInworldVoices = useCallback(async (key: string) => {
    if (!key.trim()) return;
    setLoadingVoices(true);
    try {
      const voices = await fetchInworldVoices(key.trim());
      setInworldVoices(voices);
      if (!inworldVoiceId) {
        setInworldVoiceIdState(voices[0]?.voice_id || "Ashley");
      }
    } catch (err: any) {
      toast.error(`Could not load Inworld voices: ${err.message}`);
    } finally {
      setLoadingVoices(false);
    }
  }, [inworldVoiceId]);

  const saveInworldKey = (key: string) => {
    setInworldApiKey(key.trim());
    if (key.trim()) loadInworldVoices(key.trim());
  };
  const addModel = () => { const m = newModelInput.trim(); if (!m) return; addModelToSettings(m); setNewModelInput(""); };
  const removeModel = (m: string) => removeModelFromSettings(m);

  const selectedBook = books.find((b) => b.id === activeBookId);

  // ----- Streaming TTS queue (lets the first sentence play before the model finishes) -----
  // Two-stage pipeline:
  //   ttsTextQueueRef  -> pending text chunks awaiting synthesis
  //   ttsAudioQueueRef -> synthesized audio ready to play
  // Up to TTS_PREFETCH_CONCURRENCY syntheses run in parallel so the next
  // sentence is already an MP3 by the time the current one finishes playing.
  const TTS_PREFETCH_CONCURRENCY = 2;
  const ttsQueueRef = useRef<string[]>([]); // text queue (kept name for compat with rest of file)
  const ttsAudioQueueRef = useRef<{ url: string }[]>([]);
  const ttsPendingSynthRef = useRef(0);
  const ttsAbortersRef = useRef<Set<AbortController>>(new Set());
  const ttsPlayingRef = useRef(false);
  const streamDoneRef = useRef(true);
  const ttsCancelledRef = useRef(false);
  // True from the moment submit() starts until the last TTS chunk finishes.
  // Covers the model wait, inter-chunk gaps, and post-TTS grace so the mic
  // never re-arms mid-turn.
  const turnActiveRef = useRef(false);

  const muteMicForTts = useCallback(() => {
    isSpeakingRef.current = true;
    if (sendTimerRef.current) { window.clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
    finalTranscriptRef.current = "";
    previousFinalLengthRef.current = 0;
    setInterimTranscript("");
    stopCurrentRecognitionQuietly();
    setIsListening(false);
    isListeningRef.current = false;
  }, []);

  const finishTtsAndResumeMic = useCallback(() => {
    setIsSpeaking(false);
    isSpeakingRef.current = false;
    turnActiveRef.current = false;
    if (handsFreeRef.current && !stoppedByUserRef.current) {
      window.setTimeout(() => safeStartListening(), POST_TTS_DELAY_MS);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maybeFinishTurn = useCallback(() => {
    if (
      streamDoneRef.current &&
      ttsQueueRef.current.length === 0 &&
      ttsAudioQueueRef.current.length === 0 &&
      ttsPendingSynthRef.current === 0 &&
      !ttsPlayingRef.current
    ) {
      finishTtsAndResumeMic();
    }
  }, [finishTtsAndResumeMic]);

  // Pump: start more syntheses while we have text + headroom.
  const pumpSynthRef = useRef<() => void>(() => {});
  const pumpPlayRef = useRef<() => void>(() => {});

  const pumpSynth = useCallback(() => {
    if (ttsCancelledRef.current) return;
    if (!inworldEnabled || !inworldApiKey || !inworldVoiceId) return; // browser TTS path doesn't prefetch
    while (
      ttsPendingSynthRef.current < TTS_PREFETCH_CONCURRENCY &&
      ttsQueueRef.current.length > 0
    ) {
      const text = ttsQueueRef.current.shift()!;
      const controller = new AbortController();
      ttsAbortersRef.current.add(controller);
      ttsPendingSynthRef.current += 1;
      synthesizeSpeech(text, inworldApiKey, inworldVoiceId, "inworld-tts-2", { signal: controller.signal })
        .then((buffer) => {
          ttsAbortersRef.current.delete(controller);
          ttsPendingSynthRef.current -= 1;
          if (ttsCancelledRef.current) return;
          const blob = new Blob([buffer], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          ttsAudioQueueRef.current.push({ url });
          pumpPlayRef.current();
          pumpSynthRef.current();
        })
        .catch((err) => {
          ttsAbortersRef.current.delete(controller);
          ttsPendingSynthRef.current -= 1;
          if (ttsCancelledRef.current) return;
          if ((err as any)?.name === "AbortError") return;
          console.error("Inworld TTS error:", err);
          // Fallback: speak this chunk via browser TTS inline, then continue.
          ttsPlayingRef.current = true;
          setIsSpeaking(true);
          isSpeakingRef.current = true;
          const u = new SpeechSynthesisUtterance(text);
          u.rate = Math.min(2, Math.max(0.5, ttsRate || 1.05));
          const done = () => {
            ttsPlayingRef.current = false;
            pumpPlayRef.current();
            pumpSynthRef.current();
            maybeFinishTurn();
          };
          u.onend = done; u.onerror = done;
          synthRef.current.speak(u);
        });
    }
  }, [inworldEnabled, inworldApiKey, inworldVoiceId, ttsRate, maybeFinishTurn]);

  const pumpPlay = useCallback(() => {
    if (ttsPlayingRef.current) return;
    if (ttsCancelledRef.current) {
      // Drain any queued audio URLs
      while (ttsAudioQueueRef.current.length) {
        const { url } = ttsAudioQueueRef.current.shift()!;
        try { URL.revokeObjectURL(url); } catch {}
      }
      return;
    }
    const next = ttsAudioQueueRef.current.shift();
    if (!next) {
      maybeFinishTurn();
      return;
    }
    ttsPlayingRef.current = true;
    setIsSpeaking(true);
    isSpeakingRef.current = true;

    let audio = inworldAudioRef.current;
    if (!audio) {
      audio = new Audio();
      inworldAudioRef.current = audio;
    } else {
      try { audio.pause(); } catch {}
    }
    audio.src = next.url;
    audio.playbackRate = Math.min(2, Math.max(0.5, ttsRate || 1.05));
    const cleanup = () => {
      try { URL.revokeObjectURL(next.url); } catch {}
      ttsPlayingRef.current = false;
      pumpPlayRef.current();
      pumpSynthRef.current();
      maybeFinishTurn();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    audio.play().catch(cleanup);
  }, [ttsRate, maybeFinishTurn]);

  // Keep refs pointing at the latest pump fns so promise callbacks can call them.
  useEffect(() => { pumpSynthRef.current = pumpSynth; }, [pumpSynth]);
  useEffect(() => { pumpPlayRef.current = pumpPlay; }, [pumpPlay]);

  // Legacy name kept so the rest of the file (which only references playNextChunk indirectly) keeps working.
  const playNextChunk = pumpPlay;

  const enqueueSpeak = useCallback((chunk: string) => {
    if (!ttsEnabled) return;
    const t = stripMarkdownForTts(chunk);
    if (!t) return;
    ttsCancelledRef.current = false;
    streamDoneRef.current = false;
    muteMicForTts();

    if (inworldEnabled && inworldApiKey && inworldVoiceId) {
      ttsQueueRef.current.push(t);
      pumpSynth();
      pumpPlay();
    } else {
      // Browser TTS: speak directly, no prefetch needed.
      ttsPlayingRef.current = true;
      setIsSpeaking(true);
      isSpeakingRef.current = true;
      const u = new SpeechSynthesisUtterance(t);
      u.rate = Math.min(2, Math.max(0.5, ttsRate || 1.05));
      const done = () => {
        ttsPlayingRef.current = false;
        maybeFinishTurn();
      };
      u.onend = done; u.onerror = done;
      synthRef.current.speak(u);
    }
  }, [ttsEnabled, muteMicForTts, inworldEnabled, inworldApiKey, inworldVoiceId, ttsRate, pumpSynth, pumpPlay, maybeFinishTurn]);

  const markTtsStreamDone = useCallback(() => {
    streamDoneRef.current = true;
    maybeFinishTurn();
  }, [maybeFinishTurn]);

  // Single-shot speak (used outside of streaming, e.g. replay or short replies)
  const speak = useCallback((text: string) => {
    if (!ttsEnabled) {
      if (handsFreeRef.current && !stoppedByUserRef.current) {
        window.setTimeout(() => safeStartListening(), POST_TTS_DELAY_MS);
      }
      return;
    }
    enqueueSpeak(text);
    markTtsStreamDone();
  }, [ttsEnabled, enqueueSpeak, markTtsStreamDone]);

  const stopSpeaking = () => {
    ttsCancelledRef.current = true;
    ttsQueueRef.current = [];
    // Abort in-flight syntheses
    for (const c of ttsAbortersRef.current) { try { c.abort(); } catch {} }
    ttsAbortersRef.current.clear();
    ttsPendingSynthRef.current = 0;
    // Revoke any queued blob URLs
    while (ttsAudioQueueRef.current.length) {
      const { url } = ttsAudioQueueRef.current.shift()!;
      try { URL.revokeObjectURL(url); } catch {}
    }
    ttsPlayingRef.current = false;
    streamDoneRef.current = true;
    synthRef.current.cancel();
    if (inworldAudioRef.current) {
      try { inworldAudioRef.current.pause(); } catch {}
      inworldAudioRef.current.src = "";
      // Keep the element instance for reuse on next turn
    }
    isSpeakingRef.current = false;
    turnActiveRef.current = false;
    setIsSpeaking(false);
  };


  const runBackgroundSearch = useCallback(async (query: string) => {
    if (!burplexityApiToken) return;
    setPendingSearchCount((c) => c + 1);
    try {
      const result = await executeQuickSearch(query, burplexityApiToken);
      if (result.error || !result.citations.length) return;
      let md = `🔍 **Search Results for:** "${query}"\n\n`;
      result.citations.forEach((c, i) => {
        md += `**${i + 1}. ${c.title}**\n${c.url}\n`;
        if (c.snippet) md += `${c.snippet}\n`;
        md += "\n";
      });
      if (result.elapsed_ms) {
        md += `_Completed in ${result.elapsed_ms}ms${result.backend ? ` via ${result.backend}` : ""}_`;
      }
      injectDisplayMessage(md);
      if (ttsEnabled) ttsSpeak("Search results are ready", { rate: ttsRate });
    } finally {
      setPendingSearchCount((c) => c - 1);
    }
  }, [burplexityApiToken, injectDisplayMessage, ttsEnabled, ttsRate]);

  const submit = useCallback(async (text: string) => {
    if (!text.trim()) return;
    if (!apiKey) { toast.error("Set your OpenRouter API key first"); setShowSettings(true); return; }

    // Lock the mic for the entire turn (model wait + streamed TTS + grace).
    // This closes the pre-first-token race where a late onresult could fire
    // before isLoadingRef catches up via its useEffect.
    turnActiveRef.current = true;
    isSpeakingRef.current = true;
    streamDoneRef.current = false;
    if (sendTimerRef.current) { window.clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
    finalTranscriptRef.current = "";
    previousFinalLengthRef.current = 0;
    setInterimTranscript("");
    stopCurrentRecognitionQuietly();

    try {
      if (voiceQuickSearch && burplexityApiToken && SEARCH_INTENT_RE.test(text)) {
        runBackgroundSearch(text); // intentionally not awaited
      }
      // Remember the next assistant message index so we can speak it when it arrives.
      lastSpokenIndexRef.current = messages.length;

      // Sentence-streaming TTS: speak each completed sentence as soon as the
      // model produces it, instead of waiting for the entire reply. The first
      // audible word lands seconds earlier in hands-free mode.
      let spokenCursor = 0;
      const sentenceRe = /[^.!?\n]+[.!?\n]+\s*/g;
      const onDelta = handsFreeRef.current && ttsEnabled
        ? (full: string) => {
            const tail = full.slice(spokenCursor);
            sentenceRe.lastIndex = 0;
            let m: RegExpExecArray | null;
            let consumed = 0;
            while ((m = sentenceRe.exec(tail)) !== null) {
              const sentence = m[0].trim();
              const endIdx = m.index + m[0].length;
              if (sentence.length >= MIN_SENTENCE_LEN) {
                enqueueSpeak(sentence);
                consumed = endIdx;
              }
            }
            if (consumed > 0) spokenCursor += consumed;
          }
        : undefined;

      const reply = await sendMessage(text, {
        voiceMode: true,
        modelOverride: voiceModel || undefined,
        onDelta,
      });

      if (reply) {
        if (onDelta) {
          // Flush any remainder past the last sentence boundary.
          const remainder = reply.slice(spokenCursor).trim();
          if (remainder) enqueueSpeak(remainder);
          markTtsStreamDone();
        } else {
          speak(reply);
        }
      } else {
        // No reply produced — end the turn cleanly.
        streamDoneRef.current = true;
        isSpeakingRef.current = false;
        turnActiveRef.current = false;
        if (handsFreeRef.current && !stoppedByUserRef.current) {
          window.setTimeout(() => safeStartListening(), POST_TTS_DELAY_MS);
        }
      }
    } catch {
      streamDoneRef.current = true;
      ttsQueueRef.current = [];
      ttsPlayingRef.current = false;
      isSpeakingRef.current = false;
      turnActiveRef.current = false;
      if (handsFreeRef.current && !stoppedByUserRef.current) {
        window.setTimeout(() => safeStartListening(), POST_TTS_DELAY_MS + 200);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, messages.length, sendMessage, speak, voiceQuickSearch, burplexityApiToken, runBackgroundSearch, voiceModel, ttsEnabled, enqueueSpeak, markTtsStreamDone]);

  const submitRef = useRef(submit);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  const flushPendingTranscript = useCallback(() => {
    if (submittingRef.current) return;
    const text = normalizeTranscript(finalTranscriptRef.current);
    if (sendTimerRef.current) { window.clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
    if (!text) return;
    submittingRef.current = true;
    finalTranscriptRef.current = "";
    previousFinalLengthRef.current = 0;
    lastSentTextRef.current = text;
    lastSentAtRef.current = Date.now();
    setInterimTranscript("");
    stopCurrentRecognitionQuietly();
    submitRef.current(text);
  }, []);

  const buildRecognition = useCallback(() => {
    const recognition = new SpeechRecognition();
    recognition.continuous = handsFreeRef.current;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onresult = (event: any) => {
      // Barge-in guard: drop anything captured while TTS is playing or a
      // request is in flight — otherwise the mic transcribes the speaker.
      if (
        isSpeakingRef.current ||
        isLoadingRef.current ||
        turnActiveRef.current ||
        submittingRef.current ||
        !streamDoneRef.current ||
        ttsPlayingRef.current ||
        ttsQueueRef.current.length > 0 || ttsAudioQueueRef.current.length > 0 || ttsPendingSynthRef.current > 0
      ) return;
      const finalPieces: string[] = [];
      const interimPieces: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        const t = String(res[0]?.transcript || "").trim();
        if (!t) continue;
        if (res.isFinal) {
          finalPieces.push(t);
        } else {
          interimPieces.push(t);
        }
      }
      const stable = mergeTranscriptPieces(finalPieces);
      const interim = mergeTranscriptPieces(interimPieces);
      const sawNewFinal = Boolean(stable) && stable !== finalTranscriptRef.current;
      const hasInterim = Boolean(interim);

      finalTranscriptRef.current = stable;
      previousFinalLengthRef.current = stable.length;
      setInterimTranscript(mergeTranscriptPieces([stable, interim]));

      // Hands-free: only send after a real pause. Reset the silence timer on
      // ANY activity (new final OR ongoing interim) so we wait for the user
      // to actually stop talking before submitting.
      if (handsFreeRef.current) {
        if (sawNewFinal || hasInterim) {
          if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current);
          if (stable) {
            const delay = hasInterim ? SILENCE_INTERIM_MS : SILENCE_FINAL_MS;
            sendTimerRef.current = window.setTimeout(() => flushPendingTranscript(), delay);
          }
        }
      } else if (sawNewFinal) {
        if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current);
        sendTimerRef.current = window.setTimeout(() => flushPendingTranscript(), 700);
      }
    };

    recognition.onerror = (event: any) => {
      const benign = event.error === "no-speech" || event.error === "aborted" || event.error === "audio-capture";
      if (!benign) {
        toast.error(`Mic error: ${event.error}`);
        stoppedByUserRef.current = true;
        setHandsFree(false);
      }
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      isListeningRef.current = false;
      const turnBusy =
        isLoadingRef.current ||
        isSpeakingRef.current ||
        turnActiveRef.current ||
        ttsPlayingRef.current ||
        ttsQueueRef.current.length > 0 || ttsAudioQueueRef.current.length > 0 || ttsPendingSynthRef.current > 0 ||
        !streamDoneRef.current;
      if (handsFreeRef.current && !stoppedByUserRef.current && !turnBusy) {
        const stable = normalizeTranscript(finalTranscriptRef.current);
        if (stable && !submittingRef.current) flushPendingTranscript();
        else {
          window.setTimeout(() => safeStartListening(), 250);
        }
      } else {
        const stable = normalizeTranscript(finalTranscriptRef.current);
        if (!handsFreeRef.current && stable && !stoppedByUserRef.current && !submittingRef.current) {
          flushPendingTranscript();
        } else {
          setInterimTranscript("");
        }
      }
    };

    return recognition;
  }, [flushPendingTranscript]);

  const safeStartListening = useCallback(() => {
    if (!SpeechRecognition) return;
    if (
      isListeningRef.current ||
      isLoadingRef.current ||
      isSpeakingRef.current ||
      turnActiveRef.current ||
      ttsPlayingRef.current ||
      ttsQueueRef.current.length > 0 || ttsAudioQueueRef.current.length > 0 || ttsPendingSynthRef.current > 0 ||
      !streamDoneRef.current
    ) return;
    if (stoppedByUserRef.current) return;
    stopCurrentRecognitionQuietly();
    resetTranscriptBuffers();
    const recognition = buildRecognition();
    recognitionRef.current = recognition;
    try { recognition.start(); } catch { /* ignore */ }
  }, [buildRecognition]);

  const startListening = useCallback(() => {
    if (!SpeechRecognition) { toast.error("Speech recognition not supported. Try Chrome."); return; }
    if (!apiKey) { toast.error("Set your API key first"); setShowSettings(true); return; }
    stopSpeaking();
    stoppedByUserRef.current = false;
    stopCurrentRecognitionQuietly();
    resetTranscriptBuffers();
    setInterimTranscript("");
    const recognition = buildRecognition();
    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}
  }, [apiKey, buildRecognition]);

  const stopListening = () => {
    stoppedByUserRef.current = true;
    resetTranscriptBuffers();
    stopCurrentRecognitionQuietly();
    setInterimTranscript("");
  };

  const stopHandsFree = (msg?: string) => {
    setHandsFree(false);
    stopListening();
    stopSpeaking();
    if (msg) toast(msg);
  };

  const toggleHandsFree = () => {
    if (handsFree) {
      stopHandsFree();
    } else {
      if (!SpeechRecognition) { toast.error("Speech recognition not supported. Try Chrome."); return; }
      if (!apiKey) { toast.error("Set your API key first"); setShowSettings(true); return; }
      setHandsFree(true);
      stoppedByUserRef.current = false;
      window.setTimeout(() => {
        try { recognitionRef.current?.stop(); } catch {}
        window.setTimeout(() => startListening(), 100);
      }, 0);
      toast.success("Hands-free on — just talk");
    }
  };

  const handleSaveToWiki = async () => {
    if (messages.length < 2) { toast.error("Chat first"); return; }
    setExtracting(true);
    try {
      const result = await extractKnowledge(messages.map(m => ({ role: m.role, content: m.content })), activeBookId || undefined);
      toast.success(`Saved ${result.entries?.length || 0} entries to wiki`);
    } catch (err: any) { toast.error(err.message); }
    finally { setExtracting(false); }
  };

  const handleClear = () => { stopSpeaking(); clearChat(); };

  const statusLabel = isListening
    ? "Listening…"
    : isLoading
    ? "Thinking…"
    : isSpeaking
    ? "Speaking…"
    : pendingSearchCount > 0
    ? `🔍 Searching… (${pendingSearchCount})`
    : handsFree
    ? "Hands-free paused"
    : "Tap to talk";

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0 relative">
      <button
        onClick={() => setNotesPanelOpen((v) => !v)}
        className="absolute top-3 right-3 z-30 flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary-container text-on-primary-container hover:bg-primary-container/90 text-sm font-semibold shadow-md"
        title="Voice notes"
      >
        <StickyNote className="w-4 h-4" />
        Notes
      </button>

      <Drawer open={showSettings} onOpenChange={setShowSettings}>
        <DrawerContent className="md:max-w-2xl md:mx-auto">
          <DrawerHeader className="relative border-b border-outline-variant/10">
            <DrawerTitle className="text-left">Settings</DrawerTitle>
            <DrawerClose asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close settings"
                className="absolute right-2 top-2 h-11 w-11"
              >
                <X className="h-5 w-5" />
              </Button>
            </DrawerClose>
          </DrawerHeader>
          <div className="max-h-[80vh] overflow-y-auto px-4 py-4 space-y-3" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-3 rounded-xl bg-surface-container-low">
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">OpenRouter API Key</label>
                <div className="relative">
                  <input className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40" type="password" placeholder="sk-or-v1-..." defaultValue={apiKey} id="voice-key-input" onKeyDown={(e) => { if (e.key === "Enter") saveApiKey((e.target as HTMLInputElement).value); }} />
                  <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">key</span>
                </div>
                <div className="flex gap-2 mt-1">
                  <Button size="sm" onClick={() => { const el = document.getElementById("voice-key-input") as HTMLInputElement; saveApiKey(el?.value || ""); }}>Save</Button>
                  {apiKey && <Button size="sm" variant="destructive" onClick={() => saveApiKey("")}>Remove</Button>}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Burplexity API Token <span className="text-on-surface-variant/60 normal-case tracking-normal">(web search)</span></label>
                <div className="relative">
                  <input className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40" type="password" placeholder="pp_..." defaultValue={burplexityApiToken} id="voice-burplexity-input" onKeyDown={(e) => { if (e.key === "Enter") { setBurplexityApiToken((e.target as HTMLInputElement).value); toast.success("Burplexity token saved"); } }} />
                  <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">travel_explore</span>
                </div>
                <div className="flex gap-2 mt-1">
                  <Button size="sm" onClick={() => { const el = document.getElementById("voice-burplexity-input") as HTMLInputElement; setBurplexityApiToken(el?.value || ""); toast.success(el?.value ? "Burplexity token saved" : "Burplexity token removed"); }}>Save</Button>
                  {burplexityApiToken && <Button size="sm" variant="destructive" onClick={() => setBurplexityApiToken("")}>Remove</Button>}
                </div>
                <p className="text-[10px] text-on-surface-variant px-1">Enables the live <code>web_search</code> tool used by the assistant.</p>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0 col-span-1 lg:col-span-2">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs align-middle">record_voice_over</span>Inworld Voice (TTS Upgrade)
                </label>
                <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-2.5 px-4">
                  <span className="text-sm text-primary">{inworldEnabled ? "Inworld TTS on" : "Browser TTS"}</span>
                  <button
                    onClick={() => setInworldEnabled(!inworldEnabled)}
                    disabled={!inworldApiKey || !inworldVoiceId}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-40 ${inworldEnabled ? "bg-primary-container" : "bg-surface-container-highest"}`}
                    aria-checked={inworldEnabled}
                    role="switch"
                    title={!inworldApiKey ? "Enter an Inworld API key first" : !inworldVoiceId ? "Select a voice first" : ""}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${inworldEnabled ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                  <div className="relative">
                    <input
                      className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40"
                      type="password"
                      placeholder="Inworld API key…"
                      defaultValue={inworldApiKey}
                      id="inworld-key-input"
                      onKeyDown={(e) => { if (e.key === "Enter") saveInworldKey((e.target as HTMLInputElement).value); }}
                    />
                    <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">key</span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => { const el = document.getElementById("inworld-key-input") as HTMLInputElement; saveInworldKey(el?.value || ""); }}>
                      Save & Load Voices
                    </Button>
                    {inworldApiKey && (
                      <Button size="sm" variant="destructive" onClick={() => { setInworldApiKey(""); setInworldEnabled(false); setInworldVoices([]); }}>
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
                {inworldApiKey && (
                  <div className="flex items-center gap-2 mt-1">
                    {loadingVoices ? (
                      <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading voices…
                      </div>
                    ) : inworldVoices.length > 0 ? (
                      <select
                        value={inworldVoiceId}
                        onChange={(e) => setInworldVoiceIdState(e.target.value)}
                        className="flex-1 bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
                      >
                        {inworldVoices.map((v) => (
                          <option key={v.voice_id} value={v.voice_id}>
                            {v.name}{v.tags?.length ? ` (${v.tags.join(", ")})` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => loadInworldVoices(inworldApiKey)}>
                        Retry loading voices
                      </Button>
                    )}
                  </div>
                )}
                <p className="text-[10px] text-on-surface-variant px-1">
                  When enabled, AI replies are spoken using an Inworld character voice instead of the browser&apos;s built-in TTS.
                </p>
              </div>

              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Model</label>
                <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
                </select>
                <div className="flex gap-2 mt-1">
                  <Input type="text" placeholder="provider/model-name" value={newModelInput} onChange={(e) => setNewModelInput(e.target.value)} className="text-sm font-mono bg-surface-container-high border-none" onKeyDown={(e) => { if (e.key === "Enter") addModel(); }} />
                  <Button size="sm" onClick={addModel}>Add</Button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {savedModels.map((m) => (
                    <span key={m} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md max-w-full break-all ${m === selectedModel ? "bg-primary-container/20 text-primary" : "bg-surface-container-highest text-on-surface-variant"}`}>
                      <button onClick={() => setSelectedModel(m)} className="hover:underline text-left break-all">{m}</button>
                      <button onClick={() => removeModel(m)} className="hover:text-destructive ml-0.5 material-symbols-outlined text-xs shrink-0">close</button>
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                  <span className="material-symbols-outlined text-xs align-middle mr-1">science</span>Deep Research Model
                </label>
                <select value={deepResearchModel} onChange={(e) => setDeepResearchModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
                </select>
                <p className="text-[10px] text-on-surface-variant px-1">Used when Deep Research is ON.</p>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                  <span className="material-symbols-outlined text-xs align-middle mr-1">bolt</span>Voice Model <span className="text-on-surface-variant/60 normal-case tracking-normal">(faster = lower latency)</span>
                </label>
                <select value={voiceModel || ""} onChange={(e) => setVoiceModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                  <option value="">Same as Chat model</option>
                  {savedModels.map((m: string) => (<option key={m} value={m}>{m}</option>))}
                </select>
                <p className="text-[10px] text-on-surface-variant px-1">Used only in the Voice tab. Pick a fast model (e.g. <code>google/gemini-2.5-flash-lite</code>) for snappier hands-free replies.</p>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                  <span className="material-symbols-outlined text-xs align-middle mr-1">travel_explore</span>Background Quick Search
                </label>
                <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-2.5 px-4">
                  <span className="text-sm text-primary">{voiceQuickSearch ? "On" : "Off"}</span>
                  <button
                    onClick={() => setVoiceQuickSearch(!voiceQuickSearch)}
                    disabled={!burplexityApiToken}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-40 ${voiceQuickSearch ? "bg-primary-container" : "bg-surface-container-highest"}`}
                    aria-checked={voiceQuickSearch}
                    role="switch"
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${voiceQuickSearch ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
                <p className="text-[10px] text-on-surface-variant px-1">
                  {burplexityApiToken ? "Searches run in background; results interrupt conversation when ready." : "Requires a Burplexity API token above."}
                </p>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Quick Search Model <span className="text-on-surface-variant/60 normal-case tracking-normal">(lightweight preferred)</span></label>
                <select value={voiceQuickSearchModel || selectedModel} onChange={(e) => setVoiceQuickSearchModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                  {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
                </select>
              </div>
            </section>
            <PromptLibrary scopeHint="voice" />
            <section className="p-3 rounded-xl bg-surface-container-low">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs align-middle">history_edu</span>Legacy Custom Instructions
              </label>
              <p className="text-[10px] text-on-surface-variant px-1 mt-1 mb-2">Used only if no Prompt Library entry is active.</p>
              <Textarea
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                rows={3}
                placeholder="e.g. Always answer as a no-nonsense literary critic."
                className="bg-surface-container-high border-none text-sm"
              />
              <div className="flex gap-2 mt-2">
                <Button size="sm" onClick={() => { setCustomSystemPrompt(promptDraft); toast.success("Saved"); }}>Save</Button>
                {customSystemPrompt && (
                  <Button size="sm" variant="destructive" onClick={() => { setCustomSystemPrompt(""); setPromptDraft(""); toast.success("Cleared"); }}>Clear</Button>
                )}
              </div>
            </section>
          </div>
        </DrawerContent>
      </Drawer>

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 overflow-auto px-4 py-6 space-y-6 hide-scrollbar">
        {selectionCapture && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              saveBubbleToNotes(selectionCapture.text);
              setSelectionCapture(null);
              window.getSelection()?.removeAllRanges();
            }}
            className="fixed z-[60] px-3 py-2 rounded-full bg-primary-container text-on-primary-container text-xs font-semibold shadow-lg flex items-center gap-1.5"
            style={{ top: selectionCapture.top, left: selectionCapture.left }}
          >
            <BookmarkPlus className="w-3.5 h-3.5" /> Save selection
          </button>
        )}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-on-surface-variant gap-4">
            <div className="w-24 h-24 rounded-full bg-primary-container/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-5xl text-primary-container">settings_voice</span>
            </div>
            <p className="font-headline font-bold text-xl text-foreground">Voice Chat</p>
            <p className="text-sm text-center max-w-md">
              {selectedBook ? `Ready to discuss "${selectedBook.title}". Tap the mic, type below, or turn on Hands-free to just talk.` : "Tap the mic, type below, or turn on Hands-free for a continuous conversation."}
            </p>
            {!SpeechRecognition && <p className="text-xs text-destructive">⚠️ Use Chrome or Edge for speech recognition.</p>}
            {!apiKey && (
              <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-lg text-primary text-sm border border-outline-variant/10">
                <span className="material-symbols-outlined text-sm">key</span> Set API Key
              </button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={msg.id || i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[85%] ${msg.role === "user" ? "self-end" : ""} group`}>
            {msg.role === "assistant" && msg.toolEvents && msg.toolEvents.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {msg.toolEvents.map((ev, idx) => (
                  <span key={idx} className={`text-[11px] px-2 py-1 rounded-md ${ev.ok ? "bg-secondary-container/40 text-on-secondary-container" : "bg-destructive/15 text-destructive"}`}>
                    <span className="material-symbols-outlined text-xs align-middle mr-1">{ev.ok ? "build" : "error"}</span>{ev.summary}
                  </span>
                ))}
              </div>
            )}
            <div
              className={`relative ${msg.role === "user" ? "message-bubble-user bg-primary-container text-on-primary-container" : "message-bubble-ai bg-surface-container-high text-foreground border-l-2 border-primary-container/20"} p-5 shadow-sm leading-relaxed select-text`}
              style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
              onTouchStart={() => startLongPress(msg.content)}
              onTouchEnd={(e) => { if (longPressFiredRef.current) { e.preventDefault(); } cancelLongPress(); }}
              onTouchMove={cancelLongPress}
              onTouchCancel={cancelLongPress}
              onContextMenu={(e) => { if (longPressFiredRef.current) e.preventDefault(); }}
            >
              {msg.role === "assistant" ? (
                <div className="prose prose-sm prose-invert max-w-none"><ReactMarkdown>{msg.content}</ReactMarkdown></div>
              ) : (
                <p className="whitespace-pre-wrap font-medium">{msg.content}</p>
              )}
              {msg.content && (() => {
                const bid = `voice-${msg.id || i}`;
                const playing = bubbleSpeakingId === bid;
                return (
                  <button
                    onClick={(e) => { e.stopPropagation(); replayBubble(bid, msg.content); }}
                    title={playing ? "Stop reading" : "Read aloud"}
                    aria-label={playing ? "Stop reading" : "Read aloud"}
                    className={`absolute top-1/2 -translate-y-1/2 ${msg.role === "user" ? "-left-3" : "-right-3"} w-7 h-7 rounded-full bg-surface-container-highest border border-outline-variant/20 shadow-sm flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all opacity-80`}
                  >
                    <span className="material-symbols-outlined text-base">{playing ? "stop_circle" : "volume_up"}</span>
                  </button>
                );
              })()}
              <button
                onClick={() => saveBubbleToNotes(msg.content)}
                className="hidden md:flex absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity items-center justify-center w-7 h-7 rounded-full bg-surface-container-highest text-on-surface-variant hover:text-primary shadow-md"
                title="Save to voice notes"
                aria-label="Save to voice notes"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="message-bubble-ai bg-surface-container-high p-5 shadow-sm flex items-center gap-2 italic text-on-surface-variant">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "75ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "150ms" }} />
              </div>
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Interim transcript */}
      {interimTranscript && (
        <div className="px-4 py-2 border-t border-outline-variant/10 bg-surface-container-low">
          <p className="text-sm text-on-surface-variant italic">🎙️ {interimTranscript}</p>
        </div>
      )}

      {/* Controls */}
      <div className="bg-surface-container-low">
        {/* Collapse handle */}
        <div
          className="relative flex items-center justify-center gap-2 px-4 py-2 cursor-pointer select-none border-t border-outline-variant/10"
          role="button"
          tabIndex={0}
          aria-expanded={!controlsCollapsed}
          aria-controls="voice-controls-panel"
          title={controlsCollapsed ? "Show controls" : "Hide controls"}
          onClick={() => setControlsCollapsed((v) => !v)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setControlsCollapsed((v) => !v); } }}
          onTouchStart={handleHandleTouchStart}
          onTouchEnd={handleHandleTouchEnd}
        >
          <div className="flex-1 flex justify-center">
            <span className={`block h-1.5 w-12 rounded-full bg-on-surface-variant/30 transition-all duration-300 ${controlsCollapsed ? "opacity-60" : "opacity-100"}`} />
          </div>
          {controlsCollapsed && (
            <button
              onClick={(e) => { e.stopPropagation(); isListening ? stopListening() : startListening(); }}
              disabled={isLoading}
              aria-label={isListening ? "Stop listening" : "Start listening"}
              className={`absolute right-4 w-11 h-11 rounded-full flex items-center justify-center shadow-md transition-all ${
                isListening
                  ? "bg-destructive text-destructive-foreground animate-pulse"
                  : isLoading
                  ? "bg-surface-container-highest text-on-surface-variant cursor-not-allowed"
                  : "bg-primary-container text-on-primary-container active:scale-95"
              }`}
              style={{ position: "absolute" }}
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <span className="material-symbols-outlined text-2xl" style={isListening ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                  {isListening ? "mic_off" : "mic"}
                </span>
              )}
            </button>
          )}
          <span
            className={`material-symbols-outlined absolute left-4 text-on-surface-variant transition-transform duration-300 ${controlsCollapsed ? "rotate-0" : "rotate-180"}`}
            style={{ position: "absolute" }}
          >
            expand_less
          </span>
        </div>

        {/* Animated collapsible panel */}
        <div
          id="voice-controls-panel"
          className="grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-300 ease-out"
          style={{ gridTemplateRows: controlsCollapsed ? "0fr" : "1fr", opacity: controlsCollapsed ? 0 : 1 }}
          aria-hidden={controlsCollapsed}
        >
          <div className="overflow-hidden min-h-0">
            <div
              className={`px-4 pb-4 pt-1 motion-safe:transition-transform motion-safe:duration-300 ease-out ${controlsCollapsed ? "translate-y-2" : "translate-y-0"}`}
            >
              {/* Mobile-first layout: mic on top, toggles in row, secondary actions in row. */}
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
                {/* Primary mic — full-width on mobile, prominent */}
                <button
                  onClick={isListening ? stopListening : startListening}
                  disabled={isLoading}
                  aria-label={isListening ? "Stop listening" : "Start listening"}
                  className={`order-1 sm:order-3 w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-lg ${
                    isListening
                      ? "bg-destructive text-destructive-foreground animate-pulse scale-110"
                      : isLoading
                      ? "bg-surface-container-highest text-on-surface-variant cursor-not-allowed"
                      : "bg-primary-container text-on-primary-container hover:scale-105 active:scale-95"
                  }`}
                >
                  {isLoading ? (
                    <Loader2 className="w-8 h-8 animate-spin" />
                  ) : (
                    <span className="material-symbols-outlined text-4xl" style={isListening ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                      {isListening ? "mic_off" : "mic"}
                    </span>
                  )}
                </button>

                {/* Row 1 (mobile): primary toggles */}
                <div className="order-2 sm:order-1 grid grid-cols-3 gap-2 w-full sm:w-auto sm:flex sm:gap-3">
                  <button
                    onClick={toggleHandsFree}
                    aria-pressed={handsFree}
                    className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-2xl sm:rounded-full transition-all text-xs sm:text-sm font-medium ${handsFree ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
                    title="Hands-free conversation"
                  >
                    <span className="material-symbols-outlined text-lg sm:text-base">all_inclusive</span>
                    <span className="leading-none">{handsFree ? "On" : "Hands-free"}</span>
                  </button>

                  <button
                    onClick={() => setVoiceQuickSearch(!voiceQuickSearch)}
                    aria-pressed={voiceQuickSearch}
                    disabled={!burplexityApiToken}
                    className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 sm:px-3 py-2.5 rounded-2xl sm:rounded-full transition-all text-xs sm:text-sm font-medium disabled:opacity-40 ${voiceQuickSearch ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
                    title={burplexityApiToken ? "Background Quick Search" : "Set Burplexity token in Settings to enable"}
                  >
                    <span className="material-symbols-outlined text-lg sm:text-base" style={voiceQuickSearch ? { fontVariationSettings: "'FILL' 1" } : {}}>travel_explore</span>
                    <span className="leading-none">{voiceQuickSearch ? "Search" : "Search"}</span>
                  </button>

                  <button
                    onClick={() => { setTtsEnabled(!ttsEnabled); if (ttsEnabled) stopSpeaking(); }}
                    aria-pressed={ttsEnabled}
                    className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 sm:px-3 py-2.5 rounded-2xl sm:rounded-full transition-all text-xs sm:text-sm font-medium ${ttsEnabled ? "bg-primary-container/30 text-primary" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
                    title={ttsEnabled ? "Voice replies on" : "Voice replies off"}
                  >
                    <span className="material-symbols-outlined text-lg sm:text-base">{ttsEnabled ? "volume_up" : "volume_off"}</span>
                    <span className="leading-none">{ttsEnabled ? "Voice On" : "Voice Off"}</span>
                  </button>
                </div>

                {/* Row 2 (mobile): secondary actions */}
                <div className="order-3 sm:order-4 grid grid-cols-4 gap-2 w-full sm:w-auto sm:flex sm:gap-3">
                  <button
                    onClick={() => setNotesPanelOpen((v) => !v)}
                    aria-pressed={notesPanelOpen}
                    className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-2xl sm:rounded-full transition-all text-xs sm:text-sm font-medium ${notesPanelOpen ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
                    title="Voice notes"
                  >
                    <StickyNote className="w-4 h-4 sm:w-4 sm:h-4" />
                    <span className="leading-none">Notes</span>
                  </button>

                  <button
                    onClick={handleSaveToWiki}
                    disabled={extracting || messages.length < 2}
                    className="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 sm:px-3 py-2.5 rounded-2xl sm:rounded-full bg-secondary-container text-on-secondary-container hover:bg-secondary-container/80 transition-all text-xs sm:text-sm font-medium disabled:opacity-40"
                    title="Save chat to Wiki"
                  >
                    {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="material-symbols-outlined text-lg sm:text-base">history_edu</span>}
                    <span className="leading-none">Wiki</span>
                  </button>

                  <button
                    onClick={handleClear}
                    disabled={messages.length === 0}
                    className="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 sm:px-3 py-2.5 rounded-2xl sm:rounded-full bg-surface-container-high text-on-surface-variant hover:text-destructive transition-colors text-xs sm:text-sm font-medium disabled:opacity-40"
                    title="Clear chat"
                  >
                    <span className="material-symbols-outlined text-lg sm:text-base">delete</span>
                    <span className="leading-none">Clear</span>
                  </button>

                  <button
                    onClick={() => setShowSettings(!showSettings)}
                    className="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 sm:px-3 py-2.5 rounded-2xl sm:rounded-full bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors text-xs sm:text-sm font-medium"
                    title="Settings"
                  >
                    <span className="material-symbols-outlined text-lg sm:text-base">tune</span>
                    <span className="leading-none">Settings</span>
                  </button>
                </div>
              </div>
              <p className="text-xs text-on-surface-variant text-center mt-3">
                {statusLabel}
                {handsFree && !isListening && !isLoading && !isSpeaking && " — say something"}
              </p>
            </div>
          </div>
        </div>
      </div>
      </div>
      <VoiceNotesPanel open={notesPanelOpen} onClose={() => setNotesPanelOpen(false)} />
    </div>
  );
};

export default VoiceChat;
