import React, { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { extractKnowledge } from "@/lib/knowledgeApi";
import { Loader2, StickyNote, BookmarkPlus } from "lucide-react";
import VoiceNotesPanel, { appendVoiceNote } from "./VoiceNotesPanel";
import { useChatSettings } from "@/hooks/useChatSettings";

const LEGACY_OPENROUTER_STORAGE_KEY = "openrouter_api_key";
const VOICE_ENABLED_KEY = "voice_tts_enabled";
const HANDS_FREE_KEY = "voice_hands_free";
const NOTES_PANEL_OPEN_KEY = "voice_notes_panel_open";

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const VoiceChat: React.FC = () => {
  const { books, activeBookId } = useApp();
  const {
    messages, isLoading, deepResearch, setDeepResearch, sendMessage, clearChat,
  } = useChat();

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem(VOICE_ENABLED_KEY) !== "false");
  const [handsFree, setHandsFree] = useState(() => localStorage.getItem(HANDS_FREE_KEY) === "true");
  const [notesPanelOpen, setNotesPanelOpen] = useState(() => localStorage.getItem(NOTES_PANEL_OPEN_KEY) === "true");
  useEffect(() => { localStorage.setItem(NOTES_PANEL_OPEN_KEY, String(notesPanelOpen)); }, [notesPanelOpen]);
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
    apiKey, savedModels, selectedModel, deepResearchModel, loaded: settingsLoaded,
    saveApiKey: persistApiKey, setSelectedModel, setDeepResearchModel,
    addModel: addModelToSettings, removeModel: removeModelFromSettings,
  } = useChatSettings();
  const [newModelInput, setNewModelInput] = useState("");

  const recognitionRef = useRef<any>(null);
  const synthRef = useRef(window.speechSynthesis);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const handsFreeRef = useRef(handsFree);
  const isLoadingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const isListeningRef = useRef(false);
  const finalBufferRef = useRef("");
  const sendTimerRef = useRef<number | null>(null);
  const stoppedByUserRef = useRef(false);
  const lastSpokenIndexRef = useRef<number>(-1);
  const lastFinalSegmentRef = useRef<string>("");
  const lastSentTextRef = useRef<string>("");
  const lastSentAtRef = useRef<number>(0);

  useEffect(() => { handsFreeRef.current = handsFree; localStorage.setItem(HANDS_FREE_KEY, String(handsFree)); }, [handsFree]);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { localStorage.setItem(VOICE_ENABLED_KEY, String(ttsEnabled)); }, [ttsEnabled]);

  // One-time migration: localStorage key -> account-synced setting
  const migratedRef = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || migratedRef.current) return;
    migratedRef.current = true;
    const legacy = localStorage.getItem(LEGACY_OPENROUTER_STORAGE_KEY);
    if (legacy && !apiKey) persistApiKey(legacy);
    if (legacy) localStorage.removeItem(LEGACY_OPENROUTER_STORAGE_KEY);
  }, [settingsLoaded, apiKey, persistApiKey]);

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
  const addModel = () => { const m = newModelInput.trim(); if (!m) return; addModelToSettings(m); setNewModelInput(""); };
  const removeModel = (m: string) => removeModelFromSettings(m);

  const selectedBook = books.find((b) => b.id === activeBookId);

  const speak = useCallback((text: string) => {
    if (!ttsEnabled) {
      if (handsFreeRef.current && !stoppedByUserRef.current) {
        window.setTimeout(() => safeStartListening(), 400);
      }
      return;
    }
    synthRef.current.cancel();
    const clean = text.replace(/[#*_`~\[\]()>|]/g, "").replace(/\n+/g, ". ");
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.05;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      setIsSpeaking(false);
      if (handsFreeRef.current && !stoppedByUserRef.current) {
        window.setTimeout(() => safeStartListening(), 450);
      }
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      if (handsFreeRef.current && !stoppedByUserRef.current) {
        window.setTimeout(() => safeStartListening(), 450);
      }
    };
    synthRef.current.speak(utterance);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsEnabled]);

  const stopSpeaking = () => { synthRef.current.cancel(); setIsSpeaking(false); };

  const submit = useCallback(async (text: string) => {
    if (!text.trim()) return;
    if (!apiKey) { toast.error("Set your OpenRouter API key first"); setShowSettings(true); return; }
    try {
      // Remember the next assistant message index so we can speak it when it arrives.
      lastSpokenIndexRef.current = messages.length; // assistant will land after the user msg
      const reply = await sendMessage(text, { voiceMode: true });
      if (reply) speak(reply);
      else if (handsFreeRef.current && !stoppedByUserRef.current) {
        window.setTimeout(() => safeStartListening(), 450);
      }
    } catch {
      if (handsFreeRef.current && !stoppedByUserRef.current) {
        window.setTimeout(() => safeStartListening(), 600);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, messages.length, sendMessage, speak]);

  const submitRef = useRef(submit);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  const flushPendingTranscript = useCallback(() => {
    const text = finalBufferRef.current.trim();
    finalBufferRef.current = "";
    if (sendTimerRef.current) { window.clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
    if (!text) return;
    lastSentTextRef.current = text;
    lastSentAtRef.current = Date.now();
    setInterimTranscript("");
    try { recognitionRef.current?.stop(); } catch {}
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
      let interim = "";
      let newFinal = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const t = String(res[0].transcript || "");
        if (res.isFinal) newFinal += (newFinal ? " " : "") + t.trim();
        else interim += t;
      }
      if (newFinal) {
        const buf = finalBufferRef.current.trim();
        finalBufferRef.current = (buf ? buf + " " : "") + newFinal;
      }
      setInterimTranscript((finalBufferRef.current + " " + interim).trim());

      // Unified debounce: wait for ~700ms of silence after the last final
      // before submitting. Works for both push-to-talk and hands-free so
      // Chrome's multi-chunk finals are concatenated instead of truncated.
      if (newFinal) {
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
      if (handsFreeRef.current && !stoppedByUserRef.current && !isLoadingRef.current && !isSpeakingRef.current) {
        const buf = finalBufferRef.current.trim();
        if (buf) flushPendingTranscript();
        else {
          finalBufferRef.current = "";
          window.setTimeout(() => safeStartListening(), 250);
        }
      } else {
        // Push-to-talk: if user released mic with text pending, send it.
        const buf = finalBufferRef.current.trim();
        if (!handsFreeRef.current && buf && !stoppedByUserRef.current) {
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
    if (isListeningRef.current || isLoadingRef.current || isSpeakingRef.current) return;
    if (stoppedByUserRef.current) return;
    try { recognitionRef.current?.stop(); } catch {}
    const recognition = buildRecognition();
    recognitionRef.current = recognition;
    try { recognition.start(); } catch { /* ignore */ }
  }, [buildRecognition]);

  const startListening = useCallback(() => {
    if (!SpeechRecognition) { toast.error("Speech recognition not supported. Try Chrome."); return; }
    if (!apiKey) { toast.error("Set your API key first"); setShowSettings(true); return; }
    stopSpeaking();
    stoppedByUserRef.current = false;
    finalBufferRef.current = "";
    lastFinalSegmentRef.current = "";
    setInterimTranscript("");
    const recognition = buildRecognition();
    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}
  }, [apiKey, buildRecognition]);

  const stopListening = () => {
    stoppedByUserRef.current = true;
    if (sendTimerRef.current) { window.clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
    finalBufferRef.current = "";
    lastFinalSegmentRef.current = "";
    try { recognitionRef.current?.stop(); } catch {}
    setIsListening(false);
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

      {showSettings && (
        <div className="border-b border-outline-variant/10 bg-surface-container-low px-4 py-4">
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
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
                  <span key={m} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ${m === selectedModel ? "bg-primary-container/20 text-primary" : "bg-surface-container-highest text-on-surface-variant"}`}>
                    <button onClick={() => setSelectedModel(m)} className="hover:underline">{m}</button>
                    <button onClick={() => removeModel(m)} className="hover:text-destructive ml-0.5 material-symbols-outlined text-xs">close</button>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">science</span>Deep Research Model
              </label>
              <select value={deepResearchModel} onChange={(e) => setDeepResearchModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <p className="text-[10px] text-on-surface-variant px-1">Used when Deep Research is ON.</p>
            </div>
          </section>
        </div>
      )}

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
          className="flex items-center justify-center gap-2 px-4 py-2 cursor-pointer select-none border-t border-outline-variant/10"
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
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <button onClick={() => setShowSettings(!showSettings)} className="p-3 rounded-full bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors" title="Settings">
                  <span className="material-symbols-outlined">tune</span>
                </button>

                <button onClick={() => { setTtsEnabled(!ttsEnabled); if (ttsEnabled) stopSpeaking(); }} className={`p-3 rounded-full transition-all ${ttsEnabled ? "bg-primary-container/20 text-primary" : "bg-surface-container-high text-on-surface-variant"}`} title={ttsEnabled ? "Voice replies on" : "Voice replies off"}>
                  <span className="material-symbols-outlined">{ttsEnabled ? "volume_up" : "volume_off"}</span>
                </button>

                <button
                  onClick={() => setDeepResearch(!deepResearch)}
                  className={`px-3 py-3 rounded-full transition-all flex items-center gap-1.5 text-xs font-semibold ${deepResearch ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
                  title="Deep Research"
                >
                  <span className="material-symbols-outlined text-base" style={deepResearch ? { fontVariationSettings: "'FILL' 1" } : {}}>science</span>
                  Deep Research {deepResearch ? "ON" : "OFF"}
                </button>

                <button
                  onClick={() => setNotesPanelOpen((v) => !v)}
                  className={`px-4 py-3 rounded-full transition-all flex items-center gap-2 text-sm font-medium ${notesPanelOpen ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
                  title="Voice notes"
                >
                  <StickyNote className="w-4 h-4" />
                  Notes
                </button>

                <button
                  onClick={toggleHandsFree}
                  className={`px-4 py-3 rounded-full transition-all flex items-center gap-2 text-sm font-medium ${handsFree ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
                  title="Hands-free conversation"
                >
                  <span className="material-symbols-outlined text-base">all_inclusive</span>
                  {handsFree ? "Hands-free on" : "Hands-free"}
                </button>

                <button
                  onClick={isListening ? stopListening : startListening}
                  disabled={isLoading}
                  className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-lg ${
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

                {messages.length >= 2 && (
                  <button onClick={handleSaveToWiki} disabled={extracting} className="p-3 rounded-full bg-secondary-container text-on-secondary-container hover:bg-secondary-container/80 transition-all disabled:opacity-50" title="Save chat to Wiki">
                    {extracting ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="material-symbols-outlined">history_edu</span>}
                  </button>
                )}

                {messages.length > 0 && (
                  <button onClick={handleClear} className="p-3 rounded-full bg-surface-container-high text-on-surface-variant hover:text-destructive transition-colors" title="Clear chat">
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                )}
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
