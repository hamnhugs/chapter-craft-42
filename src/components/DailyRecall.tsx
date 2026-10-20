import React, { useEffect, useState, useCallback, useRef } from "react";
import { fetchDueReviews, recordReview, type DueReview } from "@/lib/knowledgeApi";
import { parseLocators } from "@/lib/cardLocators";
import { openPassage } from "@/lib/openPassage";
import { DAILY_RECALL_SIZE, locatorBookId, markDailyRecallDone } from "@/lib/dailyRecall";
import { useApp } from "@/context/AppContext";

// Daily recall: three notes a day, answer first, then check. Retrieval
// practice and spacing are the two study techniques with the strongest
// evidence (Dunlosky et al. 2013); answering BEFORE seeing the note is the
// part that does the work (Roediger & Karpicke 2006). Each answer links back
// to the page the note came from, so a miss is one tap from re-reading.
const DailyRecall: React.FC<{
  wikiId: string | null;
  open: boolean;
  onClose: () => void;
  onReviewed?: () => void;
}> = ({ wikiId, open, onClose, onReviewed }) => {
  const app = useApp();
  const [cards, setCards] = useState<DueReview[]>([]);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setCards([]); setIdx(0); setRevealed(false); setDone(0); setAnswer("");
    fetchDueReviews(wikiId, DAILY_RECALL_SIZE)
      .then((c) => { if (!cancelled) setCards(c); })
      .catch(() => { if (!cancelled) setCards([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, wikiId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const gradingRef = useRef(false);
  useEffect(() => { gradingRef.current = false; }, [idx]);
  const grade = useCallback((recalled: boolean) => {
    if (gradingRef.current) return;
    const card = cards[idx];
    if (!card) return;
    gradingRef.current = true;
    void recordReview(card.id, recalled).catch(() => { /* scheduling is best-effort */ });
    setDone((d) => d + 1);
    setRevealed(false);
    setAnswer("");
    setIdx((i) => i + 1);
    if (idx + 1 >= cards.length) {
      markDailyRecallDone();
      onReviewed?.();
    }
  }, [cards, idx, onReviewed]);

  if (!open) return null;

  const card = cards[idx];
  const finished = !loading && (cards.length === 0 || idx >= cards.length);
  const locators = card ? parseLocators(card.locators) : [];
  const firstLoc = locators[0];
  const bookId = firstLoc ? locatorBookId(firstLoc, app.books) : null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm motion-safe:animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl bg-surface-container-high border border-outline-variant/20 shadow-2xl p-5 sm:p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Daily recall"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary" aria-hidden>psychology_alt</span>
            <h3 className="font-headline font-bold text-lg text-foreground">Daily recall</h3>
          </div>
          <button onClick={onClose} aria-label="Close daily recall" className="text-on-surface-variant hover:text-foreground rounded-lg p-1">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-on-surface-variant py-10 text-center">Picking today's notes…</p>
        ) : finished ? (
          <div className="py-8 text-center">
            <span className="material-symbols-outlined text-4xl text-primary" aria-hidden>{done > 0 ? "task_alt" : "bedtime"}</span>
            <p className="text-sm text-foreground mt-3 font-medium">
              {done > 0 ? "That's today's recall done." : "Nothing to recall yet."}
            </p>
            <p className="text-xs text-on-surface-variant mt-1 max-w-xs mx-auto">
              {done > 0
                ? "Notes you remembered come back later and later; the ones you missed come back tomorrow."
                : "As Counsel saves notes from your reading and chats, three of them show up here each day."}
            </p>
            <button onClick={onClose} className="mt-5 px-5 py-2 rounded-xl bg-primary-container text-on-primary-container font-semibold text-sm active:scale-95 transition-transform">Done</button>
          </div>
        ) : card ? (
          <div>
            <div className="text-[11px] text-on-surface-variant mb-2 tabular-nums">{idx + 1} of {cards.length}</div>
            <div className="rounded-xl bg-surface-container-low p-4 sm:p-5">
              <h4 className="font-headline font-bold text-xl text-foreground mb-1">{card.title}</h4>
              {!revealed ? (
                <>
                  <p className="text-sm text-on-surface-variant mb-3">What do you remember about this? Answer before you look.</p>
                  <label htmlFor="daily-recall-answer" className="sr-only">Your answer</label>
                  <textarea
                    id="daily-recall-answer"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    rows={3}
                    placeholder="Type it, or just say it in your head"
                    className="w-full rounded-lg bg-surface-container border border-outline-variant/20 p-3 text-sm text-foreground placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </>
              ) : (
                <div className="space-y-3 max-h-[30vh] overflow-y-auto">
                  {answer.trim() && (
                    <p className="text-xs text-on-surface-variant border-l-2 border-outline-variant/40 pl-3 whitespace-pre-wrap">You said: {answer.trim()}</p>
                  )}
                  {card.hook && <p className="text-sm font-medium text-foreground">{card.hook}</p>}
                  <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{card.content}</p>
                  {firstLoc && (
                    <div className="flex items-center gap-2 flex-wrap text-xs text-on-surface-variant pt-1">
                      <span className="material-symbols-outlined text-sm" aria-hidden>bookmark</span>
                      <span className="min-w-0 truncate">
                        {firstLoc.book_title ? `${firstLoc.book_title} · ` : ""}p. {firstLoc.page}
                      </span>
                      {bookId && (
                        <button
                          onClick={() => { onClose(); openPassage(app, bookId, firstLoc.page); }}
                          className="text-primary font-semibold hover:underline"
                        >
                          Open page
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {revealed ? (
              <div className="flex gap-2 mt-4">
                <button onClick={() => grade(false)} className="flex-1 py-2.5 rounded-xl bg-surface-container-low text-on-surface-variant font-semibold text-sm border border-outline-variant/20 hover:bg-surface-container active:scale-95 transition-all">Missed it</button>
                <button onClick={() => grade(true)} className="flex-1 py-2.5 rounded-xl bg-primary-container text-on-primary-container font-semibold text-sm active:scale-95 transition-transform">I remembered</button>
              </div>
            ) : (
              <button onClick={() => setRevealed(true)} className="w-full mt-4 py-2.5 rounded-xl bg-primary/15 text-primary font-semibold text-sm hover:bg-primary/20 active:scale-95 transition-all">Show the note</button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default DailyRecall;
