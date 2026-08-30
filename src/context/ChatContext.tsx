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
import { CHAT_TOOL_DEFINITIONS, executeChatTool, resetToolshedCache, ToolEvent, type ToolProposal, type ProgramProposal } from "@/lib/chatTools";
import {
  computeToolGates, availableToolNames, groupWithheld,
  type ToolGate, type ToolGateCode,
} from "@/lib/toolAvailability";
import { foundryAvailable, countApprovedTools } from "@/lib/toolFoundry";
import { programsAvailable, resetProgramsAvailability } from "@/lib/programFoundry";
import { resetProgramEdgeAvailability } from "@/lib/programRunner";
import { modelToolSupport } from "@/lib/modelCapabilities";
import { scanTextForToolCalls, hasUnclosedCallOpener, type RecoveredToolCall } from "@/lib/providers/textToolCalls";
import type { ChatImageRef } from "@/lib/imageGen";
import type { ChatVideoRef } from "@/lib/videoGen";
import type { ChatSplatRef } from "@/lib/splatGen";
import { parseBlocks, type ResponseBlock } from "@/lib/responseBlocks";
import { parseArtifact, type Artifact } from "@/lib/artifacts";
import { workspaceStore, deriveResearchTitle } from "@/lib/workspaceStore";
import { extractCodeBlocks, excludeArtifactDuplicates } from "@/lib/workspaceFiles";
import { buildFocusBlock, type UsedFocusItem } from "@/lib/chatFocus";
import {
  bookContextStore, selectContextBooks, hydrateBooksForContext,
  buildBookContextBlock, bookContextCharBudget, type UsedBookContext,
  type BookContextMode,
} from "@/lib/chatBooks";
import { toast } from "sonner";
import { isEmbeddingModel, isBatchOnlyModel } from "@/lib/utils";
import { describeModel, freeChatProviders, localModelId, modelProvider, providerConfigured, providerKey, providerKeyUrl, providerLabel, resolveModel } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";
import { namespacedNvidiaId, nvidiaModelInfo, nvidiaNoThinkingBody, NVIDIA_STARTER_MODEL } from "@/lib/nvidiaCatalog";
import { namespacedGeminiId, GEMINI_STARTER_MODEL } from "@/lib/geminiCatalog";

/** Every registered tool name, in registration order — the input to the gate
 *  map, and the denominator for "how many did we offer this turn". */
const ALL_TOOL_NAMES: string[] = CHAT_TOOL_DEFINITIONS.map((t: any) => t.function.name as string);

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
  /** Pinned workspace items serialized into this turn's focus block — shown
   *  as a "Focused on N files" receipt chip so focus is falsifiable, not
   *  asserted. Transient, like usedMemories. */
  usedFocus?: UsedFocusItem[];
  /** Books serialized into this turn's book-context block — the receipt
   *  ("N books in context") that makes the loaded-books claim falsifiable.
   *  Transient, like usedFocus. */
  usedBooks?: UsedBookContext[];
  /** Generated/recalled images rendered inline in the bubble (from the
   *  generate_image / edit_image / show_image tools). */
  images?: ChatImageRef[];
  /** Memory Lens: repeat-recall images collapsed to tappable chips under the
   *  bubble (ephemeral — chips are re-derived from recall state, not synced). */
  memoryImageChips?: MemoryImageCandidate[];
  /** Tool Foundry: drafted tools awaiting approval — rendered as approval
   *  cards (ephemeral; Settings → Tool Foundry is the canonical surface). */
  toolProposals?: ToolProposal[];
  /** Program Foundry: drafted VPS programs awaiting approval — rendered as
   *  program approval cards (ephemeral; Settings → Program Foundry is canonical). */
  programProposals?: ProgramProposal[];
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
  /** Ground truth for "was the tool even offered?" — the size and shape of the
   *  roster this turn's request actually carried.
   *
   *  This is the single fact that makes the whole status surface falsifiable.
   *  A provider that silently lacks function calling finishes with
   *  `finish_reason: "stop"` and no tool_calls, byte-identical to a model that
   *  simply chose not to call one; from the response alone the two are
   *  indistinguishable, and a panel that guessed would confidently explain the
   *  wrong thing forever. The app knows how many tools it put on the wire, so
   *  it records that instead of inferring it.
   *
   *  Stamped ONCE per turn, only after the roster is frozen — i.e. after the
   *  embedding-model and provider-key pre-flight gates — so a bubble from a
   *  send that never reached a provider can never claim a roster.
   *
   *  IN-MEMORY ONLY, deliberately: persisting it would need a new
   *  chat_messages column and another arm on persistMessage's cascade, and the
   *  question it answers ("why did this turn have no tools?") is a live one.
   *  Restored history simply has no toolAccess, which reads as "unknown"
   *  rather than as a false claim. */
  toolAccess?: {
    offered: number;
    withheld: number;
    codes: ToolGateCode[];
    /** How many calls this turn had to be RECOVERED from the reply's prose
     *  because the provider put them there instead of in `tool_calls` (NVIDIA
     *  documents that its API does not guarantee otherwise) AND then actually
     *  ran. Absent means the structured path carried everything, which is the
     *  ordinary case. It is recorded because the alternative — a call silently
     *  dropped and narrated — is precisely the failure this turn's machinery
     *  exists to catch, and a receipt nobody can read is not a receipt. */
    recovered?: number;
    /** Of the calls found in the prose, how many were NOT run — everything
     *  outside textToolCalls' read-class allow-list (barrier (c)).
     *
     *  RENAMED from `recoveredRefused`, and the old name was describing
     *  behaviour that no longer exists: those calls used to be pushed into the
     *  turn's tool_calls and answered with a result telling the model to send
     *  them again. Nothing is handed back now — the app records that a call
     *  was found in the text, does not run it, and never restates its name or
     *  its arguments. "Not run" is the whole of the fact.
     *
     *  SEPARATE FROM `recovered` on purpose. "We salvaged your call and ran it"
     *  and "we salvaged your call and did not run it" are opposite facts about
     *  whether anything happened, and collapsing them into one number would
     *  make the receipt claim the action took place — which is the exact
     *  sentence this whole ship exists to stop being false. */
    recoveredNotRun?: number;
    /** Which emitted dialects those recoveries came from — diagnostics only,
     *  never shown to the user. */
    recoveredFormats?: string[];
  };
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
  /** Which tools the NEXT chat turn would carry, and why any are missing.
   *
   *  Derived from the same computeToolGates() the send path uses, from the
   *  same live settings — so the chip near the composer and the roster on the
   *  wire cannot disagree. `hasImages` mirrors the send path's
   *  `turnOpensWithImages`: pixels are only ever serialized for the CURRENT
   *  upload turn (older images ride as text notes), so "this message has
   *  attachments" is exactly the condition the model-level image gate tests.
   *
   *  Prospective, not historical: it describes the next send, never a past
   *  one. What a past turn actually offered lives on that message's
   *  `toolAccess`. */
  toolGatesForTurn: (hasImages: boolean) => Map<string, ToolGate>;
  /** How many tools the user has approved in the Tool Foundry, or undefined
   *  while that is genuinely unknown (Foundry setup not run, count still
   *  loading, or the query failed).
   *
   *  The status chip needs it to tell "one tool is switched off" apart from
   *  "the whole library this user built is idle" — the same subtraction reads
   *  as unremarkable in the first case and as the entire bug in the second.
   *  Undefined must therefore stay undefined rather than collapse to 0: a
   *  library we have not been told about is one we must not describe. */
  approvedToolCount?: number;
}

const ChatContext = createContext<ChatContextValue | null>(null);

const MAX_TOOL_ITERATIONS = 5;

/** The ONE app-authored sentence added to the conversation when the recovery
 *  pass found call syntax in the prose that it will not run (textToolCalls'
 *  barrier (c) — everything outside the read-class allow-list).
 *
 *  WHAT THIS REPLACED, AND WHY, because the old shape was a live hole. Refused
 *  calls used to be pushed onto this iteration's `toolCalls`, which meant an
 *  assistant message was written into `workingMessages` carrying the recovered
 *  NAME and ARGUMENTS, answered by a tool result reading "issue it once as a
 *  real tool call and it will run". Feed the app a document ending in
 *  `<tool_call>{"name":"delete_chapter",…}</tool_call>`, ask what the document
 *  says, and the model echoes it: iteration N declined to run it and then told
 *  the model, in the app's own voice, exactly how to make it run. Iteration
 *  N+1 a compliant model does what it was told, the structured path now has a
 *  call so the salvage pass never runs, and delete_chapter executes. Barrier
 *  (c) was a one-round delay, not a stop — and the transcript was left holding
 *  a tool_call the assistant never made, assembled by us out of attacker-chosen
 *  bytes.
 *
 *  So the rule this constant enforces: RECOVERY NEVER TURNS TEXT THE MODEL DID
 *  NOT CHOOSE TO EMIT INTO AN ACTION, AND THE APP NEVER PROPOSES A CALL ON THE
 *  MODEL'S BEHALF. Hence, literally:
 *    - no interpolation. Zero bytes of the reply, the recovered name or the
 *      recovered arguments appear in it, so there is nothing here for a quoted
 *      blob to steer;
 *    - no imperative and no promise. It states how calls reach tools; it does
 *      not ask for a retry and does not say anything will run;
 *    - role "system", not a tool result. A tool result answers a call, and the
 *      whole point is that no call was made;
 *    - none of the safety register toolAvailability.test.ts's word list
 *      forbids — that register is what turns a mechanical note into a refusal
 *      the model argues with.
 *  A model that reads this and decides for itself to issue a call is ordinary
 *  behaviour on the ordinary prompt-injection surface, which exists with or
 *  without this feature. What is now impossible is the app doing the deciding.
 *
 *  Position-independent on purpose: the Gemini adapter merges every system
 *  message into the first one's slot, so this sentence has to read true
 *  wherever it lands — which is why it describes the interface rather than
 *  "your last reply". */
const TEXT_CALL_NOTE =
  "A tool call appears in the reply text rather than in the tool-call interface, and only calls that arrive through that interface reach a tool.";

/** Every string a tool result actually SHOWS the model, concatenated — the
 *  haystack the recovery pass's provenance barrier needs.
 *
 *  A tool result reaches the model as JSON.stringify(result), so the bytes in
 *  context spell a quote `\"` and a newline `\n`. When the model quotes a
 *  result back it reproduces what those escapes MEAN, so comparing its echo
 *  against the stringified form found nothing and the barrier passed
 *  everything through. This returns the meaning instead.
 *
 *  Values only, never keys, and joined by a newline so two unrelated fields
 *  cannot fuse into a span that appears in neither. Bounded TWO ways — total
 *  characters here, and the caller's own 24k clip on the same result — because
 *  a tool result is the one input here whose size the app does not choose.
 *
 *  THERE WAS A THIRD BOUND, A 5_000-NODE BUDGET, AND IT WAS A HOLE. It counted
 *  every value the walk visited — containers and numbers included, not just the
 *  strings that end up in the haystack — and it terminated the WHOLE walk
 *  rather than the branch that ran out. So a result shaped
 *  `{ head: "hello", pad: [5000 numbers], output: "<tool_call>…" }` stringifies
 *  to about 10k characters: comfortably under the caller's clip, so the model
 *  reads all of it — while this returned just "hello". Truthy, so the caller's
 *  `|| toolResultText` fallback never fired, and the echoed call syntax then
 *  passed provenance and, for a read-class tool, ran. A forged tool's own
 *  return value through run_tool is a realistic producer of exactly that shape.
 *
 *  Why the character cap alone is safe, and provably so. Object.values and
 *  JSON.stringify walk an object in the same order, and stringify spends at
 *  least two quote characters on every string plus keys, commas and escapes,
 *  while this spends len+1. So the running `total` at any string is never AHEAD
 *  of that same string's offset in the stringified blob. Anything the model can
 *  reach inside its 24k clip is therefore already collected here, and a string
 *  this cap truncates is truncated at least as hard in the model's copy.
 *
 *  The node budget was never what made this terminate, either: `value` only
 *  reaches us by having survived JSON.stringify one statement earlier at the
 *  call site, so it is finite, acyclic and shallow enough to recurse — and that
 *  stringify already paid for a full traversal of this very object. Dropping
 *  the budget costs a constant factor on work the caller has already done. */
const TOOL_RESULT_VISIBLE_CAP = 24_000;
function toolResultVisibleText(value: unknown): string {
  const out: string[] = [];
  let total = 0;
  const walk = (v: unknown): void => {
    if (total >= TOOL_RESULT_VISIBLE_CAP) return;
    if (typeof v === "string") {
      if (v.length === 0) return;
      out.push(v);
      total += v.length + 1;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(value);
  return out.join("\n").slice(0, TOOL_RESULT_VISIBLE_CAP);
}

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
  const { books, activeBookId, activeWiki, activeWikiId, activeWikis, wikis, addChapter, updateChapter, removeChapter, updateBookTitle, loadChapterText, setActiveBookSilent } = useApp();

  const { apiKey, nvidiaKeyLast4, geminiApiKey, tavilyApiKey, leanMode, selectedModel, setSelectedModel, savedModels, addModel, deepResearchModel, customSystemPrompt, burplexityApiToken, accessAllNeurons, maxReplySentences, autoShowMemoryImages, chatToolPermissions, visionModel, imageModelPrimary, imageModelFallback,
    videoModelPrimary, videoDefaultDuration, videoDefaultResolution, videoDefaultAspect, videoGenerateAudio, videoConfirmThreshold,
    videoIdentityScale, videoQcEnabled, videoMotionModel,
    falApiKey, splatModelPrimary, splatDefaultQuality, splatMaxFileMb, splatConfirmThreshold, splatMonthlyQuota, splatAutoFallback,
    programRunnerConfigured } = useChatSettings();
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
  // Probed EAGERLY, not only once an opt-in flips. The roster is unaffected
  // either way — forgeEnabled is `forgeOptIn && foundryReady`, so knowing the
  // migration exists never grants anything on its own — but the status panel
  // is not. With the lazy probe, the instant after a user turned "Forge new
  // tools" on, foundryReady was still false and the panel confidently told
  // them the database migration hadn't run: a reason produced by our own async
  // state rather than by their configuration, and the exact class of
  // misleading explanation this ship exists to remove. foundryAvailable()
  // caches its answer process-wide and dedupes concurrent callers, so this
  // costs one HEAD query per session.
  //
  // Re-probed on sign-in change as well as on the opt-in, and — critically —
  // NOT sticky on a transient answer. foundryAvailable() only caches a
  // definite result (schema present, or schema demonstrably missing); a
  // network blip leaves the cache null, and without re-asking, one bad moment
  // at page load would have the panel telling the user for the rest of the
  // session that they need to run a database migration they already ran.
  useEffect(() => {
    let alive = true;
    resetToolshedCache();
    foundryAvailable().then((ok) => { if (alive) setFoundryReady(ok); });
    return () => { alive = false; };
  }, [foundryOptIn, user?.id]);
  // How many tools this user has already approved. The status chip cannot say
  // "the AI can't run the tools you approved" without it, and that sentence is
  // the whole point: with "Run approved tools" off, every other surface reports
  // a calm "one tool off" while an entire library the user built and reviewed
  // sits idle.
  //
  // A COUNT, not a listing: countApprovedTools issues a head-only query that
  // transfers no rows, where listTools() would pull up to 100 full records
  // including every tool's source code. Once per session, gated on the schema
  // actually existing, alongside the availability probe above — never per
  // render, and never on the send path.
  //
  // Stays UNDEFINED on failure or before it lands, which the panel reads as
  // "say nothing". Deliberately not refreshed when a tool is approved
  // mid-session: approving through the card now turns "Run approved tools" on
  // in the same click, so the count only matters in the state that click leaves
  // behind, and a stale-by-one count there would still be > 0.
  const [approvedToolCount, setApprovedToolCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    // CLEARED FIRST, UNCONDITIONALLY — not only on the !foundryReady arm.
    // This effect also re-runs on user?.id, and the count is per-account. The
    // clear used to be inside the early return, so on a sign-out/sign-in the
    // refetch started while the PREVIOUS user's number stayed on screen; and
    // because the resolve arm is `n !== null`, a failed or refused query never
    // overwrote it. foundryReady does not save us: foundryAvailable() caches
    // process-wide (a schema probe, not a user fact) so it stays true straight
    // through the account change, and ChatProvider is mounted unkeyed in
    // App.tsx, so it never remounts to reset the state either. Result was user
    // A's library size labelling user B's chip for the rest of the session.
    // Clearing here costs nothing: React bails out when the value is already
    // undefined, which is every run that isn't an account or readiness change.
    setApprovedToolCount(undefined);
    if (!foundryReady) return;
    let alive = true;
    countApprovedTools().then((n) => { if (alive && n !== null) setApprovedToolCount(n); }).catch(() => {});
    return () => { alive = false; };
  }, [foundryReady, user?.id]);
  // Gate PER TOOL: with a single combined flag, enabling only "forge" would
  // still advertise run_tool to the model, which then calls it and gets a
  // "not enabled" refusal — exactly the mid-chat nagging this design avoids.
  const forgeEnabled = forgeOptIn && foundryReady;
  const runEnabled = runOptIn && foundryReady;
  const foundryEnabled = forgeEnabled || runEnabled;

  // Program Foundry (VPS execution). Same inverted opt-in as the Tool Foundry,
  // but readiness has a SECOND axis: the migration must have landed AND a VPS
  // runner must be connected. With no runner there is nowhere to execute or even
  // smoke-test, so every program verb is withheld from the roster (never a
  // mid-chat NO_RUNNER refusal), and `programReady` folds both so a verb whose
  // first call would fail is never offered.
  const forgeProgramOptIn = chatToolPermissions?.forge_program === true;
  const runProgramOptIn = chatToolPermissions?.run_program === true;
  const programOptIn = forgeProgramOptIn || runProgramOptIn;
  const [programsMigrated, setProgramsMigrated] = useState(false);
  useEffect(() => {
    let alive = true;
    // Reset the session probes on a sign-in change (they cache process-wide), so
    // the second account's Program Foundry is judged on its own schema/runner.
    resetProgramsAvailability();
    resetProgramEdgeAvailability();
    programsAvailable().then((ok) => { if (alive) setProgramsMigrated(ok); });
    return () => { alive = false; };
  }, [programOptIn, user?.id]);
  // Default CLOSED while the probe is unresolved: never emit a program verb whose
  // first call would 404 before the session knows the migration/runner state.
  const programReady = programsMigrated && programRunnerConfigured === true;
  const programEnabled = programOptIn && programReady;
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
  // Per-tool permissions, same live-read discipline as Lean Mode — and the
  // AUTHORITATIVE copy. The roster gate below reads this in-memory snapshot
  // while the forge_tool / run_tool executors in chatTools.ts re-read
  // chat_tool_permissions fresh from the database on every call. The settings
  // save is debounced 500ms and, until this ship, reported failure only to
  // console.error — so a lagging or failed write made the two disagree in the
  // cruellest direction: the switch reads ON, the model is offered the tool,
  // calls it, and gets "the Tool Foundry is opt-in and not enabled" while the
  // user stares at a switch that says it is on. This ref is handed down
  // through ToolDeps as `permissionsSnapshot`; the executors are to prefer it
  // over their own database read. (chatTools.ts is not touched by this ship —
  // that half is the integrator's.)
  const permissionsRef = useRef<Record<string, boolean>>(chatToolPermissions || {});
  useEffect(() => { permissionsRef.current = chatToolPermissions || {}; }, [chatToolPermissions]);

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
      if (!model || isEmbeddingModel(model) || isBatchOnlyModel(model)) return;
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
  // userIdRef mirrors user?.id for sendMessage (which deliberately omits
  // `user` from its deps — the messagesRef pattern): reading user?.id from
  // the closure would go stale across login/logout.
  const userIdRef = useRef<string | null>(null);
  useEffect(() => {
    userIdRef.current = user?.id ?? null;
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

      // ── Model + tool roster: computed ONCE, frozen for the whole turn ────
      //
      // ORDERING CONSTRAINT — this block has to sit ABOVE the prompt build.
      // The system prompt NAMES tools ("You have these tools: …", the approved
      // Foundry roster), and a tool named in the prompt but absent from the
      // request is the highest-fabrication shape there is: shown a menu it has
      // no function to order from, the model narrates having used the item
      // instead of reporting that nothing ran. So the prompt builder takes the
      // frozen roster (`offeredTools`) and gates every tool-naming sentence on
      // it, which means the roster must exist first. It used to be computed
      // ~150 lines below, next to the request it configures.
      //
      // And there is exactly ONE computeToolGates call on this path, feeding
      // BOTH the prompt and the wire `tools` array. Computing it twice — once
      // for what we say, once for what we send — is precisely how the two
      // drift apart, which is the entire bug class this ship closes.
      //
      // The roster must also not change BETWEEN tool iterations: the
      // transcript accumulates assistant tool_calls and role:"tool" replies as
      // the loop runs, and a request whose `tools` no longer declares a
      // function still referenced in `messages` is rejected outright by some
      // providers (Gemini) and confuses the rest — the "context-dangling tool"
      // failure. Decided from the turn's opening state, then held.
      const model = opts?.modelOverride
        || (hasUploads && visionModel ? visionModel : (deepResearch ? deepResearchModel : selectedModel));
      const { provider: turnProviderId, localId: turnLocalId } = resolveModel(model);
      const nvInfo = turnProviderId === "nvidia" ? nvidiaModelInfo(turnLocalId) : null;
      // Read off baseHistory rather than the assembled request, which does not
      // exist yet at this point. Same answer: pixels are only ever serialized
      // for the CURRENT user message (older images ride as text notes), and
      // that message is the last one in the window, so no slice can drop it.
      const turnOpensWithImages = baseHistory.some((m: any) =>
        Array.isArray(m?.content) && m.content.some((p: any) => p?.type === "image_url"));
      // Can the model call functions AT ALL — asked for EVERY provider now,
      // not just NVIDIA. The old test only consulted the NVIDIA catalog, so
      // every OpenRouter and Gemini model was assumed capable; a model that
      // cannot call functions was handed a full roster and answered with prose
      // describing work nobody did. modelToolSupport fails OPEN when no
      // catalog knows the model, so an unlisted model still gets its tools.
      const providerSupportsTools = modelToolSupport(model).supportsTools;
      // Separate, narrower NVIDIA rule and still correct: its VL models drop
      // tools on any turn that carries a picture.
      const imageTurnDisablesTools = !!nvInfo && nvInfo.imagesDisableTools === true && turnOpensWithImages;
      const sendTools = providerSupportsTools && !imageTurnDisablesTools;
      // ONE choke point for every gate. Every reason a tool can be missing —
      // the model can't call functions, the model drops tools on picture
      // turns, the Tool Foundry is opt-in, Lean Mode, a per-tool permission —
      // is decided by lib/toolAvailability.ts, which is also what the status
      // chip near the composer reads. Enforcement is still omission: a
      // capability the model cannot see is one it cannot pretend to use, and
      // prompt steering alone gets about half compliance while failing by
      // narrating media it never made. What changed is that the omission is
      // now EXPLAINED — to the user by the panel, to the model by a typed
      // terminal refusal when a gated call is replayed from earlier history,
      // and, since this ship, by the prompt simply not claiming the tool.
      const turnGates = computeToolGates({
        toolNames: ALL_TOOL_NAMES,
        leanMode,
        // The turn-start snapshot, frozen with the rest of the roster — NOT
        // permissionsRef. The roster must not change between tool iterations
        // (a request whose `tools` no longer declares a function still named
        // in `messages` is rejected outright by some providers), so the live
        // ref belongs only in ToolDeps, where the executor backstop reads it.
        permissions: chatToolPermissions || {},
        forgeOptIn,
        runOptIn,
        foundryReady,
        forgeProgramOptIn,
        runProgramOptIn,
        programReady,
        providerSupportsTools,
        imageTurnDisablesTools,
      });
      // Both model-level gates are INPUTS to computeToolGates above, so when
      // sendTools is false every gate reads off_model_* and this set is empty.
      // One set, therefore, is the honest answer to all three questions: what
      // the prompt may name, what goes on the wire, and what a recovered
      // text-emitted call is allowed to be.
      const offeredNames = new Set(availableToolNames(turnGates));
      // `tools` stays UNDEFINED — never an empty array — when a model-level
      // gate fires: some providers reject `tools: []` outright. The gate map
      // explains the omission; the wire format is unchanged.
      const toolDefs = sendTools
        ? CHAT_TOOL_DEFINITIONS.filter((t: any) => offeredNames.has(t.function.name))
        : undefined;

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
        // Still the outer switch for the whole Foundry section — the builder
        // reads it before it reads the roster, and with it false the section
        // is absent entirely. `offeredTools` then decides, per verb, what that
        // section is allowed to SAY: forge and run are gated independently, so
        // "run approved tools" off no longer prints a named menu of the user's
        // approved tools with no `run_tool` to order from.
        foundryTools: foundryEnabled,
        programTools: programEnabled,
        offeredTools: [...offeredNames],
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

      // Pinned workspace focus — resolved fresh from the store at every send
      // (pins are references, not snapshots: an edited item is never stale, a
      // deleted one silently drops). It rides as its OWN system message: the
      // main prompt still varies per query (its retrieval section), so a
      // separate byte-stable block is the cache-friendly placement, and
      // the summaryNote message below proves multi-system payloads work on
      // all three providers.
      // The SAME frozen roster the prompt and the wire got, for the same
      // reason. This block is the sharpest place in the whole payload to name
      // a tool that isn't there: its excerpt labels sit directly against
      // content the model can SEE is cut off, which is the strongest possible
      // invitation to call something — and if `read_workspace_item` is not on
      // this turn's wire, what comes back is a narrated read of a remainder
      // nobody fetched. Ordering is already correct: `offeredNames` is
      // computed with the rest of the roster above the prompt build, ~60 lines
      // up, so this is a pass-through and needs no further hoisting.
      const focusBlock = buildFocusBlock(
        workspaceStore.getFocused(userIdRef.current),
        { voiceMode: isVoice, offeredTools: [...offeredNames] },
      );

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
      // Program Foundry proposals forged this turn (VPS program approval cards).
      const turnProgramProposals: ProgramProposal[] = [];
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
                programProposals: turnProgramProposals.length > 0 ? [...turnProgramProposals] : copy[i].programProposals,
              };
              break;
            }
          }
          return copy;
        });
      };

      // `model` and the whole tool roster were resolved above the prompt build
      // — see the ordering note there. These two pre-flight gates stay HERE,
      // below the streaming bubble, because both report their refusal by
      // writing into it.
      if (isEmbeddingModel(model)) {
        const msg = `"${model}" is an embedding model — pick a chat model in Settings (it's only valid for Wiki reindex).`;
        toast.error(msg);
        assistantText = `❌ ${msg}`;
        updateAssistant();
        setIsLoading(false);
        return;
      }
      // ":batch" ids run only on OpenRouter's asynchronous Batch API — the
      // live endpoint 404s them. Refuse with the runnable sibling named
      // rather than silently stripping the suffix: the sibling bills at full
      // price, and swapping models behind the user's back is the invisible
      // routing the provider-visibility rule forbids.
      if (isBatchOnlyModel(model)) {
        const msg = `"${model}" is a batch-pricing variant that can't answer live chat — in Settings pick "${model.replace(/:batch$/i, "")}" (same model, standard pricing) instead.`;
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
      // Book context — the loaded shelf/books, resolved fresh from the store
      // at every send (a reference, not a snapshot: books added to the shelf
      // appear, deleted ones drop). Hydration happens HERE, below the
      // pre-flight gates, so an error turn never pays for whole-book fetches.
      bookContextStore.init(userIdRef.current);
      const bookSelection = bookContextStore.get();
      let contextBooks = selectContextBooks(books, bookSelection, activeBookId ?? null);
      // Catalog mode rides on the persisted selection (Card Catalog Stage 1).
      // A model that can NEVER call tools gets full text regardless — a
      // catalog is a map to text it has no way to fetch, and its footer's
      // "read the chapter" framing would be an unactionable instruction
      // (review-confirmed). This is the PERMANENT gate only: a transient
      // image-turn tool drop keeps the catalog — its bytes stay stable, its
      // wording claims no fetch capability, and the tools return next turn.
      let bookCtxMode: BookContextMode =
        bookSelection.mode === "catalog" && providerSupportsTools ? "catalog" : "full";
      // FALLBACK, not a default: with no shelf/book selection the active book
      // normally stays OUT of context — the model reads it on demand with
      // `get_chapter_text` (Stage 0 removed the inline Chapter Contents that
      // used to ride here). But when THIS turn carries no `get_chapter_text`
      // (a model without function calling, or an image turn that drops
      // tools), on-demand reading does not exist, and a reading question
      // about the open book would reach the model with neither the text nor
      // any way to fetch it. Only then does the active book ride as a block —
      // the one path that still gets text to a model that cannot ask for it.
      if (contextBooks.length === 0 && activeBookId && !offeredNames.has("get_chapter_text")) {
        const active = books.find((b) => b.id === activeBookId);
        if (active) {
          contextBooks = [active];
          bookCtxMode = "full";
        }
      }
      // The turn's AbortController exists BEFORE hydration, and the fetches
      // carry its signal — otherwise the Stop button is dead for the whole
      // whole-book download stall and the provider request fires anyway.
      abortRef.current = new AbortController();
      const turnSignal = abortRef.current.signal;
      let bookBlock: ReturnType<typeof buildBookContextBlock> = null;
      if (contextBooks.length > 0) {
        try {
          // Catalog mode needs no text: the spine (with gists) is already in
          // state, so the whole-book hydration fetch is skipped entirely —
          // the mode's latency win is real, not only a token win.
          const hydrated = bookCtxMode === "catalog"
            ? contextBooks
            : await hydrateBooksForContext(contextBooks, { signal: turnSignal });
          bookBlock = buildBookContextBlock(hydrated, {
            voiceMode: isVoice,
            offeredTools: [...offeredNames],
            totalCharBudget: bookContextCharBudget(model),
            mode: bookCtxMode,
          });
        } catch (e) {
          if (turnSignal.aborted) {
            // The user stopped the send during hydration — withdraw the empty
            // streaming bubble and end the turn quietly.
            setMessages((prev) => prev.filter((m) => m.id !== assistantId));
            setIsLoading(false);
            return;
          }
          // The turn proceeds without the block; the missing receipt is the
          // honest signal that no book text was sent.
          toast.error("Couldn't load book text for context — sending without it.");
        }
      }

      // The book block is the FIRST message on the wire: long documents at
      // the top with the query at the end (the position-bias literature), and
      // the longest byte-stable prefix on the request. The main prompt's
      // fences are session-stable now (Stage 0), but its retrieval section
      // still varies per query — so the block AHEAD of it is what
      // provider-side prefix caching reliably hits, and the adapter is told
      // exactly how many leading messages are stable (cacheStablePrefixCount).
      const workingMessages: any[] = [
        ...(bookBlock?.message ? [{ role: "system", content: bookBlock.message }] : []),
        { role: "system", content: systemPrompt },
        ...(summaryNote ? [{ role: "system", content: summaryNote }] : []),
        ...(focusBlock ? [{ role: "system", content: focusBlock.message }] : []),
        ...historyForModel,
      ];
      // Focus receipt stamped only HERE — after the embedding-model and
      // provider-key gates — so an error bubble from a send that never
      // reached a provider can't claim "Focused on N files". The usedBooks
      // receipt is stricter still: it commits with toolAccess on the FIRST
      // STREAM EVENT (see stampToolAccess) — it claims what a reply actually
      // carried, and a dead connection must not leave a bubble asserting
      // books rode with it.
      if (focusBlock && focusBlock.used.length > 0) {
        const used = focusBlock.used;
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, usedFocus: used } : m)));
      }

      // Ground truth for this turn: how many tools this request actually put
      // on the wire. "We never offered it" and "we offered it and the model
      // declined" are indistinguishable from a response alone — a provider
      // that silently lacks function calling finishes with `stop` and no
      // tool_calls, byte-identical to a model that chose not to call one — so
      // the app records what it knows instead of letting the panel infer.
      //
      // COMMITTED ON THE FIRST STREAM EVENT, never here: a bubble is only
      // entitled to claim a roster once a provider has answered. Stamping at
      // roster time would have let a DNS failure or a refused connection leave
      // an error bubble asserting "this reply went out with 58 tools" when
      // nothing went out at all.
      let turnToolAccess: NonNullable<ChatMessage["toolAccess"]> = {
        offered: toolDefs?.length ?? 0,
        withheld: ALL_TOOL_NAMES.length - (toolDefs?.length ?? 0),
        codes: groupWithheld(turnGates).map((g) => g.code),
      };
      let toolAccessStamped = false;
      const stampToolAccess = () => {
        if (toolAccessStamped) return;
        toolAccessStamped = true;
        // The usedBooks receipt commits here — with toolAccess, on the first
        // stream event — because both claim what this reply's request
        // actually carried; stamping at assembly time would let a refused
        // connection leave an error bubble asserting "N books in context".
        const usedB = bookBlock && bookBlock.used.length > 0 ? bookBlock.used : undefined;
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, toolAccess: turnToolAccess, ...(usedB ? { usedBooks: usedB } : {}) } : m)));
      };
      /** Re-stamp after calls had to be salvaged out of the reply's prose.
       *  A NEW object every time, never a mutation of the stamped one: the
       *  bubble holds it by reference, so mutating in place would update the
       *  receipt everywhere except on screen.
       *
       *  `ran` were executed; `notRun` were found in the text and left alone —
       *  nothing was proposed to the model and nothing happened. They are
       *  counted apart because a receipt that merges them says the action took
       *  place, which is the one thing it must never say falsely. */
      const noteRecoveredCalls = (ran: RecoveredToolCall[], notRun: RecoveredToolCall[]) => {
        turnToolAccess = {
          ...turnToolAccess,
          recovered: (turnToolAccess.recovered ?? 0) + ran.length,
          recoveredNotRun: (turnToolAccess.recoveredNotRun ?? 0) + notRun.length,
          recoveredFormats: [...new Set([...(turnToolAccess.recoveredFormats ?? []), ...ran.map((c) => c.format), ...notRun.map((c) => c.format)])],
        };
        toolAccessStamped = true;
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, toolAccess: turnToolAccess } : m)));
      };

      // Text that reached this turn from OUTSIDE the model, kept for the
      // recovery pass's provenance barrier. A tool result is the likeliest
      // place a `<tool_call>`-shaped blob enters a conversation at all — a
      // forged tool's own return value, a read file, a search snippet — and
      // the moment the model echoes one back, text that merely LOOKS like a
      // call would otherwise execute. Newest first at scan time, because the
      // result the model just read is the one it is quoting.
      //
      // References to strings that already exist in workingMessages, never
      // copies, and never the whole transcript: this is one turn's results
      // only, and the scanner spends a fixed character budget across them.
      const turnToolResultText: string[] = [];
      // Whether TEXT_CALL_NOTE has already been added to THIS send. Once said,
      // it is in context and stays there, so repeating it on every iteration
      // would be N identical system lines — and on the Gemini adapter, which
      // merges system messages into one, N copies of the same sentence stacked
      // inside the main prompt. It also stops a model that keeps re-emitting
      // the same prose call from buying five round trips to be told the same
      // thing five times.
      let textCallNoteSent = false;

      try {
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
          capSegStart = assistantText.length;
          const { adapter, localId } = resolveModel(model);

          let iterText = "";
          // The SCAN's copy of this iteration's prose, which the sentence cap
          // never freezes — see the recovery block below for why the visible
          // string cannot double as the scanned one.
          let rawIterText = "";
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
            // Only the book block qualifies: it is byte-stable per selection.
            // The focus block is stable too but sits AFTER the query-varying
            // main prompt, where a breakpoint can never be reached by a read.
            cacheStablePrefixCount: bookBlock?.message ? 1 : 0,
          });

          for await (const ev of stream) {
            // First byte back from the provider — the request demonstrably
            // went out, so the roster it carried is now a fact this bubble may
            // state. Cheap: one boolean test per event after the first.
            stampToolAccess();
            if (ev.type === "reasoning") {
              turnReasoning += ev.delta;
              updateAssistant();
            } else if (ev.type === "text") {
              // ALWAYS, before the cap gets a say. Everything below this line
              // is about what the USER sees; the recovery scan needs what the
              // MODEL sent, and those stopped being the same string the moment
              // a cap existed. A provider that writes its call into the prose
              // writes it AFTER the narration — i.e. after the cut — so with
              // only `iterText` to scan, a sentence cap silently switched the
              // whole salvage path off for everyone who had set one.
              rawIterText += ev.delta;
              if (iterCapped) {
                // Past the cut: discard beyond-cap prose but keep draining
                // so any tool calls behind the narration still arrive.
                //
                // `toolCallAcc` is the STRUCTURED path's guard and it is blind
                // to the case this whole salvage pass exists for: a provider
                // writing its call into message.content leaves that accumulator
                // empty the entire time. Cancelling then severs the blob
                // mid-write, the truncated JSON fails to parse, nothing is
                // recovered, and the user reads a paragraph about an action
                // that never ran — the original report, reproduced for exactly
                // the capped population this pass was built for.
                // hasUnclosedCallOpener is that guard's text-path twin, and it
                // is consulted at the only two moments it can change the
                // outcome — arming and firing. Each happens about once per
                // iteration, so a 32k tail scan is not paid on every dropped
                // delta; while a call IS mid-write it runs once per delta,
                // which is bounded by the length of that one blob.
                const structuredIdle = Object.keys(toolCallAcc).length === 0;
                if (valveArmed) {
                  if (structuredIdle && !hasUnclosedCallOpener(rawIterText)) {
                    cappedProseOnly = true;
                    break;
                  }
                } else if (++capDrops >= 40 && structuredIdle && !hasUnclosedCallOpener(rawIterText)) {
                  // Cost valve: ~40 dropped prose deltas after the cut with
                  // ZERO tool activity — structured OR written into the prose —
                  // ⇒ provably a prose-only reply, so stop paying for it. (Any
                  // tool delta, or an unfinished call in the text, ⇒ drain to
                  // the natural end.)
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
            // cascades into a reader cancel). It does NOT break out of the
            // iteration loop here any more — that break sat above the salvage
            // pass, so a capped reply whose call was written as text had the
            // one thing that could have rescued it skipped entirely. Cancelling
            // is only resource cleanup; `rawIterText` already holds everything
            // that arrived, and the ordinary `toolCalls.length === 0` break
            // below ends the turn identically when nothing is recovered.
            //
            // Salvaging from a stream we deliberately stopped reading is safe
            // by construction, not by luck: a call blob cut off mid-write fails
            // JSON.parse and is never recovered. Only a complete one survives.
            try { void stream.return(undefined); } catch { /* already closed */ }
          }

          const toolCalls = Object.values(toolCallAcc).filter((t) => t.name);
          // Set when the salvage pass found call syntax it will not run. It is
          // a BOOLEAN, deliberately: the only thing that travels out of that
          // branch is the fact that it happened. The name and the arguments go
          // nowhere — see TEXT_CALL_NOTE for the round trip that made carrying
          // them a working exploit.
          let textCallNoted = false;
          // A stream cut by the token limit or a filter leaves the LAST call's
          // arguments half-written: executing that would either fail
          // JSON.parse and burn another iteration against an already-
          // overflowing context, or (worse) run a destructive tool on a
          // truncated-but-parseable prefix. It also means any call sitting in
          // the prose is itself probably truncated, so nothing is salvaged
          // from a reply that ended this way.
          const streamCutShort = finishNative === "length" || finishNative === "content_filter";

          // ── Calls the provider wrote as PROSE ──────────────────────────────
          // NVIDIA's NIM docs state the API "does not guarantee that
          // <tool_call> or other tool-related text does not appear in
          // message.content". When that happens the structured path sees
          // nothing, the turn ends with "stop", and the user reads a paragraph
          // describing an action that never ran — the report this whole ship
          // answers. So when NOTHING arrived structurally, the reply's own text
          // gets one salvage pass against the roster this request actually
          // carried (`toolDefs` present ⇒ tools went out; `offeredNames` is
          // that roster, and a name outside it stays prose forever).
          //
          // Calls the module CLEARS TO RUN (`scan.calls`, its read-class
          // allow-list — see RECOVERY_EXECUTABLE) are pushed into `toolCalls`
          // itself rather than handled beside it: everything downstream — the
          // assistant tool_calls message, the executor, the permission
          // backstop, the events — must treat them identically, and a second
          // path is a second set of rules to drift. Everything else
          // (`scan.refused`) goes nowhere near that array; the only thing that
          // leaves this block for it is one boolean.
          //
          // Fires at most once per iteration by construction (one pass, here),
          // and cannot re-scan converted text: both accumulators are rebuilt
          // from empty on the next iteration.
          //
          // SCANS `rawIterText`, NOT `iterText`. They diverge exactly when a
          // sentence cap is set: past the cut `iterText` is frozen and later
          // deltas are dropped, so the blob a provider writes AFTER its
          // narration — which is where every provider writes it — never entered
          // the string being scanned. A cap therefore switched recovery off
          // completely for anyone who had one, which is a large share of the
          // users who reported this bug in the first place.
          //
          // Two barriers are opted into here, both of them about text that
          // reached the reply from somewhere other than the model:
          //   requireTerminal — a real emitted call is the last thing in the
          //     message; a candidate with prose after it is being quoted.
          //   inbound — this turn's outside-the-model text. A span that appears
          //     verbatim in a tool result, in the user's own message or in a
          //     pinned file was transcribed, not authored, and a transcribed
          //     blob can carry its own `confirm: true`.
          if (toolDefs && !streamCutShort && toolCalls.length === 0 && rawIterText) {
            const scan = scanTextForToolCalls(rawIterText, offeredNames, {
              requireTerminal: true,
              // Newest tool result last, because the result the model just read
              // is the one it echoes. Each entry is compared SEPARATELY and gets
              // an equal share of the module's comparison budget, so the order
              // no longer decides who gets compared at all — but the count does,
              // which is why every tool result contributes exactly one string
              // (see toolResultVisibleText at the push site).
              inbound: [
                trimmed,
                ...(focusBlock ? [focusBlock.message] : []),
                // Loaded book text is inbound too: a book that quotes
                // call-shaped JSON (a technical manual, this app's own docs)
                // must not have its quotes executed as authored calls.
                ...(bookBlock?.message ? [bookBlock.message] : []),
                ...turnToolResultText.slice().reverse(),
              ],
            });
            if (scan.calls.length > 0 || scan.refused.length > 0) {
              // WHAT THE VISIBLE REPLY BECOMES, and why it is not just
              // `scan.cleanedText`. The scan read the UNCAPPED segment, so its
              // cleaned copy is in general longer than what the user has been
              // shown — assigning it straight through would let a salvaged call
              // quietly un-cap the reply. The cap is a promise about how much
              // the assistant says, and rescuing a tool call is no reason to
              // break it. So the cleaned text goes back through the same cap
              // the stream applied. Two things fall out: the call syntax is
              // gone from the bubble wherever it landed (before OR after the
              // cut), and the segment can never exceed `sentenceCap` sentences.
              // It may GROW up to the cap — the streaming freeze is deliberately
              // conservative and can cut early — which is the cap being honoured
              // more exactly, not less. With no cap set, rawIterText and
              // iterText are the same string and this is the old behaviour.
              const cleaned = scan.cleanedText;
              iterText = sentenceCap > 0 ? truncateAtSentenceCap(cleaned, sentenceCap) : cleaned;
              // assistantText was accumulated delta-by-delta, so it is repaired
              // by splicing this iteration's segment the same way the cap does.
              assistantText = assistantText.slice(0, capSegStart) + iterText;
              updateAssistant();
              // `iterText` is also what goes into workingMessages below, so the
              // provider's raw call syntax never re-enters model context.
              noteRecoveredCalls(scan.calls, scan.refused);
              scan.calls.forEach((c, i) => {
                toolCalls.push({ id: `call_${iteration}_r${i}`, name: c.name, args: c.args });
              });
              // Everything the module would not clear. ONE BOOLEAN LEAVES THIS
              // LINE. The name and the arguments are read for the receipt's
              // counts and then dropped on the floor — they are not pushed onto
              // `toolCalls`, not written into a tool_calls message, not put in
              // a tool result, not interpolated into any string. Those bytes
              // can be attacker-chosen (a document quoted back at the user's
              // request), and the moment the app restates them as something the
              // assistant said, it has laundered them into the transcript and
              // handed the next iteration a call to make. See TEXT_CALL_NOTE.
              textCallNoted = scan.refused.length > 0;
            }
          }

          // Run accumulated tool calls even when finish_reason isn't the
          // OpenAI-canonical "tool_calls" — some NVIDIA backends finish with
          // "stop" after emitting calls, and discarding them silently kills
          // the very action the model narrated.
          //
          // `textCallNoted` keeps the loop alive for one more round with no
          // calls in it. That round exists so the note below actually reaches
          // the model — pushing it and then breaking would append a sentence to
          // a conversation nobody sends. It costs the same round trip the old
          // refusal-as-tool-result cost, and MAX_TOOL_ITERATIONS bounds it the
          // same way. `textCallNoteSent` bounds it harder: the note is worth
          // one extra round, not five, and a model that keeps writing the same
          // prose call has already been told.
          if ((toolCalls.length === 0 && (!textCallNoted || textCallNoteSent)) || streamCutShort) {
            break;
          }

          if (toolCalls.length > 0) {
            workingMessages.push({
              role: "assistant",
              content: iterText || null,
              tool_calls: toolCalls.map((t, i) => ({
                id: t.id || `call_${iteration}_${i}`,
                type: "function",
                function: { name: t.name, arguments: t.args || "{}" },
              })),
            });
          } else if (iterText) {
            // Note-only round: no call was made, so there is no tool_calls
            // message to write — an assistant message carrying an empty
            // tool_calls array is malformed, and one carrying a fabricated
            // entry is the exploit this ship closed. What goes back is the
            // model's OWN prose with the recovered spans already removed, which
            // is the context the note refers to. When even that is empty
            // (the whole reply was one call blob) nothing is pushed at all.
            workingMessages.push({ role: "assistant", content: iterText });
          }

          // Vision payloads requested via view_image this round — injected as a
          // user message AFTER the tool results (tool messages are text-only).
          const visionPayloads: string[] = [];

          for (let i = 0; i < toolCalls.length; i++) {
            const t = toolCalls[i];
            const callId = t.id || `call_${iteration}_${i}`;
            // `permissionsSnapshot` is the AUTHORITATIVE in-memory permission
            // state (see permissionsRef) — the same values that decided which
            // tools the model was offered. Every executor reads it through
            // readToolPermissions() in chatTools.ts instead of re-querying
            // chat_tool_permissions, which could lose a race with the 500ms
            // debounced save and refuse a tool whose switch reads ON.
            const toolDeps = {
              books,
              activeBookId,
              setActiveBookId: setActiveBookSilent,
              addChapter,
              updateChapter,
              removeChapter,
              updateBookTitle,
              loadChapterText,
              burplexityApiToken,
              tavilyApiKey,
              userId: user?.id ?? null,
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
              permissionsSnapshot: permissionsRef.current,
              programRunnerConfigured: programRunnerConfigured === true,
            };
            const { result, event } = await executeChatTool(t.name!, t.args || "{}", toolDeps);

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
              if (r.__programProposal && typeof r.__programProposal === "object") {
                turnProgramProposals.push(r.__programProposal);
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
              if ("__images" in r || "__videos" in r || "__splats" in r || "__vision" in r || "__toolProposal" in r || "__programProposal" in r || "__artifact" in r) {
                const { __images, __videos, __splats, __vision, __toolProposal, __programProposal, __artifact, ...clean } = r;
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
            const toolResultText = JSON.stringify(modelResult).slice(0, 24000);
            workingMessages.push({
              role: "tool",
              tool_call_id: callId,
              name: t.name,
              content: toolResultText,
            });
            // Kept for the recovery pass's provenance barrier: this result is
            // now inside the model's context, so anything it echoes back that
            // matches it was transcribed, not authored.
            //
            // WHAT IS HANDED OVER IS THE MODEL-VISIBLE TEXT, NOT THE STRINGIFIED
            // BLOB, and the difference is the whole barrier. `toolResultText` is
            // JSON: a quote inside a result is `\"` there, a newline is the two
            // characters `\n`. The model does not echo THAT — it echoes what the
            // string says. Handing over the blob made the comparison a no-op on
            // the exact channel this barrier was written for: a search snippet, a
            // read file, a forged tool's own return value.
            //
            // Why REPLACING the blob rather than adding to it. A span echoed in
            // its still-escaped form cannot become a call at all — `{\"name\":…}`
            // fails JSON.parse, so it is never a candidate — which leaves the
            // decoded reading as the only one that can matter. And textToolCalls
            // decodes ONE level of each source it is given, so passing the
            // visible text also covers the doubly-escaped case (a result
            // carrying an already-JSON payload), where passing the blob spends
            // that one level just getting back to visible. It also keeps the
            // source COUNT unchanged, and the module divides its comparison
            // budget equally per source — a second entry per result would halve
            // how much of each long result is compared at all.
            //
            // THAT IS NOT FREE, and this comment used to claim it was. Replacing
            // makes the haystack exactly as complete as toolResultVisibleText:
            // every string the walk fails to reach is a string the model can
            // read and provenance cannot see, and a truthy `visible` hides the
            // shortfall instead of falling back to the blob. A node budget in
            // that walk bought the free-looking version its counterexample —
            // padding ahead of the readable string returned a short, truthy
            // haystack while the model read the whole result. The budget is gone
            // for that reason (see toolResultVisibleText), and what remains is
            // the same 24_000 character ceiling applied to toolResultText on the
            // line above, so the two now cover the same text by construction.
            //
            // Values only, never keys: a key is app vocabulary, and the barrier
            // must not learn to reject a span because it contains "name".
            const visible = toolResultVisibleText(modelResult);
            turnToolResultText.push(visible || toolResultText);
          }

          // The one sentence the app contributes when the salvage pass found
          // call syntax it will not run. AFTER the tool results, never between
          // an assistant tool_calls message and the results that answer it —
          // that ordering is a hard requirement of the chat-completions shape.
          // Zero interpolation: see TEXT_CALL_NOTE for why a note that names
          // the tool is a working exploit rather than a nicety.
          if (textCallNoted && !textCallNoteSent) {
            workingMessages.push({ role: "system", content: TEXT_CALL_NOTE });
            textCallNoteSent = true;
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

        // Auto-capture: substantial fenced code blocks in the reply become
        // real Workspace files. A fence in the transcript is gone on reload —
        // a file is not, and it can be downloaded, pinned and re-read. Runs
        // once per completed turn (never in a render), after `artifacts` is
        // populated so a block already filed as an artifact isn't filed twice.
        // Triple-deduped: against this turn's artifacts, against repeats
        // inside one reply, and by content fingerprint in the store.
        if (assistantText) {
          try {
            const files = excludeArtifactDuplicates(
              extractCodeBlocks(assistantText),
              artifacts.map((a) => a.content),
            );
            for (const f of files) {
              workspaceStore.addFile({
                userId: user?.id ?? null,
                title: f.title,
                kind: f.kind,
                language: f.language,
                content: f.content,
                meta: { source: "Chat" },
              });
            }
          } catch { /* capture is best-effort — never break a delivered reply */ }
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
    // rebuilds the roster on the next turn, and forgeOptIn/runOptIn/
    // foundryReady are the raw inputs computeToolGates now takes (it draws the
    // opt-in and availability distinction itself, so the pre-combined
    // forgeEnabled/runEnabled are no longer read here).
    [apiKey, nvidiaKeyLast4, geminiApiKey, tavilyApiKey, leanMode, books, activeBookId, chatDeepResearch, voiceDeepResearch, isPaid, planLoaded, accessAllNeurons, maxReplySentences, autoShowMemoryImages, foundryEnabled, forgeOptIn, runOptIn, foundryReady, chatToolPermissions, wikis, activeWiki, activeWikiId, activeWikis, selectedModel, deepResearchModel, visionModel, videoModelPrimary, videoDefaultDuration, videoDefaultResolution, videoDefaultAspect, videoGenerateAudio, videoConfirmThreshold, videoIdentityScale, videoQcEnabled, videoMotionModel, falApiKey, splatModelPrimary, splatDefaultQuality, splatMaxFileMb, splatConfirmThreshold, splatMonthlyQuota, splatAutoFallback, customSystemPrompt, getActiveBodyForScope, burplexityApiToken, persistMessage, updateRollingSummary, addChapter, updateChapter, removeChapter, updateBookTitle, loadChapterText, setActiveBookSilent]
  );


  /** The roster the next chat turn would carry, as a gate map.
   *
   *  Mirrors the send path exactly rather than approximating it: the same
   *  model resolution (vision override on picture turns, Deep Research model
   *  when the paid toggle is on, otherwise the chat model), the same NVIDIA
   *  capability lookup, the same computeToolGates. Anything less and the chip
   *  would eventually claim a tool was offered when it was not — the one
   *  failure that would make this whole surface worse than nothing.
   *
   *  Reads chatToolPermissions from STATE, not permissionsRef: a ref cannot
   *  re-render, and a chip that stayed stale after a toggle would send the
   *  user back to a switch they had already flipped. */
  const toolGatesForTurn = useCallback((hasImages: boolean): Map<string, ToolGate> => {
    const model = hasImages && visionModel
      ? visionModel
      : ((chatDeepResearch && isPaid) ? deepResearchModel : selectedModel);
    const { provider, localId } = resolveModel(model);
    const nv = provider === "nvidia" ? nvidiaModelInfo(localId) : null;
    return computeToolGates({
      toolNames: ALL_TOOL_NAMES,
      leanMode,
      permissions: chatToolPermissions || {},
      forgeOptIn,
      runOptIn,
      foundryReady,
      forgeProgramOptIn,
      runProgramOptIn,
      programReady,
      // The SAME capability call the send path makes, for the same reason it
      // is a shared function and not two expressions: the chip and the wire
      // must be one computation, or the chip eventually claims a tool was
      // offered when it was not — the one failure that would make this
      // surface worse than nothing.
      providerSupportsTools: modelToolSupport(model).supportsTools,
      // Still NVIDIA-specific and still correct: only its VL models drop
      // tools on a picture turn.
      imageTurnDisablesTools: !!nv && nv.imagesDisableTools === true && hasImages,
    });
  }, [visionModel, chatDeepResearch, isPaid, deepResearchModel, selectedModel, leanMode, chatToolPermissions, forgeOptIn, runOptIn, foundryReady, forgeProgramOptIn, runProgramOptIn, programReady]);

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
      toolGatesForTurn,
      approvedToolCount,
    }),
    [messages, isLoading, chatDeepResearch, voiceDeepResearch, setChatDeepResearch, setVoiceDeepResearch, sendMessage, injectDisplayMessage, clearChat, abort, loadEarlier, hasEarlier, loadingEarlier, toolGatesForTurn, approvedToolCount],
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
