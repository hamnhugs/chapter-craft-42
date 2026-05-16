import { supabase } from "@/integrations/supabase/client";
import { BookDocument, Chapter } from "@/types/library";

export interface ToolDeps {
  books: BookDocument[];
  activeBookId: string | null;
  setActiveBookId: (id: string) => void;
  addChapter: (bookId: string, chapter: Chapter) => Promise<void>;
  updateChapter: (bookId: string, chapterId: string, name: string) => Promise<void> | void;
  removeChapter: (bookId: string, chapterId: string) => Promise<void> | void;
  burplexityApiToken?: string;
}

export const BURPLEXITY_BOT_ASK_URL = "https://tmagmbmitnvcwubxcwoc.supabase.co/functions/v1/bot-ask";
const BURPLEXITY_QUICK_SEARCH_URL = "https://tmagmbmitnvcwubxcwoc.supabase.co/functions/v1/bot-search-quick";

export const CHAT_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_books",
      description: "List every book in the user's library with id, title, page count and chapter count.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_book",
      description: "Get a single book with all its chapters and page ranges.",
      parameters: {
        type: "object",
        properties: { book_id: { type: "string", description: "Book id." } },
        required: ["book_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_chapter_text",
      description: "Fetch the extracted text for a chapter. Use when you need to quote or analyse exact wording.",
      parameters: {
        type: "object",
        properties: {
          chapter_id: { type: "string" },
          max_chars: { type: "number", description: "Optional cap on returned characters (default 8000)." },
        },
        required: ["chapter_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_active_book",
      description: "Switch the user's active/focused book so future context includes its chapters.",
      parameters: {
        type: "object",
        properties: { book_id: { type: "string" } },
        required: ["book_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_wiki",
      description: "Keyword search the user's knowledge wiki (title + content). Returns up to `limit` entries.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Default 10." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Live web search via the user's Burplexity instance. Use this whenever the user asks to search the internet, look something up online, or wants current/time-sensitive info. Returns a synthesized answer plus citation URLs. Prefer this over search_wiki for anything not stored locally.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "isolate_chapter",
      description:
        "Create a new chapter in a book by specifying its page range. The chapter text is empty unless extracted separately.",
      parameters: {
        type: "object",
        properties: {
          book_id: { type: "string" },
          name: { type: "string" },
          start_page: { type: "number" },
          end_page: { type: "number" },
          text_content: { type: "string", description: "Optional chapter text content." },
        },
        required: ["book_id", "name", "start_page", "end_page"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_chapter",
      description: "Rename a chapter.",
      parameters: {
        type: "object",
        properties: { chapter_id: { type: "string" }, book_id: { type: "string" }, name: { type: "string" } },
        required: ["chapter_id", "book_id", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_chapter",
      description: "Delete a chapter from a book.",
      parameters: {
        type: "object",
        properties: { chapter_id: { type: "string" }, book_id: { type: "string" } },
        required: ["chapter_id", "book_id"],
      },
    },
  },
] as const;

export interface ToolEvent {
  name: string;
  summary: string;
  ok: boolean;
}

export async function executeChatTool(
  name: string,
  rawArgs: string,
  deps: ToolDeps
): Promise<{ result: unknown; event: ToolEvent }> {
  let args: any = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return {
      result: { error: "Invalid JSON arguments" },
      event: { name, summary: `${name}: invalid arguments`, ok: false },
    };
  }

  try {
    switch (name) {
      case "list_books": {
        const list = deps.books.map((b) => ({
          id: b.id,
          title: b.title,
          page_count: b.pageCount,
          chapter_count: b.chapters.length,
          is_active: b.id === deps.activeBookId,
        }));
        return { result: list, event: { name, summary: `Listed ${list.length} book(s)`, ok: true } };
      }
      case "get_book": {
        const book = deps.books.find((b) => b.id === args.book_id);
        if (!book) return { result: { error: "Book not found" }, event: { name, summary: "Book not found", ok: false } };
        return {
          result: {
            id: book.id,
            title: book.title,
            page_count: book.pageCount,
            chapters: book.chapters.map((c) => ({
              id: c.id,
              name: c.name,
              start_page: c.startPage,
              end_page: c.endPage,
              has_text: !!c.textContent,
            })),
          },
          event: { name, summary: `Opened "${book.title}"`, ok: true },
        };
      }
      case "get_chapter_text": {
        const maxChars = Math.max(500, Math.min(20000, Number(args.max_chars) || 8000));
        let chapter: Chapter | undefined;
        let bookTitle = "";
        for (const b of deps.books) {
          const c = b.chapters.find((ch) => ch.id === args.chapter_id);
          if (c) {
            chapter = c;
            bookTitle = b.title;
            break;
          }
        }
        if (!chapter) {
          return { result: { error: "Chapter not found" }, event: { name, summary: "Chapter not found", ok: false } };
        }
        const text = chapter.textContent || "";
        return {
          result: {
            id: chapter.id,
            name: chapter.name,
            start_page: chapter.startPage,
            end_page: chapter.endPage,
            text: text.slice(0, maxChars),
            truncated: text.length > maxChars,
          },
          event: { name, summary: `Read "${chapter.name}" from ${bookTitle}`, ok: true },
        };
      }
      case "set_active_book": {
        const book = deps.books.find((b) => b.id === args.book_id);
        if (!book) return { result: { error: "Book not found" }, event: { name, summary: "Book not found", ok: false } };
        deps.setActiveBookId(args.book_id);
        return { result: { ok: true }, event: { name, summary: `Focused on "${book.title}"`, ok: true } };
      }
      case "search_wiki": {
        const q = String(args.query || "").trim();
        if (!q) return { result: { error: "Empty query" }, event: { name, summary: "Empty query", ok: false } };
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const { data, error } = await supabase
          .from("knowledge_entries")
          .select("id, title, content, entry_type, confidence, source_book_id, tags")
          .or(`title.ilike.%${q}%,content.ilike.%${q}%`)
          .limit(limit);
        if (error) throw error;
        const entries = (data || []).map((e: any) => ({
          id: e.id,
          title: e.title,
          entry_type: e.entry_type,
          confidence: e.confidence,
          snippet: (e.content || "").slice(0, 400),
        }));
        return { result: entries, event: { name, summary: `Searched wiki for "${q}" — ${entries.length} hit(s)`, ok: true } };
      }
      case "web_search": {
        const q = String(args.query || "").trim();
        if (!q) return { result: { error: "Empty query" }, event: { name, summary: "Empty query", ok: false } };
        const token = (deps.burplexityApiToken || "").trim();
        if (!token) {
          return {
            result: { error: "Burplexity API token not configured. Ask the user to paste a pp_… token in Settings → Burplexity API Token." },
            event: { name, summary: "Burplexity token missing — add it in Settings", ok: false },
          };
        }
        try {
          const r = await fetch(BURPLEXITY_BOT_ASK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": token },
            body: JSON.stringify({ query: q, save_to_wiki: false }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            const msg = j?.error || `HTTP ${r.status}`;
            return {
              result: { error: `Burplexity search failed: ${msg}` },
              event: { name, summary: `Web search failed: ${msg}`, ok: false },
            };
          }
          const answer = String(j.answer || "").slice(0, 3500);
          const citations = Array.isArray(j.citations)
            ? j.citations.slice(0, 5).map((c: any) => ({ title: c.title, url: c.url, snippet: (c.snippet || "").slice(0, 240) }))
            : [];
          return {
            result: { answer, citations },
            event: { name, summary: `Searched the web for "${q}" — ${citations.length} source(s)`, ok: true },
          };
        } catch (e: any) {
          return {
            result: { error: `Web search error: ${e?.message || "network failure"}` },
            event: { name, summary: `Web search failed: ${e?.message || "network"}`, ok: false },
          };
        }
      }
      case "isolate_chapter": {
        const book = deps.books.find((b) => b.id === args.book_id);
        if (!book) return { result: { error: "Book not found" }, event: { name, summary: "Book not found", ok: false } };
        const sp = Number(args.start_page);
        const ep = Number(args.end_page);
        if (!Number.isFinite(sp) || !Number.isFinite(ep) || sp < 1 || ep < sp) {
          return {
            result: { error: "Invalid page range" },
            event: { name, summary: "Invalid page range", ok: false },
          };
        }
        const newChapter: Chapter = {
          id: crypto.randomUUID(),
          name: String(args.name || "Untitled chapter"),
          startPage: sp,
          endPage: ep,
          textContent: String(args.text_content || ""),
        };
        await deps.addChapter(book.id, newChapter);
        return {
          result: { id: newChapter.id, name: newChapter.name, start_page: sp, end_page: ep },
          event: { name, summary: `Isolated "${newChapter.name}" (p.${sp}–${ep}) in ${book.title}`, ok: true },
        };
      }
      case "rename_chapter": {
        await deps.updateChapter(String(args.book_id), String(args.chapter_id), String(args.name));
        return {
          result: { ok: true },
          event: { name, summary: `Renamed chapter to "${args.name}"`, ok: true },
        };
      }
      case "delete_chapter": {
        await deps.removeChapter(String(args.book_id), String(args.chapter_id));
        return { result: { ok: true }, event: { name, summary: `Deleted chapter`, ok: true } };
      }
      default:
        return { result: { error: `Unknown tool ${name}` }, event: { name, summary: `Unknown tool ${name}`, ok: false } };
    }
  } catch (e: any) {
    return {
      result: { error: e?.message || "Tool failed" },
      event: { name, summary: `${name} failed: ${e?.message || "error"}`, ok: false },
    };
  }
}

export async function executeQuickSearch(
  query: string,
  token: string
): Promise<{
  citations: Array<{ title: string; url: string; snippet: string }>;
  answer?: string;
  elapsed_ms?: number;
  backend?: string;
  error?: string;
}> {
  try {
    const r = await fetch(BURPLEXITY_QUICK_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": token },
      body: JSON.stringify({ query, max_results: 8, include_snippets: true }),
    });
    if (r.status === 404) {
      // Fallback to bot-ask with 15 s timeout
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 15000);
      try {
        const fb = await fetch(BURPLEXITY_BOT_ASK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": token },
          body: JSON.stringify({ query, save_to_wiki: false }),
          signal: controller.signal,
        });
        clearTimeout(tid);
        const j = await fb.json().catch(() => ({}));
        if (!fb.ok) return { citations: [], error: j?.error || `HTTP ${fb.status}` };
        return {
          citations: Array.isArray(j.citations) ? j.citations : [],
          answer: j.answer || "",
          backend: "bot-ask",
        };
      } catch {
        clearTimeout(tid);
        return { citations: [], error: "timeout" };
      }
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { citations: [], error: j?.error || `HTTP ${r.status}` };
    return {
      citations: Array.isArray(j.citations) ? j.citations : [],
      answer: j.answer || "",
      elapsed_ms: j.elapsed_ms,
      backend: j.backend,
    };
  } catch (e: any) {
    return { citations: [], error: e?.message || "network failure" };
  }
}
