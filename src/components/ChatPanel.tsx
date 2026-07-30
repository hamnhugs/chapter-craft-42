import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { safeUrlTransform, safeMarkdownComponents } from "@/lib/markdownSafety";
import { focusComposer, isTouchPrimary } from "@/lib/focusPolicy";
import PocketScreen from "@/components/PocketScreen";
import { LensImageFrame, MemoryChips } from "@/components/MemoryLensStrip";
import ToolApprovalCard from "@/components/ToolApprovalCard";
import { extractKnowledge } from "@/lib/knowledgeApi";
import { Loader2, StickyNote, BookmarkPlus } from "lucide-react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { useReadAloud } from "@/hooks/useReadAloud";
import { useHandsFree } from "@/hooks/useHandsFree";
import { isEmbeddingModel } from "@/lib/utils";
import { useDictation } from "@/hooks/useDictation";
import { requestSettingsSection } from "@/lib/settingsNav";
import VoiceNotesPanel, { appendVoiceNote } from "@/components/VoiceNotesPanel";
import ResponseBlocks from "@/components/ResponseBlocks";
import GeneratedImage from "@/components/GeneratedImage";
import VideoBubble from "@/components/VideoBubble";
import SplatBubble from "@/components/SplatBubble";
import MediaReveal from "@/components/MediaReveal";
import WorkingMemoryPanel from "@/components/WorkingMemoryPanel";
import WorkspacePanel from "@/components/WorkspacePanel";
import type { Artifact } from "@/lib/artifacts";
import { workspaceStore, deriveResearchTitle, useWorkspaceItems } from "@/lib/workspaceStore";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { executeQuickSearch, BURPLEXITY_BOT_ASK_URL, pickCitations, isSearchRateLimited } from "@/lib/chatTools";
import { useDownloadableTtsId, downloadTtsAudio } from "@/lib/ttsAudioCache";
import { fileToDownscaledDataUrl, isAcceptedImage, uploadChatImage, registerUploadedImage, removeUploadedChatImage, type PendingChatImage } from "@/lib/imageUpload";


const VOICE_QUICK_SEARCH_KEY = "voice_quick_search";

const SEARCH_INTENT_RE =
  /\b(search|look up|look for|find|google|what is|what are|who is|who are|tell me about|research|check online|latest|current|news about)\b/i;

const ChatPanel: React.FC = () => {
  const { books, activeBookId, activeWiki, activeWikiId, activeWikis, activeWikiIds, toggleNeuronInSession, setActiveTab } = useApp();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const {
    apiKey, savedModels, selectedModel, voiceModel, autoReadReplies, burplexityApiToken, accessAllNeurons, loaded,
    handsFreeTtsRate,
    setSelectedModel, setAutoReadReplies,
  } = useChatSettings();
  const { messages, isLoading, chatDeepResearch, setChatDeepResearch, sendMessage, injectDisplayMessage, clearChat, abort, loadEarlier, hasEarlier, loadingEarlier } = useChat();
  const { isPaid } = usePlan();
  const { speakingId, speak, stop: stopSpeaking, pause: pauseSpeaking, resume: resumeSpeaking, isAudioActive } = useReadAloud();
  // Configured in the Settings tab; re-read here on mount (tab switches remount this panel).
  const [bargeInEnabled] = useState(() => localStorage.getItem("hands_free_barge_in") === "true");
  const handsFree = useHandsFree({
    onUtterance: (text) => sendMessage(text, { voiceMode: true, modelOverride: voiceModel || undefined }),
    // Hands-free has its own speech speed (read-aloud buttons keep ttsRate).
    speak: (text, opts) => speak(text, { ...opts, rate: handsFreeTtsRate || undefined }),
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,
    isAudioActive,
    bargeIn: bargeInEnabled,
  });

  // Draft survives tab switches (e.g. a trip to Settings unmounts this panel —
  // the old in-place settings sheet never did, so losing the draft here would
  // be a regression). sessionStorage: per-tab, cleared when the browser closes.
  const [input, setInput] = useState(() => sessionStorage.getItem("counsel_draft") || "");
  useEffect(() => {
    try { sessionStorage.setItem("counsel_draft", input); } catch { /* quota — drop */ }
  }, [input]);
  // Pending image attachments for the next send (composer-local).
  const [pendingImages, setPendingImages] = useState<PendingChatImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Storage uploads start at ATTACH time (standard chat-app pattern) so the
  // file is usually already durable by the time the user hits send. Keyed by
  // the pending image's localId; send awaits any still in flight.
  const uploadsRef = useRef(new Map<string, Promise<{ storagePath: string }>>());
  // Guards the window between hitting send and sendMessage() flipping
  // isLoading — awaiting upload registration opened a gap where a second
  // Enter could start a concurrent stream and corrupt both bubbles.
  const sendingRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);

  // Chips never sent die with the composer (pendingImages is component
  // state, lost on tab switch) — remove their eagerly-uploaded files too.
  // handleSend takes its images' promises OUT of the map first, so files
  // belonging to an in-flight send are never touched here.
  useEffect(() => () => {
    for (const up of uploadsRef.current.values()) {
      void up.then(({ storagePath }) => removeUploadedChatImage(storagePath)).catch(() => {});
    }
    uploadsRef.current.clear();
  }, []);

  const addImagesFromFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files).filter(isAcceptedImage);
    if (!arr.length) return;
    const room = Math.max(0, 4 - pendingImages.length);
    if (room === 0) { toast.error("Max 4 images per message"); return; }
    const slice = arr.slice(0, room);
    if (arr.length > room) toast.info(`Only the first ${room} image(s) were added (max 4)`);
    for (const file of slice) {
      try {
        const { dataUrl, mime, width, height } = await fileToDownscaledDataUrl(file);
        const localId = crypto.randomUUID();
        setPendingImages((prev) => [...prev, { localId, dataUrl, mime, width, height, filename: (file as File).name }]);
        const up = uploadChatImage(dataUrl, mime);
        up.catch(() => {}); // send retries — keep the rejection off the unhandled channel
        uploadsRef.current.set(localId, up);
      } catch (e: any) {
        toast.error(e?.message || "Could not load image");
      }
    }
  }, [pendingImages.length]);

  const removePendingImage = useCallback((localId: string) => {
    setPendingImages((prev) => prev.filter((p) => p.localId !== localId));
    // The chip was never sent — clean up the eagerly-uploaded file.
    const up = uploadsRef.current.get(localId);
    uploadsRef.current.delete(localId);
    if (up) void up.then(({ storagePath }) => removeUploadedChatImage(storagePath)).catch(() => {});
  }, []);
  const [extracting, setExtracting] = useState(false);
  const [deepSearching, setDeepSearching] = useState(false);
  const [digesting, setDigesting] = useState(false);

  // ---- Voice features absorbed from the former Echo (Voice) tab ----
  const [notesPanelOpen, setNotesPanelOpen] = useState(false);
  // Configured in the Settings tab; read-only here.
  const [voiceQuickSearch] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_KEY) === "true");
  const [pendingSearchCount, setPendingSearchCount] = useState(0);
  const [selectionCapture, setSelectionCapture] = useState<{ text: string; top: number; left: number } | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => localStorage.getItem("counsel_workspace_open") === "1");
  const [workspaceSelectedId, setWorkspaceSelectedId] = useState<string | null>(null);
  const workspaceItems = useWorkspaceItems();
  const workspaceCount = workspaceItems.filter((i) => i.userId == null || i.userId === user?.id).length;
  useEffect(() => { localStorage.setItem("counsel_workspace_open", workspaceOpen ? "1" : "0"); }, [workspaceOpen]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputBeforeDictationRef = useRef<string>("");
  // When a message is sent we stop the mic and ignore the recognizer's trailing
  // final callback, so it can't repopulate the just-cleared composer.
  const suppressDictationRef = useRef(false);

  const dictation = useDictation({
    onInterim: (text) => {
      if (suppressDictationRef.current) return;
      setInput((inputBeforeDictationRef.current ? inputBeforeDictationRef.current + " " : "") + text);
    },
    onFinal: (text) => {
      if (suppressDictationRef.current) return;
      const base = inputBeforeDictationRef.current;
      setInput((base ? base + " " : "") + text);
    },
  });
  const handleMicToggle = () => {
    if (!dictation.supported) { toast.error("Voice input not supported in this browser."); return; }
    if (dictation.isListening) { dictation.stop(); return; }
    inputBeforeDictationRef.current = input;
    suppressDictationRef.current = false;
    dictation.start();
  };

  // Auto-scroll only when the TAIL of the conversation changes (a new message
  // appended, or the streaming reply growing) — never when older history is
  // prepended by "Load earlier", which must keep the view where it is.
  const tailAnchorRef = useRef<{ key?: string; content?: string; role?: string }>({});
  useEffect(() => {
    const last = messages[messages.length - 1];
    const prev = tailAnchorRef.current;
    const changed = !!last && (last.id !== prev.key || last.role !== prev.role || last.content !== prev.content);
    tailAnchorRef.current = { key: last?.id, content: last?.content, role: last?.role };
    if (changed) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Prepending shifts content down; compensate manually (and predictably —
  // Safari has no native scroll anchoring, so the container opts out of it
  // everywhere rather than double-adjusting only in Chrome). The adjustment
  // runs in a LAYOUT effect on the commit whose first message changed: a
  // requestAnimationFrame after the await could fire before React commits
  // the prepend and measure a stale scrollHeight.
  const scrollAdjustRef = useRef<{ top: number; height: number } | null>(null);
  const prevFirstIdRef = useRef<string | undefined>(undefined);
  const handleLoadEarlier = useCallback(async () => {
    const el = messagesContainerRef.current;
    scrollAdjustRef.current = el ? { top: el.scrollTop, height: el.scrollHeight } : null;
    const prepended = await loadEarlier();
    if (prepended === 0) scrollAdjustRef.current = null;
  }, [loadEarlier]);
  useLayoutEffect(() => {
    const firstId = messages[0]?.id;
    const firstChanged = firstId !== prevFirstIdRef.current;
    prevFirstIdRef.current = firstId;
    const saved = scrollAdjustRef.current;
    if (!saved || !firstChanged) return;
    scrollAdjustRef.current = null;
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = saved.top + (el.scrollHeight - saved.height);
  }, [messages]);

  // Autogrow the composer up to ~10 lines, then scroll internally.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  // Desktop-only composer refocus after a reply finishes — and only when it
  // cannot steal: the user sent from the composer area, nothing else has been
  // focused since, no text selection is active, and they haven't just been
  // scrolling the transcript. On touch devices this NEVER fires: Android
  // Chrome opens the soft keyboard on any programmatic focus() once the
  // session has seen a gesture (the old line here popped the keyboard after
  // every AI reply — the exact bug this replaces).
  const prevLoadingRef = useRef(false);
  const wasFocusedAtSendRef = useRef(false);
  const lastTranscriptInteractionRef = useRef(0);
  useEffect(() => {
    const wasStreaming = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;
    if (!wasStreaming || isLoading) return;
    if (!wasFocusedAtSendRef.current) return;
    wasFocusedAtSendRef.current = false;
    if (isTouchPrimary() || handsFree.active || document.hidden) return;
    const ae = document.activeElement;
    if (ae !== document.body && ae !== inputRef.current) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (Date.now() - lastTranscriptInteractionRef.current < 3000) return;
    focusComposer(inputRef.current, { handsFreeActive: handsFree.active });
  }, [isLoading, handsFree.active]);

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
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const id = last.id || `chat-${messages.length - 1}`;
    if (autoReadRef.current.lastId === id) return;
    if (!last.content || !last.content.trim()) return;
    // Mark the reply consumed UNCONDITIONALLY — before the hands-free guard.
    // Recording lastId only when this effect spoke meant a reply spoken BY
    // hands-free was never marked, so toggling hands-free off re-ran this
    // effect (handsFree.active is a dependency) and re-spoke the whole reply
    // from sentence one.
    autoReadRef.current.lastId = id;
    if (handsFree.active) return; // hands-free speaks replies itself — don't double up
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

  // Id of the message whose Inworld audio finished playing and is held in
  // memory — its bubble shows a download button (saving costs no API credits).
  const downloadableTtsId = useDownloadableTtsId();
  const handleDownloadAudio = (msg: { id?: string; content: string }, i: number) => {
    if (!downloadTtsAudio(bubbleId(msg, i), msg.content)) {
      toast.error("Audio is no longer available — play the message again first");
    }
  };

  // Navigate to the consolidated Settings tab, optionally landing on a section.
  const openSettings = (section?: string) => {
    if (section) requestSettingsSection(section);
    setActiveTab("settings");
  };

  const selectedBook = books.find((b) => b.id === activeBookId);

  const handleSaveToWiki = async () => {
    if (messages.length < 2) { toast.error("Chat first before saving to neuron"); return; }
    setExtracting(true);
    try {
      const result = await extractKnowledge(messages.map(m => ({ role: m.role, content: m.content })), activeBookId || undefined, activeWikiId);
      const entries: any[] = result.entries || [];
      const added = entries.filter((e) => e.action === "ADDED");
      const updated = entries.filter((e) => e.action === "UPDATED");
      const skipped = entries.filter((e) => e.action === "SKIPPED_DUPLICATE");
      if (added.length === 0 && updated.length === 0) {
        toast.info(skipped.length > 0 ? "Already remembered — nothing new to save" : "Nothing new to remember from this chat");
      } else {
        const names = [...added, ...updated].map((e) => e.title).filter(Boolean);
        const parts: string[] = [];
        if (added.length) parts.push(`${added.length} new`);
        if (updated.length) parts.push(`${updated.length} updated`);
        if (skipped.length) parts.push(`${skipped.length} duplicate${skipped.length === 1 ? "" : "s"} skipped`);
        toast.success(`Memory updated — ${parts.join(", ")}`, {
          description: names.slice(0, 3).join(" · ") + (names.length > 3 ? ` · +${names.length - 3} more` : ""),
        });
      }
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
      const reply = await sendMessage(DIGEST_PROMPTS[format], { capExempt: true });
      // Speak it unless a reply is already being spoken (auto-read / hands-free).
      if (reply && reply.trim() && !autoReadReplies && !handsFree.active) {
        speak(reply, { id: `digest-${Date.now()}` });
      }
    } finally {
      setDigesting(false);
    }
  };

  const handleSend = async () => {
    if (isLoading || sendingRef.current) return; // a reply is streaming — use Stop first
    const text = input.trim();
    const imagesToSend = pendingImages;
    if (!text && imagesToSend.length === 0) return;
    if (!apiKey) { toast.error("Please set your OpenRouter API key first"); openSettings("models"); return; }
    sendingRef.current = true;
    // Desktop refocus eligibility: this send came from the composer area
    // (Enter or the send button). Touch devices never refocus.
    wasFocusedAtSendRef.current = !isTouchPrimary() && !handsFree.active;
    try {
      suppressDictationRef.current = true;
      dictation.stop();
      setInput("");
      setPendingImages([]);
      if (voiceQuickSearch && burplexityApiToken && SEARCH_INTENT_RE.test(text)) {
        runBackgroundSearch(text); // intentionally not awaited
      }
      // Take ownership of the attach-time upload promises: the unmount
      // cleanup must never remove a file this send is about to reference.
      const ownedUploads = new Map<string, Promise<{ storagePath: string }> | undefined>();
      for (const p of imagesToSend) {
        ownedUploads.set(p.localId, uploadsRef.current.get(p.localId));
        uploadsRef.current.delete(p.localId);
      }
      // Finish each image's upload (started at attach time), then register it as
      // a FIRST-CLASS library image: an image_attachments row whose image_id the
      // assistant can act on (edit_image / generate_video / generate_splat /
      // lock_master_asset / save_image_to_memory / delete_image) plus an
      // image_memories row for caption/OCR recall. Degrades to vision-only pixels
      // if storage fails, so the send never blocks on infrastructure trouble.
      const imagesForModel = await Promise.all(
        imagesToSend.map(async (p) => {
          let storagePath: string | null = null;
          try {
            try {
              ({ storagePath } = await (ownedUploads.get(p.localId) ?? uploadChatImage(p.dataUrl, p.mime)));
            } catch {
              // Attach-time upload failed (e.g. transient network) — one fresh retry.
              ({ storagePath } = await uploadChatImage(p.dataUrl, p.mime));
            }
            const { ref, memoryId } = await registerUploadedImage({
              storagePath,
              mime: p.mime,
              filename: p.filename,
              width: p.width,
              height: p.height,
              wikiId: activeWikiId || null,
            });
            return { dataUrl: p.dataUrl, mime: p.mime, ref, memoryId: memoryId || undefined };
          } catch (e: any) {
            console.warn("[image upload]", e?.message || e);
            // Registration failed after the file landed — don't leave an orphan.
            if (storagePath) void removeUploadedChatImage(storagePath);
            return { dataUrl: p.dataUrl, mime: p.mime };
          }
        })
      );
      if (imagesForModel.some((i) => !("ref" in i) || !i.ref)) {
        toast.warning("An image couldn't be saved to your library — the AI can see it this turn, but won't be able to edit or reuse it later.");
      }
      try {
        await sendMessage(text || "(see attached image)", { images: imagesForModel });
      } catch { /* surfaced via toast */ }
    } finally {
      sendingRef.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f && isAcceptedImage(f)) files.push(f);
      }
    }
    if (files.length > 0) { e.preventDefault(); addImagesFromFiles(files); }
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col h-full flex-1 min-w-0 relative">
      {/* Active-book indicator — confirms to the user (and signals that the AI
          knows) which book Counsel is currently focused on. */}
      {selectedBook && (
        <div className="px-4 pt-3 pb-0.5 flex items-center gap-2 text-xs font-body text-on-surface-variant">
          <span className="material-symbols-outlined text-sm text-primary-container" aria-hidden>
            auto_stories
          </span>
          <span className="truncate">
            Now discussing: <span className="font-semibold text-primary">{selectedBook.title}</span>
          </span>
        </div>
      )}

      {/* Loaded-neuron chips — the set Counsel reads from. Secondary chips
          can be unloaded inline; "+" opens the ⌘K switcher; 2+ loaded shows
          a save-as-chain affordance (Linear-style: save at point of use). */}
      {activeWikis.length > 0 && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-1.5 flex-wrap text-xs font-body text-on-surface-variant">
          <span className="mr-0.5">
            {activeWikis.length > 1 ? "Loaded neurons:" : "Your Knowledge Neuron:"}
          </span>
          {activeWikis.map((w, i) => (
            <span
              key={w.id}
              className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full bg-surface-container-high border border-outline-variant/20 max-w-[160px]"
              title={i === 0 ? `${w.name} — primary (new knowledge is saved here)` : w.name}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: w.cover_color || "#7C3AED" }}
                aria-hidden
              />
              <span className="font-semibold text-primary truncate">{w.name}</span>
              {i === 0 && activeWikis.length > 1 && (
                <span className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant">primary</span>
              )}
              {i > 0 && (
                <button
                  onClick={() => toggleNeuronInSession(w.id).catch((e: any) => toast.error(e.message || "Couldn't unload"))}
                  className="rounded-full hover:bg-surface-container-highest p-0.5 leading-none"
                  title={`Unload "${w.name}"`}
                  aria-label={`Unload ${w.name}`}
                >
                  <span className="material-symbols-outlined text-[12px] block">close</span>
                </button>
              )}
            </span>
          ))}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("open-neuron-switcher"))}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-dashed border-outline-variant/40 hover:border-primary/50 hover:text-primary transition-colors"
            title="Load another neuron alongside (⌘K)"
          >
            <span className="material-symbols-outlined text-[14px]">add</span>
          </button>
          {activeWikis.length >= 2 && (
            <button
              onClick={() => import("@/components/ChainDialog").then((m) => m.openChainDialog({ prefillIds: activeWikiIds }))}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-outline-variant/40 hover:border-primary/50 hover:text-primary transition-colors"
              title="Save these neurons as a chain"
            >
              <span className="material-symbols-outlined text-[14px]">link</span>
              <span className="text-[10px] font-bold uppercase tracking-widest">Save chain</span>
            </button>
          )}
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
      <div className="flex-1 overflow-hidden">
        <div ref={messagesContainerRef} role="log" aria-label="Conversation with The Librarian" aria-live="off" onScroll={() => { lastTranscriptInteractionRef.current = Date.now(); }} onPointerDown={() => { lastTranscriptInteractionRef.current = Date.now(); }} className="h-full overflow-auto px-4 py-6 space-y-6 hide-scrollbar [overflow-anchor:none]">

        {messages.length > 0 && hasEarlier && (
          <div className="flex justify-center">
            <button
              onClick={() => void handleLoadEarlier()}
              disabled={loadingEarlier}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-full bg-surface-container-high border border-outline-variant/20 text-on-surface-variant hover:text-primary hover:border-primary-container/50 transition-colors disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-sm">history</span>
              {loadingEarlier ? "Loading…" : "Load earlier messages"}
            </button>
          </div>
        )}

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
              <button onClick={() => openSettings("models")} className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-lg text-primary text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
                <span className="material-symbols-outlined text-sm">key</span> Set API Key
              </button>
            )}
          </div>
        )}

        {messages.length > 0 && <WorkingMemoryPanel />}

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
            {msg.role === "assistant" && msg.usedMemories && msg.usedMemories.length > 0 && (
              <details className="mb-2 ml-4">
                <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-primary-container/20 text-on-surface-variant hover:bg-primary-container/30 transition-colors">
                  <span className="material-symbols-outlined text-xs">neurology</span>
                  Drew on {msg.usedMemories.length} {msg.usedMemories.length === 1 ? "memory" : "memories"}
                </summary>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {msg.usedMemories.map((m) => (
                    <span key={m.id} className="text-[11px] px-2 py-0.5 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/20">
                      {m.title}
                    </span>
                  ))}
                </div>
              </details>
            )}
            <div
              className={`relative group ${msg.role === "user" ? "message-bubble-user bg-primary-container text-on-primary-container" : "message-bubble-ai bg-surface-container-high text-foreground border-l-2 border-primary-container/20"} p-5 shadow-sm leading-relaxed select-text`}
              style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
              onTouchStart={() => startLongPress(msg.content)}
              // The fired flag must be CONSUMED here, not just read: media frames
              // stop touchstart propagation (so startLongPress never re-arms and
              // resets it), and a stale true would preventDefault — i.e. kill —
              // every later tap on their buttons.
              onTouchEnd={(e) => { if (longPressFiredRef.current) { e.preventDefault(); longPressFiredRef.current = false; } cancelLongPress(); }}
              onTouchMove={cancelLongPress}
              onTouchCancel={cancelLongPress}
              onContextMenu={(e) => { if (longPressFiredRef.current) e.preventDefault(); }}
            >
              {msg.role === "assistant" ? (
                <>
                  {msg.splats && msg.splats.length > 0 && (
                    <MediaReveal restored={msg.restored} kind="splat" count={msg.splats.length} label={msg.splats[0].prompt}>
                      <div className={`grid gap-2 mb-2 ${msg.splats.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
                        {msg.splats.map((s) => (
                          <SplatBubble key={s.request_id} splat={s} />
                        ))}
                      </div>
                    </MediaReveal>
                  )}
                  {msg.videos && msg.videos.length > 0 && (
                    <MediaReveal restored={msg.restored} kind="video" count={msg.videos.length} label={msg.videos[0].prompt}>
                      <div className={`grid gap-2 mb-2 ${msg.videos.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
                        {msg.videos.map((v) => (
                          <VideoBubble key={v.job_id} video={v} />
                        ))}
                      </div>
                    </MediaReveal>
                  )}
                  {msg.images && msg.images.length > 0 && (
                    <MediaReveal restored={msg.restored} kind="image" count={msg.images.length} label={msg.images[0].prompt}>
                      <div
                        className={`grid gap-2 mb-2 ${
                          msg.images.length === 1
                            ? "grid-cols-1"
                            : msg.images.length === 2
                            ? "grid-cols-2"
                            : "grid-cols-2 sm:grid-cols-2 md:grid-cols-3"
                        }`}
                      >
                        {msg.images.map((img) => (
                          <LensImageFrame key={img.id} imageId={img.id} memoryLinked={!!(img.memory_title || img.entry_id)} handsFreeActive={handsFree.active}>
                            <GeneratedImage
                              storagePath={img.storage_path}
                              alt={img.prompt}
                              caption={img.memory_title ? `From your memory: ${img.memory_title}` : img.entry_id ? `${img.prompt} · saved to memory` : img.prompt}
                              resizable
                            />
                          </LensImageFrame>
                        ))}
                      </div>
                    </MediaReveal>
                  )}
                  {msg.memoryImageChips && msg.memoryImageChips.length > 0 && (
                    <MemoryChips chips={msg.memoryImageChips} handsFreeActive={handsFree.active} />
                  )}
                  {msg.toolProposals && msg.toolProposals.map((p) => (
                    <ToolApprovalCard key={p.tool_id} proposal={p} />
                  ))}
                  {msg.content && <div className="prose prose-sm prose-invert max-w-none"><ReactMarkdown urlTransform={safeUrlTransform} components={safeMarkdownComponents}>{msg.content}</ReactMarkdown></div>}
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
                <>
                  {msg.images && msg.images.length > 0 && (
                    <MediaReveal restored={msg.restored} kind="image" count={msg.images.length} label={msg.images[0].prompt}>
                      <div className={`grid gap-2 mb-2 ${msg.images.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
                        {msg.images.map((img) => (
                          <GeneratedImage
                            key={img.id}
                            storagePath={img.storage_path}
                            alt={img.prompt}
                            resizable
                          />
                        ))}
                      </div>
                    </MediaReveal>
                  )}
                  <p className="whitespace-pre-wrap font-medium">{msg.content}</p>
                </>
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
              {msg.content && downloadableTtsId === bubbleId(msg, i) && (
                <button
                  onClick={() => handleDownloadAudio(msg, i)}
                  title="Download audio"
                  aria-label="Download audio"
                  className={`absolute top-1/2 -translate-y-[calc(50%+2.25rem)] ${msg.role === "user" ? "-left-3" : "-right-3"} w-7 h-7 rounded-full bg-surface-container-highest border border-outline-variant/20 shadow-sm flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all opacity-70 hover:opacity-100`}
                >
                  <span className="material-symbols-outlined text-base" aria-hidden="true">download</span>
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
      </div>


      {/* Pocket screen: hands-free touch guard on phones (arms after idle) */}
      <PocketScreen active={handsFree.active} state={handsFree.state} />

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
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pb-1">
              {pendingImages.map((p) => (
                <div key={p.localId} className="relative w-16 h-16 rounded-lg overflow-hidden border border-outline-variant/40 bg-surface-container-high group">
                  <img src={p.dataUrl} alt={p.filename || "attachment"} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removePendingImage(p.localId)}
                    aria-label="Remove image"
                    className="absolute top-0.5 right-0.5 bg-black/70 text-white rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            className={`flex items-end gap-3 ${dragOver ? "ring-2 ring-primary/60 rounded-xl" : ""}`}
            onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDragOver(true); } }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              if (e.dataTransfer.files?.length) {
                e.preventDefault();
                setDragOver(false);
                addImagesFromFiles(e.dataTransfer.files);
              }
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif"
              multiple
              className="hidden"
              onChange={(e) => { addImagesFromFiles(e.target.files); if (fileInputRef.current) fileInputRef.current.value = ""; }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
              aria-label="Attach image"
              className="h-[50px] w-[44px] shrink-0 flex items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant hover:text-primary hover:bg-surface-container-highest transition-colors"
            >
              <span className="material-symbols-outlined text-xl">attach_file</span>
            </button>
            <div className="flex-grow relative">
              <Textarea
                ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
                inputMode={handsFree.active ? "none" : undefined}
                aria-label="Message The Librarian"
                placeholder={dictation.isListening ? "Listening… speak now" : apiKey ? "Ask about your books, or drop an image…" : "Set your OpenRouter API key to start chatting"}
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
                  disabled={!input.trim() && pendingImages.length === 0}
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
                aria-label="Save to Neuron"
                title="Save to Neuron"
                className="h-[50px] px-3 sm:px-5 bg-secondary-container text-on-secondary-container rounded-xl flex items-center gap-2 hover:bg-secondary-container/80 transition-all active:scale-95 border border-outline-variant/20 shrink-0"
              >
                {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="material-symbols-outlined text-lg">history_edu</span>}
                <span className="hidden sm:inline text-sm font-semibold whitespace-nowrap">Save to Neuron</span>
              </button>
            )}
          </div>
          <div className="flex justify-between items-center px-2">
            <div className="flex items-center gap-4 flex-nowrap overflow-x-auto hide-scrollbar snap-x flex-1 min-w-0 [&>*]:shrink-0 [&>*]:snap-start [&>*]:min-h-[40px] md:flex-wrap md:overflow-visible md:[&>*]:min-h-0">
              {/* Scope indicator — always shows what Counsel can read (NotebookLM-style transparency). */}
              <button
                onClick={() => openSettings("research")}
                title="What Counsel can read — click to change in Settings"
                className="text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 text-on-surface-variant hover:text-primary transition-colors max-w-[180px]"
              >
                <span className="material-symbols-outlined text-sm" aria-hidden>neurology</span>
                <span className="truncate">
                  {accessAllNeurons && isPaid
                    ? "Reading: all neurons"
                    : activeWikis.length > 1
                      ? `Reading: ${activeWikis.length} neurons`
                      : `Reading: ${activeWiki?.name || "no neuron"}`}
                </span>
              </button>
              <button onClick={() => { if (!isPaid) { openPricing("deep-research"); return; } setChatDeepResearch(!chatDeepResearch); }} title={isPaid ? undefined : "Deep Research is a Pro feature"} className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${chatDeepResearch && isPaid ? "text-primary-container" : "text-on-surface-variant hover:text-primary"}`}>
                <span className="material-symbols-outlined text-sm" style={chatDeepResearch && isPaid ? { fontVariationSettings: "'FILL' 1" } : {}}>{isPaid ? "science" : "lock"}</span> Deep Research {chatDeepResearch && isPaid ? "ON" : "OFF"}
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
              <button onClick={() => openSettings()} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-primary transition-colors" title="Open the Settings tab">
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
