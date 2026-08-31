import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/context/AppContext";
import { anchorQuote, approxPage, normalizeSearchQuery } from "@/lib/bookSearch";
import {
  CARD_SCHEMA_MISSING_NOTE, findRegisterMatches, mergeLocatorsViaRpc,
  writeCardFields, QUOTE_MAX, type CardLocator, type RegisterMatch,
} from "@/lib/cardLocators";
import type { BookDocument } from "@/types/library";

/**
 * Capture flow (Card Catalog Stage 2, docs/stage2-card-pointers.md §6):
 * a selection in the reader becomes a CARD DRAFT with an auto-filled,
 * VERIFIED locator — the annotation is typed and generative (the learning-
 * science law: bare highlighting is a low-utility ritual; a claim in the
 * reader's own words anchored to the passage is an index entry).
 *
 * Anchoring laws:
 *  - candidate chapters = those whose page range contains the current page;
 *    the FIRST candidate (spine order) whose text anchors the selection wins
 *    (deterministic tie-break for boundary pages);
 *  - anchoring uses THE one shared predicate (bookSearch) — glyph-folded and
 *    whitespace-flexible, so the pdf.js text layer's rendering quirks don't
 *    defeat it;
 *  - selections longer than the search cap anchor by their leading slice —
 *    the locator points at the passage START, honestly (read_span's context
 *    window serves the surroundings);
 *  - no anchor ⇒ the dialog SAYS so and offers an unanchored save — never a
 *    fake anchor.
 *
 * Register law: before minting, the title is checked against the active
 *  wiki's register (normalized-exact) — adding a location to an existing
 *  card beats a new card. The USER clicking "add to existing" may merge into
 *  any card (unlike the chat tool, which never auto-merges into
 *  user-authored cards).
 */

interface CaptureQuoteDialogProps {
  open: boolean;
  onClose: () => void;
  book: BookDocument | null;
  page: number;
  selectionText: string;
}

type AnchorState =
  | { status: "working" }
  | { status: "anchored"; locator: CardLocator; chapterName: string }
  | { status: "unanchored"; reason: string };

const CaptureQuoteDialog: React.FC<CaptureQuoteDialogProps> = ({ open, onClose, book, page, selectionText }) => {
  const { activeWikiId, loadChapterTextStrict } = useApp();
  const [anchor, setAnchor] = useState<AnchorState>({ status: "working" });
  const [title, setTitle] = useState("");
  const [gloss, setGloss] = useState("");
  const [saving, setSaving] = useState(false);
  const [registerMatch, setRegisterMatch] = useState<RegisterMatch | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setGloss("");
    setRegisterMatch(null);
    setAnchor({ status: "working" });
    let cancelled = false;
    (async () => {
      if (!book) {
        setAnchor({ status: "unanchored", reason: "No book is open." });
        return;
      }
      const candidates = book.chapters
        .map((chapter, index) => ({ chapter, index }))
        .filter(({ chapter }) => page >= chapter.startPage && page <= chapter.endPage);
      if (candidates.length === 0) {
        setAnchor({
          status: "unanchored",
          reason: `Page ${page} isn't part of any isolated chapter yet — isolate this chapter first, or save the note unanchored.`,
        });
        return;
      }
      for (const { chapter, index } of candidates) {
        let text = chapter.textContent || "";
        if (!text) {
          const r = await loadChapterTextStrict(chapter.id);
          if (cancelled) return;
          if (!r.ok) continue; // transient — try the next candidate; the fall-through reason stays honest
          text = r.text || "";
        }
        if (!text) continue;
        const hit = anchorQuote(text, selectionText);
        if (!hit) continue;
        const chapterName = chapter.name || `Chapter ${index + 1}`;
        setAnchor({
          status: "anchored",
          chapterName,
          locator: {
            chapter_id: chapter.id,
            char_start: hit.start,
            char_end: hit.end,
            page: approxPage(chapter, hit.start, text.length),
            quote: text.slice(hit.start, Math.min(hit.end, hit.start + QUOTE_MAX)),
            book_id: book.id,
            book_title: (book.title || "Untitled").slice(0, 80),
            chapter_name: chapterName.slice(0, 80),
          },
        });
        return;
      }
      if (!cancelled) {
        setAnchor({
          status: "unanchored",
          reason:
            "Couldn't locate this selection in the chapter's extracted text (the reader's text layer and the extraction can differ). You can still save it as an unanchored note.",
        });
      }
    })();
    return () => { cancelled = true; };
  }, [open, book?.id, page, selectionText]);

  const quotePreview = (normalizeSearchQuery(selectionText) || selectionText).slice(0, 200);

  const createEntry = async (content: string): Promise<string> => {
    const { data, error } = await supabase.rpc("memory_entry_upsert" as any, {
      _id: null,
      _wiki_id: activeWikiId,
      _title: title.trim().slice(0, 200),
      _content: content,
      _entry_type: "concept",
      _tags: [],
      _confidence: 0.9,
    });
    if (error) throw error;
    return data as unknown as string;
  };

  const handleSave = async () => {
    if (!activeWikiId) {
      toast.error("Load a neuron first — the card needs a wiki to live in.");
      return;
    }
    if (!title.trim()) return;
    setSaving(true);
    try {
      const loc = anchor.status === "anchored" ? anchor.locator : null;
      // Register lookup before minting (once, at save): adding a location to
      // an existing card beats a new card. Surfaced as a choice, not done
      // silently — the user decides.
      // Surfaced whenever a card by this label exists — INCLUDING the
      // unanchored path. Skipping the check when the selection didn't anchor
      // meant the flow most likely to mint a duplicate was the one that
      // never warned about one (review finding); the "add location" action
      // is what needs an anchor, not the warning.
      if (!registerMatch) {
        const matches = await findRegisterMatches(activeWikiId, title, []);
        if (matches.length > 0) {
          setRegisterMatch(matches[0]);
          setSaving(false);
          return;
        }
      }
      const content = gloss.trim() || `"${quotePreview}"`;
      const entryId = await createEntry(content);
      if (loc) {
        const attach = await writeCardFields(entryId, { locators: [loc], author: "user" });
        if (!attach.written) {
          // The entry EXISTS — say exactly what didn't happen (design §1
          // partial-failure contract; a silent partial success would mint the
          // unanchored book note this flow exists to end).
          toast.warning(
            attach.missingSchema
              ? `Card saved UNANCHORED — ${CARD_SCHEMA_MISSING_NOTE}`
              : `Card saved, but the location could not be attached (${attach.error || "error"}) — use Find in book on the card to anchor it.`,
          );
        } else {
          toast.success(`Card anchored to "${anchor.status === "anchored" ? anchor.chapterName : ""}" p.${loc.page}`);
        }
      } else {
        await writeCardFields(entryId, { author: "user" });
        toast.success("Card saved (unanchored).");
      }
      try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch { /* best effort */ }
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Couldn't save the card.");
    } finally {
      setSaving(false);
    }
  };

  const handleAddToExisting = async () => {
    if (!registerMatch || anchor.status !== "anchored") return;
    setSaving(true);
    try {
      const merged = await mergeLocatorsViaRpc(registerMatch.id, [anchor.locator], registerMatch.locators);
      if (!merged.ok) {
        toast.error(merged.missingSchema ? CARD_SCHEMA_MISSING_NOTE : merged.error || "Couldn't add the location.");
        return;
      }
      // What LANDED, not what was sent: the merge dedupes and caps.
      if ((merged.added ?? 1) === 0) {
        toast.info(`"${registerMatch.title}" already points at that passage — nothing was added.`);
      } else {
        toast.success(`Added this location to "${registerMatch.title}" (${(merged.locators || []).length} total).`);
      }
      try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch { /* best effort */ }
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Couldn't add the location.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">Save quote to neuron</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <blockquote className="border-l-2 border-primary/40 pl-3 text-sm text-on-surface-variant max-h-24 overflow-y-auto whitespace-pre-wrap">
            {quotePreview}
            {selectionText.length > 200 ? "…" : ""}
          </blockquote>
          {anchor.status === "working" && (
            <p className="text-xs text-on-surface-variant animate-pulse">Locating this passage in the chapter text…</p>
          )}
          {anchor.status === "anchored" && (
            <p className="text-xs text-accent">
              Anchored: “{anchor.chapterName}” · p.{anchor.locator.page} · chars {anchor.locator.char_start}–{anchor.locator.char_end}
            </p>
          )}
          {anchor.status === "unanchored" && (
            <p className="text-xs text-destructive">{anchor.reason}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="cq-title">Card label</Label>
            <Input
              id="cq-title"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setRegisterMatch(null); }}
              placeholder="The claim in your own words — e.g. Desirable difficulty"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cq-gloss">Gloss (optional — why this passage matters)</Label>
            <Textarea
              id="cq-gloss"
              value={gloss}
              onChange={(e) => setGloss(e.target.value)}
              placeholder="One or two sentences in your own words. Left empty, the quote itself is saved."
              rows={2}
            />
          </div>
          {registerMatch && (
            <div className="rounded-lg border border-primary/30 bg-primary-container/20 p-3 text-sm space-y-2">
              <p>
                A card called <span className="font-semibold">“{registerMatch.title}”</span> already exists
                ({registerMatch.locators.length} location{registerMatch.locators.length === 1 ? "" : "s"}).
                Adding this location to it usually beats minting a duplicate.
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddToExisting} disabled={saving || anchor.status !== "anchored"}>
                  Add location to it
                </Button>
                <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
                  Create a separate card anyway
                </Button>
              </div>
              {anchor.status !== "anchored" && (
                <p className="text-[11px] text-on-surface-variant">
                  This selection isn't anchored, so there's no location to add — you can still create a separate card.
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          {!registerMatch && (
            <Button onClick={handleSave} disabled={saving || !title.trim() || anchor.status === "working"}>
              {saving ? "Saving…" : anchor.status === "anchored" ? "Save anchored card" : "Save unanchored note"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CaptureQuoteDialog;
