import React, { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { extractKnowledge } from "@/lib/knowledgeApi";
import { Loader2, StickyNote, BookmarkPlus } from "lucide-react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { useReadAloud } from "@/hooks/useReadAloud";
import { useHandsFree } from "@/hooks/useHandsFree";
import { isEmbeddingModel } from "@/lib/utils";
import { useDictation } from "@/hooks/useDictation";
import PromptLibrary from "@/components/PromptLibrary";
import VoiceNotesPanel, { appendVoiceNote } from "@/components/VoiceNotesPanel";
import ResponseBlocks from "@/components/ResponseBlocks";
import WorkspacePanel from "@/components/WorkspacePanel";
import type { Artifact } from "@/lib/artifacts";
import { workspaceStore, deriveResearchTitle, useWorkspaceItems } from "@/lib/workspaceStore";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { executeQuickSearch, BURPLEXITY_BOT_ASK_URL, pickCitations, isSearchRateLimited } from "@/lib/chatTools";
import { synthesizeSpeech, fetchInworldVoices, type InworldVoice } from "@/lib/inworldTts";

import { synthesizeSpeech, fetchInworldVoices, type InworldVoice } from "@/lib/inworldTts";
import counselBgVideo from "@/assets/counsel-bg.mp4";
const VOICE_QUICK_SEARCH_MODEL_KEY = "voice_quick_search_model";

const SEARCH_INTENT_RE =
  /\b(search|look up|look for|find|google|what is|what are|who is|who are|tell me about|research|check online|latest|current|news about)\b/i;

const ChatPanel: React.FC = () => {
  const { books, activeBookId, activeWiki, activeWikiId } = useApp();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const {
    apiKey, savedModels, selectedModel, deepResearchModel, voiceModel, ttsRate, autoReadReplies, customSystemPrompt, burplexityApiToken, inworldApiKey, inworldEnabled, inworldVoiceId, loaded,
    saveApiKey, addModel, removeModel, setSelectedModel, setDeepResearchModel, setVoiceModel, setTtsRate, setAutoReadReplies, setCustomSystemPrompt, setBurplexityApiToken, setInworldApiKey, setInworldEnabled, setInworldVoiceId,
  } = useChatSettings();
  const { messages, isLoading, chatDeepResearch, setChatDeepResearch, sendMessage, injectDisplayMessage, clearChat, abort } = useChat();
  const { speakingId, speak, stop: stopSpeaking } = useReadAloud();
  const [bargeInEnabled, setBargeInEnabled] = useState(() => localStorage.getItem("hands_free_barge_in") === "true");
  const handsFree = useHandsFree({
    onUtterance: (text) => sendMessage(text, { voiceMode: true, modelOverride: voiceModel || undefined }),
    speak: (text, opts) => speak(text, opts),
    stopSpeaking,
    bargeIn: bargeInEnabled,
  });

  const [input, setInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [newModelInput, setNewModelInput] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [deepSearching, setDeepSearching] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");

  // ---- Voice features absorbed from the former Echo (Voice) tab ----
  const [notesPanelOpen, setNotesPanelOpen] = useState(false);
  const [voiceQuickSearch, setVoiceQuickSearch] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_KEY) === "true");
  const [voiceQuickSearchModel, setVoiceQuickSearchModel] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_MODEL_KEY) || "");
  const [pendingSearchCount, setPendingSearchCount] = useState(0);
  const [inworldVoices, setInworldVoices] = useState<InworldVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [testingVoice, setTestingVoice] = useState(false);
  const [selectionCapture, setSelectionCapture] = useState<{ text: string; top: number; left: number } | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => localStorage.getItem("counsel_workspace_open") === "1");
  const [workspaceSelectedId, setWorkspaceSelectedId] = useState<string | null>(null);
  const workspaceItems = useWorkspaceItems();
  const workspaceCount = workspaceItems.filter((i) => i.userId == null || i.userId === user?.id).length;
  useEffect(() => { localStorage.setItem("counsel_workspace_open", workspaceOpen ? "1" : "0"); }, [workspaceOpen]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const inputBeforeDictationRef = useRef<string>("");

  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_KEY, String(voiceQuickSearch)); }, [voiceQuickSearch]);
  useEffect(() => { localStorage.setItem(VOICE_QUICK_SEARCH_MODEL_KEY, voiceQuickSearchModel); }, [voiceQuickSearchModel]);
  useEffect(() => { localStorage.setItem("hands_free_barge_in", String(bargeInEnabled)); }, [bargeInEnabled]);

  const dictation = useDictation({
    onInterim: (text) => {
      setInput((inputBeforeDictationRef.current ? inputBeforeDictationRef.current + " " : "") + text);
    },
    onFinal: (text) => {
      const base = inputBeforeDictationRef.current;
      setInput((base ? base + " " : "") + text);
    },
  });
  const handleMicToggle = () => {
    if (!dictation.supported) { toast.error("Voice input not supported in this browser."); return; }
    if (dictation.isListening) { dictation.stop(); return; }
    inputBeforeDictationRef.current = input;
    dictation.start();
  };

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { setPromptDraft(customSystemPrompt || ""); }, [customSystemPrompt, showSettings]);

  // Autogrow the composer up to ~10 lines, then scroll internally.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  // Keep focus in the composer after a reply finishes streaming.
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) inputRef.current?.focus();
    prevLoadingRef.current = isLoading;
  }, [isLoading]);

  // Accessibility: announce streamed assistant text to screen readers, but
  // debounced (~2.5s) and only the NEW text since the last announcement, so it
  // isn't re-read on every token (aria-atomic="false").
  const [srAnnounce, setSrAnnounce] = useState("");
  const announcedRef = useRef<{ id: string | null; len: number }>({ id: null, len: 0 });
  const announceTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !last.content) return;
    const id = last.id || `idx-${messages.length - 1}`;
    if (announcedRef.current.id !== id) announcedRef.current = { id, len: 0 };
    if (announceTimerRef.current) window.clearTimeout(announceTimerRef.current);
    announceTimerRef.current = window.setTimeout(() => {
      const content = last.content || "";
      if (content.length > announcedRef.current.len) {
        const delta = content.slice(announcedRef.current.len).trim();
        announcedRef.current.len = content.length;
        if (delta) setSrAnnounce(delta);
      }
    }, 2500);
  }, [messages]);

  // ESC + click-outside to close the settings panel.
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowSettings(false); };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (settingsPanelRef.current && !settingsPanelRef.current.contains(target)) {
        const toggle = document.getElementById("chat-settings-toggle");
        if (toggle && toggle.contains(target)) return;
        setShowSettings(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [showSettings]);

  // Chat cannot use embedding-only models (they're for Wiki reindex). Auto-switch away.
  const chatModels = savedModels.filter((m) => !isEmbeddingModel(m));
  useEffect(() => {
    if (!loaded) return;
    if (isEmbeddingModel(selectedModel)) {
      const fallback = chatModels[0];
      if (fallback) {
        setSelectedModel(fallback);
        toast.message(`Switched Chat to "${fallback}"`, { description: `"${selectedModel}" is an embedding model and can't be used for chat.` });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, selectedModel]);

  // Auto-read assistant replies when the user has the setting enabled.
  const autoReadRef = useRef<{ enabled: boolean; lastId: string | null }>({ enabled: false, lastId: null });
  useEffect(() => {
    const wasEnabled = autoReadRef.current.enabled;
    autoReadRef.current.enabled = autoReadReplies;
    // If user just turned it OFF, stop any in-flight playback.
    if (wasEnabled && !autoReadReplies) stopSpeaking();
    // Seed lastId so we don't read historical messages when toggling ON.
    if (!wasEnabled && autoReadReplies) {
      const last = messages[messages.length - 1];
      autoReadRef.current.lastId = last ? (last.id || String(messages.length - 1)) : null;
    }
  }, [autoReadReplies]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!autoReadReplies || isLoading) return;
    if (handsFree.active) return; // hands-free speaks replies itself — don't double up
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const id = last.id || `chat-${messages.length - 1}`;
    if (autoReadRef.current.lastId === id) return;
    if (!last.content || !last.content.trim()) return;
    autoReadRef.current.lastId = id;
    speak(last.content, { id: `chat-${last.id || messages.length - 1}` });
  }, [messages, isLoading, autoReadReplies, speak, handsFree.active]);

  // ----- Selection capture → save to notes (anywhere in the transcript) -----
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

  // ----- Long-press a bubble to save it as a note (touch) -----
  const longPressTimer = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);
  const startLongPress = (text: string) => {
    longPressFiredRef.current = false;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(async () => {
      longPressFiredRef.current = true;
      const note = await appendVoiceNote(text);
      if (note) {
        try { (navigator as any).vibrate?.(30); } catch { /* no-op */ }
        toast.success("Saved to notes");
        setNotesPanelOpen(true);
      }
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const saveBubbleToNotes = async (text: string) => {
    const note = await appendVoiceNote(text);
    if (note) { toast.success("Saved to notes"); setNotesPanelOpen(true); }
  };

  // Open a chat artifact in the Workspace panel (instead of a one-off modal).
  // Prefer the linked workspace item id; fall back to matching by content, and
  // capture it on the fly for older messages that predate the workspace.
  const openArtifactInWorkspace = (msg: { artifact?: Artifact; workspaceItemId?: string }) => {
    if (!msg.artifact) return;
    const art = msg.artifact;
    const kind = art.kind === "svg" ? "svg" : "html";
    let id = msg.workspaceItemId;
    if (!id || !workspaceItems.some((w) => w.id === id)) {
      const match = workspaceItems.find(
        (w) => w.kind === kind && w.title === art.title && w.content === art.content
      );
      id = match?.id;
    }
    if (!id) {
      id = workspaceStore.add({
        userId: user?.id ?? null,
        kind,
        title: art.title,
        content: art.content,
        meta: { source: "Artifact" },
      }).id;
    }
    setWorkspaceSelectedId(id);
    setWorkspaceOpen(true);
  };

  const bubbleId = (msg: { id?: string }, i: number) => `chat-${msg.id || i}`;
  const handleSpeak = (msg: { id?: string; content: string }, i: number) => {
    const id = bubbleId(msg, i);
    if (speakingId === id) { stopSpeaking(); return; }
    speak(msg.content, { id });
  };

  const handleSaveApiKey = (key: string) => { saveApiKey(key); setShowSettings(false); };
  const handleAddModel = () => { const m = newModelInput.trim(); if (!m) return; addModel(m); setNewModelInput(""); };

  // ----- Inworld voice management (settings) -----
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

  const selectedBook = books.find((b) => b.id === activeBookId);

  const handleSaveToWiki = async () => {
    if (messages.length < 2) { toast.error("Chat first before saving to wiki"); return; }
    setExtracting(true);
    try {
      const result = await extractKnowledge(messages.map(m => ({ role: m.role, content: m.content })), activeBookId || undefined, activeWikiId);
      const count = result.entries?.length || 0;
      toast.success(`Saved ${count} knowledge ${count === 1 ? "entry" : "entries"} to your wiki`);
    } catch (err: any) {
      toast.error(err.message || "Failed to extract knowledge");
    } finally {
      setExtracting(false);
    }
  };

  // Background Quick Search — runs a lightweight web search in the background
  // and injects the results into the transcript when ready.
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
      workspaceStore.add({
        userId: user?.id ?? null,
        kind: "research",
        title: deriveResearchTitle("", query),
        content: md,
        meta: {
          query,
          citations: result.citations.map((c) => ({ title: c.title, url: c.url, snippet: c.snippet })),
          source: "Quick Search",
        },
      });
    } finally {
      setPendingSearchCount((c) => c - 1);
    }
  }, [burplexityApiToken, injectDisplayMessage, user?.id]);

  const handleDeepWebSearch = async () => {
    const query = input.trim();
    if (!query) { toast.error("Type a query first"); return; }
    if (!burplexityApiToken) { toast.error("Set your Burplexity token in Settings"); return; }
    setDeepSearching(true);
    try {
      const r = await fetch(BURPLEXITY_BOT_ASK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": burplexityApiToken },
        body: JSON.stringify({ query, save_to_wiki: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error || `HTTP ${r.status}`;
        toast.error(isSearchRateLimited(r.status, msg)
          ? "Web search is busy (rate-limited). Try again in a moment."
          : msg);
        return;
      }
      const cites = pickCitations(j);
      let md = `🔎 **Web Search Results for:** "${query}"\n\n`;
      if (j.answer) md += `${j.answer}\n\n`;
      if (cites.length) {
        md += "**Sources:**\n";
        cites.forEach((c, i) => {
          md += `**${i + 1}. ${c.title}**\n${c.url}\n`;
          if (c.snippet) md += `${c.snippet}\n`;
          md += "\n";
        });
      }
      injectDisplayMessage(md);
      // Persist to the durable Workspace so it survives tab switches / reloads.
      workspaceStore.add({
        userId: user?.id ?? null,
        kind: "research",
        title: deriveResearchTitle(j.answer || "", query),
        content: j.answer ? String(j.answer) : md,
        meta: { query, citations: cites, source: "Web Search" },
      });
      setInput("");
    } finally {
      setDeepSearching(false);
    }
  };

  // Audio Digest: summarize the conversation in a chosen format and (when a
  // reply isn't already being spoken) read it aloud.
  const DIGEST_PROMPTS: Record<"brief" | "deep" | "critique", string> = {
    brief: "Give me a concise digest of our conversation so far: key topics covered, any decisions or conclusions reached, important insights, and open questions remaining.",
    deep: "Give me a thorough deep-dive digest of our conversation: break down each topic in detail with its full context and reasoning, the connections between ideas, the decisions reached, and all open questions.",
    critique: "Give me a critical review (critique) of our conversation so far: question the assumptions, point out gaps, weak reasoning, or missing perspectives, and suggest what to reconsider or explore next.",
  };
  const handleDigest = async (format: "brief" | "deep" | "critique") => {
    if (messages.length < 2) { toast.error("Nothing to digest yet"); return; }
    setDigesting(true);
    try {
      const reply = await sendMessage(DIGEST_PROMPTS[format]);
      // Speak it unless a reply is already being spoken (auto-read / hands-free).
      if (reply && reply.trim() && !autoReadReplies && !handsFree.active) {
        speak(reply, { id: `digest-${Date.now()}` });
      }
    } finally {
      setDigesting(false);
    }
  };

  const handleSend = async () => {
    if (isLoading) return; // a reply is streaming — use Stop first
    const text = input.trim();
    if (!text) return;
    if (!apiKey) { toast.error("Please set your OpenRouter API key first"); setShowSettings(true); return; }
    setInput("");
    if (voiceQuickSearch && burplexityApiToken && SEARCH_INTENT_RE.test(text)) {
      runBackgroundSearch(text); // intentionally not awaited
    }
    try { await sendMessage(text); } catch { /* surfaced via toast */ }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col h-full flex-1 min-w-0 relative">
      {/* Settings bar */}
      {showSettings && (
        <>
          {/* Mobile scrim — tap to dismiss the settings sheet */}
          <div
            className="md:hidden fixed inset-0 z-[55] bg-black/50 animate-in fade-in-0"
            aria-hidden
            onClick={() => setShowSettings(false)}
          />
        <div
          ref={settingsPanelRef}
          className="space-y-4 overflow-y-auto overscroll-contain bg-surface-container-low fixed inset-x-0 bottom-0 z-[60] max-h-[88vh] rounded-t-2xl border-t border-outline-variant/10 px-4 pt-2 shadow-2xl max-md:animate-in max-md:slide-in-from-bottom max-md:duration-300 md:static md:z-auto md:max-h-[70vh] md:rounded-none md:border-b md:border-t-0 md:py-4 md:shadow-none"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <div className="sticky top-0 -mx-4 -mt-2 md:-mt-3 px-4 pt-2 pb-2 bg-surface-container-low/95 backdrop-blur-sm z-10">
            {/* Mobile grab handle */}
            <div className="md:hidden mx-auto mb-2 h-1.5 w-10 rounded-full bg-outline-variant/40" aria-hidden />
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant">Settings</span>
              <button
                onClick={() => setShowSettings(false)}
                aria-label="Close settings"
                className="inline-flex items-center justify-center h-10 w-10 md:h-8 md:w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high active:scale-95 transition-all"
              >
                <span className="material-symbols-outlined text-[22px] md:text-[20px]">close</span>
              </button>
            </div>
          </div>

          {/* ── Models & Keys ── */}
          <p className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/70 px-1">Models &amp; Keys</p>
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-3 md:p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">OpenRouter API Key</label>
              <div className="relative">
                <input
                  className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40 transition-all"
                  type="password" placeholder="sk-or-v1-..." defaultValue={apiKey}
                  id="openrouter-key-input"
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveApiKey((e.target as HTMLInputElement).value); }}
                />
                <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">key</span>
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" onClick={() => { const el = document.getElementById("openrouter-key-input") as HTMLInputElement; handleSaveApiKey(el?.value || ""); }}>Save</Button>
                {apiKey && <Button size="sm" variant="destructive" onClick={() => handleSaveApiKey("")}>Remove</Button>}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Burplexity API Token <span className="text-on-surface-variant/60 normal-case tracking-normal">(web search)</span></label>
              <div className="relative">
                <input
                  className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40 transition-all"
                  type="password" placeholder="pp_..." defaultValue={burplexityApiToken}
                  id="burplexity-token-input"
                  onKeyDown={(e) => { if (e.key === "Enter") { setBurplexityApiToken((e.target as HTMLInputElement).value); toast.success("Burplexity token saved"); } }}
                />
                <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">travel_explore</span>
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" onClick={() => { const el = document.getElementById("burplexity-token-input") as HTMLInputElement; setBurplexityApiToken(el?.value || ""); toast.success(el?.value ? "Burplexity token saved" : "Burplexity token removed"); }}>Save</Button>
                {burplexityApiToken && <Button size="sm" variant="destructive" onClick={() => setBurplexityApiToken("")}>Remove</Button>}
              </div>
              <p className="text-[10px] text-on-surface-variant px-1">Enables the live <code>web_search</code> tool. Generate at your Burplexity app → API Keys.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Active Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
              >
                {chatModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <div className="flex gap-2 mt-1">
                <Input type="text" placeholder="provider/model-name" value={newModelInput} onChange={(e) => setNewModelInput(e.target.value)} className="text-sm font-mono bg-surface-container-high border-none" onKeyDown={(e) => { if (e.key === "Enter") handleAddModel(); }} />
                <Button size="sm" onClick={handleAddModel}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {savedModels.map((m) => {
                  const embed = isEmbeddingModel(m);
                  return (
                    <span key={m} title={embed ? "Embedding model — used by Wiki reindex, not Chat" : undefined} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ${m === selectedModel ? "bg-primary-container/20 text-primary border border-primary-container/30" : embed ? "bg-surface-container-highest/50 text-on-surface-variant/60 italic" : "bg-surface-container-highest text-on-surface-variant"}`}>
                      <button onClick={() => { if (embed) { toast.error("Embedding model — pick it in Wiki Settings, not Chat."); return; } setSelectedModel(m); }} className="hover:underline">{m}{embed ? " (embed)" : ""}</button>
                      <button onClick={() => removeModel(m)} className="hover:text-destructive ml-0.5 material-symbols-outlined text-xs">close</button>
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Focus Context</label>
              <div className="flex items-center gap-3 bg-surface-container-high rounded-lg py-2.5 px-4 border border-outline-variant/10">
                <div className="w-2 h-2 rounded-full bg-primary-container shadow-[0_0_8px_rgba(255,191,0,0.4)]" />
                <span className="text-sm font-headline italic text-primary">{selectedBook?.title || "No book selected"}</span>
              </div>
            </div>
          </section>

          {/* ── Research & Search ── */}
          <p className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/70 px-1">Research &amp; Search</p>
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-3 md:p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">science</span>Deep Research Model
              </label>
              <select
                value={deepResearchModel}
                onChange={(e) => setDeepResearchModel(e.target.value)}
                className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
              >
                {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <p className="text-[10px] text-on-surface-variant px-1">Used when Deep Research is ON. Pick a strong reasoning model for best results.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">travel_explore</span>Background Quick Search
              </label>
              <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
                <span className="text-sm text-primary">{voiceQuickSearch ? "On" : "Off"}</span>
                <Switch checked={voiceQuickSearch} onCheckedChange={setVoiceQuickSearch} disabled={!burplexityApiToken} aria-label="Background Quick Search" />
              </div>
              <p className="text-[10px] text-on-surface-variant px-1">
                {burplexityApiToken ? "When a message looks like a search, results are fetched in the background and added to the chat." : "Requires a Burplexity API token above."}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Quick Search Model <span className="text-on-surface-variant/60 normal-case tracking-normal">(lightweight preferred)</span></label>
              <select value={voiceQuickSearchModel || selectedModel} onChange={(e) => setVoiceQuickSearchModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
            </div>
          </section>

          {/* ── Voice (input + output) ── */}
          <p className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/70 px-1">Voice</p>
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-3 md:p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">record_voice_over</span>Auto-read replies
              </label>
              <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
                <span className="text-sm text-primary">{autoReadReplies ? "On — replies will be read aloud" : "Off"}</span>
                <Switch checked={autoReadReplies} onCheckedChange={setAutoReadReplies} aria-label="Auto-read assistant replies" />
              </div>
              <p className="text-[10px] text-on-surface-variant px-1">Reads each new assistant reply aloud using the voice + speed below.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center justify-between">
                <span><span className="material-symbols-outlined text-xs align-middle mr-1">volume_up</span>Voice Playback Speed</span>
                <span className="text-primary normal-case tracking-normal">{ttsRate.toFixed(2)}×</span>
              </label>
              <div className="bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
                <Slider
                  value={[ttsRate]}
                  min={0.5}
                  max={2}
                  step={0.05}
                  onValueChange={(v) => setTtsRate(v[0])}
                />
              </div>
              <p className="text-[10px] text-on-surface-variant px-1">Used for read-aloud buttons and auto-read here.</p>
            </div>
            <div className="flex flex-col gap-1.5 lg:col-span-2">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs align-middle">record_voice_over</span>Inworld Voice (TTS Upgrade)
              </label>
              <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-2.5 px-4">
                <span className="text-sm text-primary">{inworldEnabled ? "Inworld TTS on" : "Browser TTS"}</span>
                <Switch
                  checked={inworldEnabled}
                  onCheckedChange={setInworldEnabled}
                  disabled={!inworldApiKey || !inworldVoiceId}
                  aria-label="Enable Inworld TTS"
                />
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
                    Save &amp; Load Voices
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
                      onChange={(e) => setInworldVoiceId(e.target.value)}
                      className="flex-1 bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
                    >
                      {inworldVoices.map((v) => (
                        <option key={v.voice_id} value={v.voice_id}>
                          {v.name}{v.tags?.length ? ` (${v.tags.join(", ")})` : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Button size="sm" variant="outline" onClick={loadInworldVoices}>
                      Retry loading voices
                    </Button>
                  )}
                  {inworldVoices.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={testInworldVoice}
                      disabled={testingVoice || !inworldVoiceId}
                      title="Play a short test phrase with the selected voice"
                    >
                      {testingVoice ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test voice"}
                    </Button>
                  )}
                </div>
              )}
              <p className="text-[10px] text-on-surface-variant px-1">
                When enabled, read-aloud uses an Inworld character voice instead of the browser&apos;s built-in TTS. Use <em>Test voice</em> to confirm the key and voice work.
              </p>
            </div>
            <div className="flex flex-col gap-1.5 lg:col-span-2">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">bolt</span>Voice Model <span className="text-on-surface-variant/60 normal-case tracking-normal">(reserved for spoken replies / hands-free)</span>
              </label>
              <select value={voiceModel || ""} onChange={(e) => setVoiceModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                <option value="">Same as Active model</option>
                {savedModels.map((m: string) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <p className="text-[10px] text-on-surface-variant px-1">Pick a fast model (e.g. <code>google/gemini-2.5-flash-lite</code>) for snappier spoken replies. Used by hands-free voice.</p>
            </div>
            <div className="flex flex-col gap-1.5 lg:col-span-2">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">front_hand</span>Barge-in (interrupt the assistant)
              </label>
              <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
                <span className="text-sm text-primary">{bargeInEnabled ? "On — talk over replies to interrupt" : "Off — turn-based (no echo)"}</span>
                <Switch checked={bargeInEnabled} onCheckedChange={setBargeInEnabled} aria-label="Enable barge-in" />
              </div>
              <p className="text-[10px] text-on-surface-variant px-1">When on, hands-free keeps listening while the assistant speaks and stops it the moment you start talking (uses on-device voice detection). Headphones give the most reliable results. When off, the mic is closed during playback to avoid echo.</p>
            </div>
          </section>

          {/* ── Prompts ── */}
          <p className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/70 px-1">Prompts</p>
          <PromptLibrary scopeHint="chat" />
          <section className="p-3 md:p-4 rounded-xl bg-surface-container-low">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center gap-1">
              <span className="material-symbols-outlined text-xs align-middle">history_edu</span>Legacy Custom Instructions
            </label>
            <p className="text-[10px] text-on-surface-variant px-1 mt-1 mb-2">Used only if no prompt above is active. Prefer the Prompt Library for new prompts.</p>
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
        </>
      )}

      {/* Active-wiki indicator */}
      {activeWiki && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2 text-xs font-body text-on-surface-variant">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: activeWiki.cover_color || "#7C3AED" }}
            aria-hidden
          />
          <span>
            Your Knowledge Wiki: <span className="font-semibold text-primary">{activeWiki.name}</span>
          </span>
        </div>
      )}

      {/* Selection → save to notes */}
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

      {/* Screen-reader live region: debounced, incremental assistant text */}
      <div className="sr-only" aria-live="polite" aria-atomic="false">{srAnnounce}</div>

      {/* Messages */}
      <div className="flex-1 relative overflow-hidden">
        <video
          src={counselBgVideo}
          autoPlay
          loop
          muted
          playsInline
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover opacity-25 pointer-events-none"
        />
        <div className="absolute inset-0 bg-background/50 pointer-events-none" aria-hidden />
        <div ref={messagesContainerRef} role="log" aria-label="Conversation with The Librarian" aria-live="off" className="relative h-full overflow-auto px-4 py-6 space-y-6 hide-scrollbar">

        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-on-surface-variant gap-3">
            <span className="material-symbols-outlined text-5xl text-primary-container">auto_stories</span>
            <p className="font-headline font-bold text-lg text-foreground">The Librarian</p>
            <p className="text-sm text-center max-w-md">
              {selectedBook
                ? `Ready to discuss "${selectedBook.title}". ${selectedBook.chapters.length > 0 ? `${selectedBook.chapters.length} chapter(s) loaded.` : "No chapters isolated yet."}`
                : "Select a book in Read, then come here to counsel with the AI about it."}
            </p>
            {!apiKey && loaded && (
              <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-lg text-primary text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
                <span className="material-symbols-outlined text-sm">key</span> Set API Key
              </button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={msg.id || i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[85%] ${msg.role === "user" ? "self-end" : ""} group`}>
            <div className="flex items-center gap-2 mb-2 mx-4">
              {msg.role === "assistant" && <span className="material-symbols-outlined text-primary-container text-lg">auto_stories</span>}
              <span className={`font-headline font-bold text-sm tracking-wide ${msg.role === "user" ? "text-primary" : "text-secondary"}`}>
                {msg.role === "user" ? "You" : "The Librarian"}
              </span>
              {msg.role === "user" && <span className="material-symbols-outlined text-primary text-lg">person</span>}
            </div>
            {msg.role === "assistant" && msg.toolEvents && msg.toolEvents.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2 ml-4">
                {msg.toolEvents.map((ev, idx) => (
                  <span key={idx} className={`text-[11px] px-2 py-1 rounded-md ${ev.ok ? "bg-secondary-container/40 text-on-secondary-container" : "bg-destructive/15 text-destructive"}`}>
                    <span className="material-symbols-outlined text-xs align-middle mr-1">{ev.ok ? "build" : "error"}</span>{ev.summary}
                  </span>
                ))}
              </div>
            )}
            <div
              className={`relative group ${msg.role === "user" ? "message-bubble-user bg-primary-container text-on-primary-container" : "message-bubble-ai bg-surface-container-high text-foreground border-l-2 border-primary-container/20"} p-5 shadow-sm leading-relaxed select-text`}
              style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
              onTouchStart={() => startLongPress(msg.content)}
              onTouchEnd={(e) => { if (longPressFiredRef.current) { e.preventDefault(); } cancelLongPress(); }}
              onTouchMove={cancelLongPress}
              onTouchCancel={cancelLongPress}
              onContextMenu={(e) => { if (longPressFiredRef.current) e.preventDefault(); }}
            >
              {msg.role === "assistant" ? (
                <>
                  {msg.content && <div className="prose prose-sm prose-invert max-w-none"><ReactMarkdown>{msg.content}</ReactMarkdown></div>}
                  {msg.blocks && msg.blocks.length > 0 && <ResponseBlocks blocks={msg.blocks} />}
                  {msg.artifact && (
                    <button
                      onClick={() => openArtifactInWorkspace(msg)}
                      className="flex items-center gap-3 w-full text-left rounded-xl bg-surface-container-high/60 border border-outline-variant/20 p-3 hover:border-primary-container/50 transition-colors mt-1"
                    >
                      <span className="material-symbols-outlined text-primary-container text-2xl">deployed_code</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-foreground truncate">{msg.artifact.title}</div>
                        <div className="text-xs text-on-surface-variant">{msg.artifact.kind.toUpperCase()} artifact · tap to open</div>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant">open_in_full</span>
                    </button>
                  )}
                </>
              ) : (
                <p className="whitespace-pre-wrap font-medium">{msg.content}</p>
              )}
              {msg.content && (
                <button
                  onClick={() => handleSpeak(msg, i)}
                  title={speakingId === bubbleId(msg, i) ? "Stop reading" : "Read aloud"}
                  className={`absolute top-1/2 -translate-y-1/2 ${msg.role === "user" ? "-left-3" : "-right-3"} w-7 h-7 rounded-full bg-surface-container-highest border border-outline-variant/20 shadow-sm flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all opacity-70 hover:opacity-100`}
                >
                  <span className="material-symbols-outlined text-base">
                    {speakingId === bubbleId(msg, i) ? "stop_circle" : "volume_up"}
                  </span>
                </button>
              )}
              <button
                onClick={() => saveBubbleToNotes(msg.content)}
                className="hidden md:flex absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity items-center justify-center w-7 h-7 rounded-full bg-surface-container-highest text-on-surface-variant hover:text-primary shadow-md"
                title="Save to notes"
                aria-label="Save to notes"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex flex-col items-start max-w-[85%]">
            <div className="flex items-center gap-2 mb-2 ml-4">
              <span className="material-symbols-outlined text-primary-container text-lg">auto_stories</span>
              <span className="font-headline font-bold text-sm text-secondary">The Librarian</span>
            </div>
            <div className="message-bubble-ai bg-surface-container-high p-5 shadow-sm flex items-center gap-2 italic text-on-surface-variant">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "75ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "150ms" }} />
              </div>
              Consulting annotations...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="px-4 pb-4 pt-2">
        <div className="bg-surface-container-low/90 backdrop-blur-xl p-3 rounded-2xl shadow-2xl border border-outline-variant/10 flex flex-col gap-3 max-w-4xl mx-auto">
          {handsFree.active && (
            <div className="flex items-center gap-2 px-2 text-xs text-on-surface-variant">
              <span className={`material-symbols-outlined text-base ${handsFree.state === "listening" ? "text-destructive animate-pulse" : "text-primary-container"}`}>
                {handsFree.state === "listening" ? "mic" : handsFree.state === "thinking" ? "more_horiz" : handsFree.state === "speaking" ? "graphic_eq" : "record_voice_over"}
              </span>
              <span className="font-medium">
                {handsFree.state === "listening" ? "Listening — just talk" : handsFree.state === "thinking" ? "Thinking…" : handsFree.state === "speaking" ? "Speaking…" : "Hands-free on"}
              </span>
              {handsFree.interim && <span className="italic truncate">“{handsFree.interim}”</span>}
              <button onClick={handsFree.stop} className="ml-auto text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Stop</button>
            </div>
          )}
          <div className="flex items-end gap-3">
            <div className="flex-grow relative">
              <Textarea
                ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                aria-label="Message The Librarian"
                placeholder={dictation.isListening ? "Listening… speak now" : apiKey ? "Ask about your books..." : "Set your OpenRouter API key to start chatting"}
                rows={1} className="bg-surface-container-high border-none rounded-xl text-foreground py-3 pl-4 pr-20 focus:ring-1 focus:ring-primary/40 resize-none min-h-[50px] max-h-[220px] overflow-y-auto"
              />
              {dictation.supported && (
                <button
                  type="button"
                  onClick={handleMicToggle}
                  title={dictation.isListening ? "Stop dictation" : "Dictate message"}
                  aria-label={dictation.isListening ? "Stop dictation" : "Dictate message"}
                  className={`absolute right-11 bottom-2 p-1.5 rounded-lg transition-all active:scale-90 ${dictation.isListening ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-surface-container-highest text-on-surface-variant hover:text-primary"}`}
                >
                  <span className="material-symbols-outlined text-lg" style={dictation.isListening ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                    {dictation.isListening ? "mic_off" : "mic"}
                  </span>
                </button>
              )}
              {isLoading ? (
                <button
                  onClick={() => abort()}
                  title="Stop generating"
                  aria-label="Stop generating"
                  className="absolute right-2 bottom-2 p-1.5 bg-destructive text-destructive-foreground rounded-lg hover:brightness-110 active:scale-90 transition-all"
                >
                  <span className="material-symbols-outlined text-lg">stop</span>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  title="Send"
                  aria-label="Send"
                  className="absolute right-2 bottom-2 p-1.5 bg-primary-container text-on-primary-container rounded-lg hover:brightness-110 active:scale-90 transition-all disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-lg">send</span>
                </button>
              )}
            </div>
            {messages.length >= 2 && (
              <button
                onClick={handleSaveToWiki}
                disabled={extracting}
                aria-label="Save to Wiki"
                title="Save to Wiki"
                className="h-[50px] px-3 sm:px-5 bg-secondary-container text-on-secondary-container rounded-xl flex items-center gap-2 hover:bg-secondary-container/80 transition-all active:scale-95 border border-outline-variant/20 shrink-0"
              >
                {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="material-symbols-outlined text-lg">history_edu</span>}
                <span className="hidden sm:inline text-sm font-semibold whitespace-nowrap">Save to Wiki</span>
              </button>
            )}
          </div>
          <div className="flex justify-between items-center px-2">
            <div className="flex items-center gap-4 flex-nowrap overflow-x-auto hide-scrollbar snap-x flex-1 min-w-0 [&>*]:shrink-0 [&>*]:snap-start [&>*]:min-h-[40px] md:flex-wrap md:overflow-visible md:[&>*]:min-h-0">
              <button onClick={() => setChatDeepResearch(!chatDeepResearch)} className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${chatDeepResearch ? "text-primary-container" : "text-on-surface-variant hover:text-primary"}`}>
                <span className="material-symbols-outlined text-sm" style={chatDeepResearch ? { fontVariationSettings: "'FILL' 1" } : {}}>science</span> Deep Research {chatDeepResearch ? "ON" : "OFF"}
              </button>
              <button onClick={() => { if (autoReadReplies) stopSpeaking(); setAutoReadReplies(!autoReadReplies); }} className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${autoReadReplies ? "text-primary-container" : "text-on-surface-variant hover:text-primary"}`} title="Read replies aloud">
                <span className="material-symbols-outlined text-sm" style={autoReadReplies ? { fontVariationSettings: "'FILL' 1" } : {}}>{autoReadReplies ? "volume_up" : "volume_off"}</span> Read Aloud {autoReadReplies ? "ON" : "OFF"}
              </button>
              {handsFree.supported && (
                <button onClick={handsFree.toggle} aria-pressed={handsFree.active} className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${handsFree.active ? "text-primary-container" : "text-on-surface-variant hover:text-primary"}`} title="Hands-free conversation — just talk">
                  <span className="material-symbols-outlined text-sm" style={handsFree.active ? { fontVariationSettings: "'FILL' 1" } : {}}>{handsFree.active ? "graphic_eq" : "record_voice_over"}</span> Hands-free {handsFree.active ? "ON" : "OFF"}
                </button>
              )}
              {burplexityApiToken && (
                <button
                  onClick={handleDeepWebSearch}
                  disabled={deepSearching || !input.trim() || isLoading}
                  className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-primary transition-colors disabled:opacity-40"
                  title="Run a one-shot web search on the current input"
                >
                  {deepSearching ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="material-symbols-outlined text-sm">travel_explore</span>} Web Search
                </button>
              )}
              {pendingSearchCount > 0 && (
                <span className="text-[10px] font-bold uppercase tracking-widest text-primary-container flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Searching ({pendingSearchCount})
                </span>
              )}
              {messages.length >= 2 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      disabled={digesting || isLoading}
                      className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-primary transition-colors disabled:opacity-40"
                      title="Digest this conversation (read aloud)"
                    >
                      {digesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="material-symbols-outlined text-sm">summarize</span>} Digest
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[160px]">
                    <DropdownMenuItem onClick={() => handleDigest("brief")}>
                      <span className="material-symbols-outlined text-base mr-2">short_text</span> Brief
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDigest("deep")}>
                      <span className="material-symbols-outlined text-base mr-2">menu_book</span> Deep dive
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDigest("critique")}>
                      <span className="material-symbols-outlined text-base mr-2">rate_review</span> Critique
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button
                onClick={() => setWorkspaceOpen((v) => !v)}
                aria-pressed={workspaceOpen}
                className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${workspaceOpen ? "text-primary-container" : "text-on-surface-variant hover:text-primary"}`}
                title="Workspace — saved files & research"
              >
                <span className="material-symbols-outlined text-sm" style={workspaceOpen ? { fontVariationSettings: "'FILL' 1" } : {}}>folder_open</span>
                Files{workspaceCount > 0 ? ` (${workspaceCount})` : ""}
              </button>
              <button
                onClick={() => setNotesPanelOpen((v) => !v)}
                aria-pressed={notesPanelOpen}
                className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${notesPanelOpen ? "text-primary-container" : "text-on-surface-variant hover:text-primary"}`}
                title="Notes"
              >
                <StickyNote className="w-3.5 h-3.5" /> Notes
              </button>
              <button id="chat-settings-toggle" onClick={() => setShowSettings(!showSettings)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-primary transition-colors">
                <span className="material-symbols-outlined text-sm">tune</span> Settings
              </button>
              {messages.length > 0 && (
                <button onClick={() => { stopSpeaking(); clearChat(); }} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined text-sm">delete</span> Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* Desktop: persistent right-side Workspace column */}
      {!isMobile && workspaceOpen && (
        <div className="flex h-full shrink-0 w-[360px] lg:w-[420px]">
          <WorkspacePanel
            userId={user?.id ?? null}
            onClose={() => setWorkspaceOpen(false)}
            selectedId={workspaceSelectedId}
            onSelect={setWorkspaceSelectedId}
          />
        </div>
      )}

      {/* Mobile: Workspace opens as a right-side sheet */}
      {isMobile && (
        <Sheet open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
          <SheetContent side="right" className="w-full sm:max-w-md p-0">
            <WorkspacePanel
              userId={user?.id ?? null}
              onClose={() => setWorkspaceOpen(false)}
              selectedId={workspaceSelectedId}
              onSelect={setWorkspaceSelectedId}
            />
          </SheetContent>
        </Sheet>
      )}

      <VoiceNotesPanel open={notesPanelOpen} onClose={() => setNotesPanelOpen(false)} />
    </div>
  );
};

export default ChatPanel;
