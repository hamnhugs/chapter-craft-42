import { supabase } from "@/integrations/supabase/client";
import { BookDocument, Chapter } from "@/types/library";
import { parseBlocksVerbose } from "@/lib/responseBlocks";
import { parseArtifact } from "@/lib/artifacts";
import {
  generateImage, storeGeneratedImage, saveImageNeuron,
  fetchImageById, searchImages, loadImageAsDataUrl,
  deleteImageAttachment, deleteImageMemory,
  IMAGE_ASPECT_RATIOS, type ChatImageRef,
} from "@/lib/imageGen";

export interface ToolDeps {
  books: BookDocument[];
  activeBookId: string | null;
  setActiveBookId: (id: string) => void;
  addChapter: (bookId: string, chapter: Chapter) => Promise<void>;
  updateChapter: (bookId: string, chapterId: string, name: string) => Promise<void> | void;
  removeChapter: (bookId: string, chapterId: string) => Promise<void> | void;
  burplexityApiToken?: string;
  /** OpenRouter key — needed by the image generation tools. */
  openRouterApiKey?: string;
  /** Paid plan flag — image generation/editing are Pro features. */
  isPaid?: boolean;
  /** Optional user-preferred image model overrides. */
  imageModelPrimary?: string;
  imageModelFallback?: string;
}


/** Tool results may carry side-channel fields for the chat UI. They are
 *  stripped before the result is sent back to the model:
 *  - `__images`: ChatImageRef[] to render inline in the assistant's bubble.
 *  - `__vision`: data-URL image to inject as vision input next iteration. */
export interface ToolSideChannel {
  __images?: ChatImageRef[];
  __vision?: string;
}

export const BURPLEXITY_BOT_ASK_URL = "https://tmagmbmitnvcwubxcwoc.supabase.co/functions/v1/bot-ask";
const BURPLEXITY_QUICK_SEARCH_URL = "https://tmagmbmitnvcwubxcwoc.supabase.co/functions/v1/bot-search-quick";

// Burplexity's response shape has varied over time. Accept several common
// field names so a backend rename doesn't silently zero out the source list
// (the "0 source(s)" symptom). `citations` is still tried first for back-compat.
// True when a search-backend response looks rate-limited (HTTP 429, or a 5xx
// whose body mentions a 429/rate-limit — e.g. bot-ask wraps an upstream
// OpenRouter 429 in its own 500). Lets us show a calm "try again" message
// instead of a scary raw error.
export function isSearchRateLimited(status: number, message?: string): boolean {
  if (status === 429) return true;
  return /\b429\b|rate.?limit|temporarily|too many requests/i.test(message || "");
}

const RATE_LIMIT_MESSAGE = "The web search service is busy (rate-limited). Please try again in a moment.";

// Resolve the AI's neuron scope for this user: which wiki is active, and
// whether the paid "Access all neurons" setting widens search/conflict tools
// to every wiki. (Locked-neuron content is additionally blocked by RLS, so
// even an unscoped query can never surface it for free accounts.)
async function getNeuronScope(): Promise<{ activeWikiId: string | null; allNeurons: boolean }> {
  const [{ data: settings }, { data: sub }] = await Promise.all([
    supabase.from("user_settings").select("active_wiki_id, access_all_neurons" as any).maybeSingle(),
    supabase.from("subscribers" as any).select("subscribed").maybeSingle(),
  ]);
  return {
    activeWikiId: (settings as any)?.active_wiki_id || null,
    allNeurons: !!(settings as any)?.access_all_neurons && !!(sub as any)?.subscribed,
  };
}

export function pickCitations(j: any): Array<{ title: string; url: string; snippet: string }> {
  const raw = j?.citations ?? j?.sources ?? j?.results ?? j?.references ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: any) => ({
      title: String(c?.title ?? c?.name ?? c?.url ?? c?.link ?? "Source"),
      url: String(c?.url ?? c?.link ?? c?.href ?? c?.source ?? ""),
      snippet: String(c?.snippet ?? c?.text ?? c?.description ?? c?.content ?? "").slice(0, 240),
    }))
    .filter((c) => c.url);
}

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
      name: "list_conflicts",
      description:
        "List knowledge wiki contradictions (conflicts) flagged by the system. Use when the user asks to review, go over, or resolve contradictions/conflicts in their wiki. Each item includes both conflicting entries (a and b) with title + snippet so you can present them.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "acknowledged", "resolved", "dismissed"], description: "Default 'open'." },
          limit: { type: "number", description: "Default 10, max 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_conflict",
      description: "Fetch full text of both entries in a specific conflict plus the AI's rationale. Use before proposing a resolution if list_conflicts snippets aren't enough.",
      parameters: {
        type: "object",
        properties: { conflict_id: { type: "string" } },
        required: ["conflict_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_conflict",
      description:
        "Resolve a wiki conflict. NEVER call with a destructive action (keep_a_delete_b, keep_b_delete_a, merge, edit_a, edit_b) until the user has explicitly approved that exact action for that exact conflict in the current turn. 'acknowledge' and 'dismiss' may be applied after a clear yes.",
      parameters: {
        type: "object",
        properties: {
          conflict_id: { type: "string" },
          action: {
            type: "string",
            enum: ["keep_a_delete_b", "keep_b_delete_a", "merge", "edit_a", "edit_b", "acknowledge", "dismiss"],
          },
          merged_title: { type: "string", description: "Required when action='merge'. Written into entry A; entry B is deleted." },
          merged_content: { type: "string", description: "Required when action='merge'." },
          merged_tags: { type: "array", items: { type: "string" } },
          new_title: { type: "string", description: "Used with edit_a/edit_b." },
          new_content: { type: "string", description: "Used with edit_a/edit_b." },
          new_tags: { type: "array", items: { type: "string" } },
        },
        required: ["conflict_id", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_conflict_status",
      description: "Set a conflict's status directly (acknowledge or dismiss it) without editing entries.",
      parameters: {
        type: "object",
        properties: {
          conflict_id: { type: "string" },
          status: { type: "string", enum: ["open", "acknowledged", "resolved", "dismissed"] },
        },
        required: ["conflict_id", "status"],
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
  {
    type: "function",
    function: {
      name: "list_wikis",
      description: "List all of the user's knowledge wikis with id, name, description, default/meta flags, and current entry count. Use when the user asks 'what wikis do I have' or before switching.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_wiki",
      description: "Return the currently active wiki (the one new knowledge gets saved to and searches are biased toward).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "switch_wiki",
      description: "Switch the active wiki by id. Future ingest / search / conflict scope follows the new active wiki. Use after the user explicitly asks to switch.",
      parameters: {
        type: "object",
        properties: { wiki_id: { type: "string" } },
        required: ["wiki_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_wiki",
      description: "Create a new wiki. Optionally make it the active wiki immediately.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          activate: { type: "boolean", description: "If true, set this as active after creation. Default true." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_wiki",
      description:
        "Permanently delete a wiki (neuron) and ALL of its entries, edges, and conflicts. DESTRUCTIVE — never call until the user has, in the current turn, explicitly approved deleting this exact wiki by name or id. Must be invoked with confirm:true; without confirm:true the tool will refuse so you can ask the user again.",
      parameters: {
        type: "object",
        properties: {
          wiki_id: { type: "string" },
          confirm: { type: "boolean", description: "Must be true. Set only after the user has explicitly approved deletion of this exact wiki in this turn." },
        },
        required: ["wiki_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate one or more AI images with Nano Banana (Google's Gemini image model) and show them to the user inline. By default each image is also saved to the user's memory as a neuron. Use when the user asks for an image, picture, illustration, visualization, logo, scene, character art, etc. For multiple images in one turn: pass `count` (2–4) for variations of the SAME prompt, or `prompts: [...]` (2–4 entries) for a DISTINCT set in one call. Each image costs a few cents on their OpenRouter key — match the count to what the user asked for, don't pad.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image description — subject, style, composition, colors, mood. Required unless `prompts` is used." },
          prompts: { type: "array", items: { type: "string" }, description: "Optional. Up to 4 distinct prompts to generate as a set in one call (e.g. logo in red/blue/green). Overrides `prompt` and `count`." },
          count: { type: "integer", minimum: 1, maximum: 4, description: "Optional. Number of variations of `prompt` to generate (1–4, default 1). Ignored if `prompts` is provided." },
          aspect_ratio: { type: "string", enum: [...IMAGE_ASPECT_RATIOS], description: "Optional. Default 1:1. Applied to every image in the batch." },
          remember: { type: "boolean", description: "Save to memory as neurons (default true). Set false only if the user says they're throwaways." },
          attach_to_entry_id: { type: "string", description: "Optional: attach ALL generated images to an EXISTING knowledge entry id instead of creating new neurons." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_image",
      description:
        "Edit or refine a previously generated image (by image_id) using a text instruction — Nano Banana keeps the subject consistent. The result is a NEW image shown to the user and linked to the same memory as the original. Use for 'make it blue', 'add a hat', 'same character but at night', etc.",
      parameters: {
        type: "object",
        properties: {
          image_id: { type: "string", description: "Id of the source image (from generate_image, list_images, or a memory's attached-image note)." },
          instruction: { type: "string", description: "What to change." },
          aspect_ratio: { type: "string", enum: [...IMAGE_ASPECT_RATIOS] },
        },
        required: ["image_id", "instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_image",
      description:
        "Re-display a stored image to the user inline (free, instant). Use when the user asks to see an image again, or when a retrieved memory mentions an attached image worth showing.",
      parameters: {
        type: "object",
        properties: { image_id: { type: "string" } },
        required: ["image_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description:
        "Load a stored image as VISION input so you can actually see its contents. Use ONLY when the question requires visual details (colors, layout, text in the image, what's depicted) that the stored prompt/caption can't answer — it costs ~1300 tokens. For merely re-showing an image to the user, use show_image instead.",
      parameters: {
        type: "object",
        properties: { image_id: { type: "string" } },
        required: ["image_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_images",
      description:
        "List the user's generated images (newest first), optionally filtered by a keyword matched against prompt/caption. Returns image_id, prompt, caption, linked entry_id, and created date. Use to find an image the user refers to ('that fox logo from last week').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword filter." },
          limit: { type: "number", description: "Default 10, max 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_image_memories",
      description:
        "Search the user's stored image memories (images they previously uploaded into chat). Returns up to N matches with memory_id, caption, OCR text, tags, and a short-lived URL that you can embed in your reply via standard markdown image syntax (![alt](url)) to show the image to the user. Use whenever the user references a picture they uploaded earlier ('that diagram I shared', 'the screenshot from yesterday').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword filter matched against caption + OCR text." },
          limit: { type: "number", description: "Default 5, max 15." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_image",
      description:
        "Permanently delete a generated image (the row in image_attachments AND the underlying file in storage). Use `list_images` first to find the image_id. DESTRUCTIVE: only call when the user has explicitly approved deleting this specific image in the current turn — paraphrase the image (prompt/date) back, get a clear 'yes', then call with confirm:true. Honors the user's per-tool permissions in Settings → AI permissions.",
      parameters: {
        type: "object",
        properties: {
          image_id: { type: "string", description: "The id returned by list_images / show_image." },
          confirm: { type: "boolean", description: "Must be true — proof the user just approved this exact deletion." },
        },
        required: ["image_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_image_memory",
      description:
        "Permanently delete an uploaded image memory (a picture the USER shared earlier). Removes both the image_memories row and the storage file. Use `recall_image_memories` first to find the memory_id. DESTRUCTIVE: only call after the user has explicitly approved this specific deletion in the current turn (paraphrase caption/date, get 'yes'). Honors per-tool permissions in Settings.",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "The id returned by recall_image_memories." },
          confirm: { type: "boolean", description: "Must be true — proof the user just approved this exact deletion." },
        },
        required: ["memory_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_blocks",
      description:
        "Render rich, structured UI blocks INLINE in your reply (cards, tables, charts, timelines, step lists, key-value lists, comparisons, quizzes). Use this when structured/dense information is clearer than prose — e.g. comparisons, data, step-by-step guides, study quizzes. Still write a short prose reply too. Each item is an object with a `type` field. Text fields support markdown.",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            description:
              "Up to 20 blocks. Allowed shapes by `type`: " +
              "callout{variant:info|success|warning|danger|tip, title?, body}; " +
              "card{title, body, footer?}; " +
              "table{columns:string[], rows:string[][]}; " +
              "chart{chart:bar|line|area|pie, data:object[], xKey:string, series:string[]}; " +
              "timeline{items:[{when, label}]}; " +
              "steps{ordered?:boolean, items:string[]}; " +
              "keyValue{pairs:[{key, value}]}; " +
              "comparison{columns:string[2..3], rows:[{label, cells:string[]}]}; " +
              "quiz{question, options:string[], answerIndex:number, explanation?}.",
            items: { type: "object", properties: { type: { type: "string" } }, required: ["type"], additionalProperties: true },
          },
        },
        required: ["blocks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_artifact",
      description:
        "Render a self-contained interactive HTML or SVG 'artifact' in a side panel — for output best shown as a live rendered document: a diagram, an interactive widget, a hand-coded chart, a small HTML/CSS/JS demo, an SVG illustration, or a styled document. Provide ONLY the inner body markup (you MAY include <style> and <script> tags); do NOT include <html>, <head>, or <body> wrappers. It runs fully sandboxed with NO network access and no access to the page. Use `render_blocks` for simple structured data; use this for rich/visual/interactive output.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title shown on the artifact panel." },
          kind: { type: "string", enum: ["html", "svg"], description: "html (default) or svg." },
          content: { type: "string", description: "Inner body markup. May include <style>/<script>. No <html>/<head>/<body> wrappers and no external network calls (blocked by sandbox CSP)." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_memory_entry",
      description:
        "Create a new knowledge entry (a 'neuron memory') in the user's active wiki. Use for facts the user explicitly asks you to remember. Honors the user's Settings → AI permissions (may be disabled).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the entry." },
          content: { type: "string", description: "Body text of the memory." },
          entry_type: { type: "string", description: "e.g. fact, person, place, concept, event.", default: "fact" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
          confidence: { type: "number", description: "0.0–1.0, default 0.8." },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory_entry",
      description:
        "Edit a knowledge entry the user already has (title / content / tags / confidence). Requires entry_id. Honors per-tool permissions.",
      parameters: {
        type: "object",
        properties: {
          entry_id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: ["entry_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory_entry",
      description:
        "Permanently delete a knowledge entry. Only call when the user has explicitly approved deleting this specific entry in the current turn. Honors per-tool permissions.",
      parameters: {
        type: "object",
        properties: {
          entry_id: { type: "string" },
        },
        required: ["entry_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_memory_entries",
      description:
        "Create or remove a typed edge between two knowledge entries (supports, contradicts, refines, related, etc.). Honors per-tool permissions.",
      parameters: {
        type: "object",
        properties: {
          source_entry_id: { type: "string" },
          target_entry_id: { type: "string" },
          relation: { type: "string", description: "e.g. supports | contradicts | refines | related | causes" },
          action: { type: "string", enum: ["upsert", "delete"], default: "upsert" },
        },
        required: ["source_entry_id", "target_entry_id", "relation"],
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
        const { activeWikiId, allNeurons } = await getNeuronScope();
        let q1: any = supabase
          .from("knowledge_entries")
          .select("id, title, content, entry_type, confidence, source_book_id, tags, wiki_id")
          .or(`title.ilike.%${q}%,content.ilike.%${q}%`)
          .limit(limit);
        if (!allNeurons && activeWikiId) q1 = q1.eq("wiki_id", activeWikiId);
        const { data, error } = await q1;
        if (error) throw error;
        const entries = (data || []).map((e: any) => ({
          id: e.id,
          title: e.title,
          entry_type: e.entry_type,
          confidence: e.confidence,
          snippet: (e.content || "").slice(0, 400),
        }));
        const scopeNote = allNeurons ? " across all neurons" : activeWikiId ? " in active wiki" : "";
        return { result: entries, event: { name, summary: `Searched wiki for "${q}" — ${entries.length} hit(s)${scopeNote}`, ok: true } };
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
            if (isSearchRateLimited(r.status, msg)) {
              return {
                result: { error: RATE_LIMIT_MESSAGE },
                event: { name, summary: "Web search rate-limited — try again shortly", ok: false },
              };
            }
            return {
              result: { error: `Burplexity search failed: ${msg}` },
              event: { name, summary: `Web search failed: ${msg}`, ok: false },
            };
          }
          const answer = String(j.answer || "").slice(0, 16000);
          const citations = pickCitations(j).slice(0, 8);
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
      case "list_conflicts": {
        const status = (args.status as string) || "open";
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const { data: conflicts, error } = await supabase
          .from("knowledge_conflicts")
          .select("id, kind, rationale, status, entry_a, entry_b, created_at")
          .eq("status", status)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        const ids = Array.from(new Set((conflicts || []).flatMap((c: any) => [c.entry_a, c.entry_b])));
        const { data: ents } = ids.length
          ? await supabase.from("knowledge_entries").select("id, title, content, entry_type, confidence, source_book_id, wiki_id" as any).in("id", ids)
          : { data: [] as any[] };
        const byId = new Map(((ents as any[]) || []).map((e: any) => [e.id, e]));
        // Scope to active wiki when one is set — both entries must live in it (or be
        // unscoped legacy entries). "Access all neurons" (paid) lifts the filter.
        const { activeWikiId, allNeurons } = await getNeuronScope();
        const inScope = (id: string) => {
          if (allNeurons || !activeWikiId) return true;
          const e: any = byId.get(id);
          if (!e) return true; // missing — surface anyway so user knows
          return !e.wiki_id || e.wiki_id === activeWikiId;
        };
        const hydrate = (id: string) => {
          const e: any = byId.get(id);
          if (!e) return { id, missing: true };
          return { id, title: e.title, entry_type: e.entry_type, confidence: e.confidence, source_book_id: e.source_book_id, snippet: (e.content || "").slice(0, 500) };
        };
        const out = (conflicts || [])
          .filter((c: any) => inScope(c.entry_a) || inScope(c.entry_b))
          .map((c: any) => ({
            conflict_id: c.id, kind: c.kind, status: c.status, rationale: c.rationale,
            entry_a: hydrate(c.entry_a), entry_b: hydrate(c.entry_b),
          }));
        return { result: out, event: { name, summary: `Listed ${out.length} ${status} conflict(s)${activeWikiId ? " in active wiki" : ""}`, ok: true } };
      }
      case "get_conflict": {
        const id = String(args.conflict_id || "");
        if (!id) return { result: { error: "conflict_id required" }, event: { name, summary: "Missing conflict_id", ok: false } };
        const { data: c, error } = await supabase
          .from("knowledge_conflicts").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!c) return { result: { error: "Conflict not found" }, event: { name, summary: "Conflict not found", ok: false } };
        const { data: ents } = await supabase
          .from("knowledge_entries").select("id, title, content, entry_type, confidence, tags, source_book_id")
          .in("id", [c.entry_a, c.entry_b]);
        const byId = new Map((ents || []).map((e: any) => [e.id, e]));
        return {
          result: {
            conflict_id: c.id, kind: c.kind, status: c.status, rationale: c.rationale,
            entry_a: byId.get(c.entry_a) || { id: c.entry_a, missing: true },
            entry_b: byId.get(c.entry_b) || { id: c.entry_b, missing: true },
          },
          event: { name, summary: `Loaded conflict ${c.id.slice(0, 8)}`, ok: true },
        };
      }
      case "resolve_conflict": {
        const id = String(args.conflict_id || "");
        const action = String(args.action || "");
        if (!id || !action) return { result: { error: "conflict_id and action required" }, event: { name, summary: "Missing args", ok: false } };
        const { data: c, error: cErr } = await supabase
          .from("knowledge_conflicts").select("*").eq("id", id).maybeSingle();
        if (cErr) throw cErr;
        if (!c) return { result: { error: "Conflict not found" }, event: { name, summary: "Conflict not found", ok: false } };

        const setStatus = async (status: string) => {
          const { error } = await supabase.from("knowledge_conflicts").update({ status }).eq("id", id);
          if (error) throw error;
        };
        const deleteEntry = async (eid: string) => {
          const { error } = await supabase.from("knowledge_entries").delete().eq("id", eid);
          if (error) throw error;
        };
        const updateEntry = async (eid: string, patch: any) => {
          const { error } = await supabase.from("knowledge_entries").update(patch).eq("id", eid);
          if (error) throw error;
        };

        switch (action) {
          case "acknowledge":
            await setStatus("acknowledged");
            return { result: { ok: true, status: "acknowledged" }, event: { name, summary: "Conflict acknowledged", ok: true } };
          case "dismiss":
            await setStatus("dismissed");
            return { result: { ok: true, status: "dismissed" }, event: { name, summary: "Conflict dismissed (false positive)", ok: true } };
          case "keep_a_delete_b":
            await deleteEntry(c.entry_b);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: "Resolved — kept entry A, deleted entry B", ok: true } };
          case "keep_b_delete_a":
            await deleteEntry(c.entry_a);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: "Resolved — kept entry B, deleted entry A", ok: true } };
          case "merge": {
            const title = String(args.merged_title || "").trim();
            const content = String(args.merged_content || "").trim();
            if (!title || !content) return { result: { error: "merged_title and merged_content required" }, event: { name, summary: "Merge missing fields", ok: false } };
            const patch: any = { title, content };
            if (Array.isArray(args.merged_tags)) patch.tags = args.merged_tags;
            await updateEntry(c.entry_a, patch);
            await deleteEntry(c.entry_b);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: `Merged into "${title}"`, ok: true } };
          }
          case "edit_a":
          case "edit_b": {
            const targetId = action === "edit_a" ? c.entry_a : c.entry_b;
            const patch: any = {};
            if (typeof args.new_title === "string" && args.new_title.trim()) patch.title = args.new_title.trim();
            if (typeof args.new_content === "string" && args.new_content.trim()) patch.content = args.new_content.trim();
            if (Array.isArray(args.new_tags)) patch.tags = args.new_tags;
            if (Object.keys(patch).length === 0) return { result: { error: "Provide new_title and/or new_content" }, event: { name, summary: "Edit missing fields", ok: false } };
            await updateEntry(targetId, patch);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: `Edited entry ${action === "edit_a" ? "A" : "B"} and resolved`, ok: true } };
          }
          default:
            return { result: { error: `Unknown action ${action}` }, event: { name, summary: `Unknown action ${action}`, ok: false } };
        }
      }
      case "update_conflict_status": {
        const id = String(args.conflict_id || "");
        const status = String(args.status || "");
        if (!id || !status) return { result: { error: "conflict_id and status required" }, event: { name, summary: "Missing args", ok: false } };
        const { error } = await supabase.from("knowledge_conflicts").update({ status }).eq("id", id);
        if (error) throw error;
        return { result: { ok: true, status }, event: { name, summary: `Conflict → ${status}`, ok: true } };
      }
      case "list_wikis": {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        const [{ data: wikis, error: wErr }, { data: settings }, { data: counts }] = await Promise.all([
          supabase.from("wikis" as any).select("id, name, description, is_default, is_meta, created_at, updated_at").order("updated_at", { ascending: false }),
          supabase.from("user_settings").select("active_wiki_id" as any).maybeSingle(),
          supabase.from("knowledge_entries").select("wiki_id" as any),
        ]);
        if (wErr) throw wErr;
        const activeId = (settings as any)?.active_wiki_id || null;
        const countMap = new Map<string, number>();
        for (const r of ((counts as any[]) || [])) {
          if (!r?.wiki_id) continue;
          countMap.set(r.wiki_id, (countMap.get(r.wiki_id) || 0) + 1);
        }
        const out = ((wikis as any[]) || []).map((w) => ({
          id: w.id, name: w.name, description: w.description, is_default: w.is_default, is_meta: w.is_meta,
          is_active: w.id === activeId, entry_count: countMap.get(w.id) || 0,
        }));
        return { result: out, event: { name, summary: `Listed ${out.length} wiki(s)`, ok: true } };
      }
      case "get_active_wiki": {
        const { data: settings } = await supabase.from("user_settings").select("active_wiki_id" as any).maybeSingle();
        const activeId = (settings as any)?.active_wiki_id || null;
        if (!activeId) return { result: { active_wiki_id: null }, event: { name, summary: "No active wiki set", ok: true } };
        const { data: wiki } = await supabase.from("wikis" as any).select("id, name, description, is_default, is_meta").eq("id", activeId).maybeSingle();
        return { result: { active_wiki_id: activeId, wiki: wiki || null }, event: { name, summary: `Active wiki: ${(wiki as any)?.name || activeId.slice(0, 8)}`, ok: true } };
      }
      case "switch_wiki": {
        const wid = String(args.wiki_id || "");
        if (!wid) return { result: { error: "wiki_id required" }, event: { name, summary: "Missing wiki_id", ok: false } };
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        const { data: wiki, error: wErr } = await supabase.from("wikis" as any).select("id, name").eq("id", wid).maybeSingle();
        if (wErr) throw wErr;
        if (!wiki) return { result: { error: "Wiki not found" }, event: { name, summary: "Wiki not found", ok: false } };
        // Free plan: only the oldest neuron is unlocked — the AI must not be a
        // side door into locked ones (mirrors the BRAIN tab and ⌘K switcher).
        // Admins bypass all plan gates (same rule as accessible_wiki_ids()).
        const { data: isAdminData } = await supabase.rpc("is_admin" as any);
        if (!isAdminData) {
          const { data: sub } = await supabase.from("subscribers" as any).select("subscribed, plan").maybeSingle();
          const paid = !!(sub as any)?.subscribed && (sub as any)?.plan !== "free";
          if (!paid) {
            const { data: oldest } = await supabase
              .from("wikis" as any)
              .select("id")
              .order("created_at", { ascending: true })
              .order("id", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (oldest && (oldest as any).id !== wid) {
              return {
                result: { error: `"${(wiki as any).name}" is locked on the free plan. Tell the user that upgrading to Pro or Lifetime unlocks all of their neurons.` },
                event: { name, summary: `"${(wiki as any).name}" is locked on the free plan`, ok: false },
              };
            }
          }
        }
        await supabase.from("wikis" as any).update({ last_loaded_at: new Date().toISOString() } as any).eq("id", wid);
        const { error } = await supabase.from("user_settings").upsert({ user_id: uid, active_wiki_id: wid } as any, { onConflict: "user_id" });
        if (error) throw error;
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wiki-active-changed"));
        return { result: { ok: true, active_wiki_id: wid, name: (wiki as any).name }, event: { name, summary: `Switched to "${(wiki as any).name}"`, ok: true } };
      }
      case "create_wiki": {
        const wname = String(args.name || "").trim();
        if (!wname) return { result: { error: "name required" }, event: { name, summary: "Missing name", ok: false } };
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        const { data, error } = await supabase.from("wikis" as any).insert({
          user_id: uid, name: wname, description: String(args.description || ""), tags: [],
        } as any).select().single();
        if (error || !data) throw error || new Error("Create failed");
        const activate = args.activate !== false;
        if (activate) {
          await supabase.from("user_settings").upsert({ user_id: uid, active_wiki_id: (data as any).id } as any, { onConflict: "user_id" });
        }
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wiki-active-changed"));
        return { result: { ok: true, id: (data as any).id, name: wname, activated: activate }, event: { name, summary: `Created wiki "${wname}"${activate ? " (active)" : ""}`, ok: true } };
      }
      case "delete_wiki": {
        // Per-tool permission gate. Defaults to allowed.
        const { data: prefs } = await supabase
          .from("user_settings")
          .select("chat_tool_permissions, active_wiki_id" as any)
          .maybeSingle();
        const perms = (((prefs as any)?.chat_tool_permissions) || {}) as Record<string, boolean>;
        if (perms.delete_wiki === false) {
          return {
            result: { error: "Tool 'delete_wiki' is disabled in the user's AI permissions. Ask the user to enable it in Settings." },
            event: { name, summary: "delete_wiki blocked by user settings", ok: false },
          };
        }
        const wid = String(args.wiki_id || "");
        if (!wid) return { result: { error: "wiki_id required" }, event: { name, summary: "Missing wiki_id", ok: false } };
        if (args.confirm !== true) {
          return {
            result: { error: "Deletion requires confirm:true. Ask the user to explicitly confirm deleting this exact wiki by name, then retry with confirm:true." },
            event: { name, summary: "Refused: confirmation required", ok: false },
          };
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };

        const { data: target, error: tErr } = await supabase
          .from("wikis" as any)
          .select("id, name, is_default")
          .eq("id", wid)
          .eq("user_id", uid)
          .maybeSingle();
        if (tErr) throw tErr;
        if (!target) return { result: { error: "Wiki not found" }, event: { name, summary: "Wiki not found", ok: false } };

        const { data: allWikis } = await supabase
          .from("wikis" as any)
          .select("id, created_at")
          .eq("user_id", uid)
          .order("created_at", { ascending: true });
        const wikis = (allWikis as any[]) || [];
        if (wikis.length <= 1) {
          return {
            result: { error: "Cannot delete the only remaining wiki. Ask the user to create another wiki first." },
            event: { name, summary: "Refused: last remaining wiki", ok: false },
          };
        }
        if ((target as any).is_default) {
          return {
            result: { error: "This wiki is marked as the default. Ask the user to set a different wiki as default before deleting." },
            event: { name, summary: "Refused: default wiki", ok: false },
          };
        }

        const wasActive = ((prefs as any)?.active_wiki_id || null) === wid;
        const { error: dErr } = await supabase
          .from("wikis" as any)
          .delete()
          .eq("id", wid)
          .eq("user_id", uid);
        if (dErr) throw dErr;

        if (wasActive) {
          const nextActive = wikis.find((w) => w.id !== wid)?.id || null;
          await supabase.from("user_settings").upsert(
            { user_id: uid, active_wiki_id: nextActive } as any,
            { onConflict: "user_id" },
          );
        }
        try {
          window.dispatchEvent(new CustomEvent("wiki-active-changed"));
          window.dispatchEvent(new Event("knowledge-entries-changed"));
        } catch {}
        return {
          result: { ok: true, deleted_id: wid, name: (target as any).name },
          event: { name, summary: `Deleted wiki "${(target as any).name}"`, ok: true },
        };
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
      case "generate_image": {
        const apiKey = (deps.openRouterApiKey || "").trim();
        if (!apiKey) {
          return {
            result: { error: "OpenRouter API key not configured — ask the user to add one in Settings." },
            event: { name, summary: "OpenRouter key missing", ok: false },
          };
        }
        if (deps.isPaid === false) {
          return {
            result: { error: "Image generation is a Pro feature. Tell the user that upgrading to Pro or Lifetime unlocks it." },
            event: { name, summary: "Image generation is a Pro feature", ok: false },
          };
        }
        // Normalize into a prompts[] (1–4 items).
        let prompts: string[] = [];
        if (Array.isArray(args.prompts) && args.prompts.length > 0) {
          prompts = args.prompts.map((p: unknown) => String(p || "").trim()).filter(Boolean).slice(0, 4);
        } else {
          const base = String(args.prompt || "").trim();
          if (!base) return { result: { error: "prompt (or non-empty prompts[]) required" }, event: { name, summary: "Missing prompt", ok: false } };
          const count = Math.min(4, Math.max(1, Number(args.count) || 1));
          prompts = Array(count).fill(base);
        }
        if (prompts.length === 0) return { result: { error: "No valid prompts." }, event: { name, summary: "Missing prompts", ok: false } };

        const aspectRatio = args.aspect_ratio ? String(args.aspect_ratio) : undefined;
        const remember = args.remember !== false;
        const sharedEntryId: string | null = String(args.attach_to_entry_id || "").trim() || null;

        const settled = await Promise.allSettled(
          prompts.map(async (p) => {
            const gen = await generateImage({ apiKey, prompt: p, aspectRatio, primaryModel: deps.imageModelPrimary, fallbackModel: deps.imageModelFallback });
            let entryId: string | null = sharedEntryId;
            let neuronCreated = false;
            if (remember && !entryId) {
              entryId = await saveImageNeuron({ prompt: p, caption: gen.text, model: gen.modelUsed });
              neuronCreated = !!entryId;
            }
            const ref = await storeGeneratedImage({
              prompt: p, caption: gen.text, model: gen.modelUsed,
              dataUrl: gen.dataUrl, mime: gen.mime, entryId,
            });
            return { ref, entryId, neuronCreated, model: gen.modelUsed, prompt: p };
          }),
        );

        const successes = settled.flatMap((s) => s.status === "fulfilled" ? [s.value] : []);
        const failures = settled.flatMap((s, i) => s.status === "rejected" ? [{ prompt: prompts[i], error: String((s as PromiseRejectedResult).reason?.message || (s as PromiseRejectedResult).reason || "unknown") }] : []);

        if (successes.length === 0) {
          return {
            result: { error: "All image generations failed.", failures },
            event: { name, summary: `Image generation failed (${failures.length})`, ok: false },
          };
        }

        const refs = successes.map((s) => s.ref);
        const firstPrompt = prompts[0];
        const summary = successes.length === 1
          ? `Generated image: "${firstPrompt.slice(0, 60)}"${successes[0].neuronCreated ? " · saved to memory" : successes[0].entryId ? " · attached to memory" : ""}`
          : `Generated ${successes.length} images${failures.length ? ` (${failures.length} failed)` : ""}`;

        return {
          result: {
            ok: true,
            count: successes.length,
            images: successes.map((s) => ({
              image_id: s.ref.id,
              entry_id: s.entryId,
              saved_to_memory: !!s.entryId,
              prompt: s.prompt,
              model: s.model,
            })),
            failures: failures.length ? failures : undefined,
            note: "All images above are ALREADY displayed to the user inline — do NOT output markdown image links. Briefly describe what you created.",
            __images: refs,
          },
          event: { name, summary, ok: true },
        };
      }
      case "edit_image": {
        const imageId = String(args.image_id || "").trim();
        const instruction = String(args.instruction || "").trim();
        if (!imageId || !instruction) return { result: { error: "image_id and instruction required" }, event: { name, summary: "Missing args", ok: false } };
        const apiKey = (deps.openRouterApiKey || "").trim();
        if (!apiKey) return { result: { error: "OpenRouter API key not configured." }, event: { name, summary: "OpenRouter key missing", ok: false } };
        if (deps.isPaid === false) {
          return {
            result: { error: "Image editing is a Pro feature. Tell the user that upgrading to Pro or Lifetime unlocks it." },
            event: { name, summary: "Image editing is a Pro feature", ok: false },
          };
        }
        const src = await fetchImageById(imageId);
        if (!src) return { result: { error: "Image not found" }, event: { name, summary: "Image not found", ok: false } };
        const srcDataUrl = await loadImageAsDataUrl(src.storage_path);
        if (!srcDataUrl) return { result: { error: "Could not load source image" }, event: { name, summary: "Source image unavailable", ok: false } };
        const gen = await generateImage({
          apiKey,
          prompt: instruction,
          aspectRatio: args.aspect_ratio ? String(args.aspect_ratio) : undefined,
          inputImageDataUrl: srcDataUrl,
          primaryModel: deps.imageModelPrimary,
          fallbackModel: deps.imageModelFallback,
        });

        const ref = await storeGeneratedImage({
          prompt: `${src.prompt} → ${instruction}`.slice(0, 2000),
          caption: gen.text, model: gen.modelUsed,
          dataUrl: gen.dataUrl, mime: gen.mime,
          entryId: src.entry_id, sourceImageId: src.id,
        });
        return {
          result: {
            ok: true, image_id: ref.id, entry_id: src.entry_id, model: gen.modelUsed,
            note: "The edited image is already displayed to the user inline. Briefly describe the change.",
            __images: [ref],
          },
          event: { name, summary: `Edited image: "${instruction.slice(0, 60)}"`, ok: true },
        };
      }
      case "show_image": {
        const imageId = String(args.image_id || "").trim();
        if (!imageId) return { result: { error: "image_id required" }, event: { name, summary: "Missing image_id", ok: false } };
        const row = await fetchImageById(imageId);
        if (!row) return { result: { error: "Image not found" }, event: { name, summary: "Image not found", ok: false } };
        const ref: ChatImageRef = { id: row.id, storage_path: row.storage_path, prompt: row.prompt, entry_id: row.entry_id };
        return {
          result: {
            ok: true, image_id: row.id, prompt: row.prompt, caption: row.caption,
            note: "The image is now displayed to the user inline.",
            __images: [ref],
          },
          event: { name, summary: `Showed image: "${row.prompt.slice(0, 60)}"`, ok: true },
        };
      }
      case "view_image": {
        const imageId = String(args.image_id || "").trim();
        if (!imageId) return { result: { error: "image_id required" }, event: { name, summary: "Missing image_id", ok: false } };
        const row = await fetchImageById(imageId);
        if (!row) return { result: { error: "Image not found" }, event: { name, summary: "Image not found", ok: false } };
        const dataUrl = await loadImageAsDataUrl(row.storage_path);
        if (!dataUrl) return { result: { error: "Could not load image" }, event: { name, summary: "Image unavailable", ok: false } };
        return {
          result: {
            ok: true, image_id: row.id, prompt: row.prompt,
            note: "The image is attached as vision input in the next user message — look at it there.",
            __vision: dataUrl,
          },
          event: { name, summary: `Looked at image: "${row.prompt.slice(0, 60)}"`, ok: true },
        };
      }
      case "list_images": {
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const rows = await searchImages(args.query ? String(args.query) : undefined, limit);
        const out = rows.map((r) => ({
          image_id: r.id,
          prompt: (r.prompt || "").slice(0, 200),
          caption: (r.caption || "").slice(0, 200),
          entry_id: r.entry_id,
          created_at: r.created_at,
        }));
        return { result: out, event: { name, summary: `Listed ${out.length} image(s)${args.query ? ` matching "${String(args.query).slice(0, 40)}"` : ""}`, ok: true } };
      }
      case "recall_image_memories": {
        const limit = Math.min(15, Math.max(1, Number(args.limit) || 5));
        const q = typeof args.query === "string" ? args.query.trim() : "";
        let query: any = (supabase.from("image_memories" as any) as any)
          .select("id, caption, ocr_text, tags, storage_path, created_at, wiki_id")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (q) {
          const safe = q.replace(/[%,()]/g, " ");
          query = query.or(`caption.ilike.%${safe}%,ocr_text.ilike.%${safe}%`);
        }
        const { data, error } = await query;
        if (error) {
          return { result: { error: error.message }, event: { name, summary: "Image memory search failed", ok: false } };
        }
        const rows: any[] = data || [];
        const out = await Promise.all(rows.map(async (r) => {
          let url: string | null = null;
          try {
            const signed = await supabase.storage.from("generated-images").createSignedUrl(r.storage_path, 60 * 60);
            url = signed.data?.signedUrl || null;
          } catch { /* ignore */ }
          return {
            memory_id: r.id,
            caption: (r.caption || "").slice(0, 240),
            ocr_excerpt: (r.ocr_text || "").slice(0, 240),
            tags: r.tags || [],
            created_at: r.created_at,
            url,
          };
        }));
        return {
          result: out,
          event: { name, summary: `Recalled ${out.length} image memory${out.length === 1 ? "" : "s"}${q ? ` matching "${q.slice(0, 40)}"` : ""}`, ok: true },
        };
      }
      case "delete_image":
      case "delete_image_memory": {
        // Per-tool permission gate. Defaults to allowed.
        const { data: prefs } = await supabase
          .from("user_settings")
          .select("chat_tool_permissions" as any)
          .maybeSingle();
        const perms = (((prefs as any)?.chat_tool_permissions) || {}) as Record<string, boolean>;
        if (perms[name] === false) {
          return {
            result: { error: `Tool '${name}' is disabled in the user's AI permissions. Ask the user to enable it in Settings → AI permissions → Images.` },
            event: { name, summary: `${name} blocked by user settings`, ok: false },
          };
        }
        if (args.confirm !== true) {
          return {
            result: { error: "Deletion requires confirm:true. Paraphrase the exact image back to the user, get explicit approval, then retry with confirm:true." },
            event: { name, summary: "Refused: confirmation required", ok: false },
          };
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };

        if (name === "delete_image") {
          const imageId = String(args.image_id || "").trim();
          if (!imageId) return { result: { error: "image_id required" }, event: { name, summary: "Missing image_id", ok: false } };
          const row = await fetchImageById(imageId);
          if (!row) return { result: { error: "Image not found or not owned by current user" }, event: { name, summary: "Image not found", ok: false } };
          try {
            await deleteImageAttachment({ id: row.id, storage_path: row.storage_path });
          } catch (e: any) {
            return { result: { error: e?.message || "Delete failed" }, event: { name, summary: "Image delete failed", ok: false } };
          }
          try { window.dispatchEvent(new CustomEvent("image-attachments-changed", { detail: { deleted: [row.id] } })); } catch {}
          return {
            result: { ok: true, deleted_id: row.id, prompt: (row.prompt || "").slice(0, 80) },
            event: { name, summary: `Deleted image: "${(row.prompt || "").slice(0, 60)}"`, ok: true },
          };
        } else {
          const memId = String(args.memory_id || "").trim();
          if (!memId) return { result: { error: "memory_id required" }, event: { name, summary: "Missing memory_id", ok: false } };
          const { data: mem, error: fErr } = await (supabase.from("image_memories" as any) as any)
            .select("id, caption, storage_path, user_id")
            .eq("id", memId)
            .maybeSingle();
          if (fErr) throw fErr;
          if (!mem || (mem as any).user_id !== uid) {
            return { result: { error: "Image memory not found or not owned by current user" }, event: { name, summary: "Memory not found", ok: false } };
          }
          try {
            await deleteImageMemory({ id: (mem as any).id, storage_path: (mem as any).storage_path });
          } catch (e: any) {
            return { result: { error: e?.message || "Delete failed" }, event: { name, summary: "Memory delete failed", ok: false } };
          }
          try { window.dispatchEvent(new CustomEvent("image-memories-changed", { detail: { deleted: [(mem as any).id] } })); } catch {}
          return {
            result: { ok: true, deleted_id: (mem as any).id, caption: ((mem as any).caption || "").slice(0, 80) },
            event: { name, summary: `Deleted image memory${(mem as any).caption ? `: "${(mem as any).caption.slice(0, 60)}"` : ""}`, ok: true },
          };
        }
      }
      case "create_artifact": {
        const art = parseArtifact(args);
        if (!art) {
          return { result: { error: "Artifact needs non-empty `content` (the inner HTML/SVG body markup, no wrappers)." }, event: { name, summary: "Artifact invalid", ok: false } };
        }
        // Rendered client-side from the tool-call arguments (see ChatContext).
        return { result: { ok: true, title: art.title, kind: art.kind, bytes: art.content.length }, event: { name, summary: `Created artifact "${art.title}"`, ok: true } };
      }
      case "render_blocks": {
        const { blocks, issues } = parseBlocksVerbose((args as any).blocks ?? args);
        if (!blocks.length) {
          // Hand the validation errors back so the model can fix and re-call.
          return {
            result: {
              error: "No blocks passed validation. Fix the issues and call render_blocks again with the exact whitelisted shapes.",
              issues: issues.slice(0, 6),
            },
            event: { name, summary: "Blocks invalid — asked model to retry", ok: false },
          };
        }
        // Blocks are rendered client-side from the tool-call arguments (see
        // ChatContext); here we acknowledge + report any dropped ones.
        return {
          result: { ok: true, rendered: blocks.length, dropped: issues.length, issues: issues.slice(0, 4) },
          event: { name, summary: `Rendered ${blocks.length} block(s)${issues.length ? `, dropped ${issues.length}` : ""}`, ok: true },
        };
      }
      case "create_memory_entry":
      case "update_memory_entry":
      case "delete_memory_entry":
      case "link_memory_entries": {
        // Per-tool permission gate. Defaults to allowed.
        const { data: prefs } = await supabase
          .from("user_settings")
          .select("chat_tool_permissions" as any)
          .maybeSingle();
        const perms = ((prefs as any)?.chat_tool_permissions || {}) as Record<string, boolean>;
        if (perms[name] === false) {
          return {
            result: { error: `Tool '${name}' is disabled in the user's AI permissions. Ask the user to enable it in Settings.` },
            event: { name, summary: `${name} blocked by user settings`, ok: false },
          };
        }

        if (name === "create_memory_entry") {
          const { activeWikiId } = await getNeuronScope();
          if (!activeWikiId) return { result: { error: "No active wiki" }, event: { name, summary: "No active wiki", ok: false } };
          const { data, error } = await supabase.rpc("memory_entry_upsert" as any, {
            _id: null,
            _wiki_id: activeWikiId,
            _title: String(args.title || "").slice(0, 200),
            _content: String(args.content || ""),
            _entry_type: String(args.entry_type || "fact"),
            _tags: Array.isArray(args.tags) ? args.tags : [],
            _confidence: typeof args.confidence === "number" ? args.confidence : 0.8,
          });
          if (error) throw error;
          try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch {}
          return { result: { ok: true, entry_id: data }, event: { name, summary: `Created memory "${args.title}"`, ok: true } };
        }
        if (name === "update_memory_entry") {
          if (!args.entry_id) return { result: { error: "entry_id required" }, event: { name, summary: "Missing entry_id", ok: false } };
          const { data, error } = await supabase.rpc("memory_entry_upsert" as any, {
            _id: args.entry_id,
            _wiki_id: null,
            _title: args.title ?? null,
            _content: args.content ?? null,
            _entry_type: args.entry_type ?? null,
            _tags: Array.isArray(args.tags) ? args.tags : null,
            _confidence: typeof args.confidence === "number" ? args.confidence : null,
          });
          if (error) throw error;
          try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch {}
          return { result: { ok: true, entry_id: data }, event: { name, summary: `Updated memory`, ok: true } };
        }
        if (name === "delete_memory_entry") {
          if (!args.entry_id) return { result: { error: "entry_id required" }, event: { name, summary: "Missing entry_id", ok: false } };
          const { error } = await supabase.from("knowledge_entries").delete().eq("id", args.entry_id);
          if (error) throw error;
          try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch {}
          return { result: { ok: true }, event: { name, summary: `Deleted memory entry`, ok: true } };
        }
        // link_memory_entries
        const action = String(args.action || "upsert");
        if (action === "delete") {
          const { error } = await supabase.rpc("memory_edge_delete" as any, {
            _source: args.source_entry_id, _target: args.target_entry_id,
          });
          if (error) throw error;
          return { result: { ok: true }, event: { name, summary: `Removed link`, ok: true } };
        }
        const { error } = await supabase.rpc("memory_edge_upsert" as any, {
          _source: args.source_entry_id, _target: args.target_entry_id, _relationship: args.relation,
        });
        if (error) throw error;
        return { result: { ok: true }, event: { name, summary: `Linked entries (${args.relation})`, ok: true } };
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
          citations: pickCitations(j),
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
      citations: pickCitations(j),
      answer: j.answer || "",
      elapsed_ms: j.elapsed_ms,
      backend: j.backend,
    };
  } catch (e: any) {
    return { citations: [], error: e?.message || "network failure" };
  }
}
