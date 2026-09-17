/**
 * Read-along playback engine: speaks a word list chunk by chunk and reports
 * the word being spoken, for the Read tab's highlight.
 *
 * Two engines, same voice settings Counsel uses:
 *  - "inworld": audio per chunk from the inworld-tts edge function with WORD
 *    timestamps, played on one <audio>; a rAF loop maps `currentTime` to a
 *    word. Without timestamps (older edge function) words are estimated over
 *    the chunk's real duration. playbackRate keeps sync for free (media time).
 *    Chunks are always cut from the start of the page, never from where
 *    playback starts, so the same page always asks for the same clips: the
 *    server serves repeats from the book's saved audio on the VPS, and a start
 *    mid-chunk just seeks into that clip. Recent clips also stay in memory, so
 *    jumping back a sentence or tapping a word re-uses audio already fetched.
 *  - "browser": speechSynthesis. Word `boundary` events when the voice emits
 *    them; otherwise (Android Chrome's network voices send none) an estimated
 *    clock from the utterance's start. Pause is cancel + restart at the
 *    current word, because speechSynthesis.pause() is broken on Android.
 *
 * Word callbacks are imperative (no React state per word); the UI subscribes
 * to coarse `status` changes only.
 */
import {
  alignTimings,
  buildReadChunks,
  chunkIndexForWord,
  estimateDuration,
  estimateTimings,
  wordAtOffset,
  wordAtTime,
  type ReadChunk,
  type SourceWord,
  type WordTimes,
} from "@/lib/readAlong";
import { synthesizeSpeechWithTimestamps } from "@/lib/inworldTts";

export type ReadAlongEngine = "inworld" | "browser";
export type ReadAlongStatus = "idle" | "loading" | "playing" | "paused";
export type ReadAlongEnd = "ended" | "stopped" | "error";

export interface ReadAlongHandlers {
  onWord: (index: number) => void;
  onStatus: (status: ReadAlongStatus) => void;
  /** Playback reached the end of the words (or was stopped / failed). */
  onEnd: (reason: ReadAlongEnd) => void;
  /** Something the user should know (engine fallback, missing voice). */
  onNotice?: (message: string) => void;
}

export interface ReadAlongVoice {
  engine: ReadAlongEngine;
  inworldVoiceId?: string;
}

interface PreparedChunk {
  url: string;
  tokens: Array<{ text: string; start: number; end: number }> | null;
}

/** Audio feels late without a small lead: output latency + perception. */
const LEAD_SECONDS = 0.04;
/** Browser chunks stay short: Chrome desktop cuts utterances off after ~15s. */
const BROWSER_MAX_CHUNK = 180;
/** Inworld chunk sizes. Changing these changes every clip's text, orphaning saved audio. */
const INWORLD_MAX_CHUNK = 240;
const INWORLD_FIRST_CHUNK = 120;
/** Decoded clips kept in memory for instant replays. */
const CLIP_MEMORY = 24;

export class ReadAlongPlayer {
  private handlers: ReadAlongHandlers;
  private text = "";
  private words: SourceWord[] = [];
  private voice: ReadAlongVoice = { engine: "browser" };
  private rate = 1;
  private status: ReadAlongStatus = "idle";
  /** Bumped on every start/stop so stale async work and events bail out. */
  private generation = 0;
  private currentWord = -1;
  private chunks: ReadChunk[] = [];
  private chunkIndex = 0;
  private raf = 0;
  // inworld
  private audio: HTMLAudioElement | null = null;
  private bookId: string | null = null;
  /** Page-anchored chunks for the current text (stable across seeks). */
  private pageChunks: ReadChunk[] | null = null;
  /** Word to seek to inside the first clip played after a mid-chunk start. */
  private seekWord = -1;
  /** voice + chunk text → clip; insertion order is recency (LRU). */
  private clips = new Map<string, Promise<PreparedChunk>>();
  private playingClip: string | null = null;
  private abort: AbortController | null = null;
  private times: WordTimes | null = null;
  private audioPaused = false;
  // browser
  private boundarySeen = false;
  private utteranceStartedAt = 0;

  constructor(handlers: ReadAlongHandlers) {
    this.handlers = handlers;
  }

  get state() {
    return { status: this.status, engine: this.voice.engine, word: this.currentWord };
  }

  setRate(rate: number) {
    this.rate = rate;
    if (this.audio) this.audio.playbackRate = rate;
    // Browser voices take rate per utterance: restart at the current word.
    if (this.voice.engine === "browser" && this.status === "playing" && this.currentWord >= 0) {
      this.playFrom(this.currentWord);
    }
  }

  /**
   * Speak `words` (offsets into `text`) starting at word `from`. `bookId` lets
   * the server save and re-use this book's Inworld audio.
   */
  start(text: string, words: SourceWord[], from: number, voice: ReadAlongVoice, rate: number, bookId?: string | null) {
    if (text !== this.text || words !== this.words) this.pageChunks = null;
    this.text = text;
    this.words = words;
    this.bookId = bookId ?? null;
    this.voice = voice.engine === "browser" || voice.inworldVoiceId ? voice : { engine: "browser" };
    this.rate = rate;
    if (this.voice.engine === "browser" && typeof window !== "undefined" && !("speechSynthesis" in window)) {
      this.handlers.onNotice?.("This device has no built-in voice. Turn on an Inworld voice in Settings.");
      this.handlers.onEnd("error");
      return;
    }
    this.playFrom(Math.max(0, Math.min(from, words.length - 1)));
  }

  /** Jump to a word (tap-to-read). Keeps the current engine and rate. */
  seek(wordIndex: number) {
    if (!this.words.length) return;
    this.playFrom(Math.max(0, Math.min(wordIndex, this.words.length - 1)));
  }

  pause() {
    if (this.status !== "playing" && this.status !== "loading") return;
    if (this.voice.engine === "inworld" && this.status === "playing" && this.audio) {
      // Mid-audio: a real pause, resumed in place.
      this.audio.pause();
      this.audioPaused = true;
    } else {
      // Still fetching, or a browser voice: drop the work, restart at the word.
      this.teardown();
      this.audioPaused = false;
    }
    cancelAnimationFrame(this.raf);
    this.setStatus("paused");
  }

  resume() {
    if (this.status !== "paused") return;
    if (this.voice.engine === "inworld" && this.audioPaused && this.audio) {
      this.audioPaused = false;
      this.setStatus("playing");
      this.audio.play().catch(() => this.playFrom(Math.max(0, this.currentWord)));
      this.loop();
    } else {
      this.playFrom(Math.max(0, this.currentWord));
    }
  }

  stop(reason: ReadAlongEnd = "stopped") {
    const wasActive = this.status !== "idle";
    this.teardown();
    this.setStatus("idle");
    if (wasActive) this.handlers.onEnd(reason);
  }

  destroy() {
    this.teardown();
    this.abort?.abort();
    this.abort = null;
    for (const p of this.clips.values()) p.then((c) => URL.revokeObjectURL(c.url)).catch(() => {});
    this.clips.clear();
    this.status = "idle";
    if (this.audio) {
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private setStatus(s: ReadAlongStatus) {
    if (this.status === s) return;
    this.status = s;
    this.handlers.onStatus(s);
  }

  private emitWord(i: number) {
    if (i === this.currentWord || i < 0) return;
    this.currentWord = i;
    this.handlers.onWord(i);
  }

  private teardown() {
    this.generation++;
    cancelAnimationFrame(this.raf);
    // In-flight clip requests are NOT aborted: Inworld is already billing
    // them, and letting them finish means they get saved and re-used.
    this.seekWord = -1;
    if (this.audio) {
      this.audio.pause();
      this.audio.onended = null;
      this.audio.onerror = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window && this.voice.engine === "browser") {
      window.speechSynthesis.cancel();
    }
    this.times = null;
  }

  private playFrom(wordIndex: number) {
    this.teardown();
    this.audioPaused = false;
    const gen = this.generation;
    if (this.voice.engine === "browser") {
      this.chunks = buildReadChunks(this.text, this.words, wordIndex, BROWSER_MAX_CHUNK, 120);
      this.chunkIndex = 0;
    } else {
      this.pageChunks ??= buildReadChunks(this.text, this.words, 0, INWORLD_MAX_CHUNK, INWORLD_FIRST_CHUNK);
      this.chunks = this.pageChunks;
      this.chunkIndex = chunkIndexForWord(this.chunks, wordIndex);
      this.seekWord = this.chunks.length && wordIndex > this.chunks[this.chunkIndex].first ? wordIndex : -1;
    }
    this.currentWord = -1;
    this.emitWord(wordIndex);
    if (!this.chunks.length) {
      this.stop("ended");
      return;
    }
    if (this.voice.engine === "inworld") {
      this.setStatus("loading");
      void this.playInworldChunk(gen);
    } else {
      this.playBrowserChunk(gen);
    }
  }

  // ── inworld ────────────────────────────────────────────────────────────

  private clipKey(chunk: ReadChunk) {
    return `${this.voice.inworldVoiceId || ""}\u0000${chunk.text}`;
  }

  private prepare(i: number): Promise<PreparedChunk> | undefined {
    const chunk = this.chunks[i];
    if (!chunk) return undefined;
    const key = this.clipKey(chunk);
    let p = this.clips.get(key);
    if (p) {
      // Refresh recency.
      this.clips.delete(key);
      this.clips.set(key, p);
      return p;
    }
    this.abort ??= new AbortController();
    p = synthesizeSpeechWithTimestamps(chunk.text, this.voice.inworldVoiceId || "", undefined, {
      signal: this.abort.signal,
      bookId: this.bookId ?? undefined,
    }).then(({ audio, words }) => ({ url: URL.createObjectURL(new Blob([audio], { type: "audio/mpeg" })), tokens: words }));
    const entry = p;
    // A failed fetch must not stick; also the unhandled-rejection guard for prefetches.
    entry.catch(() => { if (this.clips.get(key) === entry) this.clips.delete(key); });
    this.clips.set(key, entry);
    this.evictClips();
    return entry;
  }

  private evictClips() {
    for (const [key, p] of this.clips) {
      if (this.clips.size <= CLIP_MEMORY) break;
      if (key === this.playingClip) continue;
      this.clips.delete(key);
      p.then((c) => URL.revokeObjectURL(c.url)).catch(() => {});
    }
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      const a = new Audio();
      a.preload = "auto";
      (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
      this.audio = a;
    }
    return this.audio;
  }

  private async playInworldChunk(gen: number) {
    const i = this.chunkIndex;
    const chunk = this.chunks[i];
    if (!chunk) {
      this.stop("ended");
      return;
    }
    let prepared: PreparedChunk;
    try {
      prepared = await this.prepare(i)!;
    } catch (err) {
      if (gen !== this.generation) return;
      console.warn("read-along: inworld chunk failed, falling back to device voice", err);
      this.handlers.onNotice?.("Inworld voice unavailable — continuing with the device voice.");
      this.voice = { engine: "browser" };
      this.playFrom(chunk.first);
      return;
    }
    if (gen !== this.generation) return;
    // Prefetch the next two so chunk joins don't stall.
    this.prepare(i + 1);
    this.prepare(i + 2);
    this.playingClip = this.clipKey(chunk);

    const audio = this.ensureAudio();
    const chunkWords = this.words.slice(chunk.first, chunk.last);
    const aligned = prepared.tokens ? alignTimings(chunkWords, prepared.tokens) : null;
    this.times = aligned;
    audio.onloadedmetadata = () => {
      if (gen !== this.generation) return;
      if (!this.times && Number.isFinite(audio.duration)) this.times = estimateTimings(chunkWords, audio.duration);
    };
    audio.onended = () => {
      if (gen !== this.generation) return;
      this.chunkIndex++;
      if (this.chunkIndex >= this.chunks.length) {
        cancelAnimationFrame(this.raf);
        this.stop("ended");
        return;
      }
      void this.playInworldChunk(gen);
    };
    audio.onerror = () => {
      if (gen !== this.generation) return;
      this.handlers.onNotice?.("Couldn't play that audio — continuing with the device voice.");
      this.voice = { engine: "browser" };
      this.playFrom(Math.max(chunk.first, this.currentWord));
    };
    if (audio.src !== prepared.url) {
      audio.src = prepared.url;
    } else {
      // Replaying the loaded clip (a seek within it): metadata won't fire again.
      audio.currentTime = 0;
      if (!this.times && Number.isFinite(audio.duration)) this.times = estimateTimings(chunkWords, audio.duration);
    }
    audio.playbackRate = this.rate;
    const seekWord = this.seekWord;
    this.seekWord = -1;
    if (seekWord > chunk.first) {
      // Started mid-chunk: jump into the clip at that word.
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve) => {
          audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
          audio.addEventListener("error", () => resolve(), { once: true });
        });
        if (gen !== this.generation) return;
      }
      const t = this.times?.[seekWord - chunk.first]?.[0];
      if (t !== undefined && Number.isFinite(t)) audio.currentTime = Math.max(0, t - LEAD_SECONDS);
    }
    audio.playbackRate = this.rate;
    try {
      await audio.play();
    } catch (err) {
      if (gen !== this.generation) return;
      // Autoplay refusal: surface as paused so the next tap resumes in-gesture.
      console.warn("read-along: play() refused", err);
      this.setStatus("paused");
      return;
    }
    if (gen !== this.generation) return;
    this.setStatus("playing");
    this.loop();
  }

  private loop() {
    cancelAnimationFrame(this.raf);
    const gen = this.generation;
    let hint = -1;
    const tick = () => {
      if (gen !== this.generation || this.status !== "playing") return;
      const chunk = this.chunks[this.chunkIndex];
      if (chunk) {
        if (this.voice.engine === "inworld" && this.audio && this.times) {
          hint = wordAtTime(this.times, this.audio.currentTime + LEAD_SECONDS, hint);
          if (hint >= 0) this.emitWord(chunk.first + hint);
        } else if (this.voice.engine === "browser" && !this.boundarySeen && this.times && this.utteranceStartedAt) {
          const t = (performance.now() - this.utteranceStartedAt) / 1000;
          hint = wordAtTime(this.times, t, hint);
          if (hint >= 0) this.emitWord(chunk.first + hint);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // ── browser ────────────────────────────────────────────────────────────

  private playBrowserChunk(gen: number) {
    const chunk = this.chunks[this.chunkIndex];
    if (!chunk) {
      this.stop("ended");
      return;
    }
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(chunk.text);
    u.rate = this.rate;
    const chunkWords = this.words.slice(chunk.first, chunk.last);
    this.boundarySeen = false;
    this.utteranceStartedAt = 0;
    this.times = estimateTimings(chunkWords, estimateDuration(chunk.text, this.rate));
    u.onstart = () => {
      if (gen !== this.generation) return;
      this.utteranceStartedAt = performance.now();
      this.setStatus("playing");
      this.loop();
    };
    u.onboundary = (e) => {
      if (gen !== this.generation || (e.name && e.name !== "word")) return;
      this.boundarySeen = true;
      this.emitWord(wordAtOffset(this.words, chunk.offset + e.charIndex, chunk.first, chunk.last));
    };
    u.onend = () => {
      if (gen !== this.generation) return;
      this.chunkIndex++;
      if (this.chunkIndex >= this.chunks.length) {
        cancelAnimationFrame(this.raf);
        this.stop("ended");
        return;
      }
      this.playBrowserChunk(gen);
    };
    u.onerror = (e) => {
      if (gen !== this.generation) return;
      // "interrupted"/"canceled" are our own cancel() calls.
      if (e.error === "interrupted" || e.error === "canceled") return;
      console.warn("read-along: speech error", e.error);
      this.handlers.onNotice?.("The device voice stopped unexpectedly.");
      this.stop("error");
    };
    if (this.status !== "playing") this.setStatus("loading");
    synth.speak(u);
    // Some Android voices never fire onstart: assume speech began shortly.
    window.setTimeout(() => {
      if (gen !== this.generation || this.utteranceStartedAt || !synth.speaking) return;
      this.utteranceStartedAt = performance.now();
      this.setStatus("playing");
      this.loop();
    }, 1200);
  }
}
