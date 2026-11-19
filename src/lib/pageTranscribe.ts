/**
 * Reading the words off a page photo.
 *
 * One vision-model call per photo, made from the browser with the reader's
 * own key — the same route a chat turn with a picture takes, so there is no
 * server piece to deploy. The photo goes to the model and nowhere else.
 *
 * The prompt's whole job is FIDELITY. Vision models are measurably prone to
 * tidying what they read — fixing a typo, modernising a spelling, swapping a
 * rare surname for a common one (DAISY's 317-page test; arXiv 2607.21617).
 * For a book that is corruption, so the instruction is verbatim text with a
 * short, named list of allowed departures, and an explicit way to say "I
 * could not read this" instead of guessing.
 *
 * The answer is structured so each consumer takes only its part: speech reads
 * `body`; Counsel also gets figures and footnotes; the running head and the
 * page number are lifted OUT of the text (nobody wants "one hundred and
 * twelve" read aloud mid-sentence) and used to title and order the book.
 */

import { GEMINI_STARTER_MODEL } from "@/lib/geminiCatalog";
import { DEFAULT_FIGURE_MODEL } from "@/lib/figureModels";
import { namespacedId, modelProvider, providerConfigured, providerKey, providerLabel, resolveModel } from "@/lib/providers/registry";
import { ProviderError } from "@/lib/providers/types";
import { newPageId, type PaperPage } from "@/lib/paperBook";

export type ShotKind = "page" | "spread" | "cover" | "other";
export type ShotProblem = "blurry" | "cut_off" | "dark" | "glare" | "no_text";

export interface Transcription {
  kind: ShotKind;
  /** The book's title, when the photo shows it (cover, title page, running head). */
  bookTitle: string | null;
  author: string | null;
  /** One entry for a page, two for an open spread (left first), none for a cover. */
  pages: PaperPage[];
  /** Set when the model could not make a usable reading. */
  problem: ShotProblem | null;
}

export interface TranscribeSettings {
  visionModel?: string;
  selectedModel?: string;
  keys: { apiKey?: string; geminiApiKey?: string; nvidiaKeyLast4?: string };
}

export type Transcriber = (dataUrl: string, opts: { signal?: AbortSignal; bookTitle?: string | null }) => Promise<Transcription>;

export const TRANSCRIBE_SYSTEM = [
  "You transcribe photographs of printed book pages for a reader who owns the book.",
  "Transcribe the source verbatim, character for character. Fidelity to the source always outranks readability.",
  "Do NOT correct spelling, grammar, punctuation, capitalisation or names, even when they look wrong. Do NOT modernise, paraphrase, summarise, translate or complete anything. Never add words that are not printed on the page.",
  "The ONLY permitted departures from the printed text are:",
  "1. Rejoin a word split by a hyphen at the end of a line (\"under-\" + \"standing\" becomes \"understanding\"). Keep real hyphens.",
  "2. Join the lines of a paragraph into one line; separate paragraphs with one blank line.",
  "3. Leave the running header, running footer and the page number OUT of the body; report the page number separately.",
  "4. Leave footnote text and footnote reference marks (superscript numbers, asterisks, daggers) OUT of the body; put each footnote in `footnotes`.",
  "5. Do not transcribe the inside of pictures, charts or tables into the body; describe each in one sentence in `figures`.",
  "6. Read multi-column pages one column at a time, left column first.",
  "If a word or passage cannot be read (blur, glare, a finger, the gutter, the edge of the photo), write [unclear] in its place. Never guess.",
  "If the last word on the page is cut by a hyphen and continues on the next page, keep the partial word with its hyphen.",
  "Ignore anything that is not the book: fingers, the table, a facing page that is only partly visible.",
  "",
  "Return STRICT JSON only, no prose and no code fence:",
  '{"kind":"page"|"spread"|"cover"|"other","book_title":string|null,"author":string|null,"problem":null|"blurry"|"cut_off"|"dark"|"glare"|"no_text","pages":[{"page_number":string|null,"chapter_title":string|null,"body":string,"footnotes":[string],"figures":[string],"starts_mid_sentence":boolean,"ends_mid_sentence":boolean,"legibility":"clear"|"partial"|"poor"}]}',
  "- kind: \"page\" = one page; \"spread\" = two full facing pages (return two entries in `pages`, left page first); \"cover\" = the front cover or title page (`pages` is empty; fill book_title and author); \"other\" = not a book.",
  "- book_title / author: only when printed in the photo (cover, title page, or a running header that is clearly the book's title). Otherwise null.",
  "- page_number: exactly as printed (\"47\", \"xii\"), or null if none is visible.",
  "- chapter_title: only when a chapter or section title STARTS on this page; then leave that title out of body.",
  "- starts_mid_sentence: true when the body's first words continue a sentence from the previous page.",
  "- ends_mid_sentence: true when the body's last sentence is not finished on this page.",
  "- legibility: \"clear\" when you could read the whole page; \"partial\" when a noticeable part is missing or marked [unclear]; \"poor\" when most of the page could not be read, or what you could read does not form coherent sentences. Be honest: this is how the reader finds pages to photograph again.",
  "- problem: set it only when most of the text cannot be read; still return whatever you could read.",
].join("\n");

const str = (v: unknown, max: number, numberOk = false): string | null => {
  if (typeof v !== "string") return numberOk && typeof v === "number" && Number.isFinite(v) ? String(v) : null;
  const t = v.replace(/\r\n?/g, "\n").trim();
  return t ? t.slice(0, max) : null;
};
const list = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => str(x, 2000)).filter((x): x is string => !!x).slice(0, max);

function extractJson(raw: string): unknown {
  const text = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  try { return JSON.parse(text); } catch { /* chatty reply — find the object */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

const KINDS: ShotKind[] = ["page", "spread", "cover", "other"];
const PROBLEMS: ShotProblem[] = ["blurry", "cut_off", "dark", "glare", "no_text"];

/**
 * A model's reply as a Transcription. Never throws and never invents: fields
 * of the wrong type are dropped, and a reply that is not the JSON asked for
 * becomes a `no_text` problem with no pages — not a page of the model's prose
 * filed into the book as if it had been printed there.
 */
export function parseTranscription(raw: string, now = Date.now()): Transcription {
  const data = extractJson(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") {
    return { kind: "other", bookTitle: null, author: null, pages: [], problem: "no_text" };
  }
  const rawPages = Array.isArray(data.pages) ? data.pages : [];
  const pages: PaperPage[] = [];
  for (const p of rawPages.slice(0, 2)) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const text = str(r.body, 40_000) || "";
    const heading = str(r.chapter_title, 200);
    const figures = list(r.figures, 12);
    if (!text && !heading && figures.length === 0) continue;
    pages.push({
      id: newPageId(),
      printed: (str(r.page_number, 12, true) || "").replace(/^(p\.?|page)\s*/i, "") || null,
      heading,
      text,
      footnotes: list(r.footnotes, 40),
      figures,
      startsMid: r.starts_mid_sentence === true,
      endsMid: r.ends_mid_sentence === true,
      unclear: (text.match(/\[unclear\]/gi) || []).length,
      flag: r.legibility === "poor" ? "poor" : r.legibility === "partial" ? "partial" : null,
      checked: false,
      at: now + pages.length,
    });
  }
  let kind = KINDS.includes(data.kind as ShotKind) ? (data.kind as ShotKind) : pages.length > 0 ? "page" : "other";
  if (pages.length === 2) kind = "spread";
  else if (pages.length === 1 && kind !== "cover") kind = "page";
  let problem = PROBLEMS.includes(data.problem as ShotProblem) ? (data.problem as ShotProblem) : null;
  if (pages.length === 0 && kind !== "cover" && !problem) problem = "no_text";
  return { kind, bookTitle: str(data.book_title, 160), author: str(data.author, 120), pages, problem };
}

/**
 * The model that will read pages: the reader's own "model for pictures" when
 * they chose one, else a fast, cheap, strong reader on whichever key they
 * have. Null when no key can see a picture.
 */
export function pickPageModel(s: TranscribeSettings): string | null {
  const usable = (id: string | undefined) => !!id && providerConfigured(modelProvider(id), s.keys);
  if (usable(s.visionModel)) return s.visionModel!;
  if (s.keys.geminiApiKey) return namespacedId("gemini", GEMINI_STARTER_MODEL);
  if (s.keys.apiKey) return DEFAULT_FIGURE_MODEL;
  if (usable(s.selectedModel)) return s.selectedModel!;
  return null;
}

export class TranscribeError extends Error {
  constructor(message: string, readonly code: "no_key" | "auth" | "credits" | "rate" | "network" | "model") {
    super(message);
    this.name = "TranscribeError";
  }
}

export const NO_KEY_MESSAGE =
  "Reading a page needs an AI key that can see pictures. Add a Gemini key (free) or an OpenRouter key in Settings → AI Models & Keys.";

export function makeTranscriber(settings: TranscribeSettings): Transcriber {
  return async (dataUrl, opts) => {
    const modelId = pickPageModel(settings);
    if (!modelId) throw new TranscribeError(NO_KEY_MESSAGE, "no_key");
    const { provider, adapter, localId } = resolveModel(modelId);
    let finish: string | undefined;
    let reply: string;
    try {
      reply = await adapter.completeChat({
        model: localId,
        apiKey: providerKey(provider, settings.keys),
        // A dense page is ~700 tokens of text; a spread twice that, plus JSON
        // and whatever a thinking model spends before its first byte.
        maxTokens: 6000,
        signal: opts.signal,
        extraBody: { temperature: 0 },
        onMeta: (m) => { finish = m.finish; },
        messages: [
          { role: "system", content: TRANSCRIBE_SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: opts.bookTitle ? `A photo from the book "${opts.bookTitle}". Transcribe it.` : "Transcribe this photo." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      if (e instanceof ProviderError) {
        const who = providerLabel(provider);
        const code = String(e.code);
        if (code === "no_key") throw new TranscribeError(NO_KEY_MESSAGE, "no_key");
        if (code === "auth") throw new TranscribeError(`${who} rejected your key. Check it in Settings.`, "auth");
        if (code === "credits") throw new TranscribeError(`${who} says this key is out of credit.`, "credits");
        if (code === "rate_limit" || e.status === 429) throw new TranscribeError(`${who} is busy. Wait a few seconds and try again.`, "rate");
        throw new TranscribeError(e.message || `${who} could not read the page.`, "model");
      }
      throw new TranscribeError("No connection. The page is kept here until you try again.", "network");
    }
    const out = parseTranscription(reply);
    // Cut off by the token limit: the JSON is incomplete, so say so rather
    // than keep half a page as if it were whole.
    if (out.pages.length === 0 && out.kind !== "cover" && finish === "length") {
      throw new TranscribeError("That page was too long to read in one go. Try one page per photo.", "model");
    }
    return out;
  };
}

export const SHOT_PROBLEM_COPY: Record<ShotProblem, string> = {
  blurry: "The words came out too blurry to read.",
  cut_off: "Part of the page is outside the photo.",
  dark: "The photo is too dark to read.",
  glare: "A glare is hiding the words.",
  no_text: "No page text was found in that photo.",
};
