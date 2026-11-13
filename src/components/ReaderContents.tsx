import React, { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import YoutubeTranscriptBadge from "@/components/YoutubeTranscriptBadge";
import type { BookDocument, Chapter } from "@/types/library";

interface ReaderContentsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  book: BookDocument;
  /** HTML books have sections and no page numbers. */
  isHtml: boolean;
  /** A sheet from the bottom on phones, from the left elsewhere. */
  side: "bottom" | "left";
  currentPage: number;
  numPages: number;
  currentChapterId: string | null;
  onSelect: (chapter: Chapter) => void;
  onRename: (chapterId: string, name: string) => void;
  onDelete: (chapterId: string) => void;
  /** New chapter from a page range (PDF only). The range lives in the reader
   *  so it survives closing the sheet to go and find the last page. */
  range: { from: number | null; to: number | null };
  onRangeChange: (range: { from: number | null; to: number | null }) => void;
  onCreate: (name: string) => Promise<boolean>;
  saving: boolean;
}

const rowBtn =
  "grid place-items-center w-11 h-11 shrink-0 rounded-full text-on-surface-variant hover:text-foreground hover:bg-surface-container-highest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";

/**
 * The reader's Contents: every chapter with its pages, the one being read
 * marked, rename and delete on each row, and making a chapter from a page
 * range. One place for what used to be a dropdown, a manage dialog, a
 * floating "current chapter" chip and the Chapter Isolation button.
 */
const ReaderContents: React.FC<ReaderContentsProps> = ({
  open, onOpenChange, book, isHtml, side, currentPage, numPages, currentChapterId,
  onSelect, onRename, onDelete, range, onRangeChange, onCreate, saving,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) return;
    setEditingId(null);
    setDeletingId(null);
  }, [open]);

  const saveEdit = () => {
    if (!editingId || !editName.trim()) return;
    onRename(editingId, editName.trim());
    setEditingId(null);
  };

  const { from, to } = range;
  const rangeOk = from != null && to != null && from >= 1 && to >= from && to <= numPages;
  const defaultName = rangeOk ? `Chapter ${book.chapters.length + 1} (pp. ${from}–${to})` : `Chapter ${book.chapters.length + 1}`;
  const num = (v: string) => {
    const n = Number(v);
    return v !== "" && Number.isInteger(n) ? n : null;
  };

  const pageField = (label: string, value: number | null, set: (n: number | null) => void) => (
    <div className="flex-1 min-w-0">
      <label className="block text-xs font-semibold text-on-surface-variant mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={numPages}
          value={value ?? ""}
          onChange={(e) => set(num(e.target.value))}
          aria-label={`${label} (1–${numPages})`}
          className="h-11 w-20 text-center"
        />
        <Button type="button" variant="outline" className="h-11 px-3 text-xs" onClick={() => set(currentPage)}>
          This page ({currentPage})
        </Button>
      </div>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={`flex flex-col gap-0 p-0 ${side === "bottom" ? "max-h-[85dvh] rounded-t-2xl" : "w-[min(92vw,24rem)] sm:max-w-sm"}`}
        style={side === "bottom" ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
      >
        <SheetHeader className="px-5 pt-5 pb-3 text-left space-y-1">
          <SheetTitle className="font-headline pr-8">Contents</SheetTitle>
          <SheetDescription className="truncate">{book.title || "Untitled"}</SheetDescription>
          <YoutubeTranscriptBadge book={book} />
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
          {book.chapters.length === 0 ? (
            <p className="px-3 py-6 text-sm text-on-surface-variant text-center">
              {isHtml ? "This book has no sections." : "No chapters yet. Make one from a range of pages below."}
            </p>
          ) : (
            <ul>
              {book.chapters.map((ch) => {
                const current = ch.id === currentChapterId;
                if (editingId === ch.id) {
                  return (
                    <li key={ch.id} className="flex items-center gap-2 px-2 py-1.5">
                      <Input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit();
                          if (e.key === "Escape") { e.stopPropagation(); setEditingId(null); }
                        }}
                        aria-label="Chapter name"
                        className="h-11"
                      />
                      <Button className="h-11" onClick={saveEdit} disabled={!editName.trim()}>Save</Button>
                      <Button className="h-11" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                    </li>
                  );
                }
                if (deletingId === ch.id) {
                  return (
                    <li key={ch.id} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="flex-1 min-w-0 truncate text-sm">Delete “{ch.name}”?</span>
                      <Button className="h-11" variant="destructive" onClick={() => { onDelete(ch.id); setDeletingId(null); }}>Delete</Button>
                      <Button className="h-11" variant="outline" onClick={() => setDeletingId(null)}>Keep</Button>
                    </li>
                  );
                }
                return (
                  <li key={ch.id} className={`flex items-center rounded-xl ${current ? "bg-primary/10" : ""}`}>
                    <button
                      type="button"
                      onClick={() => onSelect(ch)}
                      aria-current={current ? "true" : undefined}
                      className="flex-1 min-w-0 flex items-center gap-3 min-h-14 px-3 py-2 text-left rounded-xl hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    >
                      <span className="flex-1 min-w-0">
                        <span className={`block truncate text-sm ${current ? "font-bold text-primary" : "font-medium text-foreground"}`}>{ch.name}</span>
                        <span className="block text-xs text-on-surface-variant">
                          {isHtml ? `Section ${ch.startPage}` : ch.startPage === ch.endPage ? `Page ${ch.startPage}` : `Pages ${ch.startPage}–${ch.endPage}`}
                          {current && " · reading now"}
                        </span>
                      </span>
                    </button>
                    <button type="button" className={rowBtn} aria-label={`Rename ${ch.name}`} title="Rename" onClick={() => { setEditingId(ch.id); setEditName(ch.name); setDeletingId(null); }}>
                      <span className="material-symbols-outlined text-xl" aria-hidden>edit</span>
                    </button>
                    <button type="button" className={rowBtn} aria-label={`Delete ${ch.name}`} title="Delete" onClick={() => { setDeletingId(ch.id); setEditingId(null); }}>
                      <span className="material-symbols-outlined text-xl" aria-hidden>delete</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {!isHtml && (
          <form
            className="border-t border-outline-variant/30 px-5 py-4 space-y-3 bg-surface-container-low"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!rangeOk || saving) return;
              if (await onCreate(name.trim() || defaultName)) setName("");
            }}
          >
            <div>
              <p className="font-headline font-bold text-sm">New chapter from pages</p>
              <p className="text-xs text-on-surface-variant">Save a range of pages as a chapter. You can close this to find the last page; the range is kept.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {pageField("First page", from, (n) => onRangeChange({ from: n, to }))}
              {pageField("Last page", to, (n) => onRangeChange({ from, to: n }))}
            </div>
            <div className="flex items-center gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} aria-label="Chapter name" className="h-11" />
              <Button type="submit" className="h-11 shrink-0" disabled={!rangeOk || saving}>
                {saving ? "Saving…" : "Save chapter"}
              </Button>
            </div>
            {from != null && to != null && !rangeOk && (
              <p className="text-xs text-destructive">The last page must be {from} or later, up to {numPages}.</p>
            )}
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
};

export default ReaderContents;
