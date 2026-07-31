// Shared streaming machinery for the provider adapters: SSE parsing,
// finish-reason normalization, tool-call index resolution, and the
// thought-tag router for models that inline reasoning into content.

import type { FinishReason } from "./types";

/** Parse an OpenAI-style SSE body into JSON payloads. Yields each `data:`
 *  object, stops at `[DONE]`, skips comments/blank lines, tolerates CRLF and
 *  payloads split across network chunks. Cancels the reader when the
 *  consumer stops early (generator return/throw). */
export async function* sseJson(res: Response): AsyncGenerator<any, void, unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response stream");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
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
        if (jsonStr === "[DONE]") return;
        try {
          yield JSON.parse(jsonStr);
        } catch {
          // Partial/garbled line — same tolerance as the old inline parser.
        }
      }
    }
  } finally {
    try { void reader.cancel(); } catch { /* already closed */ }
  }
}

export function mapFinishReason(native: unknown): FinishReason {
  switch (native) {
    case "stop": return "stop";
    case "length": return "length";
    case "tool_calls": return "tool_calls";
    case "content_filter": return "content_filter";
    case "error": return "error";
    default: return "other";
  }
}

/** Resolves a stable accumulation index for streamed tool calls.
 *
 *  OpenAI-style providers send `index` with incremental argument fragments.
 *  NVIDIA NIM backends are known to send COMPLETE tool calls in one chunk,
 *  possibly without `index` — naive `index ?? 0` accumulation collapses
 *  parallel calls into one slot. Rules:
 *    - explicit numeric index wins;
 *    - otherwise a chunk carrying a NEW id (or a name with no id) starts a
 *      new slot;
 *    - otherwise (bare argument fragment) it continues the last slot. */
export class ToolCallIndexer {
  private byId = new Map<string, number>();
  private next = 0;
  private last = 0;

  resolve(tc: { index?: unknown; id?: string; function?: { name?: string } }): number {
    if (typeof tc.index === "number") {
      this.last = tc.index;
      this.next = Math.max(this.next, tc.index + 1);
      if (tc.id) this.byId.set(tc.id, tc.index);
      return tc.index;
    }
    if (tc.id) {
      const known = this.byId.get(tc.id);
      if (known !== undefined) { this.last = known; return known; }
      const idx = this.next++;
      this.byId.set(tc.id, idx);
      this.last = idx;
      return idx;
    }
    if (tc.function?.name) {
      // A named call with no id and no index opens a NEW slot — two parallel
      // whole-calls in that shape would otherwise overwrite each other's name
      // and concatenate their argument JSON into an unparseable blob.
      // (OpenAI-style streams always carry `index` on named chunks, so they
      // never reach this branch.)
      this.last = this.next;
      return this.next++;
    }
    return this.last;
  }
}

// ---------------------------------------------------------------------------
// Thought-tag router.
//
// Some NVIDIA-hosted models inline their reasoning into `content` instead of
// (or in addition to) the `reasoning_content` field:
//   - DeepSeek-style:      <think> ... </think>
//   - DiffusionGemma:      <|channel>thought\n ... <channel|>
// DiffusionGemma emits an EMPTY tag pair even with thinking off, so tags are
// stripped unconditionally. Text inside a thought block is rerouted to
// reasoning; everything else passes through as text. Tags split across
// stream chunks are handled by holding back any suffix that could still
// become a tag.
// ---------------------------------------------------------------------------

const TAG_PAIRS: Array<{ open: string; close: string }> = [
  { open: "<think>", close: "</think>" },
  { open: "<|channel>thought", close: "<channel|>" },
];

/** Longest suffix of `s` that is a proper prefix of any candidate tag. */
function holdbackLen(s: string, tags: string[]): number {
  const maxLen = Math.max(...tags.map((t) => t.length)) - 1;
  for (let len = Math.min(maxLen, s.length); len > 0; len--) {
    const tail = s.slice(s.length - len);
    if (tags.some((t) => t.startsWith(tail))) return len;
  }
  return 0;
}

export class ThoughtRouter {
  private buf = "";
  private inThought = false;
  private closeTag = "";

  /** Route a content delta; returns what should surface as visible text and
   *  what should surface as reasoning. */
  push(delta: string): { text: string; reasoning: string } {
    this.buf += delta;
    let text = "";
    let reasoning = "";
    // Loop until no full tag remains in the buffer.
    for (;;) {
      if (!this.inThought) {
        let earliest = -1;
        let pair: { open: string; close: string } | null = null;
        for (const p of TAG_PAIRS) {
          const at = this.buf.indexOf(p.open);
          if (at !== -1 && (earliest === -1 || at < earliest)) { earliest = at; pair = p; }
        }
        if (pair && earliest !== -1) {
          text += this.buf.slice(0, earliest);
          this.buf = this.buf.slice(earliest + pair.open.length);
          if (this.buf.startsWith("\n")) this.buf = this.buf.slice(1);
          this.inThought = true;
          this.closeTag = pair.close;
          continue;
        }
        const hold = holdbackLen(this.buf, TAG_PAIRS.map((p) => p.open));
        text += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      } else {
        const at = this.buf.indexOf(this.closeTag);
        if (at !== -1) {
          reasoning += this.buf.slice(0, at);
          this.buf = this.buf.slice(at + this.closeTag.length);
          if (this.buf.startsWith("\n")) this.buf = this.buf.slice(1);
          this.inThought = false;
          this.closeTag = "";
          continue;
        }
        const hold = holdbackLen(this.buf, [this.closeTag]);
        reasoning += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
    }
    return { text, reasoning };
  }

  /** Drain whatever is held back at end of stream. An unclosed thought block
   *  stays reasoning; held-back partial tags in text mode are just text. */
  flush(): { text: string; reasoning: string } {
    const out = this.inThought
      ? { text: "", reasoning: this.buf }
      : { text: this.buf, reasoning: "" };
    this.buf = "";
    this.inThought = false;
    this.closeTag = "";
    return out;
  }
}
