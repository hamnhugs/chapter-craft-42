import { BookDocument } from "@/types/library";
import { fetchKnowledgeEntries, fetchConversationMemory, retrieveKnowledge } from "@/lib/knowledgeApi";
import { DEEP_RESEARCH_SYSTEM_PROMPT, DEEP_RESEARCH_ADVANCED_PROMPT } from "@/lib/deepResearchPrompt";

interface BuildOpts {
  books: BookDocument[];
  selectedBook: BookDocument | undefined;
  deepResearch: boolean;
  /** When true, prepends a brief instruction asking for spoken-friendly replies. */
  voiceMode?: boolean;
  /** Latest user message — used to retrieve graph-aware context. */
  latestUserQuery?: string;
  /** Free-form user-supplied instructions prepended at the very top. */
  customSystemPrompt?: string;
  /** Active wiki name — surfaced to the model so it knows which wiki is in focus. */
  activeWikiName?: string | null;
  /** Active wiki id — scopes retrieval to that wiki (+ bridged entries). */
  activeWikiId?: string | null;
}

export async function buildChatSystemPrompt({
  books, selectedBook, deepResearch, voiceMode, latestUserQuery, customSystemPrompt, activeWikiName, activeWikiId,
}: BuildOpts): Promise<string> {
  const parts: string[] = [];

  if (customSystemPrompt && customSystemPrompt.trim()) {
    parts.push("## User Custom Instructions", customSystemPrompt.trim(), "");
  }

  if (voiceMode) {
    parts.push(
      "You are speaking through a voice interface. Keep replies conversational and concise (usually 1–3 sentences) unless the user explicitly asks for depth. Avoid heavy markdown/lists when the answer will be read aloud."
    );
  }
  parts.push(
    "You are an intelligent reading assistant for the Chapter Craft app with long-term memory and a knowledge graph. You help users understand, analyze, and discuss their books and chapters.",
  );
  if (activeWikiName) {
    parts.push(`The user's active knowledge wiki is "${activeWikiName}". New knowledge captured this session is scoped to that wiki, and \`search_wiki\` results are biased toward it.`);
  }
  parts.push(
    "You have these tools: list_books, get_book, get_chapter_text, set_active_book, isolate_chapter, rename_chapter, delete_chapter, list_conflicts, get_conflict, resolve_conflict, update_conflict_status, list_wikis, get_active_wiki, switch_wiki, create_wiki, and TWO search tools:",
    "- `search_wiki` → search ONLY the user's locally saved knowledge wiki. Use it for things they've already studied/ingested.",
    "- `web_search` → LIVE INTERNET search via the user's Burplexity instance. Use this WHENEVER the user asks to 'search', 'look up', 'google', 'check online', 'what's the latest', or anything time-sensitive or not in the wiki. You may call both `search_wiki` and `web_search` in the same turn when useful. Don't refuse online searches — call `web_search`.",
    "When the user asks about which wiki is active, to list wikis, switch to another wiki, or create a new one, USE the wiki tools (`list_wikis`, `get_active_wiki`, `switch_wiki`, `create_wiki`) — never claim a switch happened without calling `switch_wiki`.",
    "When the 'Retrieved Knowledge' section below contains 'contradicts' or 'refutes' edges, surface those conflicts to the user — never silently pick a side.",
    "## Wiki Conflict Resolution",
    "If the user asks to review, go over, fix, or resolve contradictions/conflicts in their wiki, call `list_conflicts` first (default status='open'). Present them ONE AT A TIME in plain language: summarise both entries (A and B), the AI's rationale, and offer clear options — keep A, keep B, merge into one, edit one to fix it, acknowledge (keep both), or dismiss (false positive). Use `get_conflict` if you need full text. NEVER call `resolve_conflict` with a destructive action (keep_a_delete_b, keep_b_delete_a, merge, edit_a, edit_b) until the user has explicitly approved that exact action for that exact conflict in the current turn — paraphrasing back and getting a 'yes' is fine; assuming is not. After each resolution, briefly confirm what changed and ask whether to move to the next.",
    ...(voiceMode ? [
      "## Voice-mode conflict + wiki rules (CRITICAL)",
      "You are talking out loud, so the user's spoken reply IS their approval. When the user says 'yes', 'do it', 'keep A', 'keep B', 'merge', 'dismiss', 'acknowledge', or names the action you just offered, IMMEDIATELY call `resolve_conflict` (or `update_conflict_status`) — do not ask again, do not narrate that you did it without calling the tool.",
      "NEVER say 'done', 'resolved', 'deleted', 'merged', 'switched', or 'created' unless the previous step in this turn was a successful tool call returning ok. If you didn't call the tool, you didn't do it — call the tool now, then speak the confirmation only after it succeeds.",
      "Same rule for wikis: any 'switch to X', 'open my Y wiki', 'make a new wiki for Z' must trigger `switch_wiki` or `create_wiki`. Never claim a switch happened from narration alone.",
    ] : [])
  );

  // Conversation memory
  try {
    const conversationMemory = await fetchConversationMemory().catch(() => null);
    if (conversationMemory?.summary) {
      parts.push("", "## Your Memory (from past conversations)", conversationMemory.summary);
      if (conversationMemory.key_facts && conversationMemory.key_facts.length > 0) {
        parts.push("", "### Key Facts You've Learned");
        (conversationMemory.key_facts as string[]).slice(-20).forEach((f) => parts.push(`- ${f}`));
      }
    }
  } catch { /* proceed without memory */ }

  // GRAPH-AWARE RETRIEVAL — replaces the old "dump 30 entries" approach
  if (latestUserQuery && latestUserQuery.trim().length > 0) {
    try {
      const retrieval = await retrieveKnowledge(latestUserQuery, { deep: deepResearch, wiki_id: activeWikiId ?? null });
      if (retrieval && retrieval.nodes.length > 0) {
        parts.push("", `## Retrieved Knowledge (${retrieval.nodes.length} nodes, ${retrieval.edges.length} edges)`);
        const idToTitle = new Map(retrieval.nodes.map((n: any) => [n.id, n.title]));
        for (const node of retrieval.nodes) {
          parts.push("", `### ${node.title}${node.hop > 0 ? ` _(via ${node.via}, hop ${node.hop})_` : ""}`);
          const maxLen = voiceMode ? 1200 : 4000;
          const text = (node.content || "").length > maxLen
            ? (node.content || "").slice(0, maxLen) + "\n[...truncated]"
            : node.content || "";
          parts.push(text);
          const outgoing = retrieval.edges.filter((e: any) => e.source_entry_id === node.id);
          if (outgoing.length > 0) {
            const labels = outgoing
              .map((e: any) => `${e.relationship} → "${idToTitle.get(e.target_entry_id) || e.target_entry_id.slice(0, 8)}"`)
              .join("; ");
            parts.push(`**Edges:** ${labels}`);
          }
        }
      }
    } catch (err) {
      console.warn("retrieveKnowledge failed, falling back to legacy dump:", err);
      // Fallback: small legacy dump so chat still works if retrieval errors
      const knowledgeEntries = await fetchKnowledgeEntries(activeWikiId ?? null).catch(() => []);
      if (knowledgeEntries.length > 0) {
        parts.push("", "## Your Knowledge Wiki (fallback)");
        const relevant = selectedBook
          ? knowledgeEntries.filter((e) => e.source_book_id === selectedBook.id || !e.source_book_id).slice(0, 15)
          : knowledgeEntries.slice(0, 15);
        relevant.forEach((e) => {
          parts.push(`- **${e.title}** (${e.entry_type}): ${e.content.slice(0, 200)}`);
        });
      }
    }
  }

  // Library catalog (always)
  parts.push("", "## Available Library", `The user has ${books.length} book(s) in their library:`);
  books.forEach((book) => {
    parts.push(`- **${book.title}** (id: ${book.id}, ${book.pageCount} pages, ${book.chapters.length} chapter(s))`);
    book.chapters.forEach((ch) => {
      parts.push(`  - Chapter: "${ch.name}" (id: ${ch.id}, pages ${ch.startPage}–${ch.endPage})`);
    });
  });

  if (selectedBook) {
    parts.push("", `## Currently Active Book: "${selectedBook.title}" (id: ${selectedBook.id})`);
    parts.push(`File: ${selectedBook.fileName} | Pages: ${selectedBook.pageCount}`);
    if (selectedBook.chapters.length > 0) {
      parts.push("", "### Chapter Contents");
      selectedBook.chapters.forEach((ch) => {
        parts.push(`#### ${ch.name} (pages ${ch.startPage}–${ch.endPage})`);
        if (ch.textContent) {
          const chapterCap = voiceMode ? 3000 : 12000;
          const text = ch.textContent.length > chapterCap ? ch.textContent.slice(0, chapterCap) + "\n\n[...truncated]" : ch.textContent;
          parts.push(text);
        } else {
          parts.push("(No text content extracted for this chapter)");
        }
        parts.push("");
      });
    }
  }

  if (deepResearch) {
    parts.push("", DEEP_RESEARCH_SYSTEM_PROMPT, DEEP_RESEARCH_ADVANCED_PROMPT);
  }

  parts.push("", "Be concise but thorough. Reference specific chapter names and page numbers when relevant. When contradictions are surfaced, present both sides explicitly.");
  return parts.join("\n");
}
