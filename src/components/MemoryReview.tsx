import React, { useEffect, useState, useCallback, useRef } from "react";
import { fetchDueReviews, recordReview, type DueReview } from "@/lib/knowledgeApi";

// Spaced retrieval-practice (Wave 2 of the memory plan): the two most robust
// findings in memory science — the spacing effect and the testing effect —
// operationalized as active recall. Surfaces memories just as they start to
// fade and asks you to recall them; a successful effortful recall strengthens
// storage most (desirable difficulty) and pushes the next review further out.
const MemoryReview: React.FC<{
  wikiId: string | null;
  open: boolean;
  onClose: () => void;
  onReviewed?: () => void;
}> = ({ wikiId, open, onClose, onReviewed }) => {
  const [cards, setCards] = useState<DueReview[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setCards([]); setIdx(0); setRevealed(false); setDone(0);
    fetchDueReviews(wikiId, 15)
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
  useEffect(() => { gradingRef.current = false; }, [idx]); // re-arm when we advance
  const grade = useCallback((recalled: boolean) => {
    if (gradingRef.current) return; // ignore a rapid double-click on the same card
    const card = cards[idx];
    if (!card) return;
    gradingRef.current = true;
    // Advance immediately (so a double-click can't grade the same card twice);
    // record the attempt in the background, best-effort.
    void recordReview(card.id, recalled).catch(() => { /* scheduled best-effort */ });
    setDone((d) => d + 1);
    setRevealed(false);
    setIdx((i) => i + 1);
    if (idx + 1 >= cards.length) onReviewed?.();
  }, [cards, idx, onReviewed]);

  if (!open) return null;

  const card = cards[idx];
  const finished = !loading && (cards.length === 0 || idx >= cards.length);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm motion-safe:animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-surface-container-high border border-outline-variant/20 shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Memory review"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary" aria-hidden>fitness_center</span>
            <h3 className="font-headline font-bold text-lg text-foreground">Memory review</h3>
          </div>
          <button onClick={onClose} aria-label="Close review" className="text-on-surface-variant hover:text-foreground rounded-lg p-1">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-on-surface-variant py-10 text-center">Finding memories due for review…</p>
        ) : finished ? (
          <div className="py-8 text-center">
            <span className="material-symbols-outlined text-4xl text-primary" aria-hidden>{done > 0 ? "task_alt" : "bedtime"}</span>
            <p className="text-sm text-foreground mt-3 font-medium">
              {done > 0 ? `Reviewed ${done} ${done === 1 ? "memory" : "memories"}. Nicely done.` : "Nothing due for review right now."}
            </p>
            <p className="text-xs text-on-surface-variant mt-1 max-w-xs mx-auto">
              {done > 0
                ? "Recalling them made them more durable — they'll come back at wider intervals."
                : "Memories resurface here as they start to fade, so you catch them just in time."}
            </p>
            <button onClick={onClose} className="mt-5 px-5 py-2 rounded-xl bg-primary-container text-on-primary-container font-semibold text-sm active:scale-95 transition-transform">Done</button>
          </div>
        ) : card ? (
          <div>
            <div className="text-[11px] text-on-surface-variant mb-2 tabular-nums capitalize">{idx + 1} / {cards.length} · {card.entry_type}</div>
            <div className="rounded-xl bg-surface-container-low p-5 min-h-[150px] max-h-[55vh] overflow-y-auto flex flex-col">
              <h4 className="font-headline font-bold text-xl text-foreground mb-3">{card.title}</h4>
              {revealed ? (
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{card.content}</p>
              ) : (
                <p className="text-sm text-on-surface-variant italic mt-auto">Try to recall this from memory — then reveal to check.</p>
              )}
            </div>
            {revealed ? (
              <div className="flex gap-2 mt-4">
                <button onClick={() => grade(false)} className="flex-1 py-2.5 rounded-xl bg-surface-container-low text-on-surface-variant font-semibold text-sm border border-outline-variant/20 hover:bg-surface-container active:scale-95 transition-all">Missed it</button>
                <button onClick={() => grade(true)} className="flex-1 py-2.5 rounded-xl bg-primary-container text-on-primary-container font-semibold text-sm active:scale-95 transition-transform">I recalled it</button>
              </div>
            ) : (
              <button onClick={() => setRevealed(true)} className="w-full mt-4 py-2.5 rounded-xl bg-primary/15 text-primary font-semibold text-sm hover:bg-primary/20 active:scale-95 transition-all">Reveal</button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default MemoryReview;
