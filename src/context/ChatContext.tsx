import React, { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useApp } from "@/context/AppContext";
import { useChatSettings } from "@/hooks/useChatSettings";
import { usePlan } from "@/hooks/usePlan";
import { computeLockedWikiIds } from "@/lib/neuronAccess";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { buildChatSystemPrompt, type UsedMemory } from "@/lib/buildChatSystemPrompt";
import { lensVerdict, type MemoryImageCandidate } from "@/lib/memoryLens";
import { findSentenceCapIndex, truncateAtSentenceCap } from "@/lib/sentenceCap";
import { isReflexEnabled } from "@/lib/reflex";
import { CHAT_TOOL_DEFINITIONS, executeChatTool, ToolEvent, type ToolProposal } from "@/lib/chatTools";
import { TOOL_PERMISSION } from "@/lib/toolPermissions";
import { foundryAvailable } from "@/lib/toolFoundry";
import type { ChatImageRef } from "@/lib/imageGen";
import type { ChatVideoRef } from "@/lib/videoGen";
import type { ChatSplatRef } from "@/lib/splatGen";
import { parseBlocks, type ResponseBlock } from "@/lib/responseBlocks";
import { parseArtifact, type Artifact } from "@/lib/artifacts";
import { workspaceStore, deriveResearchTitle } from "@/lib/workspaceStore";
import { toast } from "sonner";
import { isEmbeddingModel } from "@/lib/utils";
import { describeModel, freeChatProviders, localModelId, modelProvider, providerConfigured, providerKey, providerKeyUrl, providerLabel, resolveModel } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";
import { namespacedNvidiaId, nvidiaModelInfo, nvidiaNoThinkingBody, NVIDIA_STARTER_MODEL } from "@/lib/nvidiaCatalog";
import { blockedTools } from "@/lib/leanMode";
import { namespacedGeminiId, GEMINI_STARTER_MODEL } from "@/lib/geminiCatalog";

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
  /** Memory Lens: repeat-recall images collapsed to tappable chips under the
   *  bubble (ephemeral — chips are re-derived from recall state, not synced). */
  memoryImageChips?: MemoryImageCandidate[];
  /** Tool Foundry: drafted tools awaiting approval — rendered as approval
   *  cards (ephemeral; Settings → Tool Foundry is the canonical surface). */
  toolProposals?: ToolProposal[];
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
  /** Model reasoning ("thinking") streamed alongside the reply — rendered as
   *  a collapsed strip, excluded from the sentence cap and from read-aloud.
   *  Transient: never persisted, never sent back in history. */
  reasoning?: string;
  /** Which model answered this turn, namespaced ("nvidia:vendor/model" or a
   *  bare OpenRouter id). Rendered as a small "via NVIDIA · model" line so
   *  provider is continuously visible, not only on failure. Transient. */
  viaModel?: string;
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
  toolEvents: Array.isArray(m.tool_events) && m.tool_events.length > 0 ? m.tool_events : undefined,
});

/** A row expands to its main message plus one display bubble per persisted
 *  artifact — the same shape the live path renders, with STABLE derived ids
 *  (`{rowId}-artifact-{i}`) so realtime echoes and re-loads dedupe cleanly.
 *  Before the artifacts column existed, sheets vanished from the transcript
 *  on reload while surviving only in the Workspace panel. */
const rowsToMessages = (m: any, restored: boolean): ChatMessage[] => {
  const out: ChatMessage[] = [rowToMessage(m, restored)];
  if (Array.isArray(m.artifacts)) {
    m.artifacts.forEach((raw: unknown, i: number) => {
      const art = parseArtifact(raw);
      if (art) {
        out.push({
          id: `${m.id}-artifact-${i}`,
          role: "assistant",
          content: "",
          artifact: art,
          restored: restored || undefined,
          displayOnly: true,
        });
      }
    });
  }
  return out;
};

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

  const { apiKey, nvidiaKeyLast4, geminiApiKey, tavilyApiKey, leanMode, selectedModel, setSelectedModel, savedModels, addModel, deepResearchModel, customSystemPrompt, burplexityApiToken, accessAllNeurons, maxReplySentences, autoShowMemoryImages, chatToolPermissions, visionModel, imageModelPrimary, imageModelFallback,
    videoModelPrimary, videoDefaultDuration, videoDefaultResolution, videoDefaultAspect, videoGenerateAudio, videoConfirmThreshold,
    videoIdentityScale, videoQcEnabled, videoMotionModel,
    falApiKey, splatModelPrimary, splatDefaultQuality, splatMaxFileMb, splatConfirmThreshold, splatMonthlyQuota, splatAutoFallback } = useChatSettings();
  // Every client-visible credential in one object, so key selection is a
  // registry lookup instead of a branch each new provider must remember to
  // extend. Shipping Gemini WITHOUT this sent Google the OpenRouter key.
  const providerKeys = { apiKey, geminiApiKey, nvidiaKeyLast4 };

  const { isPaid, loaded: planLoaded } = usePlan();
  const { getActiveBodyForScope, migrate } = usePromptPresets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Mirror for callbacks that need the CURRENT transcript without depending
  // on it — see the note at sendMessage's historySource.
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [isLoading, setIsLoading] = useState(false);
  // Tool Foundry gating: OPT-IN (perms === true, inverted from the app's
  // default-allow convention) AND the migration must exist. When either is
  // false the foundry tools are omitted from the model's roster entirely —
  // the model can't attempt what it can't see, so pre-migration there is no
  // mid-chat refusal nagging.
  const forgeOptIn = chatToolPermissions?.forge_tool === true;
  const runOptIn = chatToolPermissions?.run_tool === true;
  const foundryOptIn = forgeOptIn || runOptIn;
  const [foundryReady, setFoundryReady] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!foundryOptIn) { setFoundryReady(false); return; }
    foundryAvailable().then((ok) => { if (alive) setFoundryReady(ok); });
    return () => { alive = false; };
  }, [foundryOptIn]);
  // Gate PER TOOL: with a single combined flag, enabling only "forge" would
  // still advertise run_tool to the model, which then calls it and gets a
  // "not enabled" refusal — exactly the mid-chat nagging this design avoids.
  const forgeEnabled = forgeOptIn && foundryReady;
  const runEnabled = runOptIn && foundryReady;
  const foundryEnabled = forgeEnabled || runEnabled;
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
  // Lean Mode read at TOOL-EXECUTION time, not turn-start: flipping the
  // switch mid-reply must stop the next generation in that same turn.
  const leanModeRef = useRef(leanMode);
  useEffect(() => { leanModeRef.current = leanMode; }, [leanMode]);

  useEffect(() => {
    summaryRef.current = user ? loadRollingSummary(user.id) : { summary: "", covered: 0 };
  }, [user?.id]);

  /** Background refresh of the rolling summary — never on the critical path
   *  of a send. Merges messages that fell out of the window into the stored
   *  summary so the NEXT turn can drop them from the request. */
  const updateRollingSummary = useCallback(
    async (allMsgs: { role: string; content: string }[], anchorId: string | undefined) => {
      if (!user || summarizingRef.current) return;
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
      // Summaries follow the selected model through the same provider seam
      // as chat — with only the OTHER provider's key saved, they'd silently
      // 404 forever otherwise. No key for this provider → skip quietly.
      const { adapter, provider, localId } = resolveModel(model);
      if (!providerConfigured(provider, providerKeys)) return;
      const batch = allMsgs.slice(cur.covered, target);
      if (batch.length === 0) return;
      let transcript = batch
        .map((m) => `${m.role}: ${(m.content || "").slice(0, 600)}`)
        .join("\n\n");
      if (transcript.length > 30000) transcript = transcript.slice(-30000);
      summarizingRef.current = true;
      try {
        const text = (await adapter.completeChat({
          model: localId,
          maxTokens: 500,
          apiKey: providerKey(provider, providerKeys),
          extraBody: provider === "nvidia" ? nvidiaNoThinkingBody(localId) : undefined,
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
        })).trim();
        if (!text) return;
        const next: RollingSummary = { summary: text.slice(0, 4000), covered: target, anchorId };
        summaryRef.current = next;
        try { localStorage.setItem(SUMMARY_STORE_KEY(user.id), JSON.stringify(next)); } catch { /* storage full */ }
      } catch { /* background — never surface */ } finally {
        summarizingRef.current = false;
      }
    },
    [user, apiKey, geminiApiKey, nvidiaKeyLast4, selectedModel]
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
      let { data, error } = await loadSel("id, role, content, created_at, images, videos, splats, artifacts, tool_events");
      if (error) ({ data, error } = await loadSel("id, role, content, created_at, images, videos, splats"));
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
          .reverse() // back to chronological for rendering
          .flatMap((m: any) => rowsToMessages(m, true))
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
      let { data, error } = await sel("id, role, content, created_at, images, videos, splats, artifacts, tool_events");
      if (error) ({ data, error } = await sel("id, role, content, created_at, images, videos, splats"));
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
          .reverse()
          .flatMap((m: any) => rowsToMessages(m, true));
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
            // rendered expanded (not `restored`). Skipping on a matched id
            // also skips the row's derived artifact bubbles — the live path
            // already rendered its own.
            if (prev.some((x) => x.id === m.id)) return prev;
            return [...prev, ...rowsToMessages(m, false)];
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
    async (id: string, role: "user" | "assistant", content: string, bookId?: string | null, images?: ChatImageRef[], videos?: ChatVideoRef[], splats?: ChatSplatRef[], artifacts?: Artifact[], toolEvents?: ToolEvent[]): Promise<void> => {
      if (!user) return;
      const base: any = { id, user_id: user.id, role, content, book_id: bookId || null };
      // `images`/`videos`/`splats`/`artifacts`/`tool_events` are newer columns
      // — cascade to fewer extras if a migration hasn't been applied yet
      // (media stays safe in its own table, and dropping one column must not
      // also drop the others).
      const ins = (row: any) => supabase.from("chat_messages").insert(row);
      const hasImages = !!images && images.length > 0;
      const hasVideos = !!videos && videos.length > 0;
      const hasSplats = !!splats && splats.length > 0;
      const hasArtifacts = !!artifacts && artifacts.length > 0;
      const hasEvents = !!toolEvents && toolEvents.length > 0;
      const full: any = { ...base };
      if (hasImages) full.images = images;
      if (hasVideos) full.videos = videos;
      if (hasSplats) full.splats = splats;
      if (hasArtifacts) full.artifacts = artifacts;
      if (hasEvents) full.tool_events = toolEvents;
      // 23505 (duplicate key) means a previous attempt actually committed and
      // only its response was lost — the row exists WITH full media: success.
      // Only a missing column (42703) justifies retrying with fewer fields;
      // any other error (offline, RLS) would fail every retry identically.
      const done = (e: any) => !e || e.code === "23505";
      const colMissing = (e: any) => e?.code === "42703";
      let { error } = await ins(full);
      if (done(error)) return;
      // Newest columns first: the transcript-persistence migration
      // (20260802152000) ships after the media columns did.
      if (colMissing(error) && (hasArtifacts || hasEvents)) {
        const noTranscript: any = { ...base };
        if (hasImages) noTranscript.images = images;
        if (hasVideos) noTranscript.videos = videos;
        if (hasSplats) noTranscript.splats = splats;
        ({ error } = await ins(noTranscript));
        if (done(error)) return;
      }
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
      // Chat needs SOME provider configured; which key the chosen model
      // actually requires is checked after model resolution below.
      // Any configured provider is enough — a Gemini-only or NVIDIA-only
      // user must not be told to go get a key they deliberately didn't pick.
      if (!apiKey && !nvidiaKeyLast4 && !geminiApiKey) {
        toast.error("Add an API key in Settings first — OpenRouter, NVIDIA or Gemini");
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
      // Read via ref, not the state binding: `messages` in the dependency
      // array gave sendMessage a fresh identity on EVERY streamed token
      // (updateAssistant → setMessages → new messages → new callback → new
      // context value), invalidating every child memoized on it, per token.
      // The ref always holds the latest committed state by the time a user
      // gesture can invoke sendMessage.
      const historySource = [...messagesRef.current, userMsg].filter((m) => !m.displayOnly);
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

      const { prompt: systemPrompt, usedMemories, memoryImages } = await buildChatSystemPrompt({
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
        leanMode,
        foundryTools: foundryEnabled,
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
      // Memory Lens chips for this reply (repeat-recall images, collapsed) —
      // filled after the stream completes, read by updateAssistant.
      let lensChipsHolder: MemoryImageCandidate[] | undefined;
      // Tool Foundry proposals forged this turn (approval cards).
      const turnToolProposals: ToolProposal[] = [];
      let assistantText = "";
      // Model "thinking" streamed alongside the reply (reasoning_content /
      // think-tag content, normalized by the adapter). Rendered as a
      // collapsed strip; never persisted, never counted by the sentence cap.
      let turnReasoning = "";
      // Set once the turn's model is resolved (below) so every bubble can
      // show which provider actually answered.
      let viaModelRef: string | undefined;
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
                reasoning: turnReasoning || undefined,
                viaModel: viaModelRef,
                toolEvents: [...assistantEvents],
                images: turnImages.length > 0 ? [...turnImages] : copy[i].images,
                videos: turnVideos.length > 0 ? [...turnVideos] : copy[i].videos,
                splats: turnSplats.length > 0 ? [...turnSplats] : copy[i].splats,
                memoryImageChips: lensChipsHolder ?? copy[i].memoryImageChips,
                toolProposals: turnToolProposals.length > 0 ? [...turnToolProposals] : copy[i].toolProposals,
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
      // Provider-aware key gate — the model decides which key this turn
      // needs, and the registry decides which key that is.
      const turnProvider = modelProvider(model);
      if (!providerConfigured(turnProvider, providerKeys)) {
        const msg = `"${localModelId(model)}" runs on ${providerLabel(turnProvider)} — add your ${providerLabel(turnProvider)} API key in Settings (${providerKeyUrl(turnProvider)}).`;
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

      // ── Tool roster: computed ONCE, frozen for the whole turn ───────────
      // It must not change between iterations. The transcript accumulates
      // assistant tool_calls and role:"tool" replies as the loop runs, and a
      // request whose `tools` no longer declares a function still referenced
      // in `messages` is rejected outright by some providers (Gemini) and
      // confuses the rest — the "context-dangling tool" failure. So the
      // roster is decided from the turn's opening state and held.
      const { provider: turnProviderId, localId: turnLocalId } = resolveModel(model);
      const nvInfo = turnProviderId === "nvidia" ? nvidiaModelInfo(turnLocalId) : null;
      // NVIDIA 400s when tools reach a model without function calling, and
      // its VL models disable tools on image turns.
      const turnOpensWithImages = workingMessages.some((m: any) =>
        Array.isArray(m?.content) && m.content.some((p: any) => p?.type === "image_url"));
      const sendTools = !nvInfo || (nvInfo.caps.tools && !(nvInfo.imagesDisableTools && turnOpensWithImages));
      // Lean Mode is enforced HERE, by omission: a capability the model
      // cannot see is one it cannot pretend to use. Prompt steering alone
      // gets about half compliance and fails by narrating media it never
      // made. The executor keeps a terminal refusal as the backstop for
      // calls replayed from history (see leanMode.blockedToolResult).
      const leanBlocked = blockedTools(leanMode);
      // Per-tool permissions are enforced the same two ways as Lean Mode:
      // roster omission here (primary — an unseen tool cannot be pretended
      // at), and the executor choke point (backstop for replayed calls). One
      // map, lib/toolPermissions.ts, drives both.
      const permBlocked = (toolName: string): boolean => {
        const permId = TOOL_PERMISSION[toolName];
        return !!permId && chatToolPermissions?.[permId] === false;
      };
      const toolDefs = sendTools
        ? CHAT_TOOL_DEFINITIONS.filter((t: any) =>
            (t.function.name !== "forge_tool" || forgeEnabled) &&
            (t.function.name !== "run_tool" || runEnabled) &&
            !leanBlocked.includes(t.function.name) &&
            !permBlocked(t.function.name))
        : undefined;

      try {
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
          capSegStart = assistantText.length;
          const { adapter, localId } = resolveModel(model);

          let iterText = "";
          const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {};
          // Cap state for THIS iteration: once the cut lands the prose is
          // frozen but the stream keeps draining — models narrate BEFORE
          // emitting tool calls, and cancelling at the cut used to silently
          // kill the very action the narration promised.
          let iterCapped = false;
          let capDrops = 0; // content deltas discarded since the cut
          let cappedProseOnly = false;
          // The valve arms on the 40th drop but only FIRES at the next text
          // event, so a tool call already in flight behind the narration
          // still lands and cancels it — models narrate before acting, and
          // killing the stream on the drop itself would silently discard the
          // very action the narration promised.
          let valveArmed = false;
          // Native finish reason of the last finish event this iteration.
          let finishNative: string | undefined;

          const stream = adapter.streamChat({
            model: localId,
            messages: workingMessages,
            tools: toolDefs,
            signal: abortRef.current.signal,
            apiKey: providerKey(turnProviderId, providerKeys),
            extraBody: nvInfo?.extraBody,
          });

          for await (const ev of stream) {
            if (ev.type === "reasoning") {
              turnReasoning += ev.delta;
              updateAssistant();
            } else if (ev.type === "text") {
              if (iterCapped) {
                // Past the cut: discard beyond-cap prose but keep draining
                // so any tool calls behind the narration still arrive.
                if (valveArmed && Object.keys(toolCallAcc).length === 0) {
                  cappedProseOnly = true;
                  break;
                }
                capDrops++;
                // Cost valve: ~40 dropped prose deltas after the cut with
                // ZERO tool activity ⇒ provably a prose-only reply — stop
                // paying for it. (Any tool delta ⇒ drain to the natural end.)
                if (capDrops >= 40 && Object.keys(toolCallAcc).length === 0) {
                  valveArmed = true;
                }
              } else {
                iterText += ev.delta;
                assistantText += ev.delta;
                // Sentence cap on this iteration's prose segment — check
                // only at possible boundaries, never once tool deltas
                // have started streaming.
                if (sentenceCap > 0 && Object.keys(toolCallAcc).length === 0 && /[.!?…。！？\n]/.test(ev.delta)) {
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
            } else if (ev.type === "tool_call_delta") {
              const idx = ev.index;
              if (!toolCallAcc[idx]) toolCallAcc[idx] = { args: "" };
              if (ev.id) toolCallAcc[idx].id = ev.id;
              if (ev.name) toolCallAcc[idx].name = ev.name;
              if (ev.argsDelta) toolCallAcc[idx].args += ev.argsDelta;
            } else if (ev.type === "finish") {
              finishNative = ev.native ?? ev.reason;
            }
          }

          if (cappedProseOnly) {
            // Capped prose-only reply: cancel the stream (generator return
            // cascades into a reader cancel), then fall through to the
            // normal persistence/summary path with the frozen text.
            try { void stream.return(undefined); } catch { /* already closed */ }
            break;
          }

          const toolCalls = Object.values(toolCallAcc).filter((t) => t.name);
          // Run accumulated tool calls even when finish_reason isn't the
          // OpenAI-canonical "tool_calls" — some NVIDIA backends finish with
          // "stop" after emitting calls, and discarding them silently kills
          // the very action the model narrated. But a stream cut by the token
          // limit or a filter leaves the LAST call's arguments half-written:
          // executing that would either fail JSON.parse and burn another
          // iteration against an already-overflowing context, or (worse) run
          // a destructive tool on a truncated-but-parseable prefix.
          if (toolCalls.length === 0 || finishNative === "length" || finishNative === "content_filter") {
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
              tavilyApiKey,
              leanMode: leanModeRef.current,
              openRouterApiKey: apiKey,
              geminiApiKey,
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
              if (r.__toolProposal && typeof r.__toolProposal === "object") {
                turnToolProposals.push(r.__toolProposal);
              }
              // A tool that renders its own document (blueprint sheets, stage
              // plans) hands it over here rather than through create_artifact's
              // arguments. This is the whole reason it is a side channel: a
              // sheet is tens of kilobytes of markup that the model authored
              // none of and has no use for, and putting it in the transcript
              // would cost more than the drawing.
              if (r.__artifact && typeof r.__artifact === "object") {
                const art = parseArtifact(r.__artifact);
                if (art) artifacts.push(art);
                else {
                  // parseArtifact returning null used to be discarded with no
                  // branch — the one gap left where a drawn sheet could vanish
                  // while the tool result claimed it was on screen. Surface it
                  // as a failure chip AND a toast; never silently.
                  assistantEvents.push({ name: t.name || "artifact", summary: "A drawing was produced but could not be displayed (too large or malformed)", ok: false });
                  toast.error("A drawing could not be displayed (too large or malformed).");
                }
              }
              if ("__images" in r || "__videos" in r || "__splats" in r || "__vision" in r || "__toolProposal" in r || "__artifact" in r) {
                const { __images, __videos, __splats, __vision, __toolProposal, __artifact, ...clean } = r;
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
              else {
                assistantEvents.push({ name: "create_artifact", summary: "The artifact could not be displayed (too large or malformed)", ok: false });
                toast.error("An artifact could not be displayed (too large or malformed).");
              }
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

        // A reasoning model can spend its whole budget inside a thought block
        // (unclosed <think>, finish_reason "length"): everything routed to
        // reasoning, nothing to prose. Saying "(No response received)" under
        // a full Thinking strip is both wrong and would persist that literal
        // string into history and the rolling summary.
        let placeholderReply = false;
        if (!assistantText && assistantEvents.length === 0) {
          placeholderReply = true;
          assistantText = turnReasoning
            ? "(The model spent its whole reply thinking — ask again, or pick a model with reasoning off.)"
            : "(No response received)";
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

        // Memory Lens deterministic layer: retrieval surfaced images attached
        // to recalled memories. If the model didn't show the never-seen one
        // itself (show_image lands in turnImages via the side-channel — that's
        // the dedupe), auto-attach the TOP never-seen candidate, max ONE per
        // turn; the rest become collapsed chips. The display only COUNTS when
        // the card is actually viewed (IntersectionObserver in the strip
        // component records it — pocket hands-free sessions consume nothing).
        if (memoryImages.length > 0 && !deepResearch) {
          try {
            const alreadyShown = new Set(turnImages.map((i) => i.id));
            const remaining = memoryImages.filter((c) => !alreadyShown.has(c.imageId));
            const verdicts = remaining.map((c) => ({ c, v: lensVerdict(c.state, autoShowMemoryImages !== false) }));
            const expand = verdicts.find((x) => x.v === "expand");
            if (expand) {
              turnImages.push({
                id: expand.c.imageId,
                storage_path: expand.c.storagePath,
                prompt: expand.c.prompt,
                entry_id: expand.c.entryId,
                memory_title: expand.c.entryTitle,
                lens_auto: true,
              });
            }
            const chips = verdicts.filter((x) => x.v === "chip" || (x.v === "expand" && x !== expand)).map((x) => x.c);
            lensChipsHolder = chips.length > 0 ? chips : undefined;
            if (expand || lensChipsHolder) updateAssistant();
          } catch { /* lens is best-effort — never block the reply */ }
        }

        if (assistantText || turnImages.length > 0 || turnVideos.length > 0 || turnSplats.length > 0 || artifacts.length > 0 || assistantEvents.length > 0) {
          // The bubble already carries assistantId — the realtime echo of this
          // insert dedupes against it by id. Artifacts and tool-event chips
          // ride the same row so the transcript survives reload — including
          // the FAILURE chips, which are the audit trail of a repair loop.
          await persistMessage(
            assistantId, "assistant", assistantText, activeBookId,
            turnImages.length > 0 ? turnImages : undefined,
            turnVideos.length > 0 ? turnVideos : undefined,
            turnSplats.length > 0 ? turnSplats : undefined,
            artifacts.length > 0 ? [...artifacts] : undefined,
            assistantEvents.length > 0 ? [...assistantEvents] : undefined,
          );
        }

        // Surface any artifacts the model created this turn. Persist each into
        // the durable Workspace first (survives tab switches / reloads / devices)
        // and link the created item id onto the bubble so tapping it opens the
        // Workspace panel.
        if (artifacts.length) {
          // Dedupe against sheets already on screen: a confirm-replace flow
          // legitimately draws the SAME sheet twice (once with the refusal,
          // once after the user's go-ahead), and posting two identical
          // documents helps nobody. Identity = title + content, checked
          // against the recent transcript tail.
          const recentArtifacts = messagesRef.current
            .slice(-10)
            .map((m) => m.artifact)
            .filter((a): a is Artifact => !!a);
          const fresh = artifacts.filter(
            (a) => !recentArtifacts.some((r) => r.title === a.title && r.content === a.content),
          );
          const created = fresh.map((artifact) =>
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
            ...fresh.map((artifact, idx) => ({
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
        if (assistantText && !placeholderReply) {
          void updateRollingSummary([...baseHistory, { role: "assistant", content: assistantText }], firstHistoryId);
        }

        return assistantText;
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return assistantText;
        }
        // ALWAYS name the provider and model. With two providers serving
        // models under identical names, "which service refused me" is the
        // first question — and the app used to make the user guess.
        const raw = err?.message || "Failed to get response";
        const who = describeModel(model);
        const msg = raw.startsWith(providerLabel(modelProvider(model))) ? raw : `${who} — ${raw}`;
        // Actionable recovery: when OpenRouter refuses for money reasons and
        // an NVIDIA key exists, the fix is one tap away — offer it here
        // rather than making the user find Settings mid-conversation.
        const code = err?.code;
        // Offer whichever FREE provider the user actually has configured —
        // not a hardcoded one. Both NVIDIA and Gemini qualify now.
        const escapeTo = freeChatProviders().find(
          (p) => p !== modelProvider(model) && providerConfigured(p, providerKeys),
        );
        const escapable =
          modelProvider(model) === "openrouter" &&
          !!escapeTo &&
          (code === "credits" || code === "rate_limit" || code === "auth");
        if (escapable) {
          const target = savedModels.find((m) => modelProvider(m) === escapeTo)
            || (escapeTo === "gemini"
              ? namespacedGeminiId(GEMINI_STARTER_MODEL)
              : namespacedNvidiaId(NVIDIA_STARTER_MODEL));
          toast.error(msg, {
            duration: 15000,
            description: `${providerLabel(escapeTo!)} needs no balance — switch chat to ${localModelId(target)}?`,
            action: {
              label: `Switch to ${providerLabel(escapeTo!)}`,
              onClick: () => {
                if (!savedModels.includes(target)) addModel(target);
                else setSelectedModel(target);
                toast.success(`Chat now runs on ${describeModel(target)} — resend your message.`);
              },
            },
          });
        } else {
          toast.error(msg);
        }
        assistantText = `❌ ${msg}`;
        updateAssistant();
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    // `messages` is deliberately ABSENT (read via messagesRef) — see the note
    // at historySource. chatToolPermissions is present so a toggle flip
    // rebuilds the roster filter on the next turn.
    [apiKey, nvidiaKeyLast4, geminiApiKey, tavilyApiKey, leanMode, books, activeBookId, chatDeepResearch, voiceDeepResearch, isPaid, planLoaded, accessAllNeurons, maxReplySentences, autoShowMemoryImages, foundryEnabled, forgeEnabled, runEnabled, chatToolPermissions, wikis, activeWiki, activeWikiId, activeWikis, selectedModel, deepResearchModel, visionModel, videoModelPrimary, videoDefaultDuration, videoDefaultResolution, videoDefaultAspect, videoGenerateAudio, videoConfirmThreshold, videoIdentityScale, videoQcEnabled, videoMotionModel, falApiKey, splatModelPrimary, splatDefaultQuality, splatMaxFileMb, splatConfirmThreshold, splatMonthlyQuota, splatAutoFallback, customSystemPrompt, getActiveBodyForScope, burplexityApiToken, persistMessage, updateRollingSummary, addChapter, updateChapter, removeChapter, setActiveBookSilent]
  );


  const injectDisplayMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `inject-${Date.now()}`, role: "assistant", content, displayOnly: true },
    ]);
  }, []);

  // Memoized so the context object only changes when a member changes —
  // previously a raw literal handed every consumer a new identity on every
  // provider render. Consumers still re-render when `messages` updates
  // (they must — it is the transcript), but children memoized on the stable
  // callbacks no longer churn with it.
  const contextValue = useMemo<ChatContextValue>(
    () => ({
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
    }),
    [messages, isLoading, chatDeepResearch, voiceDeepResearch, setChatDeepResearch, setVoiceDeepResearch, sendMessage, injectDisplayMessage, clearChat, abort, loadEarlier, hasEarlier, loadingEarlier],
  );

  return (
    <ChatContext.Provider value={contextValue}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = (): ChatContextValue => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
};
