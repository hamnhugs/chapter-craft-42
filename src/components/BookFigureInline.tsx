import React, { useEffect, useState } from "react";
import GeneratedImage from "@/components/GeneratedImage";
import { resolveFigure, type ResolvedFigure } from "@/lib/bookFigures";

/**
 * A book figure placed inside a reply by a [[fig:<handle>]] marker.
 *
 * Resolved at render time from the handle alone, so a reply reloaded from
 * history shows its figures again with nothing extra stored. A handle that
 * resolves to nothing — invented by the model, or a figure since deleted —
 * renders nothing at all: a missing picture must not leave a broken frame or
 * raw marker text in the middle of an answer.
 */
const BookFigureInline: React.FC<{
  figureRef: string;
  /** Book title for the provenance line, when the book is in the library. */
  bookTitle?: (bookId: string) => string | undefined;
  /** Jump to the figure's page in the reader. */
  onOpenPage?: (bookId: string, page: number) => void;
}> = ({ figureRef, bookTitle, onOpenPage }) => {
  const [figure, setFigure] = useState<ResolvedFigure | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setFigure(undefined);
    resolveFigure(figureRef).then((f) => { if (!cancelled) setFigure(f); });
    return () => { cancelled = true; };
  }, [figureRef]);

  if (figure === null) return null;
  if (figure === undefined) {
    return <div className="my-2 h-40 w-56 max-w-full rounded-xl bg-surface-container-high/60 border border-outline-variant/20 animate-pulse" aria-hidden />;
  }

  const title = bookTitle?.(figure.bookId);
  return (
    <div className="my-2 not-prose" data-book-figure={figure.id}>
      <GeneratedImage storagePath={figure.storagePath} alt={figure.label} resizable />
      <div className="mt-1 text-[11px] leading-snug text-on-surface-variant/80 max-w-prose">
        <span className="text-foreground/85">{figure.label}</span>
        {" · "}
        {onOpenPage ? (
          <button
            type="button"
            onClick={() => onOpenPage(figure.bookId, figure.page)}
            className="underline decoration-dotted underline-offset-2 hover:text-primary"
            title="Open this page in the reader"
          >
            {title ? `${title}, p. ${figure.page}` : `p. ${figure.page}`}
          </button>
        ) : (
          <span>{title ? `${title}, p. ${figure.page}` : `p. ${figure.page}`}</span>
        )}
      </div>
    </div>
  );
};

export default BookFigureInline;
