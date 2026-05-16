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
}

export async function buildChatSystemPrompt({
  books, selectedBook, deepResearch, voiceMode, latestUserQuery, customSystemPrompt,
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
    "You have these tools: list_books, get_book, get_chapter_text, set_active_book, isolate_chapter, rename_chapter, delete_chapter, and TWO search tools:",
    "- `search_wiki` → search ONLY the user's locally saved knowledge wiki. Use it for things they've already studied/ingested.",
    "- `web_search` → LIVE INTERNET search via the user's Burplexity instance. Use this WHENEVER the user asks to 'search', 'look up', 'google', 'check online', 'what's the latest', or anything time-sensitive or not in the wiki. You may call both `search_wiki` and `web_search` in the same turn when useful. Don't refuse online searches — call `web_search`.",
    "When the 'Retrieved Knowledge' section below contains 'contradicts' or 'refutes' edges, surface those conflicts to the user — never silently pick a side."
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
      const retrieval = await retrieveKnowledge(latestUserQuery, { deep: deepResearch });
      if (retrieval && retrieval.nodes.length > 0) {
        parts.push("", `## Retrieved Knowledge (${retrieval.nodes.length} nodes, ${retrieval.edges.length} edges)`);
        const idToTitle = new Map(retrieval.nodes.map((n: any) => [n.id, n.title]));
        for (const node of retrieval.nodes) {
          parts.push("", `### ${node.title}${node.hop > 0 ? ` _(via ${node.via}, hop ${node.hop})_` : ""}`);
          const text = (node.content || "").length > 4000
            ? (node.content || "").slice(0, 4000) + "\n[...truncated]"
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
      const knowledgeEntries = await fetchKnowledgeEntries().catch(() => []);
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
          const text = ch.textContent.length > 12000 ? ch.textContent.slice(0, 12000) + "\n\n[...truncated]" : ch.textContent;
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
