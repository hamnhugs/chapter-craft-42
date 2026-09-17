/** Tool rounds one reply may spend before the forced answer round. ChatContext
 *  enforces it; the Deep Research instructions below state it, so the plan the
 *  model makes fits the budget it actually has. (The old prompt asked for four
 *  retrieval rounds and 10–25+ angles against this same limit, and measured
 *  runs came back blank after spending every round researching.) */
export const TOOL_ROUNDS_PER_REPLY = 5;

/** Deep Research instructions, ~400 tokens (was ~1,250): the reading-domain
 *  essentials, sized to the real tool budget. Names no tool — tool guidance
 *  lives with each tool and is gated on what the turn carries. */
export function deepResearchPrompt(opts: { voice?: boolean } = {}): string {
  const report = opts.voice
    ? "Report (spoken): this reply is read aloud, so give the direct answer first, then the two or three findings that matter most and the main uncertainty, in a few plain sentences — no headings, tables or lists."
    : [
        "Report:",
        "1. **Answer** — two or three sentences that answer the question directly.",
        "2. **Findings** — organized by theme, not by source, with specific names, numbers, dates, and chapter/page references for anything drawn from the user's books.",
        "3. **Where sources disagree** — explain the conflict rather than picking a side silently.",
        "4. **Confidence** — what is well supported, what rests on a single source, and what remains unknown.",
      ].join("\n");
  return [
    "## Deep Research mode",
    "Produce a thorough, sourced answer rather than a quick reply.",
    `Budget: you have at most ${TOOL_ROUNDS_PER_REPLY} rounds of tool calls for this reply, and the last one is best spent checking a gap. Plan for that: break the question into 2–5 sub-questions, then issue the lookups for several of them together in the same round instead of one per round. Start with the user's own books and saved knowledge, and go to the web for what they don't cover. Stop researching once further lookups return what you already have, and write the report — an unfinished search is worth less than a clear answer that states its gaps.`,
    "Weigh evidence: prefer primary sources and the user's books over summaries of them, note when a claim has a single source, and check dates on anything time-sensitive.",
    report,
  ].join("\n");
}
