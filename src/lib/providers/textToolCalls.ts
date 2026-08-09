// Salvage pass for tool calls a model emitted as PLAIN TEXT instead of in the
// structured `tool_calls` field.
//
// NVIDIA's own NIM documentation states the API "does not guarantee that
// <tool_call> or other tool-related text does not appear in message.content".
// When that happens the structured path sees no call at all: the turn ends
// with finish_reason "stop", nothing runs, and the user reads a paragraph
// describing an action that never happened. That is the exact shape of the
// "it says it did the thing but nothing happened" report this module exists
// to close.
//
// It is a GATE, not merely a parser. Whatever it returns is handed to the same
// executor the structured path feeds, so these rules are load-bearing:
//   - a candidate becomes a call ONLY if its name is in the roster that was
//     actually offered for this turn. A name nobody granted is prose, not a
//     call, and stays in the text untouched — that is what stops a model (or
//     content quoted into a reply) from naming something it was never given;
//   - arguments must parse as JSON and yield a plain object. Never repaired,
//     never half-parsed, never inferred;
//   - a ``` fence belongs to the reader, not to us. Nothing is mined out of one
//     unless the fence's own info string says it IS a call — `tool_call` /
//     `tool_calls`, which no model emits as illustration. A ```json fence is
//     NEVER consumed: "don't run it, just show me the JSON you'd send to delete
//     chapter 3" is the most idiomatic way there is to ask for an example, and
//     answering it must not delete chapter 3;
//   - recovering nothing returns the input string byte-identically. That is
//     the path essentially every turn takes, and it must have no side effects
//     on the text at all.
//
// RECOVERY IS NOT A CAPABILITY GRANT. Before this module existed, text that
// merely LOOKED like a call could never execute. Text reaches a reply from
// outside the model all the time — a web_search result, an imported chapter, a
// pinned workspace file, a forged tool's own return value — and gets echoed
// back inline the moment the user asks "what does this say?". Such a blob can
// carry its own confirm:true, so the argument-level gates downstream are no
// defence. Three INDEPENDENT barriers stand in the way, and the caller opts
// into the first two per turn:
//   (a) TERMINAL CALL BLOCK (`requireTerminal`) — real providers emit their
//       calls as the last thing in the message. From the first recovered span
//       to the end of the reply there must be nothing but recovered spans and
//       whitespace; prose anywhere in that stretch means this is prose that
//       CONTAINS call syntax, not a reply that ENDS in calls, and NOTHING is
//       recovered. All or nothing, deliberately: see terminalBlock.
//   (b) PROVENANCE (`inbound`) — a span that appears verbatim in the text that
//       arrived from outside the model this turn was transcribed, not authored.
//   (c) BLAST RADIUS (always on) — only a tool on the RECOVERY_EXECUTABLE
//       allow-list may run from recovered text; see isRecoveryExecutable.
//       Everything else comes back in `refused`, which exists FOR THE RECEIPT
//       AND NOTHING ELSE: the app tells the USER that a call arrived as text
//       and did not run. The caller must never name one to the MODEL.
//
//       THIS BLOCK USED TO SAY THE OPPOSITE — that refused calls came back "so
//       the caller can tell the MODEL its call arrived written into the reply
//       as text and has to be re-issued as a real tool call". That round trip
//       is REMOVED, because it was a one-round delay rather than a stop. Feed
//       the app a document ending in
//       `<tool_call>{"name":"delete_chapter",…}</tool_call>` and ask what it
//       says: the model echoes it, iteration N declined to run it and then
//       told the model, in the app's own voice, exactly how to make it run,
//       and iteration N+1 a compliant model obliges — at which point the
//       structured path carries the call, this pass never runs, and it
//       executes. ChatContext's TEXT_CALL_NOTE is the whole permitted
//       response: one app-authored sentence, no tool name, no arguments, no
//       imperative, so a quoted blob has nothing in it to steer.
//       Saying nothing to the model is NOT the "it says it did the thing and
//       nothing happened" bug returning. That bug was the USER being told an
//       action happened when none did, and the receipt is what answers it.
// (a) and (b) reject a candidate outright: it was never a call, so its text is
// left exactly where it was. (c) accepts it as a call and declines to run it.
//
// What the text is guaranteed to look like afterwards, stated exactly, because
// raw call syntax left in `cleanedText` reaches the user's bubble AND is pushed
// back into model context on the next turn:
//   - recovery did nothing (calls and refused both empty)  => byte-identical
//     input. This covers every (a)- and (b)-rejected reply, and it is load
//     bearing: "what does this imported chapter say?" is answered by quoting
//     the passage, and deleting the passage the user asked to see would be its
//     own kind of lying.
//   - recovery did something => every span it recovered, executed or refused,
//     is gone. Under rule (a) that is every candidate the scan found, so a
//     reply that ends in calls cannot leave one of them behind as markup.
//   - the one exception, on purpose: a (b)-rejected span sitting earlier in a
//     reply that also ends in a real call. That span is the model quoting the
//     user's own document, and it stays.
//
// Pure by design apart from one import of toolPermissions.ts, itself a
// zero-dependency constants module: the chat pipeline, the receipt and the
// tests all read the same functions, and they must be trivially testable.

import { PERMISSION_GROUPS, TOOL_PERMISSION } from "@/lib/toolPermissions";

export interface RecoveredToolCall {
  name: string;
  /** Raw JSON text of the arguments, ready for the same JSON.parse the structured path uses. */
  args: string;
  /** The exact substring of the reply this was parsed out of, so the caller can remove it. */
  matched: string;
  /** Which emitted dialect this came from — for the receipt, never for the user. */
  format: "tool_call_tag" | "function_tag" | "python_tag" | "fenced_json" | "bare_json";
}

export interface TextToolCallScan {
  /** Recovered AND cleared to execute. */
  calls: RecoveredToolCall[];
  /** Recovered, but outside the RECOVERY_EXECUTABLE allow-list, so not run
   *  (barrier c). NOT a synonym for "destructive": web_search is out because it
   *  is third-party and metered, the show_* family because it pushes media into
   *  the user's transcript, view_image because it bills vision tokens. Anything
   *  nobody vetted for this path is here, which is the point of an allow-list.
   *
   *  THESE ARE FOR THE RECEIPT ONLY. The caller counts them and tells the USER
   *  a call arrived written into the reply as text and did not run. The caller
   *  must NEVER name one to the MODEL — not the name, not the arguments, not a
   *  paraphrase, and never as a proposed tool_call — because the reply text may
   *  have been quoted INTO the model out of a file, a search result or a forged
   *  tool's return value, and echoing it back is the app choosing an attacker's
   *  call on the model's behalf. See barrier (c) at the top of this file for
   *  the round trip that was deleted and why it only delayed the exploit by one
   *  iteration. ChatContext's TEXT_CALL_NOTE — one app-authored sentence, no
   *  tool name, no arguments, no imperative — is the entire permitted response.
   *
   *  This module only reports the facts; it composes no sentence at all. */
  refused: RecoveredToolCall[];
  /** The reply with every recovered call — executed or refused — removed and
   *  the seams healed. When nothing was recovered this is the input string
   *  byte-for-byte, which is how a reply that merely QUOTES call syntax keeps
   *  the passage the user asked to see. */
  cleanedText: string;
}

export interface ScanOptions {
  /** Barrier (a). Require the recovered spans to be the TAIL of the reply:
   *  from the first of them to the last character, nothing but those spans and
   *  whitespace. Prose between two candidates disqualifies every candidate —
   *  all or nothing, never a subset. */
  requireTerminal?: boolean;
  /** Text that arrived from outside the model on this turn — the user's
   *  message, this turn's tool results, injected file context. A candidate
   *  whose span appears in here was transcribed, not authored. Barrier (b). */
  inbound?: string | readonly string[];
}

// --- barrier (c): blast radius ----------------------------------------------
//
// This used to be a DENY-list, derived from `danger:true` permissions, `confirm`
// arguments and the `delete_` prefix. It was wrong BY DEFAULT: every tool those
// three rules failed to name was executable from recovered text. Walking the
// roster found what that let through —
//   * resolve_conflict: retires entries, hard-deletes on the legacy schema and
//     supersedes content on edit_a/edit_b, and has NO entry in TOOL_PERMISSION
//     at all, so the danger-permission rule could never reach it. Its own
//     description says never to call it destructively without explicit approval;
//   * link_memory_entries with {"action":"delete"} — the destructive verb is an
//     ARGUMENT, and no rule that reads tool names can see an argument;
//   * rename_book — book_id "defaults to the active book", so a call carrying
//     only a title retitles whatever the user happens to have open;
//   * create_memory_entry — needs only title+content, and what it writes comes
//     back on every later turn as the user's own remembered fact. One echoed
//     search snippet is permanent knowledge poisoning;
//   * generate_image / edit_image — billed to the user's key. Only the two
//     generators that happen to take a `confirm` argument were ever caught.
// The shape of the mistake matters more than the list: a deny-list asks "is
// this one of the dangerous ones?", and the answer for anything nobody thought
// about is no.
//
// So it is an ALLOW-LIST, and a tool nobody vetted cannot execute. A tool earns
// a place only if ALL of these hold, judged from its EXECUTOR in chatTools.ts
// and never from its name:
//   1. it writes nothing — no database row, no storage object, no app state;
//   2. it deletes nothing;
//   3. it spends none of the user's money and none of their metered quota, and
//      it sends nothing to a third party;
//   4. it cannot change what a LATER turn retrieves or believes. Switching the
//      active book, the active wiki, the loaded neuron set or the promoted take
//      is a write in every way that matters, whatever the verb is called.
// Membership is spelled out rather than imported because chatTools.ts drags in
// the whole app and a live Supabase client, and this module has to stay a pure,
// trivially-testable gate. textToolCalls.test.ts is what keeps it honest: it
// walks CHAT_TOOL_DEFINITIONS and fails the build if a member has a `confirm`
// argument, a danger permission, or a destructive `action` enum, or if a member
// is not a real tool at all. A NEW tool is non-executable the moment it is
// added, and can only join by someone editing this list on purpose.

/** The permission ids the settings screen itself renders with a danger badge.
 *  Reading the UI's own marking means a tool the product calls destructive
 *  cannot quietly become recoverable-and-executable — even by being typed into
 *  the allow-list below, which this set is subtracted from. */
const DANGER_PERMISSION_IDS: ReadonlySet<string> = new Set(
  PERMISSION_GROUPS.flatMap((g) => g.items.filter((i) => i.danger === true).map((i) => i.id)),
);

/** Read-class tools, with the reason each one qualifies. Everything absent —
 *  including every tool added after this list was written — is refused. */
const RECOVERY_ALLOWED = [
  // ── Library ──
  // Reads deps.books (already in memory) or one SELECT against the account.
  "list_books",
  // Reads one book out of deps.books. No fetch, no write.
  "get_book",
  // Reads chapter text through deps.loadChapterText. Returns the user's own
  // words to the model; nothing is stored, nothing is focused.
  "get_chapter_text",

  // ── Knowledge ──
  // SELECT over knowledge_entries, scoped to the loaded neurons, results
  // fenced as untrusted data. It does not change the scope it searched.
  "search_wiki",
  // SELECT of one entry's supersession chain. Read-only by construction.
  "get_memory_history",
  // SELECT over knowledge_conflicts. Reading a contradiction is not resolving
  // it — resolve_conflict and update_conflict_status are the writes, and both
  // are absent here.
  "list_conflicts",
  "get_conflict",
  // SELECT over wikis plus an entry count. switch_wiki, create_wiki,
  // set_active_neurons and activate_chain all change which neurons later turns
  // retrieve from, and none of them are here.
  "list_wikis",
  "get_active_wiki",
  "list_chains",

  // ── Media catalogues (metadata only) ──
  // SELECTs returning ids, prompts, captions and status. No bytes, no signed
  // URLs, no generation. recall_image_memories is deliberately absent: it mints
  // one-hour signed URLs to private storage objects, which is a bearer
  // capability, not a listing. show_image / show_video / show_splat are absent
  // too: they push media into the user's transcript, and view_image bills
  // ~1300 vision tokens to the user's key on top of that.
  "list_images",
  "list_videos",
  "list_splats",
  "list_master_assets",

  // ── Production ──
  // SELECT of saved scenes; lock_scene and delete_scene are the writes.
  "list_scenes",
  // Aggregate read of the production ledger. accept_generation and
  // reject_generation write verdicts — and an accepted take is what future work
  // re-anchors on, i.e. rule 4 — so neither is here.
  "get_production_stats",

  // ── Workspace ──
  // Reads the in-memory workspace store, filtered to this user, fenced as
  // untrusted data. save_file and create_artifact write and are absent.
  "list_workspace_items",
  "read_workspace_item",

  // ── Tool Foundry (inspection only) ──
  // Inventory and source of the user's own forged tools, fenced as data. Being
  // able to READ its own source is what makes repair possible; running is a
  // different verb. run_tool executes forged code in the sandbox, test_tool
  // executes CANDIDATE code supplied in the arguments — a quoted blob must not
  // reach either in one hop — and forge_tool writes a row and raises an
  // approval card, which is both a write and a place to put a persuasive
  // sentence in front of the user. All three are absent.
  "list_tools",
  "read_tool",
] as const;

/** The effective allow-list: what was vetted above, minus anything the settings
 *  screen marks as dangerous. Subtraction can only ever narrow, so a mistake in
 *  the list cannot widen the barrier. */
export const RECOVERY_EXECUTABLE: ReadonlySet<string> = new Set(
  RECOVERY_ALLOWED.filter(
    (name) =>
      !name.startsWith("delete_") &&
      !DANGER_PERMISSION_IDS.has(TOOL_PERMISSION[name] ?? ""),
  ),
);

/** May a call recovered from the reply TEXT actually run? The caller and the
 *  tests share this one definition so they cannot drift. */
export function isRecoveryExecutable(name: string): boolean {
  return RECOVERY_EXECUTABLE.has(name);
}

// --- bounds -----------------------------------------------------------------
// Every limit here exists so a hostile or merely runaway reply costs a fixed
// amount of work. There are no unbounded or nested-quantifier regexes in this
// file; every scan is an explicit character loop with a ceiling.

/** Replies longer than this are not scanned at all. */
const MAX_TEXT = 200_000;
/** Most calls we will ever recover from one reply. */
const MAX_CALLS = 8;
/** Longest single payload we will brace-match. A stray "{" must not turn each
 *  candidate into a full-text walk — that is how linear becomes quadratic. */
const MAX_PAYLOAD = 100_000;
/** Total candidate sites inspected across all dialects, hit or miss. */
const MAX_SITES = 64;
/** Provenance budget (barrier b), spent PER SOURCE rather than drained in
 *  caller order. It used to be one 200k allowance handed out first-come: a
 *  pinned focus block or one long chapter could consume all of it before this
 *  turn's TOOL RESULTS were compared at all — and tool results are the channel
 *  this barrier's own comment names as likeliest. Ordering alone silently
 *  switched the barrier off for the payload it was written for.
 *  Each source now gets an equal share of MAX_INBOUND, never below
 *  MIN_INBOUND_SHARE, and at most MAX_INBOUND_SOURCES sources are read, so the
 *  worst case is a fixed MAX_INBOUND_SOURCES * MIN_INBOUND_SHARE characters of
 *  normalisation (~512k) plus at most MAX_CALLS native substring searches per
 *  haystack. Text past a source's share is not compared — stated plainly rather
 *  than pretended away, because barriers (a) and (c) are independent of this
 *  one and still stand. */
const MAX_INBOUND = 200_000;
const MIN_INBOUND_SHARE = 8_192;
const MAX_INBOUND_SOURCES = 64;
/** Longest tail hasUnclosedCallOpener inspects. It runs once per streaming
 *  delta, so it must not walk a growing reply from the front — that is how a
 *  per-delta check becomes quadratic in the reply length. */
const UNCLOSED_TAIL = 32_768;

const OPEN_TOOL_CALL = "<tool_call>";
const CLOSE_TOOL_CALL = "</tool_call>";
const OPEN_FUNCTION = "<function";
const CLOSE_FUNCTION = "</function>";
const PYTHON_TAG = "<|python_tag|>";

/** Fence info strings whose body may itself be a call (dialect 4). Anything
 *  else fenced is the reader's content and is left exactly as written.
 *  `json` is POINTEDLY absent. It used to be here, and it meant that answering
 *  "don't run it, just show me the JSON you'd send to delete chapter 3" — whose
 *  most idiomatic answer is a ```json fence holding exactly one envelope —
 *  deleted chapter 3. No model emits ```tool_call as illustration; every model
 *  emits ```json as illustration. */
const CALL_FENCE_INFO = new Set(["tool_call", "tool_calls"]);

interface Fence {
  start: number;
  end: number;
  /** First word of the info string, lowercased. */
  info: string;
  bodyStart: number;
  bodyEnd: number;
}

interface Found {
  start: number;
  end: number;
  call: RecoveredToolCall;
}

interface Budget {
  sites: number;
}

/** Recover tool calls a model wrote into its prose. `offered` is the roster
 *  that was actually sent with the request — not the full tool table.
 *  `options` is optional and defaults to the pre-barrier behaviour for (a) and
 *  (b); barrier (c) is unconditional and cannot be opted out of. */
export function scanTextForToolCalls(
  text: string,
  offered: ReadonlySet<string>,
  options?: ScanOptions,
): TextToolCallScan {
  // The overwhelmingly common path: nothing to do, and the caller must get its
  // own string back with no normalisation applied behind its back.
  const untouched: TextToolCallScan = { calls: [], refused: [], cleanedText: text };
  if (!text || offered.size === 0 || text.length > MAX_TEXT) return untouched;

  // Dialect 5 first. Checking it before anything else keeps "only when it is
  // the entire reply" a structural property rather than a filter applied after
  // mining prose for JSON — we never mine prose for JSON.
  const whole = readBareJson(text, offered);
  if (whole) {
    // A reply that is nothing but the envelope is trivially terminal, so only
    // barrier (b) has anything to say about it.
    if (fromInbound(whole.matched, inboundHaystacks(options?.inbound))) return untouched;
    return split([whole], "");
  }

  const fences = findFences(text);
  const found: Found[] = [];
  const budget: Budget = { sites: MAX_SITES };

  collectToolCallTag(text, offered, fences, found, budget);
  collectFunctionTag(text, offered, fences, found, budget);
  collectPythonTag(text, offered, fences, found, budget);
  collectFencedJson(text, offered, fences, found, budget);

  if (found.length === 0) return untouched;

  found.sort((a, b) => a.start - b.start);
  let kept: Found[] = [];
  let lastEnd = -1;
  for (const f of found) {
    // Two dialects can claim overlapping spans (a JSON envelope nested inside a
    // tag, say). The earlier start wins; removing both would corrupt the text.
    if (f.start < lastEnd) continue;
    kept.push(f);
    lastEnd = f.end;
    if (kept.length >= MAX_CALLS) break;
  }

  // Barrier (b) BEFORE barrier (a): a transcribed span stays in the text, which
  // means anything after it is no longer terminal either. Running provenance
  // first lets that fall out of the terminal test instead of being a special
  // case — strictly the more conservative order.
  const haystacks = inboundHaystacks(options?.inbound);
  if (haystacks.length > 0) kept = kept.filter((f) => !fromInbound(f.call.matched, haystacks));
  if (options?.requireTerminal === true) kept = terminalBlock(text, kept);

  if (kept.length === 0) return untouched;
  return split(kept.map((f) => f.call), stitch(text, kept));
}

/** Barrier (c) applied: everything recovered is reported, but only the
 *  non-destructive half is handed to the executor. */
function split(recovered: RecoveredToolCall[], cleanedText: string): TextToolCallScan {
  const calls: RecoveredToolCall[] = [];
  const refused: RecoveredToolCall[] = [];
  for (const c of recovered) (isRecoveryExecutable(c.name) ? calls : refused).push(c);
  return { calls, refused, cleanedText };
}

/** Barrier (a), ALL OR NOTHING: the recovered spans must be the tail of the
 *  reply — from the first of them to the last character there is nothing but
 *  those spans and whitespace.
 *
 *  It used to keep the longest whitespace-contiguous SUFFIX of `kept` and drop
 *  the rest, which had two faces and both were wrong. It executed an arbitrary
 *  SUBSET of what the model asked for: "Let me look these up.\n<call A>\nAnd
 *  the images.\n<call B>" ran B, dropped A on the floor, and told nobody — the
 *  "it says it did the thing and nothing happened" bug, rebuilt inside the
 *  module that exists to close it. And the dropped span stayed in the text, so
 *  raw `<tool_call>` markup landed in the user's bubble and went back into
 *  model context on the next turn.
 *  One rule instead: prose anywhere between the candidates means this is prose
 *  that CONTAINS call syntax, not a reply that ENDS in calls, and nothing is
 *  recovered at all. That is strictly more conservative than the old rule, it
 *  never executes half an intention, and — because every survivor is then part
 *  of one block that stitch() removes whole — it is what makes "recovery never
 *  leaves the markup it recognised behind" true rather than aspirational. */
function terminalBlock(text: string, kept: Found[]): Found[] {
  if (kept.length === 0) return kept;
  if (!isAllWs(text, kept[kept.length - 1].end, text.length)) return [];
  for (let i = 1; i < kept.length; i++) {
    if (!isAllWs(text, kept[i - 1].end, kept[i].start)) return [];
  }
  return kept;
}

/** Barrier (b). Sources are kept SEPARATE rather than concatenated so a needle
 *  can never be assembled out of the tail of one source and the head of the
 *  next. Each source contributes up to TWO haystacks — see decodeJsonEscapes
 *  for why the second one is the whole point of this barrier working at all. */
function inboundHaystacks(inbound: string | readonly string[] | undefined): string[] {
  if (inbound === undefined) return [];
  const sources = typeof inbound === "string" ? [inbound] : inbound;
  const count = Math.min(sources.length, MAX_INBOUND_SOURCES);
  if (count === 0) return [];
  const share = Math.max(MIN_INBOUND_SHARE, Math.floor(MAX_INBOUND / count));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const src = sources[i];
    if (typeof src !== "string" || src.length === 0) continue;
    const cut = src.length > share ? src.slice(0, share) : src;
    // Two readings of the same source, because we do not know which one the
    // caller handed us. Both are searched; matching either rejects the span,
    // and rejecting more is always the safe direction for this barrier.
    const asWritten = normalizeSpan(cut);
    if (asWritten.length > 0) out.push(asWritten);
    const asDecoded = normalizeSpan(decodeJsonEscapes(cut));
    if (asDecoded.length > 0 && asDecoded !== asWritten) out.push(asDecoded);
  }
  return out;
}

/** True when this span was transcribed out of `inbound` rather than authored. */
function fromInbound(matched: string, haystacks: string[]): boolean {
  if (haystacks.length === 0) return false;
  const needle = normalizeSpan(matched);
  if (needle.length === 0) return false;
  for (const h of haystacks) if (h.includes(needle)) return true;
  return false;
}

/** Collapse every whitespace run to one space so re-wrapping a quoted blob —
 *  which a model does constantly — does not defeat the comparison. */
function normalizeSpan(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Undo ONE level of JSON string escaping.
 *
 *  Why this exists: the caller stores each tool result as JSON.stringify(...)
 *  and hands that string in as `inbound`. So the haystack holds \" where the
 *  model's echo holds a bare quote, and a two-character \n where the echo holds
 *  a real newline — and normalizeSpan only ever collapsed whitespace, so the
 *  substring test could not match. For web_search snippets, read_workspace_item
 *  bodies, search_wiki hits and forged-tool return values — the exact channel
 *  the barrier was written for — provenance was a no-op that looked like a
 *  feature.
 *
 *  Applied to the HAYSTACK ONLY, never to the needle. A needle that goes
 *  through this too would decode its own arguments (a literal \n inside a
 *  string argument becomes a newline) while a doubly-escaped haystack decodes
 *  only to the literal \n, and the two would drift apart again in the opposite
 *  direction.
 *
 *  One left-to-right pass over an already-capped string, so \\n is consumed as
 *  an escaped backslash followed by "n" and never as a newline. A backslash
 *  that does not begin a JSON escape is emitted verbatim: nothing here guesses. */
function decodeJsonEscapes(s: string): string {
  if (s.indexOf("\\") === -1) return s; // the common case pays nothing
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) {
      out += c;
      i++;
      continue;
    }
    if (n === "\\" || n === '"' || n === "/") {
      out += n;
      i += 2;
      continue;
    }
    if (n === "n") { out += "\n"; i += 2; continue; }
    if (n === "t") { out += "\t"; i += 2; continue; }
    if (n === "r") { out += "\r"; i += 2; continue; }
    if (n === "b") { out += "\b"; i += 2; continue; }
    if (n === "f") { out += "\f"; i += 2; continue; }
    if (n === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (HEX4.test(hex)) {
        // Per code UNIT: a surrogate pair arrives as two \uXXXX escapes and the
        // two units concatenate back into the right character on their own.
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dialect 1 — <tool_call>{"name":…,"arguments":{…}}</tool_call>
// Qwen, Hermes and NIM-hosted models. The unclosed variant is common when the
// model runs out of budget mid-tag, and it is exactly the case where dropping
// the call silently is most damaging.
// ---------------------------------------------------------------------------

function collectToolCallTag(
  text: string,
  offered: ReadonlySet<string>,
  fences: Fence[],
  out: Found[],
  budget: Budget,
): void {
  let i = 0;
  for (;;) {
    const at = text.indexOf(OPEN_TOOL_CALL, i);
    if (at === -1) return;
    i = at + OPEN_TOOL_CALL.length;
    if (budget.sites-- <= 0) return;

    const close = text.indexOf(CLOSE_TOOL_CALL, i);
    if (close !== -1) {
      const end = close + CLOSE_TOOL_CALL.length;
      const env = readEnvelope(text.slice(i, close).trim(), offered);
      if (env && !intersectsFence(fences, at, end)) {
        out.push(make(text, at, end, env, "tool_call_tag"));
        i = end;
      }
      continue;
    }

    // Unclosed at end of reply: take exactly the one JSON object that follows
    // and nothing after it, so trailing prose survives instead of being eaten.
    const objStart = skipWs(text, i);
    if (text[objStart] !== "{") continue;
    const objEnd = jsonObjectEnd(text, objStart);
    if (objEnd === -1) continue;
    const env = readEnvelope(text.slice(objStart, objEnd), offered);
    if (!env || intersectsFence(fences, at, objEnd)) continue;
    out.push(make(text, at, objEnd, env, "tool_call_tag"));
    i = objEnd;
  }
}

// ---------------------------------------------------------------------------
// Dialect 2 — <function=name>{…}</function> and <function name="x">{…}</function>
// Llama-family. Note the body IS the argument object here; there is no
// name/arguments envelope, so the name comes from the tag alone.
// ---------------------------------------------------------------------------

/** Anchored, bounded, no nested quantifiers — matches only the opening tag. */
const FUNCTION_HEAD = /^<function(?:=([^\s>]+)|\s+name\s*=\s*"([^"]*)")\s*>/;
/** The same opener with its ">" not yet streamed. Only hasUnclosedCallOpener
 *  uses it: "<function=get_bo" is a tag mid-flight, "<functional" is a word. */
const FUNCTION_HEAD_OPEN = /^<function(?:=|\s)/;
/** Enough for any real opening tag; keeps the regex off long strings. */
const FUNCTION_HEAD_WINDOW = 512;

function collectFunctionTag(
  text: string,
  offered: ReadonlySet<string>,
  fences: Fence[],
  out: Found[],
  budget: Budget,
): void {
  let i = 0;
  for (;;) {
    const at = text.indexOf(OPEN_FUNCTION, i);
    if (at === -1) return;
    i = at + OPEN_FUNCTION.length;
    if (budget.sites-- <= 0) return;

    const head = FUNCTION_HEAD.exec(text.slice(at, at + FUNCTION_HEAD_WINDOW));
    if (!head) continue; // "<functional>", "<functions>" and friends are prose.
    const name = head[1] ?? head[2] ?? "";
    const bodyStart = at + head[0].length;
    const close = text.indexOf(CLOSE_FUNCTION, bodyStart);
    if (close === -1) continue;
    const end = close + CLOSE_FUNCTION.length;
    if (!offered.has(name)) continue;
    const args = normalizeArgs(parsePlainObject(text.slice(bodyStart, close).trim()));
    if (args === null || intersectsFence(fences, at, end)) continue;
    out.push(make(text, at, end, { name, args }, "function_tag"));
    i = end;
  }
}

// ---------------------------------------------------------------------------
// Dialect 3 — <|python_tag|>name(arg="v", n=1) or <|python_tag|>{"name":…}
// Llama 3.x. The call-expression form is the only place we translate rather
// than parse, so its value grammar is deliberately small: string, number,
// boolean, null (Python spellings included) and JSON array/object literals.
// Anything else — a bare identifier, an expression, an f-string, a positional
// argument — makes the WHOLE candidate unsupported. Half a translation is a
// fabricated call, so we skip and leave the text alone.
// ---------------------------------------------------------------------------

function collectPythonTag(
  text: string,
  offered: ReadonlySet<string>,
  fences: Fence[],
  out: Found[],
  budget: Budget,
): void {
  let i = 0;
  for (;;) {
    const at = text.indexOf(PYTHON_TAG, i);
    if (at === -1) return;
    i = at + PYTHON_TAG.length;
    if (budget.sites-- <= 0) return;

    const after = skipWs(text, i);

    if (text[after] === "{") {
      const objEnd = jsonObjectEnd(text, after);
      if (objEnd === -1) continue;
      const env = readEnvelope(text.slice(after, objEnd), offered);
      if (!env || intersectsFence(fences, at, objEnd)) continue;
      out.push(make(text, at, objEnd, env, "python_tag"));
      i = objEnd;
      continue;
    }

    const nameEnd = identifierEnd(text, after);
    if (nameEnd === after) continue;
    const name = text.slice(after, nameEnd);
    const open = skipWs(text, nameEnd);
    // A dotted or subscripted callee (brave_search.call(...)) stops here, which
    // is correct: we cannot say which tool that names.
    if (text[open] !== "(") continue;
    const close = matchingClose(text, open);
    if (close === -1) continue;
    if (!offered.has(name)) continue;
    const args = pythonKwargsToJson(text.slice(open + 1, close));
    if (args === null || intersectsFence(fences, at, close + 1)) continue;
    out.push(make(text, at, close + 1, { name, args }, "python_tag"));
    i = close + 1;
  }
}

// ---------------------------------------------------------------------------
// Dialect 4 — a ```tool_call / ```tool_calls fence whose body is one call
// envelope. These are the ONLY fences we are allowed to consume, which is what
// lets every other fence — ```json above all — be returned verbatim.
// The `format` tag stays "fenced_json" because the BODY is still JSON and the
// receipt and its persisted rows already read that string.
// ---------------------------------------------------------------------------

function collectFencedJson(
  text: string,
  offered: ReadonlySet<string>,
  fences: Fence[],
  out: Found[],
  budget: Budget,
): void {
  for (const f of fences) {
    if (budget.sites-- <= 0) return;
    if (!CALL_FENCE_INFO.has(f.info)) continue;
    const env = readEnvelope(text.slice(f.bodyStart, f.bodyEnd).trim(), offered);
    if (!env) continue;
    out.push(make(text, f.start, f.end, env, "fenced_json"));
  }
}

// ---------------------------------------------------------------------------
// Dialect 5 — the whole reply is one call envelope and nothing else.
// ---------------------------------------------------------------------------

function readBareJson(text: string, offered: ReadonlySet<string>): RecoveredToolCall | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PAYLOAD || trimmed[0] !== "{") return null;
  // "Exactly one object" — a second object, or any trailing prose, disqualifies
  // it. Otherwise this dialect would degenerate into mining arbitrary text.
  if (jsonObjectEnd(trimmed, 0) !== trimmed.length) return null;
  const env = readEnvelope(trimmed, offered);
  if (!env) return null;
  return { name: env.name, args: env.args, matched: trimmed, format: "bare_json" };
}

// ---------------------------------------------------------------------------
// Envelope and argument validation.
// ---------------------------------------------------------------------------

interface Envelope {
  name: string;
  args: string;
}

/** `{"name": "x", "arguments": {…}}` — the shape dialects 1, 3, 4 and 5 share.
 *  `"parameters"` is accepted as a synonym; both are common on the wire. */
function readEnvelope(raw: string, offered: ReadonlySet<string>): Envelope | null {
  const obj = parsePlainObject(raw);
  if (!obj) return null;
  const name = obj.name;
  // The roster gate. Everything downstream trusts this line.
  if (typeof name !== "string" || !offered.has(name)) return null;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(obj, k);
  // An object that carries only a matching `name` is not evidence of an
  // intended call — every dialect above ships the argument object even when it
  // is empty. Requiring it keeps prose that happens to mention a tool out.
  if (!has("arguments") && !has("parameters")) return null;
  const args = normalizeArgs(has("arguments") ? obj.arguments : obj.parameters);
  if (args === null) return null;
  return { name, args };
}

/** Normalize an already-parsed arguments value to JSON text, or null if it is
 *  not a plain object. Some backends stringify the object one level too many,
 *  which is a re-parse, not a repair — anything else is refused. */
function normalizeArgs(value: unknown): string | null {
  if (typeof value === "string") {
    const inner = parsePlainObject(value);
    return inner ? JSON.stringify(inner) : null;
  }
  if (isPlainObject(value)) return JSON.stringify(value);
  return null;
}

function parsePlainObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PAYLOAD) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed or truncated. No repair pass — a guessed argument object runs
    // as if the model had asked for it.
    return null;
  }
  return isPlainObject(parsed) ? (parsed as Record<string, unknown>) : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Python call-expression translation.
// ---------------------------------------------------------------------------

function pythonKwargsToJson(body: string): string | null {
  if (body.length > MAX_PAYLOAD) return null;
  const parts = splitTopLevel(body);
  if (!parts) return null;

  const obj: Record<string, unknown> = {};
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k].trim();
    if (part === "") {
      // `name()` and one trailing comma are empty by design; ",," or a leading
      // comma is malformed and we do not straighten it out.
      if (parts.length === 1 || k === parts.length - 1) continue;
      return null;
    }
    const head = KWARG_HEAD.exec(part);
    if (!head) return null; // positional argument, or an expression
    const key = head[1];
    // A repeated keyword has no single faithful reading.
    if (Object.prototype.hasOwnProperty.call(obj, key)) return null;
    const json = pythonValueToJson(part.slice(head[0].length));
    if (json === null) return null;
    obj[key] = JSON.parse(json);
  }
  return JSON.stringify(obj);
}

/** `key =` at the start of an argument. The negative lookahead keeps `a == b`
 *  (and, via the anchored identifier, `a >= b`) out. */
const KWARG_HEAD = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*/;
/** Strict JSON number spelling — rejects 0x10, 1_000, inf, 1+2. */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

function pythonValueToJson(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return null;

  if (v[0] === '"') {
    // Reuse JSON's own string grammar. A Python-only escape simply fails here,
    // which is the outcome we want.
    try {
      const parsed = JSON.parse(v);
      return typeof parsed === "string" ? JSON.stringify(parsed) : null;
    } catch {
      return null;
    }
  }
  if (v[0] === "'") {
    const decoded = decodeSingleQuoted(v);
    return decoded === null ? null : JSON.stringify(decoded);
  }
  if (v === "True" || v === "true") return "true";
  if (v === "False" || v === "false") return "false";
  if (v === "None" || v === "null") return "null";
  if (JSON_NUMBER.test(v)) return v;
  if (v[0] === "[" || v[0] === "{") {
    // Only literals JSON itself accepts. A Python dict with single-quoted keys
    // fails here rather than being rewritten into something we invented.
    try {
      return JSON.stringify(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return null;
}

/** Decode a complete single-quoted literal, or null if it is not one or uses
 *  an escape we cannot map exactly. */
function decodeSingleQuoted(s: string): string | null {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "'") return i === s.length - 1 ? out : null;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) return null;
    if (n === "\\") out += "\\";
    else if (n === "'") out += "'";
    else if (n === '"') out += '"';
    else if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (!HEX4.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else return null; // \x41, \0, \b … — not worth a guess
    i += 1;
  }
  return null; // unterminated
}

/** Split an argument list on top-level commas, or null if it is unbalanced. */
function splitTopLevel(s: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let esc = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return null;
    } else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || depth !== 0) return null;
  parts.push(s.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// Character scanners. All bounded; none use regex backtracking.
// ---------------------------------------------------------------------------

/** Index just past the `}` closing the object at `start`, or -1. String bodies
 *  and their escapes are honoured so a brace inside a value cannot end it. */
function jsonObjectEnd(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  const limit = Math.min(text.length, start + MAX_PAYLOAD);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < limit; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchingClose(text: string, open: number): number {
  const limit = Math.min(text.length, open + MAX_PAYLOAD);
  let depth = 0;
  let quote = "";
  let esc = false;
  for (let i = open; i < limit; i++) {
    const c = text[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function identifierEnd(text: string, start: number): number {
  const first = text.charCodeAt(start);
  if (!isIdentStart(first)) return start;
  let i = start + 1;
  while (i < text.length && isIdentPart(text.charCodeAt(i))) i++;
  return i;
}

function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

function skipWs(text: string, i: number): number {
  let k = i;
  while (k < text.length && isWs(text.charCodeAt(k))) k++;
  return k;
}

function isAllWs(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (!isWs(text.charCodeAt(i))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Fences.
// ---------------------------------------------------------------------------

/** Every ``` region in the text, paired sequentially. An unclosed opener runs
 *  to the end of the reply — while a fence is open the reader sees code, so we
 *  treat it as code too. */
function findFences(text: string): Fence[] {
  const fences: Fence[] = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf("```", i);
    if (start === -1) return fences;
    let lineEnd = text.indexOf("\n", start + 3);
    if (lineEnd === -1) lineEnd = text.length;
    const info = text.slice(start + 3, lineEnd).trim().split(/\s+/)[0].toLowerCase();
    const bodyStart = Math.min(lineEnd + 1, text.length);
    const closeAt = text.indexOf("```", bodyStart);
    const bodyEnd = closeAt === -1 ? text.length : closeAt;
    const end = closeAt === -1 ? text.length : closeAt + 3;
    fences.push({ start, end, info, bodyStart, bodyEnd });
    i = end;
    if (i >= text.length) return fences;
  }
}

function intersectsFence(fences: Fence[], start: number, end: number): boolean {
  for (const f of fences) if (start < f.end && end > f.start) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Streaming guard.
// ---------------------------------------------------------------------------

/** Openers that can be caught half-written when a stream is cut, paired with
 *  the shortest prefix worth believing. Three characters is the line: a reply
 *  ending in "<to", "<fu" or "<|p" is a tag being typed, while "<" or "``"
 *  alone is ordinary prose and an ordinary code fence. */
const OPENER_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  [OPEN_TOOL_CALL, 3],
  [OPEN_FUNCTION, 3],
  [PYTHON_TAG, 3],
  ["```tool_call", 5],
  ["```tool_calls", 5],
];

/** True when the text ENDS inside a call the model had not finished writing.
 *
 *  The reason this is exported: the cost valve cancels a stream that has run
 *  past its budget, and on a model that emits calls as TEXT it cancels mid-blob
 *  — the truncated JSON then fails to parse, nothing is recovered, and the user
 *  reads a paragraph about an action that never happened. That is the original
 *  report, reproduced for exactly the capped users this module exists for. The
 *  structured path already has its equivalent guard (it refuses to cut while
 *  tool-call deltas are accumulating); this is the text path's.
 *
 *  Cheap by construction: it runs per streaming delta, so it looks only at the
 *  last UNCLOSED_TAIL characters. An opener whose payload is longer than that
 *  window is not detected, and dialect 5 (the whole reply is one envelope) is
 *  only checked while the whole reply still fits the window. Erring toward
 *  `true` costs a few tokens; erring toward `false` costs the call. */
export function hasUnclosedCallOpener(text: string): boolean {
  if (!text) return false;
  const tail = text.length > UNCLOSED_TAIL ? text.slice(text.length - UNCLOSED_TAIL) : text;

  // The stream stopped in the middle of the opener token itself — or exactly on
  // its last character, which "<function" reaches before it has an argument
  // object for the checks below to look at.
  for (const [token, min] of OPENER_PREFIXES) {
    for (let k = Math.min(token.length, tail.length); k >= min; k--) {
      if (tail.endsWith(token.slice(0, k))) return true;
    }
  }

  // Dialect 1: <tool_call> with neither its closing tag nor a finished object.
  // A complete object IS already recoverable (collectToolCallTag handles the
  // unclosed-tag form), so that case is not "unfinished".
  const tc = tail.lastIndexOf(OPEN_TOOL_CALL);
  if (tc !== -1 && tail.indexOf(CLOSE_TOOL_CALL, tc + OPEN_TOOL_CALL.length) === -1) {
    const objStart = skipWs(tail, tc + OPEN_TOOL_CALL.length);
    if (tail[objStart] !== "{" || jsonObjectEnd(tail, objStart) === -1) return true;
  }

  // Dialect 2: <function…> with no </function> yet. "<functional>" and
  // "<functions>" are prose and must not hold the stream open, so the tag has
  // to look like a real opener — or still be missing its ">".
  const fn = tail.lastIndexOf(OPEN_FUNCTION);
  if (fn !== -1 && tail.indexOf(CLOSE_FUNCTION, fn + OPEN_FUNCTION.length) === -1) {
    const head = tail.slice(fn, fn + FUNCTION_HEAD_WINDOW);
    if (tail.indexOf(">", fn) === -1) {
      if (FUNCTION_HEAD_OPEN.test(head)) return true;
    } else if (FUNCTION_HEAD.test(head)) {
      return true;
    }
  }

  // Dialect 3: <|python_tag|> whose payload has not closed.
  const pt = tail.lastIndexOf(PYTHON_TAG);
  if (pt !== -1) {
    const after = skipWs(tail, pt + PYTHON_TAG.length);
    if (after >= tail.length) return true;
    if (tail[after] === "{") {
      if (jsonObjectEnd(tail, after) === -1) return true;
    } else {
      const nameEnd = identifierEnd(tail, after);
      // Not an identifier at all: this is not a shape we translate, so there is
      // nothing to wait for.
      if (nameEnd > after) {
        const open = skipWs(tail, nameEnd);
        if (open >= tail.length) return true; // name written, arguments not started
        if (tail[open] === "(" && matchingClose(tail, open) === -1) return true;
      }
    }
  }

  // Dialect 4: a ```tool_call fence that never closed. findFences runs an
  // unclosed fence to the end of the text, which is exactly that condition.
  for (const f of findFences(tail)) {
    if (CALL_FENCE_INFO.has(f.info) && f.bodyEnd === f.end && f.end === tail.length) return true;
  }

  // Dialect 5: the whole reply is one envelope and the object has not closed.
  if (tail === text) {
    const start = skipWs(text, 0);
    if (text[start] === "{" && jsonObjectEnd(text, start) === -1) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Text repair.
// ---------------------------------------------------------------------------

function make(
  text: string,
  start: number,
  end: number,
  env: Envelope,
  format: RecoveredToolCall["format"],
): Found {
  return {
    start,
    end,
    call: { name: env.name, args: env.args, matched: text.slice(start, end), format },
  };
}

/** Cut every recovered span out and heal only the seams it left behind.
 *  Whitespace elsewhere is the model's (or the reader's) and is not touched:
 *  a preserved code block must survive its own indentation. */
function stitch(text: string, kept: Found[]): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const f of kept) {
    pieces.push(text.slice(cursor, f.start));
    cursor = f.end;
  }
  pieces.push(text.slice(cursor));

  let out = pieces[0];
  for (let k = 1; k < pieces.length; k++) {
    const right = pieces[k];
    const lw = trailingWsLen(out);
    const rw = leadingWsLen(right);
    const newlines =
      countNewlines(out, out.length - lw, out.length) + countNewlines(right, 0, rw);
    // The removed call consumed one line of its own, so a vertical seam gives
    // back one break fewer than it spanned — "a\n<call>\nb" becomes "a\nb", not
    // a stray blank line — and never more than one blank line either way. A
    // horizontal seam collapses to a single space so "check. <call> Done."
    // does not read as "check.  Done.".
    const glue =
      newlines === 0
        ? lw + rw > 0
          ? " "
          : ""
        : "\n".repeat(Math.min(2, Math.max(1, newlines - 1)));
    out = out.slice(0, out.length - lw) + glue + right.slice(rw);
  }

  // Only the whitespace the removal ORPHANED is ours to collapse. The reply's
  // own leading and trailing whitespace belongs to the transcript: recovery
  // runs per streaming iteration, and iteration N+1 routinely opens with the
  // "\n\n" that separates it from iteration N. Trimming that unconditionally
  // persisted "…deleted chapter 3.Now I'll update the index."
  const body = out.trim();
  // A reply whose only content WAS the call is empty, not a pair of stray
  // newlines — the caller decides whether to persist anything at all.
  if (body.length === 0) return "";
  return text.slice(0, leadingWsLen(text)) + body + text.slice(text.length - trailingWsLen(text));
}

function trailingWsLen(s: string): number {
  let n = 0;
  while (n < s.length && isWs(s.charCodeAt(s.length - 1 - n))) n++;
  return n;
}

function leadingWsLen(s: string): number {
  let n = 0;
  while (n < s.length && isWs(s.charCodeAt(n))) n++;
  return n;
}

function countNewlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
