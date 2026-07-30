import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useApp } from "@/context/AppContext";
import { useChatSettings } from "@/hooks/useChatSettings";
import { usePlan } from "@/hooks/usePlan";
import { computeLockedWikiIds } from "@/lib/neuronAccess";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { buildChatSystemPrompt, type UsedMemory } from "@/lib/buildChatSystemPrompt";
import { findSentenceCapIndex, truncateAtSentenceCap } from "@/lib/sentenceCap";
import { isReflexEnabled } from "@/lib/reflex";
import { CHAT_TOOL_DEFINITIONS, executeChatTool, ToolEvent } from "@/lib/chatTools";
import type { ChatImageRef } from "@/lib/imageGen";
import type { ChatVideoRef } from "@/lib/videoGen";
import type { ChatSplatRef } from "@/lib/splatGen";
import { parseBlocks, type ResponseBlock } from "@/lib/responseBlocks";
import { parseArtifact, type Artifact } from "@/lib/artifacts";
import { workspaceStore, deriveResearchTitle } from "@/lib/workspaceStore";
import { toast } from "sonner";
import { isEmbeddingModel } from "@/lib/utils";

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  toolEvents?: ToolEvent[];
  displayOnly?: boolean;
  /** Validated structured blocks to render (from the render_blocks tool). */
  blocks?: ResponseBlock[];
  /** Sandboxed HTML/SVG artifact to render (from the create_artifact tool). */
  artifact?: Artifact;
  /** Id of the durable Workspace item this artifact was captured as (so the
   *  bubble can open it in the Workspace panel). */
  workspaceItemId?: string;
  /** Memory entries injected into the prompt for this reply — shown as a
   *  transparency chip ("Drew on N memories") under the bubble. */
  usedMemories?: UsedMemory[];
  /** Generated/recalled images rendered inline in the bubble (from the
   *  generate_image / edit_image / show_image tools). */
  images?: ChatImageRef[];
  /** Generated video clips rendered inline in the bubble (from the
   *  generate_video / show_video tools). Each resolves live via its job_id. */
  videos?: ChatVideoRef[];
  /** Generated 3D Gaussian splats rendered inline (from generate_splat /
   *  show_splat). Each resolves live via its fal request_id. */
  splats?: ChatSplatRef[];
  /** True for messages loaded from history (initial load / earlier pages)
   *  rather than produced live this session. Restored media renders
   *  collapsed — an expandable card instead of eagerly fetching every
   *  signed URL / job row the moment an old transcript opens. */
  restored?: boolean;
}

interface SendOpts {
  /** When true, the system prompt asks for concise, spoken-friendly replies. */
  voiceMode?: boolean;
  /** Optional override model — e.g. fast voice model. */
  modelOverride?: string;
  /** Called on every streamed delta with the cumulative assistant text. */
  onDelta?: (fullText: string) => void;
  /** Skip the user's max-sentences cap for this send (Digest — explicitly
   *  long-form). Deep Research turns are exempted automatically. */
  capExempt?: boolean;
  /** Image attachments to send with this turn (multimodal user content).
   *  `ref` is the image_attachments row created at send time — it makes the
   *  upload a first-class library image the assistant can act on, and is
   *  persisted on the user message so the id survives reloads. */
  images?: Array<{ dataUrl: string; mime?: string; ref?: ChatImageRef; memoryId?: string; storagePath?: string }>;
}

interface ChatContextValue {
  messages: ChatMessage[];
  isLoading: boolean;
  /** Legacy combined flag — true if either tab has Deep Research on. Kept for backward compat. */
  deepResearch: boolean;
  /** Deprecated: writes to the chat-tab flag (preserves old call sites). */
  setDeepResearch: (v: boolean) => void;
  chatDeepResearch: boolean;
  setChatDeepResearch: (v: boolean) => void;
  voiceDeepResearch: boolean;
  setVoiceDeepResearch: (v: boolean) => void;
  sendMessage: (text: string, opts?: SendOpts) => Promise<string>;
  injectDisplayMessage: (content: string) => void;
  clearChat: () => Promise<void>;
  abort: () => void;
  /** Keyset-page older history above the loaded window. Resolves with the
   *  number of messages prepended (0 = nothing older / call superseded). */
  loadEarlier: () => Promise<number>;
  hasEarlier: boolean;
  loadingEarlier: boolean;
}

const ChatContext = createContext<ChatContextValue | null>(null);

const MAX_TOOL_ITERATIONS = 5;

// ── Sliding-window history ───────────────────────────────────────────────
// Long-context research (LongMemEval, "context rot") shows models get WORSE
// — not just slower/pricier — when every past turn is re-sent verbatim. So
// each request carries only the last HISTORY_WINDOW messages plus a rolling
// summary of everything older. The summary is refreshed in the background
// (off the critical path) once at least SUMMARY_MIN_BATCH messages have
// fallen out of the window.
const HISTORY_WINDOW = 20;
const SUMMARY_MIN_BATCH = 6;
/** Absolute most messages ever serialized into one request — the sliding
 *  window handles quality; this guards cost/context when no summary exists. */
const HISTORY_HARD_CAP = 60;
const SUMMARY_STORE_KEY = (uid: string) => `bw_chat_summary_${uid}`;

// ── Cross-device history paging ──────────────────────────────────────────
// The transcript loads the NEWEST window and pages older messages by keyset
// cursor on (created_at, id) — the tuple the idx_chat_messages_user_created
// index walks. Offset paging is both slower and unstable while new messages
// arrive; keyset is the standard fix.
const INITIAL_LOAD = 200;
const EARLIER_PAGE = 100;

/** Map a chat_messages row to the client shape. `restored` marks messages
 *  loaded from history so their media renders collapsed. */
const rowToMessage = (m: any, restored: boolean): ChatMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  restored: restored || undefined,
  images: Array.isArray(m.images) && m.images.length > 0 ? m.images : undefined,
  videos: Array.isArray(m.videos) && m.videos.length > 0 ? m.videos : undefined,
  splats: Array.isArray(m.splats) && m.splats.length > 0 ? m.splats : undefined,
});

interface RollingSummary {
  summary: string;
  /** How many leading messages of the conversation the summary covers. */
  covered: number;
  /** Id of the FIRST message of the history the count was computed against.
   *  `covered` is an index into a specific array — if the loaded window now
   *  starts elsewhere ("Load earlier" prepended, or a different device's
   *  window), the count is meaningless and must be re-anchored. */
  anchorId?: string;
}

function loadRollingSummary(uid: string): RollingSummary {
  try {
    const raw = localStorage.getItem(SUMMARY_STORE_KEY(uid));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.summary === "string" && typeof parsed?.covered === "number") {
        return {
          summary: parsed.summary,
          covered: parsed.covered,
          anchorId: typeof parsed?.anchorId === "string" ? parsed.anchorId : undefined,
        };
      }
    }
  } catch { /* corrupted/missing — start fresh */ }
  return { summary: "", covered: 0 };
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const { books, activeBookId, activeWiki, activeWikiId, activeWikis, wikis, addChapter, updateChapter, removeChapter, setActiveBookSilent } = useApp();

  const { apiKey, selectedModel, deepResearchModel, customSystemPrompt, burplexityApiToken, accessAllNeurons, maxReplySentences, visionModel, imageModelPrimary, imageModelFallback,
    videoModelPrimary, videoDefaultDuration, videoDefaultResolution, videoDefaultAspect, videoGenerateAudio, videoConfirmThreshold,
    videoIdentityScale, videoQcEnabled, videoMotionModel,
    falApiKey, splatModelPrimary, splatDefaultQuality, splatMaxFileMb, splatConfirmThreshold, splatMonthlyQuota, splatAutoFallback } = useChatSettings();
  const { isPaid, loaded: planLoaded } = usePlan();
  const { getActiveBodyForScope, migrate } = usePromptPresets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [chatDeepResearch, setChatDeepResearch] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("chat_deep_research") === "1");
  const [voiceDeepResearch, setVoiceDeepResearch] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("voice_deep_research") === "1");
  useEffect(() => { localStorage.setItem("chat_deep_research", chatDeepResearch ? "1" : "0"); }, [chatDeepResearch]);
  useEffect(() => { localStorage.setItem("voice_deep_research", voiceDeepResearch ? "1" : "0"); }, [voiceDeepResearch]);
  // One-time seed of prompt presets from legacy customSystemPrompt.
  const migratedPromptsRef = useRef(false);
  useEffect(() => {
    if (migratedPromptsRef.current) return;
    if (!customSystemPrompt) return;
    migratedPromptsRef.current = true;
    migrate(customSystemPrompt);
  }, [customSystemPrompt, migrate]);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(false);
  const summaryRef = useRef<RollingSummary>({ summary: "", covered: 0 });
  const summarizingRef = useRef(false);

  useEffect(() => {
    summaryRef.current = user ? loadRollingSummary(user.id) : { summary: "", covered: 0 };
  }, [user?.id]);

  /** Background refresh of the rolling summary — never on the critical path
   *  of a send. Merges messages that fell out of the window into the stored
   *  summary so the NEXT turn can drop them from the request. */
  const updateRollingSummary = useCallback(
    async (allMsgs: { role: string; content: string }[], anchorId: string | undefined) => {
      if (!user || !apiKey || summarizingRef.current) return;
      const target = allMsgs.length - HISTORY_WINDOW;
      let cur = summaryRef.current;
      // Window start moved since `covered` was computed (prepend / other
      // device): the count no longer indexes this array. Keep the summary
      // text — the merge prompt absorbs re-summarized overlap — but restart
      // the count from zero against the current window.
      if (cur.covered > 0 && cur.anchorId !== anchorId) {
        cur = { summary: cur.summary, covered: 0, anchorId: undefined };
        summaryRef.current = cur;
      }
      if (target <= 0 || target <= cur.covered) return;
      // Batch: don't pay an LLM call every turn for 2 messages.
      if (cur.covered > 0 && target - cur.covered < SUMMARY_MIN_BATCH) return;
      const model = selectedModel;
      if (!model || isEmbeddingModel(model)) return;
      const batch = allMsgs.slice(cur.covered, target);
      if (batch.length === 0) return;
      let transcript = batch
        .map((m) => `${m.role}: ${(m.content || "").slice(0, 600)}`)
        .join("\n\n");
      if (transcript.length > 30000) transcript = transcript.slice(-30000);
      summarizingRef.current = true;
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": window.location.origin,
            "X-Title": "Chapter Craft",
          },
          body: JSON.stringify({
            model,
            stream: false,
            max_tokens: 500,
            messages: [
              {
                role: "system",
                content:
                  "You maintain a running summary of a conversation between a user and a reading assistant. Merge the existing summary (if any) with the new messages into ONE concise summary of at most ~250 words. Preserve concrete facts, names, numbers, decisions, books/chapters discussed, and open questions. Output ONLY the summary text.",
              },
              {
                role: "user",
                content: `${cur.summary ? `EXISTING SUMMARY:\n${cur.summary}\n\n` : ""}NEW MESSAGES:\n${transcript}`,
              },
            ],
          }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const text = (data?.choices?.[0]?.message?.content || "").trim();
        if (!text) return;
        const next: RollingSummary = { summary: text.slice(0, 4000), covered: target, anchorId };
        summaryRef.current = next;
        try { localStorage.setItem(SUMMARY_STORE_KEY(user.id), JSON.stringify(next)); } catch { /* storage full */ }
      } catch { /* background — never surface */ } finally {
        summarizingRef.current = false;
      }
    },
    [user, apiKey, selectedModel]
  );

  // Bind the durable Workspace store to the signed-in user so its files sync
  // from Supabase (cross-device) and stream live via realtime.
  useEffect(() => {
    workspaceStore.setUser(user?.id ?? null);
  }, [user]);

  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Keyset cursor = (created_at, id) of the OLDEST loaded message.
  const cursorRef = useRef<{ createdAt: string; id: string } | null>(null);

  useEffect(() => {
    if (!user) {
      setMessages([]);
      setHasEarlier(false);
      cursorRef.current = null;
      loadedRef.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      // DESCENDING + reverse: the window must anchor to the NEWEST messages.
      // The old ascending+limit query returned the first 200 messages EVER —
      // for anyone past 200 lifetime messages, recent conversation silently
      // never loaded, which read as "my chat doesn't persist across devices".
      // `images`/`videos`/`splats` are newer columns — cascade to older
      // selects if a migration hasn't been applied yet so history never
      // fails to load entirely.
      const loadSel = (cols: string) => supabase
        .from("chat_messages")
        .select(cols as any)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(INITIAL_LOAD) as any;
      let { data, error } = await loadSel("id, role, content, created_at, images, videos, splats");
      if (error) ({ data, error } = await loadSel("id, role, content, created_at, images, videos"));
      if (error) ({ data, error } = await loadSel("id, role, content, created_at, images"));
      if (error) ({ data, error } = await loadSel("id, role, content, created_at"));
      if (cancelled) return;
      if (error) {
        console.error("Failed to load chat history:", error);
        loadedRef.current = true;
        return;
      }
      const rows: any[] = data || [];
      if (rows.length > 0) {
        const oldest = rows[rows.length - 1]; // descending order → last = oldest
        cursorRef.current = { createdAt: oldest.created_at, id: oldest.id };
      }
      setHasEarlier(rows.length === INITIAL_LOAD);
      setMessages(
        rows
          .filter((m: any) => m.role === "user" || m.role === "assistant")
          .map((m: any) => rowToMessage(m, true))
          .reverse() // back to chronological for rendering
      );
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // Depend on the id, not the object: supabase-js emits a fresh user object
    // on every TOKEN_REFRESHED (~hourly) — an object dep would silently
    // refetch-and-replace the transcript mid-session, collapsing this
    // session's media into restored cards and dropping tool chips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const loadEarlier = useCallback(async (): Promise<number> => {
    if (!user || loadingEarlier || !cursorRef.current) return 0;
    setLoadingEarlier(true);
    // The cursor object doubles as a ticket: clearChat and sign-out null it,
    // and a superseding page replaces it — a fetch that resolves after either
    // must not prepend rows into a cleared (or someone else's) transcript.
    const ticket = cursorRef.current;
    try {
      const { createdAt, id } = ticket;
      // Strictly-older-than-cursor on the (created_at, id) tuple; values are
      // quoted because timestamps contain PostgREST-reserved characters.
      const sel = (cols: string) => supabase
        .from("chat_messages")
        .select(cols as any)
        .eq("user_id", user.id)
        .or(`created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt."${id}")`)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(EARLIER_PAGE) as any;
      let { data, error } = await sel("id, role, content, created_at, images, videos, splats");
      if (error) ({ data, error } = await sel("id, role, content, created_at, images, videos"));
      if (error) ({ data, error } = await sel("id, role, content, created_at, images"));
      if (error) ({ data, error } = await sel("id, role, content, created_at"));
      if (error) {
        console.error("Failed to load earlier messages:", error);
        return 0;
      }
      if (cursorRef.current !== ticket) return 0; // cleared/signed out mid-flight
      const rows: any[] = data || [];
      let older: ChatMessage[] = [];
      if (rows.length > 0) {
        const oldest = rows[rows.length - 1];
        cursorRef.current = { createdAt: oldest.created_at, id: oldest.id };
        older = rows
          .filter((m: any) => m.role === "user" || m.role === "assistant")
          .map((m: any) => rowToMessage(m, true))
          .reverse();
        setMessages((prev) => [...older, ...prev]);
      }
      setHasEarlier(rows.length === EARLIER_PAGE);
      return older.length;
    } finally {
      setLoadingEarlier(false);
    }
  }, [user, loadingEarlier]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`chat-messages-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const m: any = payload.new;
          if (!m) return;
          if (m.role !== "user" && m.role !== "assistant") return;
          setMessages((prev) => {
            // Our own inserts echo back here too — messages carry their DB id
            // from birth (client-generated), so the id check always catches
            // them. What remains are turns from OTHER devices: live activity,
            // rendered expanded (not `restored`).
            if (prev.some((x) => x.id === m.id)) return prev;
            return [...prev, rowToMessage(m, false)];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "chat_messages", filter: `user_id=eq.${user.id}` },
        () => {
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // Same as the load effect: id, not object — don't tear down and resubscribe
    // the realtime channel on every token refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const persistMessage = useCallback(
    // The id is CLIENT-generated (crypto.randomUUID) and already stamped on
    // the local message before this runs. That makes the realtime echo of our
    // own insert exactly deduplicatable — the old flow attached the id only
    // after the insert round-trip, and an echo racing that window would have
    // duplicated the bubble.
    async (id: string, role: "user" | "assistant", content: string, bookId?: string | null, images?: ChatImageRef[], videos?: ChatVideoRef[], splats?: ChatSplatRef[]): Promise<void> => {
      if (!user) return;
      const base: any = { id, user_id: user.id, role, content, book_id: bookId || null };
      // `images`/`videos`/`splats` are newer columns — cascade to fewer extras
      // if a migration hasn't been applied yet (media stays safe in its own
      // table, and dropping one column must not also drop the others).
      const ins = (row: any) => supabase.from("chat_messages").insert(row);
      const hasImages = !!images && images.length > 0;
      const hasVideos = !!videos && videos.length > 0;
      const hasSplats = !!splats && splats.length > 0;
      const full: any = { ...base };
      if (hasImages) full.images = images;
      if (hasVideos) full.videos = videos;
      if (hasSplats) full.splats = splats;
      // 23505 (duplicate key) means a previous attempt actually committed and
      // only its response was lost — the row exists WITH full media: success.
      // Only a missing column (42703) justifies retrying with fewer fields;
      // any other error (offline, RLS) would fail every retry identically.
      const done = (e: any) => !e || e.code === "23505";
      const colMissing = (e: any) => e?.code === "42703";
      let { error } = await ins(full);
      if (done(error)) return;
      if (colMissing(error) && hasSplats) {
        const noSplats: any = { ...base };
        if (hasImages) noSplats.images = images;
        if (hasVideos) noSplats.videos = videos;
        ({ error } = await ins(noSplats));
        if (done(error)) return;
      }
      if (colMissing(error) && hasVideos) {
        const noVideos: any = { ...base };
        if (hasImages) noVideos.images = images;
        ({ error } = await ins(noVideos));
        if (done(error)) return;
      }
      if (colMissing(error) && hasImages) {
        ({ error } = await ins(base));
        if (done(error)) return;
      }
      if (error) console.error("Failed to persist chat message:", error);
    },
    [user]
  );

  const clearChat = useCallback(async () => {
    abortRef.current?.abort();
    setMessages([]);
    setHasEarlier(false);
    cursorRef.current = null;
    summaryRef.current = { summary: "", covered: 0 };
    if (user) {
      try { localStorage.removeItem(SUMMARY_STORE_KEY(user.id)); } catch { /* ignore */ }
      const { error } = await supabase.from("chat_messages").delete().eq("user_id", user.id);
      if (error) console.error("Failed to clear chat history:", error);
    }
    toast.success("Chat cleared");
  }, [user]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string, opts?: SendOpts): Promise<string> => {
      const trimmed = text.trim();
      if (!trimmed) return "";
      if (!apiKey) {
        toast.error("Set your OpenRouter API key first");
        throw new Error("Missing API key");
      }

      const selectedBook = books.find((b) => b.id === activeBookId);
      // Uploaded images that were registered in the library carry a ref —
      // attach those to the user message so (a) the bubble renders them
      // durably and (b) every future history rebuild can re-annotate the ids.
      const uploadRefs: ChatImageRef[] = (opts?.images || [])
        .map((i) => i.ref)
        .filter((r): r is ChatImageRef => !!r);
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed, images: uploadRefs.length > 0 ? uploadRefs : undefined };
      setMessages((prev) => [...prev, userMsg]);
      void persistMessage(userMsg.id!, "user", trimmed, activeBookId, uploadRefs.length > 0 ? uploadRefs : undefined);

      setIsLoading(true);

      const hasUploads = !!opts?.images && opts.images.length > 0;
      // Durable image handles: any message carrying image refs (user uploads
      // or assistant-generated) gets a text note with the image_id, so the
      // model can act on the image in ANY later turn — the pixels themselves
      // are only sent for the current upload turn (vision is per-turn; the
      // model re-inspects older images via view_image). Same note format the
      // memory system already uses; the system prompt says to use, never
      // emit, these notes.
      const imageIdNote = (imgs: ChatImageRef[] | undefined): string =>
        imgs && imgs.length > 0
          ? imgs.map((im) => `[Attached image — image_id: ${im.id}${im.prompt ? ` — "${im.prompt.slice(0, 80)}"` : ""}]`).join("\n")
          : "";
      const historySource = [...messages, userMsg].filter((m) => !m.displayOnly);
      // Anchors the rolling summary's `covered` count to this exact window —
      // see RollingSummary.anchorId.
      const firstHistoryId = historySource[0]?.id;
      const baseHistory = historySource
        .map((m, i, arr) => {
          const note = imageIdNote(m.images);
          // Multimodal injection: turn the latest user message into a
          // [text, image_url[]] content array when this send has uploads.
          if (hasUploads && i === arr.length - 1 && m.role === "user") {
            return {
              role: "user",
              content: [
                { type: "text", text: (m.content || "(see attached image)") + (note ? `\n\n${note}` : "") },
                ...opts!.images!.map((img) => ({
                  type: "image_url",
                  image_url: { url: img.dataUrl },
                })),
              ],
            } as any;
          }
          return { role: m.role, content: note ? `${m.content}\n\n${note}` : m.content };
        });

      const isVoice = !!opts?.voiceMode;
      // Deep Research is a paid feature — enforced here so every send path
      // (chat, voice, hands-free) respects the plan regardless of toggle state.
      const deepResearch = (isVoice ? voiceDeepResearch : chatDeepResearch) && isPaid;
      const scopedPromptBody = getActiveBodyForScope(isVoice ? "voice" : "chat");
      const promptToInject = scopedPromptBody || customSystemPrompt;
      // Hard per-reply sentence cap (user setting; 0 = off). Digest passes
      // capExempt and Deep Research turns are exempt — both are long-form by
      // request. Enforced three ways: prompt steering (below), a streaming
      // abort at the boundary, and a final truncation invariant pre-persist.
      const sentenceCap = !opts?.capExempt && !deepResearch && maxReplySentences > 0 ? maxReplySentences : 0;

      // Neuron scope: by default the AI reads ONLY the active neuron. The
      // "Access all neurons" toggle widens that — paid plans only. The same
      // rule is enforced in chatTools (search_wiki) and, ultimately, by RLS:
      // locked-neuron content never leaves the database for free accounts.
      const allNeurons = accessAllNeurons && isPaid;
      const lockedIds = computeLockedWikiIds(wikis, isPaid, planLoaded);
      // Locked neurons keep scoping retrieval (RLS hides their content) but
      // their names are withheld from the prompt — same rule as before, now
      // applied per member of the loaded set.
      const activeNeurons = (activeWikis.length > 0 ? activeWikis : activeWiki ? [activeWiki] : [])
        .map((w) => ({ id: w.id, name: lockedIds.has(w.id) ? "" : w.name }));

      const { prompt: systemPrompt, usedMemories } = await buildChatSystemPrompt({
        books,
        selectedBook,
        deepResearch,
        voiceMode: isVoice,
        latestUserQuery: trimmed,
        customSystemPrompt: promptToInject,
        activeNeurons,
        allNeurons,
        reflex: isReflexEnabled(),
        maxReplySentences: sentenceCap,
      });

      // Sliding window: replace messages older than the window with the
      // rolling summary (when one exists). Until the background summarizer
      // has caught up, the uncovered prefix is still sent verbatim so no
      // context is ever silently dropped.
      let historyForModel = baseHistory;
      let summaryNote: string | null = null;
      const rolling = summaryRef.current;
      // The summary's `covered` count only means anything while the loaded
      // window still starts at the same message it was computed against —
      // "Load earlier" prepends and cross-device window shifts both move the
      // start, and a misaligned cut would drop the wrong messages.
      const anchored = !!rolling.anchorId && rolling.anchorId === firstHistoryId;
      if (baseHistory.length > HISTORY_WINDOW && rolling.summary && rolling.covered > 0 && anchored) {
        const cut = Math.min(rolling.covered, baseHistory.length - HISTORY_WINDOW);
        if (cut > 0) {
          historyForModel = baseHistory.slice(cut);
          summaryNote = `## Earlier conversation summary\nThe first ${cut} messages of this conversation were replaced by this summary to save context:\n\n${rolling.summary}`;
        }
      }
      // Hard ceiling regardless of summary state: "Load earlier" can grow the
      // local transcript into the hundreds, and a fresh device has no rolling
      // summary yet — without a cap the whole array would be serialized into
      // one request and blow the model's context.
      if (historyForModel.length > HISTORY_HARD_CAP) {
        historyForModel = historyForModel.slice(-HISTORY_HARD_CAP);
      }

      const assistantEvents: ToolEvent[] = [];
      // Raw web_search answers captured this turn, surfaced as a "full answer"
      // card after the model's synthesized reply.
      const webSearchCards: { answer: string; citations: Array<{ title?: string; url: string; snippet?: string }> }[] = [];
      // Structured block sets emitted via the render_blocks tool this turn.
      const blockSets: ResponseBlock[][] = [];
      // Artifacts emitted via the create_artifact tool this turn.
      const artifacts: Artifact[] = [];
      // Images generated/recalled via the image tools this turn — rendered
      // inline in the assistant's bubble and persisted with the message.
      const turnImages: ChatImageRef[] = [];
      const turnVideos: ChatVideoRef[] = [];
      const turnSplats: ChatSplatRef[] = [];
      let assistantText = "";
      // Sentence-cap segment anchor: the cap applies to each tool-iteration's
      // PROSE segment (text after the previous tool round), so capping the
      // model's pre-tool narration can never swallow its post-tool answer.
      let capSegStart = 0;
      // The streaming bubble carries its DB id from birth and every update
      // targets it BY ID — never "the last assistant message". With realtime
      // on, a turn finishing on another device appends a bubble at the end
      // mid-stream, and last-assistant targeting would overwrite it.
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", toolEvents: [], usedMemories: usedMemories.length > 0 ? usedMemories : undefined }]);

      const updateAssistant = () => {
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].id === assistantId) {
              copy[i] = {
                ...copy[i],
                content: assistantText,
                toolEvents: [...assistantEvents],
                images: turnImages.length > 0 ? [...turnImages] : copy[i].images,
                videos: turnVideos.length > 0 ? [...turnVideos] : copy[i].videos,
                splats: turnSplats.length > 0 ? [...turnSplats] : copy[i].splats,
              };
              break;
            }
          }
          return copy;
        });
      };

      const model = opts?.modelOverride
        || (hasUploads && visionModel ? visionModel : (deepResearch ? deepResearchModel : selectedModel));
      if (isEmbeddingModel(model)) {
        const msg = `"${model}" is an embedding model — pick a chat model in Settings (it's only valid for Wiki reindex).`;
        toast.error(msg);
        assistantText = `❌ ${msg}`;
        updateAssistant();
        setIsLoading(false);
        return;
      }
      const workingMessages: any[] = [
        { role: "system", content: systemPrompt },
        ...(summaryNote ? [{ role: "system", content: summaryNote }] : []),
        ...historyForModel,
      ];

      abortRef.current = new AbortController();

      try {
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
          capSegStart = assistantText.length;
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "HTTP-Referer": window.location.origin,
              "X-Title": "Chapter Craft",
            },
            body: JSON.stringify({
              model,
              messages: workingMessages,
              tools: CHAT_TOOL_DEFINITIONS,
              tool_choice: "auto",
              stream: true,
            }),
            signal: abortRef.current.signal,
          });

          if (!response.ok) {
            const errText = await response.text();
            if (response.status === 401) throw new Error("Invalid API key.");
            if (response.status === 402) throw new Error("Insufficient credits.");
            if (response.status === 429) throw new Error("Rate limited. Try again.");
            throw new Error(`OpenRouter error (${response.status}): ${errText}`);
          }

          const reader = response.body?.getReader();
          if (!reader) throw new Error("No response stream");
          const decoder = new TextDecoder();
          let buffer = "";
          let iterText = "";
          const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {};
          let finishReason: string | null = null;
          // Cap state for THIS iteration: once the cut lands the prose is
          // frozen but the stream keeps draining — models narrate BEFORE
          // emitting tool calls, and cancelling at the cut used to silently
          // kill the very action the narration promised.
          let iterCapped = false;
          let capDrops = 0; // content deltas discarded since the cut

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) !== -1) {
              let line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (jsonStr === "[DONE]") break;
              try {
                const parsed = JSON.parse(jsonStr);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta;
                if (delta?.content) {
                  if (iterCapped) {
                    // Past the cut: discard beyond-cap prose but keep draining
                    // so any tool calls behind the narration still arrive.
                    capDrops++;
                  } else {
                    iterText += delta.content;
                    assistantText += delta.content;
                    // Sentence cap on this iteration's prose segment — check
                    // only at possible boundaries, never once tool deltas
                    // have started streaming.
                    if (sentenceCap > 0 && Object.keys(toolCallAcc).length === 0 && /[.!?…。！？\n]/.test(delta.content)) {
                      const cut = findSentenceCapIndex(iterText, sentenceCap, { streaming: true });
                      if (cut !== null) {
                        iterCapped = true;
                        iterText = iterText.slice(0, cut).trimEnd();
                        assistantText = assistantText.slice(0, capSegStart) + iterText;
                      }
                    }
                    updateAssistant();
                    try { opts?.onDelta?.(assistantText); } catch {}
                  }
                }
                if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAcc[idx]) toolCallAcc[idx] = { args: "" };
                    if (tc.id) toolCallAcc[idx].id = tc.id;
                    if (tc.function?.name) toolCallAcc[idx].name = tc.function.name;
                    if (tc.function?.arguments) toolCallAcc[idx].args += tc.function.arguments;
                  }
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
              } catch {
              }
            }
            // Cost valve: ~40 dropped prose deltas after the cut with ZERO
            // tool activity ⇒ provably a prose-only reply — stop paying for
            // it. (Any tool delta present ⇒ drain to the natural end.)
            if (iterCapped && capDrops >= 40 && Object.keys(toolCallAcc).length === 0) break;
          }

          if (iterCapped && capDrops >= 40 && Object.keys(toolCallAcc).length === 0) {
            // Capped prose-only reply: cancel the stream, then fall through
            // to the normal persistence/summary path with the frozen text.
            try { void reader.cancel(); } catch { /* stream already closed */ }
            break;
          }

          const toolCalls = Object.values(toolCallAcc).filter((t) => t.name);
          if (toolCalls.length === 0 || finishReason !== "tool_calls") {
            break;
          }

          workingMessages.push({
            role: "assistant",
            content: iterText || null,
            tool_calls: toolCalls.map((t, i) => ({
              id: t.id || `call_${iteration}_${i}`,
              type: "function",
              function: { name: t.name, arguments: t.args || "{}" },
            })),
          });

          // Vision payloads requested via view_image this round — injected as a
          // user message AFTER the tool results (tool messages are text-only).
          const visionPayloads: string[] = [];

          for (let i = 0; i < toolCalls.length; i++) {
            const t = toolCalls[i];
            const { result, event } = await executeChatTool(t.name!, t.args || "{}", {
              books,
              activeBookId,
              setActiveBookId: setActiveBookSilent,
              addChapter,
              updateChapter,
              removeChapter,
              burplexityApiToken,
              openRouterApiKey: apiKey,
              isPaid,
              imageModelPrimary,
              imageModelFallback,
              videoModelPrimary,
              videoDefaultDuration,
              videoDefaultResolution,
              videoDefaultAspect,
              videoGenerateAudio,
              videoConfirmThreshold,
              videoIdentityScale,
              videoQcEnabled,
              videoMotionModel,
              falApiKey,
              splatModelPrimary,
              splatDefaultQuality,
              splatMaxFileMb,
              splatConfirmThreshold,
              splatMonthlyQuota,
              splatAutoFallback,
            });

            assistantEvents.push(event);
            const r = result as any;
            // Strip UI side-channel fields before the result goes to the model.
            let modelResult = result;
            if (r && typeof r === "object") {
              if (Array.isArray(r.__images) && r.__images.length > 0) {
                turnImages.push(...r.__images);
              }
              if (Array.isArray(r.__videos) && r.__videos.length > 0) {
                turnVideos.push(...r.__videos);
              }
              if (Array.isArray(r.__splats) && r.__splats.length > 0) {
                turnSplats.push(...r.__splats);
              }
              if (typeof r.__vision === "string" && r.__vision.startsWith("data:")) {
                visionPayloads.push(r.__vision);
              }
              if ("__images" in r || "__videos" in r || "__splats" in r || "__vision" in r) {
                const { __images, __videos, __splats, __vision, ...clean } = r;
                modelResult = clean;
              }
            }
            updateAssistant();
            if (t.name === "web_search" && r && typeof r === "object" && r.answer) {
              webSearchCards.push({ answer: String(r.answer), citations: Array.isArray(r.citations) ? r.citations : [] });
            }
            if (t.name === "render_blocks") {
              const blocks = parseBlocks(t.args || "{}");
              if (blocks.length) blockSets.push(blocks);
            }
            if (t.name === "create_artifact") {
              const art = parseArtifact(t.args || "{}");
              if (art) artifacts.push(art);
            }
            workingMessages.push({
              role: "tool",
              tool_call_id: t.id || `call_${iteration}_${i}`,
              name: t.name,
              content: JSON.stringify(modelResult).slice(0, 24000),
            });
          }

          if (visionPayloads.length > 0) {
            workingMessages.push({
              role: "user",
              content: [
                { type: "text", text: "[System: image(s) loaded via view_image — inspect them to answer the user's question.]" },
                ...visionPayloads.map((url) => ({ type: "image_url", image_url: { url } })),
              ],
            });
          }
        }

        if (!assistantText && assistantEvents.length === 0) {
          assistantText = "(No response received)";
          updateAssistant();
        }

        // Cap invariant: the FINAL prose segment (text after the last tool
        // round; the whole reply when no tools ran) is truncated at the cap
        // boundary before persisting — even if it streamed too fast for the
        // freeze to land. Earlier segments were already frozen as they
        // streamed, so persisted === shown === summarized === spoken.
        if (sentenceCap > 0 && assistantText.length > capSegStart) {
          const seg = assistantText.slice(capSegStart);
          const capped = truncateAtSentenceCap(seg, sentenceCap);
          if (capped !== seg) {
            assistantText = assistantText.slice(0, capSegStart) + capped;
            updateAssistant();
          }
        }

        if (assistantText || turnImages.length > 0 || turnVideos.length > 0 || turnSplats.length > 0) {
          // The bubble already carries assistantId — the realtime echo of this
          // insert dedupes against it by id.
          await persistMessage(assistantId, "assistant", assistantText, activeBookId, turnImages.length > 0 ? turnImages : undefined, turnVideos.length > 0 ? turnVideos : undefined, turnSplats.length > 0 ? turnSplats : undefined);
        }

        // Surface any artifacts the model created this turn. Persist each into
        // the durable Workspace first (survives tab switches / reloads / devices)
        // and link the created item id onto the bubble so tapping it opens the
        // Workspace panel.
        if (artifacts.length) {
          const created = artifacts.map((artifact) =>
            workspaceStore.add({
              userId: user?.id ?? null,
              kind: artifact.kind === "svg" ? "svg" : "html",
              title: artifact.title,
              content: artifact.content,
              meta: { source: "Artifact" },
            })
          );
          setMessages((prev) => [
            ...prev,
            ...artifacts.map((artifact, idx) => ({
              id: `artifact-${Date.now()}-${idx}`,
              role: "assistant" as const,
              content: "",
              artifact,
              workspaceItemId: created[idx]?.id,
              displayOnly: true,
            })),
          ]);
        }

        // Render any structured blocks the model emitted this turn.
        if (blockSets.length) {
          setMessages((prev) => [
            ...prev,
            ...blockSets.map((blocks, idx) => ({
              id: `blocks-${Date.now()}-${idx}`,
              role: "assistant" as const,
              content: "",
              blocks,
              displayOnly: true,
            })),
          ]);
        }

        // Surface the complete raw web_search answer(s) + sources as a card
        // below the model's synthesized reply, so nothing is lost to summarizing.
        if (webSearchCards.length) {
          setMessages((prev) => [
            ...prev,
            ...webSearchCards.map((card, idx) => {
              let md = `📄 **Full search answer**\n\n${card.answer}`;
              if (card.citations.length) {
                md += `\n\n**Sources:**\n` + card.citations
                  .map((c, i) => `${i + 1}. ${c.title ? `[${c.title}](${c.url})` : c.url}`)
                  .join("\n");
              }
              return { id: `websearch-card-${Date.now()}-${idx}`, role: "assistant" as const, content: md, displayOnly: true };
            }),
          ]);
          // Persist research answers to the durable Workspace.
          webSearchCards.forEach((card) =>
            workspaceStore.add({
              userId: user?.id ?? null,
              kind: "research",
              title: deriveResearchTitle(card.answer, trimmed),
              content: card.answer,
              meta: {
                query: trimmed,
                citations: card.citations,
                source: deepResearch ? "Deep Research" : "Web Search",
              },
            })
          );
        }

        // Refresh the rolling summary in the background so the NEXT turn can
        // drop old messages from the request. Fire-and-forget by design.
        if (assistantText) {
          void updateRollingSummary([...baseHistory, { role: "assistant", content: assistantText }], firstHistoryId);
        }

        return assistantText;
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return assistantText;
        }
        const msg = err?.message || "Failed to get response";
        toast.error(msg);
        assistantText = `❌ Error: ${msg}`;
        updateAssistant();
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [apiKey, books, activeBookId, chatDeepResearch, voiceDeepResearch, isPaid, planLoaded, accessAllNeurons, maxReplySentences, wikis, activeWiki, activeWikiId, activeWikis, selectedModel, deepResearchModel, visionModel, videoModelPrimary, videoDefaultDuration, videoDefaultResolution, videoDefaultAspect, videoGenerateAudio, videoConfirmThreshold, videoIdentityScale, videoQcEnabled, videoMotionModel, falApiKey, splatModelPrimary, splatDefaultQuality, splatMaxFileMb, splatConfirmThreshold, splatMonthlyQuota, splatAutoFallback, customSystemPrompt, getActiveBodyForScope, burplexityApiToken, messages, persistMessage, updateRollingSummary, addChapter, updateChapter, removeChapter, setActiveBookSilent]
  );


  const injectDisplayMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `inject-${Date.now()}`, role: "assistant", content, displayOnly: true },
    ]);
  }, []);

  return (
    <ChatContext.Provider
      value={{
        messages,
        isLoading,
        deepResearch: chatDeepResearch || voiceDeepResearch,
        setDeepResearch: setChatDeepResearch,
        chatDeepResearch,
        setChatDeepResearch,
        voiceDeepResearch,
        setVoiceDeepResearch,
        sendMessage,
        injectDisplayMessage,
        clearChat,
        abort,
        loadEarlier,
        hasEarlier,
        loadingEarlier,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = (): ChatContextValue => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
};
