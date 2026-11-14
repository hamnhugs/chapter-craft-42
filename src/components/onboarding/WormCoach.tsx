import React, { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import BookWorm, { type BookWormHandle } from "@/components/BookWorm";
import { useApp } from "@/context/AppContext";
import { markTipSeen, muteTips, noteProgress, pendingTip, useOnboarding, type TipId } from "@/lib/onboarding";
import { TAB_TIPS } from "@/lib/onboardingTips";
import { useSetupWizardOpen } from "@/components/SetupWizard";

/**
 * Bookworm explains a tab the first time it is opened.
 *
 * NOT A MODAL. There is no scrim and nothing is blocked: the page underneath
 * stays live, so the user can do the thing being described while it is being
 * described. A tour that locks the screen teaches people to hunt for the X
 * (NN/g found no task-success difference between people who read tutorials
 * and people who skipped them); one that sits beside the work can be ignored
 * at no cost.
 *
 * A step may point at a real control. The ring is drawn over the control's
 * measured box and re-measured while the tour is up, so it follows scrolling,
 * resizing and a layout that settles late. CSS anchor positioning would do
 * this without a line of script, but Safari and Firefox only shipped it
 * recently and the Android WebView this app also runs in trails Chrome — a
 * measured box works everywhere today.
 *
 * A tab counts as explained the moment its tour appears, not when it is
 * finished: leaving half-way must not bring it back.
 */

type Box = { top: number; left: number; width: number; height: number };

const sameBox = (a: Box | null, b: Box) =>
  !!a && Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;

function measure(selector: string): Box | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  let r: { top: number; left: number; right: number; bottom: number; width: number; height: number } = el.getBoundingClientRect();
  // A full-width row is ringed round what is in it, not round the whole row.
  if (el.getAttribute("data-tour-fit") === "content" && el.children.length) {
    const kids = [...el.children].map((c) => c.getBoundingClientRect()).filter((c) => c.width > 0);
    if (kids.length) {
      const left = Math.max(r.left, Math.min(...kids.map((c) => c.left)));
      const right = Math.min(r.right, Math.max(...kids.map((c) => c.right)));
      r = { top: r.top, bottom: r.bottom, height: r.height, left, right, width: right - left };
    }
  }
  if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > window.innerHeight) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const WormCoach: React.FC = () => {
  const { activeTab, activeBookId } = useApp();
  const ob = useOnboarding();
  const wizardOpen = useSetupWizardOpen();
  const [tour, setTour] = useState<{ id: TipId; step: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const worm = useRef<BookWormHandle>(null);

  useEffect(() => {
    if (activeTab === "wiki") noteProgress("openedNotebook");
  }, [activeTab]);

  // Open the tab's tour once the tab has had a moment to draw itself.
  // The Read tour is about a book on the desk; with none open it waits (the
  // empty reader already says where books come from).
  const waiting = wizardOpen || (activeTab === "viewer" && !activeBookId);
  const due = waiting ? null : pendingTip(ob, activeTab);
  useEffect(() => {
    setTour((t) => (t && (t.id !== activeTab || wizardOpen) ? null : t));
    if (!due) return;
    const timer = setTimeout(() => {
      markTipSeen(due);
      setTour({ id: due, step: 0 });
    }, 700);
    return () => clearTimeout(timer);
  }, [due, activeTab, wizardOpen]);

  const tip = tour ? TAB_TIPS[tour.id] : null;
  const step = tip && tour ? tip.steps[tour.step] : null;
  const target = step?.target;

  useEffect(() => {
    if (!target) { setBox(null); return; }
    const update = () => {
      const next = measure(target);
      setBox((prev) => (next ? (sameBox(prev, next) ? prev : next) : null));
    };
    update();
    const poll = setInterval(update, 250);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearInterval(poll);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [target]);

  const close = useCallback(() => setTour(null), []);
  const next = useCallback(() => {
    setTour((t) => (t && t.step < TAB_TIPS[t.id].steps.length - 1 ? { ...t, step: t.step + 1 } : null));
    worm.current?.nod();
  }, []);

  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tour, close]);

  if (!tour || !tip || !step) return null;

  const last = tour.step === tip.steps.length - 1;
  // Stay out of the way of what is being pointed at: a control in the lower
  // half of the window sends the card to the top.
  const atTop = !!box && box.top + box.height / 2 > window.innerHeight / 2;

  return (
    <>
      {box && (
        <div
          aria-hidden
          className="cc-coach-ring"
          style={{ top: box.top - 5, left: box.left - 5, width: box.width + 10, height: box.height + 10 }}
        />
      )}
      {/* An <aside>, not role="dialog": it takes no focus and blocks nothing,
          and the themes dress every [role=dialog] as a modal panel. */}
      <aside
        aria-label={tip.name}
        data-coach={tour.id}
        className={`cc-coach ${atTop ? "cc-coach-top" : "cc-coach-bottom"} flex items-end gap-2 rounded-2xl border border-outline-variant/30 bg-popover py-3 pl-2 pr-3 text-popover-foreground`}
      >
        <BookWorm ref={worm} mood={last ? "cheer" : "watch"} size={58} className="shrink-0 h-auto" />
        <div className="min-w-0 flex-1">
          <div aria-live="polite" className="pr-7">
            <p className="font-headline text-[15px] font-bold leading-tight text-foreground">{step.title}</p>
            <p className="mt-1 text-[13px] leading-snug text-on-surface-variant">{step.body}</p>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            {tip.steps.length > 1 && (
              <span className="flex items-center gap-1" aria-label={`Tip ${tour.step + 1} of ${tip.steps.length}`}>
                {tip.steps.map((_, i) => (
                  <span key={i} className={`h-1.5 rounded-full transition-all ${i === tour.step ? "w-4 bg-primary" : "w-1.5 bg-outline-variant/50"}`} />
                ))}
              </span>
            )}
            <span className="flex-1" />
            <button
              onClick={() => { muteTips(); close(); }}
              className="rounded px-1.5 py-1 text-[11px] font-medium text-on-surface-variant underline-offset-2 hover:text-foreground hover:underline"
            >
              No more tips
            </button>
            <Button size="sm" className="h-8 px-3.5" onClick={next}>
              {last ? "Got it" : "Next"}
            </Button>
          </div>
        </div>
        <button
          onClick={close}
          aria-label="Close tip"
          className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </aside>
    </>
  );
};

export default WormCoach;
