import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { bookContextStore, selectContextBooks } from "@/lib/chatBooks";
import { buildSearchPattern, normalizeSearchQuery, searchChaptersInMemory, approxPage } from "@/lib/bookSearch";
import {
  CARD_SCHEMA_MISSING_NOTE, mergeLocatorsViaRpc, parseLocators, QUOTE_MAX,
  type CardLocator,
} from "@/lib/cardLocators";
import type { KnowledgeEntry } from "@/lib/knowledgeApi";
import type { BookDocument } from "@/types/library";

/**
 * Book anchors on a wiki card (Card Catalog Stage 2, design §6).
 *
 * Anchored cards list their locators — the exact passages they cite. The
 * grandfathered corpus (every pre-Stage-2 entry) is unanchored; "Find in
 * book" is the BACKFILL ASSIST: a search over the entry's source book (else
 * the books in play, else the active book) using the same shared predicate
 * the chat tools use — the USER picks the passage that actually grounds the
 * card. Assisted, never automatic: a paraphrased entry the search can't find
 * stays honestly unanchored (report §9: accept partial coverage rather than
 * fake anchors). Merges go through the atomic server-side RPC; authorship is
 * NOT restamped (author = creator, not last editor).
 */

interface Hit {
  chapterId: string;
  chapterName: string;
  bookId: string;
  bookTitle: string;
  page: number;
  charStart: number;
  charEnd: number;
  excerpt: string;
  quote: string;
}

const EntryLocatorPanel: React.FC<{
  entry: KnowledgeEntry;
  onLocatorsChanged: (locators: CardLocator[]) => void;
}> = ({ entry, onLocatorsChanged }) => {
  const { books, activeBookId, loadChapterTextStrict } = useApp();
  const locators = useMemo(() => parseLocators((entry as any).locators), [entry]);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [saving, setSaving] = useState(false);

  const scopedBooks: BookDocument[] = useMemo(() => {
    const source = entry.source_book_id ? books.find((b) => b.id === entry.source_book_id) : undefined;
    if (source) return [source];
    const inPlay = selectContextBooks(books, bookContextStore.get(), activeBookId ?? null);
    if (inPlay.length > 0) return inPlay;
    const active = activeBookId ? books.find((b) => b.id === activeBookId) : undefined;
    return active ? [active] : [];
  }, [books, entry.source_book_id, activeBookId]);

  const runSearch = async () => {
    const normalized = normalizeSearchQuery(query);
    if (!normalized) {
      toast.error("Give the search at least a few words of the passage or topic.");
      return;
    }
    if (scopedBooks.length === 0) {
      toast.error("No book to search — open the source book or load a shelf first.");
      return;
    }
    setSearching(true);
    setHits(null);
    try {
      const found: Hit[] = [];
      const js = buildSearchPattern(normalized);
      let loaded = 0;
      for (const book of scopedBooks) {
        for (let i = 0; i < book.chapters.length; i++) {
          const chapter = book.chapters[i];
          let text = chapter.textContent || "";
          if (!text) {
            if (loaded >= 20) continue; // bounded fetches; the scope note below stays honest
            loaded++;
            const r = await loadChapterTextStrict(chapter.id);
            if (!r.ok) continue;
            text = r.text || "";
          }
          if (!text) continue;
          const { results } = searchChaptersInMemory([{ id: chapter.id, textContent: text }], js, 4);
          for (const res of results) {
            for (const m of res.matches) {
              found.push({
                chapterId: chapter.id,
                chapterName: chapter.name || `Chapter ${i + 1}`,
                bookId: book.id,
                bookTitle: book.title || "Untitled",
                page: approxPage(chapter, m.charStart, text.length),
                charStart: m.charStart,
                charEnd: m.charEnd,
                excerpt: m.excerpt,
                quote: text.slice(m.charStart, Math.min(m.charEnd, m.charStart + QUOTE_MAX)),
              });
              if (found.length >= 8) break;
            }
            if (found.length >= 8) break;
          }
          if (found.length >= 8) break;
        }
        if (found.length >= 8) break;
      }
      setHits(found);
    } finally {
      setSearching(false);
    }
  };

  const anchorTo = async (hit: Hit) => {
    setSaving(true);
    try {
      const loc: CardLocator = {
        chapter_id: hit.chapterId,
        char_start: hit.charStart,
        char_end: hit.charEnd,
        page: hit.page,
        quote: hit.quote,
        book_id: hit.bookId,
        book_title: hit.bookTitle.slice(0, 80),
        chapter_name: hit.chapterName.slice(0, 80),
      };
      const merged = await mergeLocatorsViaRpc(entry.id, [loc]);
      if (!merged.ok) {
        toast.error(merged.missingSchema ? CARD_SCHEMA_MISSING_NOTE : merged.error || "Couldn't anchor the card.");
        return;
      }
      toast.success(`Anchored to “${hit.chapterName}” p.${hit.page}.`);
      onLocatorsChanged(merged.locators || []);
      setFinding(false);
      setHits(null);
      setQuery("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-outline-variant/10 pt-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Book anchors</h3>
        {locators.length === 0 && !finding && (
          <Button size="sm" variant="outline" onClick={() => { setFinding(true); setQuery(entry.title); }}>
            <span className="material-symbols-outlined text-base mr-1" aria-hidden>manage_search</span>
            Find in book
          </Button>
        )}
      </div>
      {locators.length > 0 ? (
        <div className="space-y-2">
          {locators.map((l, i) => (
            <div key={`${l.chapter_id}:${l.char_start}`} className="p-3 rounded-xl bg-surface-container-high text-sm">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-on-surface-variant">
                <span className="material-symbols-outlined text-primary text-sm" aria-hidden>bookmark</span>
                <span>
                  {(l.book_title || "Book")} · {(l.chapter_name || "chapter")} · p.{l.page}
                  {l.stance ? ` · ${l.stance}` : ""}
                </span>
              </div>
              <p className="mt-1 text-on-surface-variant italic">“{l.quote}”</p>
            </div>
          ))}
        </div>
      ) : !finding ? (
        <p className="text-sm text-on-surface-variant">
          This card doesn't point into any book yet. Anchoring it to the passage it came from lets the
          assistant read the exact wording it cites.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Words from the passage this card came from…"
              onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
            />
            <Button size="sm" onClick={runSearch} disabled={searching}>{searching ? "Searching…" : "Search"}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setFinding(false); setHits(null); }}>Close</Button>
          </div>
          <p className="text-[11px] text-on-surface-variant">
            Searching {scopedBooks.length === 1 ? `“${scopedBooks[0].title}”` : `${scopedBooks.length} books`} — exact
            wording matches best; a paraphrased card may need a distinctive word from the original passage.
          </p>
          {hits !== null && hits.length === 0 && (
            <p className="text-sm text-on-surface-variant">
              No matches. The card may paraphrase the book — try a distinctive word from the original passage. If it
              can't be found, it stays an honest unanchored note.
            </p>
          )}
          {hits !== null && hits.length > 0 && (
            <div className="space-y-2">
              {hits.map((h, i) => (
                <button
                  key={`${h.chapterId}:${h.charStart}`}
                  onClick={() => anchorTo(h)}
                  disabled={saving}
                  className="w-full text-left p-3 rounded-xl bg-surface-container-high hover:bg-surface-container-highest transition-all"
                >
                  <div className="text-[11px] font-semibold text-on-surface-variant mb-1">
                    “{h.chapterName}” · p.{h.page} — click to anchor here
                  </div>
                  <p className="text-sm text-on-surface-variant line-clamp-2">…{h.excerpt.slice(0, 220)}…</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default EntryLocatorPanel;
