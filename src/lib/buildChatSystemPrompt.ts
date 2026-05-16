import { BookDocument } from "@/types/library";
import { fetchKnowledgeEntries, fetchConversationMemory } from "@/lib/knowledgeApi";
import { DEEP_RESEARCH_SYSTEM_PROMPT, DEEP_RESEARCH_ADVANCED_PROMPT } from "@/lib/deepResearchPrompt";

interface BuildOpts {
  books: BookDocument[];
  selectedBook: BookDocument | undefined;
  deepResearch: boolean;
  /** When true, prepends a brief instruction asking for spoken-friendly replies. */
  voiceMode?: boolean;
}

export async function buildChatSystemPrompt({ books, selectedBook, deepResearch, voiceMode }: BuildOpts): Promise<string> {
  const parts: string[] = [];

  if (voiceMode) {
    parts.push(
      "You are speaking through a voice interface. Keep replies conversational and concise (usually 1–3 sentences) unless the user explicitly asks for depth. Avoid heavy markdown/lists when the answer will be read aloud."
    );
  }
  parts.push(
    "You are an intelligent reading assistant for the Chapter Craft app with long-term memory. You help users understand, analyze, and discuss their books and chapters.",
    "You have access to tools that can list books, read chapter text, search the user's knowledge wiki, switch the active book, and isolate/rename/delete chapters. Call them whenever you need fresh facts or the user asks you to take an action on their library."
  );

  try {
    const [knowledgeEntries, conversationMemory] = await Promise.all([
      fetchKnowledgeEntries().catch(() => []),
      fetchConversationMemory().catch(() => null),
    ]);

    if (conversationMemory?.summary) {
      parts.push("", "## Your Memory (from past conversations)", conversationMemory.summary);
      if (conversationMemory.key_facts && conversationMemory.key_facts.length > 0) {
        parts.push("", "### Key Facts You've Learned");
        (conversationMemory.key_facts as string[]).slice(-20).forEach((f) => parts.push(`- ${f}`));
      }
    }

    if (knowledgeEntries.length > 0) {
      parts.push("", "## Your Knowledge Wiki");
      const relevant = selectedBook
        ? knowledgeEntries.filter((e) => e.source_book_id === selectedBook.id || !e.source_book_id).slice(0, 30)
        : knowledgeEntries.slice(0, 30);
      relevant.forEach((e) => {
        parts.push(`- **${e.title}** (${e.entry_type}, ${Math.round(e.confidence * 100)}%): ${e.content.slice(0, 200)}`);
      });
    }
  } catch {
    /* proceed without memory */
  }

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

  parts.push("", "Be concise but thorough. Reference specific chapter names and page numbers when relevant.");
  return parts.join("\n");
}
