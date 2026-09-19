import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useSyncExternalStore } from "react";
import { useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { safeUrlTransform, safeMarkdownComponents } from "@/lib/markdownSafety";
import { focusComposer, isTouchPrimary } from "@/lib/focusPolicy";
import PocketScreen from "@/components/PocketScreen";
import { LensImageFrame, MemoryChips } from "@/components/MemoryLensStrip";
import ToolApprovalCard from "@/components/ToolApprovalCard";
import ProgramApprovalCard from "@/components/ProgramApprovalCard";
import { Loader2, BookmarkPlus } from "lucide-react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { isToolBlocked } from "@/lib/leanMode";
import { TOOL_PERMISSION } from "@/lib/toolPermissions";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { useReadAloud } from "@/hooks/useReadAloud";
import { useHandsFree } from "@/hooks/useHandsFree";
import { isEmbeddingModel } from "@/lib/utils";
import { describeModel } from "@/lib/providers/registry";
import { useDictation } from "@/hooks/useDictation";
import { requestSettingsSection } from "@/lib/settingsNav";
import VoiceNotesPanel, { appendVoiceNote } from "@/components/VoiceNotesPanel";
// Lazy: ResponseBlocks pulls recharts (~large) but only renders when a model emits chart blocks
const ResponseBlocks = React.lazy(() => import("@/components/ResponseBlocks"));
import GeneratedImage from "@/components/GeneratedImage";
import VideoBubble from "@/components/VideoBubble";
import SplatBubble from "@/components/SplatBubble";
import MediaReveal from "@/components/MediaReveal";
import WorkingMemoryPanel from "@/components/WorkingMemoryPanel";
import WorkspaceShell from "@/components/WorkspaceShell";
import ToolStatusPanel from "@/components/ToolStatusPanel";
import PromptSwitcher from "@/components/PromptSwitcher";
import { turnPromptStore } from "@/lib/promptRouting";
import { markLastPromptRouteCorrected } from "@/lib/promptRoutingApi";
import type { Artifact } from "@/lib/artifacts";
import { workspaceStore, deriveResearchTitle, useWorkspaceItems } from "@/lib/workspaceStore";
import { focusStatesForPinned } from "@/lib/chatFocus";
import { bookContextStore, selectContextBooks } from "@/lib/chatBooks";
import { focusBookId } from "@/lib/counselFocus";
import BookContextPicker from "@/components/BookContextPicker";
import CounselToolsSheet from "@/components/CounselToolsSheet";
import BookWorm from "@/components/BookWorm";
import { useBookWorm } from "@/hooks/useBookWorm";
import { executeQuickSearch, BURPLEXITY_BOT_ASK_URL, pickCitations, isSearchRateLimited } from "@/lib/chatTools";
import { useDownloadableTtsId, downloadTtsAudio } from "@/lib/ttsAudioCache";
import { fileToDownscaledDataUrl, isAcceptedImage, uploadChatImage, registerUploadedImage, removeUploadedChatImage, type PendingChatImage } from "@/lib/imageUpload";
import { extractMentions, resolveMentions, buildMentionNote, findActiveMention, mentionTokenEnd, getCachedMasters, refreshMastersCache, type ActiveMention } from "@/lib/mentions";
import type { MasterAssetRow } from "@/lib/masterAssets";
import { formatUsage } from "@/lib/chatHistory";


const VOICE_QUICK_SEARCH_KEY = "voice_quick_search";

const SEARCH_INTENT_RE =
  /\b(search|look up|look for|find|google|what is|what are|who is|who are|tell me about|research|check online|latest|current|news about)\b/i;

const ChatPanel: React.FC = () => {
  const { books, activeBookId, activeWiki, activeWikiId, activeWikis, activeWikiIds, toggleNeuronInSession, setActiveTab, shelves } = useApp();
  const { user } = useAuth();
  const {
    apiKey, nvidiaKeyLast4, geminiApiKey, leanMode, savedModels, selectedModel, voiceModel, autoReadReplies, burplexityApiToken, accessAllNeurons, loaded,
    chatToolPermissions,
    handsFreeTtsRate,
    setSelectedModel, setAutoReadReplies,
  } = useChatSettings();
  const { messages, isLoading, chatDeepResearch, setChatDeepResearch, sendMessage, injectDisplayMessage, clearChat, abort, loadEarlier, hasEarlier, loadingEarlier, toolGatesForTurn, approvedToolCount } = useChat();
  const { isPaid } = usePlan();
  const {
    speakingId, speak, stop: stopSpeaking, pause: pauseSpeaking, resume: resumeSpeaking, isAudioActive,
    progress: speakProgress, isPaused: speakPaused, togglePause: toggleSpeakPause,
    skipBack: speakSkipBack, skipForward: speakSkipForward,
  } = useReadAloud();
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
  // The reader's "Ask in chat" on a highlight appends the quote to the draft.
  // (When this panel isn't mounted, the reader writes the stored draft instead.)
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (text) setInput((prev) => (prev.trim() ? `${prev}\n\n${text}` : text));
    };
    window.addEventListener("chat-composer-insert", onInsert);
    return () => window.removeEventListener("chat-composer-insert", onInsert);
  }, []);
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

  // ── Tool status ──────────────────────────────────────────────────────────
  // What the NEXT send would carry, derived from the same gate function the
  // send path uses. `pendingImages.length > 0` is not an approximation of the
  // send path's image test — it is the same condition: pixels are serialized
  // only for the current upload turn (older images ride as text notes), so a
  // message with attachments is exactly what can trip the model-level image
  // gate. Recomputes whenever a permission, Lean Mode, the model or the
  // attachment set changes, because toolGatesForTurn's identity changes with
  // all of them — a chip that stayed stale after a toggle would send the user
  // back to a switch they had already flipped.
  const toolGates = useMemo(
    () => toolGatesForTurn(pendingImages.length > 0),
    [toolGatesForTurn, pendingImages.length],
  );
  // Ground truth from the most recent reply that actually reached a provider.
  // Recorded at send time, never inferred from the response: a model that
  // silently lacks function calling finishes identically to one that simply
  // chose not to call anything.
  // Returns the stored record BY REFERENCE, never a fresh { offered, withheld }
  // literal: `messages` changes on every streamed token, and a new object each
  // time would re-render the status panel once per token for a value that
  // hasn't moved since the turn began.
  const lastTurnToolAccess = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].toolAccess) return messages[i].toolAccess;
    }
    return undefined;
  }, [messages]);

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
  const [deepSearching, setDeepSearching] = useState(false);

  // ---- @mention autocomplete over master assets ----
  // `mention` is the "@tok|en" under the caret, or null (popup closed). It is
  // ONLY ever set from real user events on the textarea — never on mount — and
  // the textarea is never programmatically focused/blurred (Android Chrome pops
  // the soft keyboard on any programmatic focus once the session has seen a
  // gesture; this file's focus policy exists to prevent exactly that).
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const [mentionMasters, setMentionMasters] = useState<MasterAssetRow[]>(() => getCachedMasters() || []);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionWasOpenRef = useRef(false);
  // Caret target for after a completion is inserted. Doubles as a "value/caret
  // not settled yet" latch so a trailing keyup can't recompute the token from
  // the pre-insertion DOM value and flash the popup back open.
  const pendingCaretRef = useRef<number | null>(null);

  // ---- Voice features absorbed from the former Echo (Voice) tab ----
  const [notesPanelOpen, setNotesPanelOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Configured in the Settings tab; read-only here.
  const [voiceQuickSearch] = useState(() => localStorage.getItem(VOICE_QUICK_SEARCH_KEY) === "true");
  const [pendingSearchCount, setPendingSearchCount] = useState(0);
  const [selectionCapture, setSelectionCapture] = useState<{ text: string; top: number; left: number } | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => localStorage.getItem("counsel_workspace_open") === "1");
  const [workspaceSelectedId, setWorkspaceSelectedId] = useState<string | null>(null);
  const workspaceItems = useWorkspaceItems();
  const workspaceCount = workspaceItems.filter((i) => i.userId == null || i.userId === user?.id).length;
  // Guarded because this was the repo's only unguarded storage write, and it
  // runs from an effect: `localStorage.setItem` throws in Safari private mode
  // and on quota exhaustion, and an unhandled throw inside an effect unmounts
  // the whole ChatPanel subtree. Key and values are unchanged ("1"/"0") — no
  // user loses their open/closed state.
  useEffect(() => {
    try {
      localStorage.setItem("counsel_workspace_open", workspaceOpen ? "1" : "0");
    } catch {
      // Storage unavailable. The workspace simply does not remember whether it
      // was open across reloads; nothing else reads this key.
    }
  }, [workspaceOpen]);
  // Pinned focus set — rendered as chips above the composer so what the AI
  // sees every turn is continuously visible (never inferred, never hidden).
  const focusedItems = useMemo(
    () => workspaceItems.filter((i) => (i.userId == null || i.userId === (user?.id ?? null)) && i.meta?.focused === true),
    [workspaceItems, user?.id]
  );
  // Badge states come from the SAME budget loop that builds the real block
  // (never a per-item shortcut — voice halving and the shared total budget
  // both change what actually gets sent). hands-free is the composer's live
  // predictor of whether the next send is a voice turn.
  const focusStates = useMemo(
    () => focusStatesForPinned(focusedItems, { voiceMode: handsFree.active }),
    [focusedItems, handsFree.active]
  );
  // Book context — the loaded shelf/books, shown as chips so what rides with
  // every message is continuously visible. Membership comes from the SAME
  // selector sendMessage uses, so chips and prompt can never disagree.
  // (Send-state badges appear on the per-reply receipt, not here: chapter
  // text isn't loaded until send time, so pre-send size claims would be
  // guesses.)
  const bookSelection = useSyncExternalStore(bookContextStore.subscribe, bookContextStore.get);
  useEffect(() => {
    bookContextStore.init(user?.id ?? null);
  }, [user?.id]);
  const contextBooks = useMemo(
    () => selectContextBooks(books, bookSelection, activeBookId ?? null),
    [books, bookSelection, activeBookId]
  );
  const [booksPickerOpen, setBooksPickerOpen] = useState(false);
  // Collapsing only hides the chip row — the books still ride with every
  // message, and the collapsed summary keeps the count visible.
  // Collapsed by DEFAULT: the expanded row is one chip per book, which on a
  // phone is the composer growing in proportion to how much the user loaded.
  // The count is the part that carries information; the titles are a detail
  // you ask for. An explicit "0" — the user having opened it themselves — is
  // still honoured, so this changes the default and nobody's choice.
  const [contextBooksCollapsed, setContextBooksCollapsed] = useState(() => {
    try {
      return localStorage.getItem("counsel_context_books_collapsed") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("counsel_context_books_collapsed", contextBooksCollapsed ? "1" : "0");
    } catch {
      // Storage unavailable. The row just won't remember its state across reloads.
    }
  }, [contextBooksCollapsed]);
  const removeContextBook = (id: string) => {
    if (bookSelection.shelfId) {
      bookContextStore.set({ ...bookSelection, excludedIds: [...bookSelection.excludedIds, id] });
    } else {
      bookContextStore.set({ ...bookSelection, bookIds: bookSelection.bookIds.filter((x) => x !== id) });
    }
  };

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

  // The BookWorm. Every signal it reads is state this panel already had; the
  // derivation, the timers and the discourse-boundary edge detection all live
  // in the hook. See src/lib/sprite/wormAnimator.ts for why it stops moving.
  const lastMsg = messages[messages.length - 1];
  const worm = useBookWorm({
    isLoading,
    lastId: lastMsg?.id,
    lastRole: lastMsg?.role,
    lastText: lastMsg?.content || "",
    input,
    speakingId,
    speakChunk: speakProgress?.index ?? null,
    listening: handsFree.state === "listening" || dictation.isListening,
    working: deepSearching || pendingSearchCount > 0,
  });
  const handleMicToggle = () => {
    if (!dictation.supported) { toast.error("Voice input not supported in this browser."); return; }
    if (dictation.isListening) { dictation.stop(); return; }
    inputBeforeDictationRef.current = input;
    suppressDictationRef.current = false;
    dictation.start();
  };

  // Recompute the active @-token from the LIVE textarea value/caret. Reads the
  // DOM element (not `input` state) so it's accurate inside onChange, before
  // React commits. Only meaningful while the textarea already holds focus.
  const syncMention = useCallback(() => {
    if (pendingCaretRef.current != null) return; // mid-completion — see applyMention
    const el = inputRef.current;
    if (!el || document.activeElement !== el) { setMention(null); return; }
    setMention(findActiveMention(el.value, el.selectionStart ?? el.value.length));
  }, []);

  const mentionQuery = mention?.query;
  const mentionMatches = mention
    ? mentionMasters.filter((m) => m.name.startsWith(mention.query)).slice(0, 6)
    : [];

  // Highlight resets to the top whenever the typed prefix changes.
  useEffect(() => { setMentionIndex(0); }, [mentionQuery]);

  // Refresh the session-cached master list once per popup-open (the cached
  // list renders instantly; new masters appear when the fetch lands).
  const mentionOpen = mention !== null;
  useEffect(() => {
    if (mentionOpen && !mentionWasOpenRef.current) {
      void refreshMastersCache().then(setMentionMasters);
    }
    mentionWasOpenRef.current = mentionOpen;
  }, [mentionOpen]);

  // Replace the whole token with "@name " and park the caret after the space.
  // Value and caret only — the textarea keeps whatever focus it already has.
  const applyMention = useCallback((name?: string) => {
    if (!mention || !name) return;
    const value = input;
    const end = mentionTokenEnd(value, mention.start);
    const rest = value.slice(end);
    // Don't double up when a space already follows the token; either way the
    // caret lands just past it, ready for the next word.
    const insert = `@${name}${rest.startsWith(" ") ? "" : " "}`;
    const next = value.slice(0, mention.start) + insert + rest;
    const caret = mention.start + name.length + 2;
    setMention(null);
    if (next === value) {
      // Completion was a no-op (token already complete) — setInput won't
      // re-render, so the caret latch below would never release. Move it now.
      const el = inputRef.current;
      if (el && document.activeElement === el) el.setSelectionRange(caret, caret);
      return;
    }
    pendingCaretRef.current = caret;
    setInput(next);
  }, [mention, input]);
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret == null) return;
    pendingCaretRef.current = null;
    const el = inputRef.current;
    // Move the caret only while the textarea is ALREADY focused — never focus it.
    if (el && document.activeElement === el) el.setSelectionRange(caret, caret);
  }, [input]);

  // Auto-scroll only when the TAIL of the conversation changes (a new message
  // appended, or the streaming reply growing) — never when older history is
  // prepended by "Load earlier", which must keep the view where it is.
  const tailAnchorRef = useRef<{ key?: string; content?: string; role?: string }>({});
  useEffect(() => {
    const last = messages[messages.length - 1];
    const prev = tailAnchorRef.current;
    const changed = !!last && (last.id !== prev.key || last.role !== prev.role || last.content !== prev.content);
    tailAnchorRef.current = { key: last?.id, content: last?.content, role: last?.role };
    if (changed) {
      // Mark this scroll as ours: the transcript's onScroll can't distinguish
      // user scrolling from smooth auto-scroll, and a streaming reply fires it
      // continuously — which would otherwise keep the "user was scrolling"
      // guard permanently hot and suppress the desktop refocus entirely.
      programmaticScrollUntilRef.current = Date.now() + 1200;
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
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
  const programmaticScrollUntilRef = useRef(0);
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

  // "Return" affordance (the Readwise Reader pattern): on a long reply the
  // playhead and the viewport drift apart — tapping the mini-player's text
  // scrolls the transcript back to the bubble being read. No-op for speech
  // without a bubble (hands-free ids, digests).
  const scrollToSpeakingBubble = useCallback(() => {
    const id = speakProgress?.id;
    if (!id) return;
    const el = messagesContainerRef.current?.querySelector(`[data-bubble-id="${CSS.escape(id)}"]`);
    if (!el) return;
    programmaticScrollUntilRef.current = Date.now() + 1200;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [speakProgress?.id]);

  // Hidden during hands-free: its FSM owns pause/resume (see the JSX note).
  const miniPlayerVisible = !!speakProgress && !handsFree.active;

  // The bar toggling in/out of flow resizes the transcript viewport, and
  // scrollTop is preserved — so if the user was pinned to the bottom, the
  // bar's height would eat exactly the tail of the bubble being spoken.
  // Auto-scroll only reacts to tail-content changes, so re-pin here.
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > 0 && dist < 140) {
      programmaticScrollUntilRef.current = Date.now() + 400;
      el.scrollTop = el.scrollHeight;
    }
  }, [miniPlayerVisible]);

  // Id of the message whose Inworld audio finished playing and is held in
  // memory — its bubble shows a download button (saving costs no API credits).
  const downloadableTtsId = useDownloadableTtsId();
  const handleDownloadAudio = (msg: { id?: string; content: string }, i: number) => {
    if (!downloadTtsAudio(bubbleId(msg, i), msg.content)) {
      toast.error("Audio is no longer available — play the message again first");
    }
  };

  // Navigate to the consolidated Settings tab, optionally landing on a section.
  // Stable identity so the memoized tool-status chip isn't re-rendered once
  // per streamed token by a prop that never actually changes.
  const openSettings = useCallback((section?: string) => {
    if (section) requestSettingsSection(section);
    setActiveTab("settings");
  }, [setActiveTab]);

  // Counsel's FOCUS book (derived — counselFocus.focusBookId), not the
  // reader's: with a shelf loaded, the reader's book is discussed only if it
  // is on the shelf. `readerBook` is what the Read tab shows.
  const focusId = focusBookId(books, bookSelection, activeBookId ?? null);
  const selectedBook = books.find((b) => b.id === focusId);
  const readerBook = activeBookId ? books.find((b) => b.id === activeBookId) : undefined;
  const loadedLabel = bookSelection.shelfId
    ? (shelves.find((f) => f.id === bookSelection.shelfId)?.name ?? "the loaded shelf")
    : bookSelection.bookIds.length > 0
      ? `${bookSelection.bookIds.length} hand-picked book${bookSelection.bookIds.length === 1 ? "" : "s"}`
      : null;

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

  /** Something to send: typed text, or an image waiting to go with it. */
  const canSend = !!input.trim() || pendingImages.length > 0;

  /**
   * What is currently shaping the next reply, named rather than counted.
   *
   * This is the composer's whole state display now that the wrapping chip
   * strip is gone. It rides in the placeholder while the field is empty, and
   * its length is the count on the `+` badge — a number alone tests badly
   * (people open the panel just to find out what it meant), so the number
   * never travels without the names.
   *
   * Hands-free is absent on purpose: it has its own lit button on the bar.
   */
  const activeModes = useMemo(() => {
    const m: string[] = [];
    if (chatDeepResearch && isPaid) m.push("Deep Research");
    if (autoReadReplies) m.push("Read Aloud");
    if (contextBooks.length) m.push(`${contextBooks.length} book${contextBooks.length === 1 ? "" : "s"}`);
    if (focusedItems.length) m.push(`${focusedItems.length} pinned`);
    if (workspaceOpen) m.push("Files");
    return m;
  }, [chatDeepResearch, isPaid, autoReadReplies, contextBooks.length, focusedItems.length, workspaceOpen]);
  const activeModeCount = activeModes.length;

  const handsFreeStateLabel =
    handsFree.state === "listening" ? "listening"
      : handsFree.state === "thinking" ? "thinking"
        : handsFree.state === "speaking" ? "speaking"
          : "on";

  /**
   * The empty field is the composer's last piece of screen that costs nothing,
   * so it carries whatever is most worth saying right now: what hands-free is
   * hearing, then what dictation is doing, then which modes are on, then the
   * ordinary hint. It is only ever visible while the field is empty, which is
   * exactly when there is room for it.
   */
  const composerPlaceholder =
    handsFree.active
      ? (handsFree.interim ? `“${handsFree.interim}”` : `Hands-free — ${handsFreeStateLabel}`)
      : dictation.isListening
        ? "Listening… speak now"
        : !(apiKey || nvidiaKeyLast4 || geminiApiKey)
          ? "Add an API key in Settings to start chatting"
          : activeModes.length
            ? `${activeModes.join(" · ")} — ask anything…`
            : "Ask about your books, or drop an image…";

  /**
   * The textarea reserves exactly the room the trailing buttons actually take.
   * A constant `pr-20` assumed a fixed pair; the bar now carries between zero
   * and three. Each face is 36px with a 6px gap, in a row inset 8px from the
   * edge, plus 8px of breathing room. Literal classes, because Tailwind reads
   * source text and never sees an interpolated one.
   */
  const trailingButtons =
    (dictation.supported ? 1 : 0) + (handsFree.supported ? 1 : 0) + (isLoading || canSend ? 1 : 0);
  const composerPadRight =
    trailingButtons >= 3 ? "pr-[136px]"
      : trailingButtons === 2 ? "pr-[94px]"
        : trailingButtons === 1 ? "pr-[52px]"
          : "pr-4";

  const handleSend = async () => {
    if (isLoading || sendingRef.current) return; // a reply is streaming — use Stop first
    const text = input.trim();
    const imagesToSend = pendingImages;
    if (!text && imagesToSend.length === 0) return;
    if (!apiKey && !nvidiaKeyLast4 && !geminiApiKey) { toast.error("Add an API key in Settings first — OpenRouter, NVIDIA or Gemini"); openSettings("models"); return; }
    sendingRef.current = true;
    // Desktop refocus eligibility: this send came from the composer area
    // (Enter or the send button). Touch devices never refocus.
    wasFocusedAtSendRef.current = !isTouchPrimary() && !handsFree.active;
    try {
      suppressDictationRef.current = true;
      dictation.stop();
      setInput("");
      setPendingImages([]);
      setMention(null); // popup state would otherwise outlive the cleared draft
      // Pre-resolve @master mentions in parallel with the image uploads so the
      // model learns the real ids exist WITHOUT a list_master_assets round-trip.
      // Hard 1.5s cap: the note is advisory and must never hold the send
      // hostage — on timeout the message goes out bare.
      const mentionNotePromise: Promise<string | null> =
        text && extractMentions(text).length > 0
          ? Promise.race([
              resolveMentions(text).then(buildMentionNote),
              new Promise<string | null>((resolve) => { window.setTimeout(() => resolve(null), 1500); }),
            ]).catch(() => null)
          : Promise.resolve(null);
      // Voice quick-search fires a REAL Burplexity/Tavily call and injects its
      // results into the turn, so it has to clear the SAME gates the executor
      // applies to web_search: Lean Mode AND the user's own switch. It only ever
      // checked Lean Mode, so a user who turned "Web search" off in Settings →
      // AI Permissions still had searches run on every message that matched
      // SEARCH_INTENT_RE — their switch did nothing here.
      //
      // DEFAULT-ALLOW, the app-wide convention: a permission counts as off ONLY
      // when its stored value is explicitly `false`, never when the key is
      // merely absent. Matches toolAvailability.ts:226
      // (`input.permissions[permId] === false`) and AiPermissionsSettings.tsx:16
      // (`chatToolPermissions[id] !== false`). Reading an absent key as "off"
      // would silently switch voice quick-search off for every user who has
      // never opened the permissions screen — a far wider regression than the
      // leak being fixed. TOOL_PERMISSION is the lookup rather than a literal id
      // so this follows the map if web_search is ever regrouped.
      //
      // Skipping is SILENT: no toast, no error, nothing written into model
      // context. The turn proceeds without the search. Permission explanation
      // lives in ToolStatusPanel by design — that register in a prompt
      // measurably suppresses legitimate tool use.
      const webSearchSwitchedOn = chatToolPermissions?.[TOOL_PERMISSION.web_search] !== false;
      if (voiceQuickSearch && burplexityApiToken && webSearchSwitchedOn && !isToolBlocked(leanMode, "web_search") && SEARCH_INTENT_RE.test(text)) {
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
      // Visibly appended (the transcript shows exactly what the model saw).
      const mentionNote = await mentionNotePromise;
      const outgoing = mentionNote ? `${text}\n\n${mentionNote}` : text;
      try {
        await sendMessage(outgoing || "(see attached image)", { images: imagesForModel });
      } catch { /* surfaced via toast */ }
    } finally {
      sendingRef.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // While the mention popup is showing, the navigation keys belong to it —
    // Enter accepts a completion instead of sending.
    if (mention && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionMatches[mentionIndex]?.name); return; }
      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
    }
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
      {/* Focus indicator — confirms to the user (and signals that the AI
          knows) which book Counsel is discussing. When the reader shows a
          book that is NOT on the loaded shelf, both are named, so the screen
          never implies the AI is reading what the user is reading. */}
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
      {!selectedBook && readerBook && loadedLabel && (
        <div className="px-4 pt-3 pb-0.5 flex items-center gap-2 text-xs font-body text-on-surface-variant" data-testid="reader-vs-focus">
          <span className="material-symbols-outlined text-sm text-primary-container" aria-hidden>
            auto_stories
          </span>
          <span className="truncate">
            Reading: <span className="font-semibold">{readerBook.title}</span>
            {" · "}Discussing: <span className="font-semibold text-primary">{loadedLabel}</span>
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
      <div className="flex-1 overflow-hidden relative">
        {/* The BookWorm sits on the floor of the transcript, above the
            composer and below the text. `relative` on the parent is what it
            anchors to; pointer-events are off inside the component, so it can
            never eat a tap meant for a bubble behind it. */}
        {worm.enabled && (
          <div className="absolute bottom-0 right-1 z-10 pointer-events-none select-none">
            <BookWorm ref={worm.ref} mood={worm.mood} voiceSource={worm.voiceSource} onPet={worm.onPet} size={64} className="w-[52px] sm:w-16 h-auto" />
          </div>
        )}
        <div ref={messagesContainerRef} role="log" aria-label="Conversation with The Librarian" aria-live="off" onScroll={() => { if (Date.now() >= programmaticScrollUntilRef.current) lastTranscriptInteractionRef.current = Date.now(); }} onPointerDown={() => { lastTranscriptInteractionRef.current = Date.now(); }} onWheel={() => { lastTranscriptInteractionRef.current = Date.now(); }} onTouchMove={() => { lastTranscriptInteractionRef.current = Date.now(); }} className="h-full overflow-auto px-4 py-6 space-y-6 hide-scrollbar [overflow-anchor:none]">

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
          <div key={msg.id || i} data-bubble-id={bubbleId(msg, i)} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[85%] ${msg.role === "user" ? "self-end" : ""} group`}>
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
            {msg.role === "assistant" && msg.usedFocus && msg.usedFocus.some((f) => f.state !== "omitted") && (
              <details className="mb-2 ml-4">
                <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-primary-container/20 text-on-surface-variant hover:bg-primary-container/30 transition-colors">
                  <span className="material-symbols-outlined text-xs">push_pin</span>
                  {(() => { const n = msg.usedFocus.filter((f) => f.state !== "omitted").length; return `Focused on ${n} ${n === 1 ? "file" : "files"}`; })()}
                </summary>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {msg.usedFocus.map((f) => (
                    <span key={f.id} className="text-[11px] px-2 py-0.5 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/20">
                      {f.title}
                      {f.state === "excerpt" ? " · excerpt" : f.state === "omitted" ? " · not sent (budget full)" : ""}
                    </span>
                  ))}
                </div>
              </details>
            )}
            {/* Prompt receipt. Only rendered when a saved prompt was in play at
                all, so ordinary turns stay uncluttered — but when one WAS in
                play it always shows, including the cases where it did not
                apply. "Editor is on" while the request carried nothing is the
                exact failure this row exists to make visible. */}
            {msg.role === "assistant" && msg.usedPrompt && (msg.usedPrompt.id || msg.usedPrompt.source === "manual") && (
              <details className="mb-2 ml-4">
                <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-primary-container/20 text-on-surface-variant hover:bg-primary-container/30 transition-colors">
                  <span className="material-symbols-outlined text-xs">psychology</span>
                  {msg.usedPrompt.name
                    ? `Prompt: ${msg.usedPrompt.name}${msg.usedPrompt.source === "manual" ? "" : " · default"}`
                    : "Prompt: none"}
                </summary>
                <p className="mt-1.5 text-[11px] text-on-surface-variant px-2">{msg.usedPrompt.why}</p>
                {/* An automatic switch must always be one tap away from being
                    undone, and the undo must also TELL the router it was
                    wrong — otherwise it makes the same call tomorrow. */}
                {msg.usedPrompt.source === "auto" && (
                  <button
                    onClick={() => {
                      const back = msg.usedPrompt?.replacedId;
                      turnPromptStore.set(back ? { mode: "pinned", presetId: back } : { mode: "plain" });
                      void markLastPromptRouteCorrected();
                      toast.success(back ? "Switched back — the AI won't change it again this conversation." : "Prompt turned off for this conversation.");
                    }}
                    className="mt-1 ml-2 text-[11px] text-primary hover:underline"
                  >
                    Not this one — put it back
                  </button>
                )}
              </details>
            )}
            {msg.role === "assistant" && msg.usedBooks && msg.usedBooks.length > 0 && (
              <details className="mb-2 ml-4">
                <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-primary-container/20 text-on-surface-variant hover:bg-primary-container/30 transition-colors">
                  <span className="material-symbols-outlined text-xs">auto_stories</span>
                  {(() => {
                    const n = msg.usedBooks.filter((b) => b.state !== "omitted").length;
                    // All-omitted is a receipt too — an invisible omission
                    // would let the chips claim books the model never saw.
                    return n > 0 ? `${n} book${n === 1 ? "" : "s"} in context` : "Books not sent";
                  })()}
                </summary>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {msg.usedBooks.map((b) => (
                    <span key={b.id} className="text-[11px] px-2 py-0.5 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/20">
                      {b.title}
                      {b.state === "full"
                        ? " · full text"
                        : b.state === "catalog"
                          ? ` · catalog · ${b.chaptersSent}/${b.chaptersTotal} chapters mapped`
                          : b.state === "excerpt"
                            ? ` · ${b.chaptersSent}/${b.chaptersTotal} chapters`
                            : b.state === "outline"
                              ? " · chapter map only"
                              : b.note
                                ? ` · not sent (${b.note})`
                                : " · not sent"}
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
                  {msg.programProposals && msg.programProposals.map((p) => (
                    <ProgramApprovalCard key={p.program_id} proposal={p} />
                  ))}
                  {msg.viaModel && (
                    <div className="text-[10px] text-on-surface-variant/60 mb-1.5 font-medium tracking-wide">
                      via {describeModel(msg.viaModel)}
                      {msg.usage && formatUsage(msg.usage) && (
                        <span title="Tokens this reply used across all its requests, as reported by the provider"> · {formatUsage(msg.usage)}</span>
                      )}
                    </div>
                  )}
                  {msg.reasoning && (
                    <details className="mb-2 rounded-lg bg-surface-container-highest/40 px-3 py-1.5">
                      <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant/80 select-none">
                        <span className="material-symbols-outlined text-xs" aria-hidden>psychology</span>
                        Thinking
                      </summary>
                      <div className="mt-1 text-xs text-on-surface-variant/80 whitespace-pre-wrap max-h-56 overflow-y-auto">{msg.reasoning}</div>
                    </details>
                  )}
                  {msg.content && <div className="prose prose-sm prose-invert max-w-none"><ReactMarkdown urlTransform={safeUrlTransform} components={safeMarkdownComponents}>{msg.content}</ReactMarkdown></div>}
                  {msg.blocks && msg.blocks.length > 0 && (
                    <React.Suspense fallback={null}>
                      <ResponseBlocks blocks={msg.blocks} />
                    </React.Suspense>
                  )}
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

      {/* TTS mini-player: docked above the composer so the seek controls stay
          one thumb-reach away however long the bubble is — the bubble's side
          button only starts/stops. Skip semantics follow the engine: real
          ±10s for Inworld audio, previous/next sentence for the browser
          voice (which has no seekable time axis). Hidden while hands-free is
          active: pause/resume there belongs to the barge-in verifier (a
          manual pause would pin the FSM in "speaking" with the mic closed,
          and a manual resume mid-verification would transcribe the
          assistant's own audio as the next turn). */}
      {miniPlayerVisible && speakProgress && (
        <div className="mx-4 mb-2 flex items-center gap-1 rounded-2xl bg-surface-container-high border border-outline-variant/30 shadow-lg px-2 py-1.5">
          <button
            onClick={scrollToSpeakingBubble}
            title="Show this message in the conversation"
            className="flex-1 min-w-0 text-left px-1.5 py-0.5 rounded-lg hover:bg-surface-container-highest transition-colors"
          >
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary/80">
              <span className="material-symbols-outlined text-xs" aria-hidden>graphic_eq</span>
              Reading · {speakProgress.index + 1}/{speakProgress.total}
            </span>
            <span className="block text-xs text-on-surface-variant truncate">{speakProgress.text}</span>
          </button>
          <button
            onClick={speakSkipBack}
            title={speakProgress.mode === "inworld" ? "Back 10 seconds" : "Previous sentence"}
            aria-label={speakProgress.mode === "inworld" ? "Back 10 seconds" : "Previous sentence"}
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-highest transition-colors"
          >
            <span className="material-symbols-outlined text-xl" aria-hidden>
              {speakProgress.mode === "inworld" ? "replay_10" : "skip_previous"}
            </span>
          </button>
          <button
            onClick={toggleSpeakPause}
            title={speakPaused ? "Resume" : "Pause"}
            aria-label={speakPaused ? "Resume" : "Pause"}
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-highest transition-colors"
          >
            <span className="material-symbols-outlined text-xl" aria-hidden>
              {speakPaused ? "play_arrow" : "pause"}
            </span>
          </button>
          <button
            onClick={speakSkipForward}
            title={speakProgress.mode === "inworld" ? "Forward 10 seconds" : "Next sentence"}
            aria-label={speakProgress.mode === "inworld" ? "Forward 10 seconds" : "Next sentence"}
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-highest transition-colors"
          >
            <span className="material-symbols-outlined text-xl" aria-hidden>
              {speakProgress.mode === "inworld" ? "forward_10" : "skip_next"}
            </span>
          </button>
          <button
            onClick={stopSpeaking}
            title="Stop reading"
            aria-label="Stop reading"
            className="w-9 h-9 ml-2 shrink-0 rounded-full flex items-center justify-center text-on-surface-variant hover:text-destructive hover:bg-surface-container-highest transition-colors"
          >
            <span className="material-symbols-outlined text-xl" aria-hidden>close</span>
          </button>
        </div>
      )}

      {/* Pocket screen: hands-free touch guard on phones (arms after idle) */}
      <PocketScreen active={handsFree.active} state={handsFree.state} />

      {/* Book-context picker (Books button + shelf "Chat with this shelf") */}
      <BookContextPicker open={booksPickerOpen} onOpenChange={setBooksPickerOpen} />

      {/* Input Area */}
      <div className="px-4 pb-4 pt-2">
        {/* The ring is the state signal that survives typing. The `+` badge and
            the named summary in the placeholder are both gone or unread once
            the user starts a message; this stays, and it is why a bare count
            was never allowed to be the whole disclosure. */}
        <div
          className={`bg-surface-container-low/90 backdrop-blur-xl p-3 rounded-2xl shadow-2xl border flex flex-col gap-2 max-w-4xl mx-auto transition-shadow ${
            handsFree.active
              ? "border-primary/40 ring-1 ring-primary/40"
              : activeModeCount > 0
                ? "border-primary-container/40 ring-1 ring-primary-container/30"
                : "border-outline-variant/10"
          }`}
        >
          {/* Hands-free used to own a whole row here, reading "Listening — just
              talk" beside a Stop button. Both moved onto the bar: the hands-free
              button IS the state (filled, accent, pulsing while it listens) and
              tapping it is the stop. Only the interim transcript still needs
              words, and it goes where the words go — the placeholder. */}
          {/* One line, never two. `flex-wrap` here was the other half of the
              stacking: pinned files and loaded books each grew their own
              second and third row as the user added to them. A nowrap strip
              that scrolls is bounded — the composer's height stops being a
              function of how much context you have loaded. */}
          {focusedItems.length > 0 && (
            <div className="flex flex-nowrap overflow-x-auto hide-scrollbar items-center gap-1.5 px-1 pb-1 text-xs font-body text-on-surface-variant [&>*]:shrink-0">
              <span
                className="material-symbols-outlined text-[14px] text-primary-container"
                style={{ fontVariationSettings: "'FILL' 1" }}
                title="Pinned focus — these files are sent to the AI with every message"
                aria-hidden
              >
                push_pin
              </span>
              {focusedItems.map((f) => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-surface-container-high border border-outline-variant/20 max-w-[200px]"
                >
                  <button
                    type="button"
                    onClick={() => { setWorkspaceSelectedId(f.id); setWorkspaceOpen(true); }}
                    className="truncate font-semibold text-primary hover:underline"
                    title={`Open "${f.title}" in the Workspace`}
                  >
                    {f.title}
                  </button>
                  {focusStates.get(f.id) === "excerpt" && (
                    <span
                      className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant shrink-0"
                      title="Too big to send in full — the AI gets an excerpt plus a tool to read the rest"
                    >
                      excerpt
                    </span>
                  )}
                  {focusStates.get(f.id) === "omitted" && (
                    <span
                      className="text-[9px] font-bold uppercase tracking-widest text-destructive shrink-0"
                      title="NOT sent — the focus budget or 5-file limit is already used up. Unpin something to make room."
                    >
                      not sent
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => workspaceStore.toggleFocused(f.id)}
                    className="rounded-full hover:bg-surface-container-highest p-0.5 leading-none shrink-0"
                    title={`Unpin "${f.title}" from focus`}
                    aria-label={`Unpin ${f.title} from focus`}
                  >
                    <span className="material-symbols-outlined text-[12px] block">close</span>
                  </button>
                </span>
              ))}
            </div>
          )}
          {contextBooks.length > 0 && (
            <div className="flex flex-nowrap overflow-x-auto hide-scrollbar items-center gap-1.5 px-1 pb-1 text-xs font-body text-on-surface-variant [&>*]:shrink-0">
              <button
                type="button"
                onClick={() => setContextBooksCollapsed((c) => !c)}
                className="inline-flex items-center gap-0.5 rounded-full hover:bg-surface-container-highest pl-0.5 pr-1 py-0.5 leading-none shrink-0"
                aria-expanded={!contextBooksCollapsed}
                title={contextBooksCollapsed
                  ? "Show the loaded books (they're still sent with every message)"
                  : "Hide the loaded books (they'll still be sent with every message)"}
              >
                <span
                  className="material-symbols-outlined text-[14px] text-primary-container"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                  aria-hidden
                >
                  auto_stories
                </span>
                <span className="material-symbols-outlined text-[14px] block" aria-hidden>
                  {contextBooksCollapsed ? "expand_more" : "expand_less"}
                </span>
                {contextBooksCollapsed && (
                  <span className="font-semibold text-primary">
                    {contextBooks.length} book{contextBooks.length === 1 ? "" : "s"}
                    {bookSelection.shelfId && loadedLabel ? ` · ${loadedLabel}` : ""}
                  </span>
                )}
              </button>
              {!contextBooksCollapsed && contextBooks.map((b) => (
                <span
                  key={b.id}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-surface-container-high border border-outline-variant/20 max-w-[200px]"
                >
                  <button
                    type="button"
                    onClick={() => setBooksPickerOpen(true)}
                    className="truncate font-semibold text-primary hover:underline"
                    title={`"${b.title}" is loaded as chat context`}
                  >
                    {b.title}
                  </button>
                  {b.id === activeBookId && (
                    <span className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant shrink-0" title="Your active book — placed first in context">
                      reading
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeContextBook(b.id)}
                    className="rounded-full hover:bg-surface-container-highest p-0.5 leading-none shrink-0"
                    title={`Remove "${b.title}" from chat context`}
                    aria-label={`Remove ${b.title} from chat context`}
                  >
                    <span className="material-symbols-outlined text-[12px] block">close</span>
                  </button>
                </span>
              ))}
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
            className={`flex items-end gap-2 ${dragOver ? "ring-2 ring-primary/60 rounded-xl" : ""}`}
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
            {/* ONE leading affordance: attach AND tools, the way every major
                assistant now does it. The paperclip it replaced was a 44x50
                block OUTSIDE the field — the single most non-idiomatic thing
                in the old bar, and 56px of a 320px phone row spent on one
                action. Merged, that space goes back to the text.

                The badge is a supplement, never the whole story: Baymard's
                testing found count-only disclosure performs poorly because
                people open the panel just to confirm what the number meant.
                So the count rides alongside the named summary in the empty
                field and the accent ring on the well — three signals, one of
                which survives in every state. */}
            <button
              type="button"
              onClick={() => setToolsOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={toolsOpen}
              title="Attach an image, or change what Counsel can read and how it answers"
              aria-label={activeModeCount > 0 ? `Attach and tools — ${activeModeCount} active` : "Attach and tools"}
              className="relative h-9 w-9 shrink-0 self-end mb-0.5 flex items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant hover:text-primary hover:bg-surface-container-highest transition-colors after:content-[''] after:absolute after:-inset-[4px]"
            >
              <span className="material-symbols-outlined text-xl">add</span>
              {activeModeCount > 0 && (
                <span
                  className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-primary text-on-primary text-[10px] font-bold leading-4 text-center pointer-events-none"
                  aria-hidden
                >
                  {activeModeCount}
                </span>
              )}
            </button>
            <div className="flex-grow relative">
              {/* @mention popup — anchored above the composer. Options use
                  onMouseDown preventDefault so choosing one never steals focus
                  from the textarea (the caret math in applyMention only runs
                  while it is already focused; Android keyboard rule). */}
              {mention && mentionMatches.length > 0 && (
                <div
                  role="listbox"
                  aria-label="Master assets"
                  className="absolute bottom-full left-0 mb-2 z-50 min-w-[200px] max-w-[280px] max-h-52 overflow-y-auto rounded-xl bg-surface-container-high border border-outline-variant/30 shadow-xl py-1"
                >
                  {mentionMatches.map((m, i) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={i === mentionIndex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyMention(m.name)}
                      onPointerMove={() => setMentionIndex(i)}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${i === mentionIndex ? "bg-primary-container/30 text-foreground" : "text-on-surface-variant"}`}
                    >
                      <span className="font-medium truncate">@{m.name}</span>
                      {m.blueprint && (
                        <span className="ml-auto text-[9px] font-bold uppercase tracking-widest text-primary-container" title="Has blueprint">blueprint</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <Textarea
                ref={inputRef} value={input} onChange={(e) => { setInput(e.target.value); syncMention(); }} onKeyDown={handleKeyDown} onPaste={handlePaste}
                onKeyUp={syncMention} onClick={syncMention} onBlur={() => setMention(null)}
                inputMode={handsFree.active ? "none" : undefined}
                aria-label="Message The Librarian"
                placeholder={composerPlaceholder}
                rows={1} className={`bg-surface-container-high border-none rounded-xl text-foreground py-3 pl-4 ${composerPadRight} focus:ring-1 focus:ring-primary/40 resize-none min-h-[50px] max-h-[220px] overflow-y-auto`}
              />

              {/* Mic and Send share one flow row instead of each carrying its
                  own `right-N` offset. The old offsets (right-11 and right-2)
                  left 6px between two ~30px buttons, which is under every
                  platform's floor and too tight to grow: expanding both hit
                  regions to 44px would have made them OVERLAP. A flex row with
                  `gap-2` gives each a 36px face and a 44px target (the
                  `after:-inset-[4px]` pad) whose edges meet but never cross —
                  WCAG 2.2 SC 2.5.5 / Apple's 44pt, without a chunkier button.
                  `touch-action: manipulation` drops the legacy 300ms
                  double-tap-zoom delay while leaving pinch-zoom alone. */}
              <div className="absolute right-2 bottom-2 flex items-center gap-1.5" style={{ touchAction: "manipulation" }}>
                {/* DICTATION — speech into the field. Deliberately the quiet,
                    outline one. Grok's composer was picked apart for making
                    its dictation mic and its live-voice button look alike
                    until you tapped one; the two do completely different
                    things, so here one is a ghost and the other is filled. */}
                {dictation.supported && (
                  <button
                    type="button"
                    onClick={handleMicToggle}
                    title={dictation.isListening ? "Stop dictation" : "Dictate message"}
                    aria-label={dictation.isListening ? "Stop dictation" : "Dictate message"}
                    className={`relative h-9 w-9 flex items-center justify-center rounded-lg transition-all active:scale-90 after:content-[''] after:absolute after:-inset-[4px] ${dictation.isListening ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-surface-container-highest text-on-surface-variant hover:text-primary"}`}
                  >
                    <span className="material-symbols-outlined text-lg" style={dictation.isListening ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                      {dictation.isListening ? "mic_off" : "mic"}
                    </span>
                  </button>
                )}
                {/* HANDS-FREE — quick draw. It lives on the bar, never behind
                    the sheet: starting a spoken conversation is the one thing
                    you reach for without looking, and every assistant that
                    ships a live-voice mode keeps it on the bar for exactly
                    that reason. It is also its own status display — filled and
                    accented when on, pulsing while it listens — which is what
                    let the "Listening — just talk" row above the composer go. */}
                {handsFree.supported && (
                  <button
                    type="button"
                    onClick={handsFree.toggle}
                    aria-pressed={handsFree.active}
                    title={handsFree.active ? `Hands-free — ${handsFreeStateLabel}. Tap to stop.` : "Hands-free — just talk"}
                    aria-label={handsFree.active ? `Stop hands-free (${handsFreeStateLabel})` : "Start hands-free conversation"}
                    className={`relative h-9 w-9 flex items-center justify-center rounded-lg transition-all active:scale-90 after:content-[''] after:absolute after:-inset-[4px] ${
                      handsFree.active
                        ? `bg-primary text-on-primary${handsFree.state === "listening" ? " animate-pulse" : ""}`
                        : "bg-surface-container-highest text-on-surface-variant hover:text-primary"
                    }`}
                  >
                    <span
                      className="material-symbols-outlined text-lg"
                      style={handsFree.active ? { fontVariationSettings: "'FILL' 1" } : undefined}
                    >
                      {handsFree.active
                        ? (handsFree.state === "thinking" ? "more_horiz" : "graphic_eq")
                        : "record_voice_over"}
                    </span>
                  </button>
                )}
                {/* Send is RENDERED ONLY WHEN THERE IS SOMETHING TO SEND, the
                    way every major assistant's composer now behaves. A disabled
                    button still occupies the corner your thumb reaches for; an
                    absent one cannot be hit by mistake at all, which is the
                    cheapest accidental-activation fix available. */}
                {isLoading ? (
                  <button
                    onClick={() => abort()}
                    title="Stop generating"
                    aria-label="Stop generating"
                    className="relative h-9 w-9 flex items-center justify-center bg-destructive text-destructive-foreground rounded-lg hover:brightness-110 active:scale-90 transition-all after:content-[''] after:absolute after:-inset-[4px]"
                  >
                    <span className="material-symbols-outlined text-lg">stop</span>
                  </button>
                ) : canSend ? (
                  <button
                    onClick={handleSend}
                    title="Send"
                    aria-label="Send"
                    className="relative h-9 w-9 flex items-center justify-center bg-primary-container text-on-primary-container rounded-lg hover:brightness-110 active:scale-90 transition-all after:content-[''] after:absolute after:-inset-[4px]"
                  >
                    <span className="material-symbols-outlined text-lg">send</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          {/* THE COMPOSER'S STATUS STRIP — what is ON, and one way in to
              everything else.

              This replaced a thirteen-chip `overflow-x-auto` scroller that sat
              directly beneath the send button. A horizontal scroller under the
              highest-consequence control on the screen means every flick to
              reach a far chip is a gesture begun on top of a live toggle; the
              prompt switcher made it worse by opening on the down-event
              (PromptSwitcher has the detail). The row also never fitted, so
              most of it was off-screen anyway — hiding by scroll, which is the
              worst kind, because nothing tells you there is more.

              What is left WRAPS (`flex-wrap`), never scrolls, and is only
              rendered when it has something to report. Chips are a claim about
              the next message, not a control panel: "Deep Research ON" is here
              because it changes the answer; "Settings" is not, because it does
              not. `touch-action: manipulation` drops the legacy 300ms
              double-tap-zoom delay without disabling pinch-zoom. */}
          {/* NOTHING STACKS HERE ANY MORE.

              This was a wrapping strip of state chips, and the wrap was not a
              styling accident — it was arithmetic. On a 360px phone the well
              gives about 304px of usable row; "Deep Research", "Read Aloud",
              "Books (3)", "Files" and the tools-status chip measure roughly
              480px together. It could only ever have been two rows, three once
              a label grew.

              So the state moved onto the bar instead, three ways at once:
              the `+` badge counts it, the empty field names it, and the well
              wears an accent ring while any of it is on. The ring is the one
              that survives typing, when the other two are gone or unread.

              The only thing that still earns a line of its own here is a live
              search, because it is the one piece of state the user did not
              switch on and cannot predict the end of. */}
          {pendingSearchCount > 0 && (
            <div className="flex items-center gap-1.5 px-2 text-[10px] font-bold uppercase tracking-widest text-primary-container">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching ({pendingSearchCount})
            </div>
          )}

          {/* The alarm, and only the alarm. The healthy readout that used to
              live here ("60 tools · 20 off") was arithmetic nobody was waiting
              on; `alertOnly` keeps the one case that means the assistant
              cannot run the user's tools at all. */}
          {loaded && (
            <ToolStatusPanel
              alertOnly
              gates={toolGates}
              onOpenSettings={openSettings}
              lastTurn={lastTurnToolAccess}
              approvedToolCount={approvedToolCount}
            />
          )}
        </div>
      </div>
      </div>

      {/* ONE workspace, ONE JSX position. Do not split this back into branches.
          It replaced a `!isMobile` column plus an `isMobile` <Sheet>: two
          sibling branches, so crossing 768 px — rotating the phone — swapped
          which one rendered, and React commits a branch swap as remove +
          insert. Removing an iframe destroys its document with no unload
          event, so the user's running mini-app reloaded on every rotation.
          WorkspaceShell keeps the node still and swaps its class instead, and
          reads its own geometry from the viewport — open/closed is the only
          thing this file still decides about the workspace. */}
      <WorkspaceShell
        open={workspaceOpen}
        userId={user?.id ?? null}
        selectedId={workspaceSelectedId}
        onSelect={setWorkspaceSelectedId}
        onClose={() => setWorkspaceOpen(false)}
      />

      <VoiceNotesPanel open={notesPanelOpen} onClose={() => setNotesPanelOpen(false)} />

      {/* Everything the composer's chip row used to carry. Mounted here, beside
          the other panels, so the composer itself stays a composer. */}
      <CounselToolsSheet
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        readingLabel={
          accessAllNeurons && isPaid
            ? "Reading: all neurons"
            : activeWikis.length > 1
              ? `Reading: ${activeWikis.length} neurons`
              : `Reading: ${activeWiki?.name || "no neuron"}`
        }
        onAttachImage={() => fileInputRef.current?.click()}
        onOpenResearchSettings={() => openSettings("research")}
        contextBookCount={contextBooks.length}
        onOpenBooks={() => setBooksPickerOpen(true)}
        workspaceCount={workspaceCount}
        workspaceOpen={workspaceOpen}
        onToggleWorkspace={() => setWorkspaceOpen((v) => !v)}
        notesOpen={notesPanelOpen}
        onToggleNotes={() => setNotesPanelOpen((v) => !v)}
        deepResearch={chatDeepResearch}
        deepResearchAllowed={isPaid}
        onToggleDeepResearch={() => {
          if (!isPaid) { setToolsOpen(false); openPricing("deep-research"); return; }
          setChatDeepResearch(!chatDeepResearch);
        }}
        autoReadReplies={autoReadReplies}
        onToggleReadAloud={() => { if (autoReadReplies) stopSpeaking(); setAutoReadReplies(!autoReadReplies); }}
        webSearchAvailable={!!burplexityApiToken}
        webSearchBusy={deepSearching}
        webSearchDisabled={deepSearching || !input.trim() || isLoading}
        onWebSearch={handleDeepWebSearch}
        onManagePrompts={() => openSettings("prompts")}
        onOpenSettings={() => openSettings()}
        canClear={messages.length > 0}
        wormEnabled={worm.enabled}
        onToggleWorm={() => worm.setEnabled(!worm.enabled)}
        onClear={() => { stopSpeaking(); clearChat(); }}
      />
    </div>
  );
};

export default ChatPanel;
