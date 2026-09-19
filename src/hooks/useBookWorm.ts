import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookWormHandle } from "@/components/BookWorm";
import type { Mood } from "@/lib/sprite/wormAnimator";
import { resolveWormMood } from "@/lib/sprite/wormMood";
import { readVoice, syntheticVoice } from "@/lib/sprite/voiceTap";

/**
 * Wires the BookWorm to Counsel without putting any of it in ChatPanel.
 *
 * ChatPanel is already 1900 lines and owns the composer, the transcript, voice
 * mode and the tool sheet. It should not also own a priority ladder for a
 * mascot's facial expressions. Everything the worm needs is derived here from
 * state the panel already had; the panel's side of this is a hook call, a ref
 * and one element.
 *
 * Two things this hook exists to get right:
 *
 * 1. NO POLLING. Mood depends on elapsed time (a celebration lasts 1.8s, sleep
 *    arrives after 90s), which naively wants an interval. `resolveWormMood`
 *    instead returns the next moment its answer could change, and this
 *    schedules exactly one timeout for it. Idle costs zero timers.
 *
 * 2. DISCOURSE BOUNDARIES ARE EVENTS, NOT STATES. The blink research the
 *    animator is built on keys off clause and topic boundaries, which are
 *    edges, not flags. Detecting them means diffing message ids, spoken chunk
 *    indices and sentence counts against the previous render — all of which is
 *    bookkeeping that belongs behind this interface rather than in the panel.
 */

const STORAGE_KEY = "counsel_bookworm";

/** Terminators, including the CJK forms the repo's sentence-cap code handles.
 *  A worm that only nods at full stops is a worm that never nods in Japanese. */
const SENTENCE_END = /[.!?。！？…]["')\]]?\s/g;

export interface BookWormSignals {
  /** A reply is being generated. */
  isLoading: boolean;
  /** Role and text of the newest message, and its id. */
  lastId: string | undefined;
  lastRole: string | undefined;
  lastText: string;
  /** Composer draft. */
  input: string;
  /** Id of the message being spoken, or null. */
  speakingId: string | null;
  /** Index of the spoken chunk — each change is a clause boundary. */
  speakChunk: number | null;
  /** A microphone is open. */
  listening: boolean;
  /** A tool or web search is running; the worm's glasses flash for it. */
  working: boolean;
}

export interface BookWormWiring {
  mood: Mood;
  ref: React.RefObject<BookWormHandle>;
  voiceSource: () => { level: number; wide: number } | null;
  /** Passed to the component so a tap resets the idle clock. The reaction
   *  itself lives in the animator; this is only about waking up. */
  onPet: () => void;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    // Private mode, or storage disabled. The worm shows; the preference just
    // will not be remembered.
    return true;
  }
}

export function useBookWorm(sig: BookWormSignals): BookWormWiring {
  const ref = useRef<BookWormHandle>(null);
  const [enabled, setEnabledState] = useState(readEnabled);
  const [mood, setMood] = useState<Mood>("idle");
  /** Bumped on a pet purely to re-run the mood ladder — a worm that has just
   *  been prodded should not stay asleep until the next message. */
  const [petNonce, setPetNonce] = useState(0);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* not remembered; still works for this session */
    }
  }, []);

  // --- clocks, as refs: none of these should cause a render on their own ---
  const typedAt = useRef(0);
  const doneAt = useRef(-Infinity);
  const eventAt = useRef(Date.now());
  const failed = useRef(false);

  // --- edge detection ------------------------------------------------------
  const prevId = useRef<string | undefined>(undefined);
  const prevLoading = useRef(false);
  const prevChunk = useRef<number | null>(null);
  const prevSentences = useRef(0);
  const scannedTo = useRef(0);
  const prevWorking = useRef(false);

  const bump = () => {
    eventAt.current = Date.now();
  };

  // A new message in the transcript is a topic boundary: Nakano et al. put the
  // first blink after one at a peak latency of 400-600ms, which is what
  // `topicChange` schedules.
  useEffect(() => {
    if (sig.lastId && sig.lastId !== prevId.current) {
      prevId.current = sig.lastId;
      prevSentences.current = 0;
      scannedTo.current = 0;
      bump();
      ref.current?.topicChange();
    }
  }, [sig.lastId]);

  // Sentences completing inside a streaming reply are clause boundaries. This
  // is what makes the worm appear to be following along with the answer rather
  // than waiting for it.
  //
  // Scanned INCREMENTALLY, which matters more than it looks. This effect runs
  // on every streamed delta — tens of times a second — and re-matching the
  // whole accumulated message each time is O(n^2) over the length of the reply,
  // on the main thread, during the one part of the turn that is already
  // fighting for frames. `scannedTo` only ever advances to the end of the last
  // COMPLETED match, so the at-most-one-sentence tail is rescanned (catching a
  // terminator whose trailing space has not arrived yet) and everything before
  // it never is.
  useEffect(() => {
    if (!sig.isLoading || sig.lastRole !== "assistant") return;
    const re = new RegExp(SENTENCE_END.source, "g");
    const tail = sig.lastText.slice(scannedTo.current);
    let m: RegExpExecArray | null;
    let end = -1;
    while ((m = re.exec(tail)) !== null) end = m.index + m[0].length;
    if (end < 0) return;
    scannedTo.current += end;
    prevSentences.current++;
    bump();
    ref.current?.clause();
  }, [sig.lastText, sig.isLoading, sig.lastRole]);

  // Each spoken chunk boundary is a clause boundary too — the same signal the
  // TTS mini-player uses for its progress readout.
  useEffect(() => {
    if (sig.speakChunk != null && sig.speakChunk !== prevChunk.current) {
      prevChunk.current = sig.speakChunk;
      bump();
      ref.current?.clause();
    }
    if (sig.speakChunk == null) prevChunk.current = null;
  }, [sig.speakChunk]);

  // The turn ending: celebrate, or not. `❌` is how ChatContext marks a failed
  // turn in the assistant bubble — there is no error state to read.
  useEffect(() => {
    const was = prevLoading.current;
    prevLoading.current = sig.isLoading;
    if (!was || sig.isLoading) return;
    failed.current = sig.lastRole === "assistant" && sig.lastText.startsWith("❌");
    doneAt.current = Date.now();
    bump();
    if (!failed.current) ref.current?.pop(1);
  }, [sig.isLoading, sig.lastRole, sig.lastText]);

  // A tool starting is the worm having an idea.
  useEffect(() => {
    if (sig.working && !prevWorking.current) {
      bump();
      ref.current?.glint();
    }
    prevWorking.current = sig.working;
  }, [sig.working]);

  useEffect(() => {
    if (!sig.input) return;
    typedAt.current = Date.now();
    bump();
  }, [sig.input]);

  useEffect(() => {
    bump();
  }, [sig.listening, sig.speakingId]);

  const onPet = useCallback(() => {
    eventAt.current = Date.now();
    setPetNonce((n) => n + 1);
  }, []);

  // --- the ladder, re-run only when it could actually change ---------------
  const streamingText = sig.isLoading && sig.lastRole === "assistant" && sig.lastText.trim().length > 0;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      const now = Date.now();
      const d = resolveWormMood({
        speaking: sig.speakingId != null,
        listening: sig.listening,
        thinking: sig.isLoading,
        streamingText,
        failed: failed.current,
        typing: sig.input.trim().length > 0,
        sinceTypedMs: now - typedAt.current,
        sinceDoneMs: now - doneAt.current,
        idleMs: now - eventAt.current,
      });
      setMood(d.mood);
      if (Number.isFinite(d.recheckInMs)) {
        // One timeout at the next moment the answer could differ. No interval.
        timer = setTimeout(evaluate, Math.max(80, d.recheckInMs));
      }
    };
    evaluate();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [sig.speakingId, sig.listening, sig.isLoading, streamingText, sig.input, sig.lastId, petNonce]);

  /**
   * Read the live voice, or fall back.
   *
   * `readVoice` returns null on the browser speechSynthesis path, whose audio
   * never enters the page's audio graph and cannot be analysed by anyone. The
   * synthetic envelope is not a guess at the words — it cannot be — it is a
   * plausible syllable rhythm. At 64px, driving a 20px mouth, the difference is
   * invisible; a motionless mouth over playing audio is not.
   */
  const voiceSource = useMemo(
    () => () => readVoice() ?? syntheticVoice(performance.now() / 1000),
    [],
  );

  return { mood, ref, voiceSource, onPet, enabled, setEnabled };
}
