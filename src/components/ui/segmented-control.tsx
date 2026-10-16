import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Segmented control with a thumb that slides to the picked option and a softer
 * highlight that follows the pointer between options.
 *
 * Adapted from 21st.dev "Segmented Tabs" (@micka_design/tabs-base). The
 * original pulls in @base-ui/react, framer-motion and a dozen size/shape/
 * surface context files; this keeps the look — sliding thumb + fluid hover —
 * with measured rects and CSS transitions, and the app's Material Symbols.
 */
export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  icon?: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  className?: string;
  /** Tailwind classes for the label span — e.g. "hidden xl:inline". */
  labelClassName?: string;
  onOptionHover?: (id: T) => void;
}

type Rect = { left: number; width: number };

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  labelClassName,
  onOptionHover,
}: Props<T>) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [rects, setRects] = React.useState<Rect[]>([]);
  const [hovered, setHovered] = React.useState<number | null>(null);
  // The thumb only animates once it has a first position, so it doesn't
  // slide in from the left edge on mount.
  const [settled, setSettled] = React.useState(false);

  const measure = React.useCallback(() => {
    setRects(
      itemRefs.current.map((el) => (el ? { left: el.offsetLeft, width: el.offsetWidth } : { left: 0, width: 0 })),
    );
  }, []);

  React.useLayoutEffect(() => {
    measure();
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    // Labels appear/disappear at the xl breakpoint, fonts load late — both
    // change widths without a React render.
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    itemRefs.current.forEach((el) => el && ro.observe(el));
    return () => ro.disconnect();
  }, [measure, options.length]);

  React.useEffect(() => {
    if (rects.length && !settled) requestAnimationFrame(() => setSettled(true));
  }, [rects, settled]);

  const selected = options.findIndex((o) => o.id === value);
  const selRect = selected >= 0 ? rects[selected] : undefined;
  const hovRect = hovered !== null && hovered !== selected ? rects[hovered] : undefined;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const n = options.length;
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (selected + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    onChange(options[next].id);
    itemRefs.current[next]?.focus();
  };

  const slide = settled
    ? "transition-[transform,width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
    : "";

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHovered(null)}
      className={cn(
        "relative flex items-center rounded-xl border border-outline-variant/10 bg-surface-container-high p-1",
        className,
      )}
    >
      {hovRect && (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-y-1 left-0 rounded-lg bg-on-surface-variant/10", slide)}
          style={{ width: hovRect.width, transform: `translateX(${hovRect.left}px)` }}
        />
      )}
      {selRect && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-1 left-0 rounded-lg bg-primary/15 ring-1 ring-primary/20 shadow-sm",
            slide,
          )}
          style={{
            width: selRect.width,
            transform: `translateX(${selRect.left}px)`,
            opacity: hovRect ? 0.8 : 1,
          }}
        />
      )}
      {options.map((opt, i) => {
        const active = i === selected;
        return (
          <button
            key={opt.id}
            ref={(el) => (itemRefs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.id)}
            onMouseEnter={() => {
              setHovered(i);
              onOptionHover?.(opt.id);
            }}
            onFocus={() => setHovered(i)}
            onBlur={() => setHovered(null)}
            className={cn(
              "cc-tap-44 relative z-10 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              active ? "text-primary font-semibold" : "text-on-surface-variant hover:text-foreground",
            )}
          >
            {opt.icon && (
              <span
                className="material-symbols-outlined text-base"
                style={active ? { fontVariationSettings: "'FILL' 1" } : undefined}
                aria-hidden
              >
                {opt.icon}
              </span>
            )}
            <span className={labelClassName}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
