import React, { useState } from "react";

// Building blocks for the Settings tab, shared by every settings card so the
// whole tab reads as one system.
//
// The pattern is the grouped list from macOS System Settings / iOS / Linear:
// a quiet group heading, then one card of rows separated by hairlines. Each
// row puts what the setting IS on the left (sentence-case label + at most one
// short line) and the control on the right, so the eye runs down a single
// column of labels and a single column of controls. Longer explanations sit
// behind an ⓘ toggle — they're there when wanted and silent otherwise
// (progressive disclosure: the default view holds only what most people need).

/** A titled card of rows. */
export const Group: React.FC<{
  title?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, footer, children, className = "" }) => (
  <div className={className}>
    {title && <h4 className="px-1 mb-1.5 text-xs font-semibold text-on-surface-variant">{title}</h4>}
    <div className="rounded-xl bg-surface-container-low border border-outline-variant/15 divide-y divide-outline-variant/10">
      {children}
    </div>
    {footer && <div className="px-1 mt-1.5 text-xs text-on-surface-variant">{footer}</div>}
  </div>
);

/** One setting: label (+ short description) left, control right. `stack`
 *  puts the control on its own full-width line (sliders, long inputs). */
export const Row: React.FC<{
  id?: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Extra explanation, revealed by the ⓘ button. */
  more?: React.ReactNode;
  stack?: boolean;
  danger?: boolean;
  /** Full-width content under the row (an opened editor). */
  after?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ id, label, description, more, stack, danger, after, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div id={id ? `set-${id}` : undefined} className="px-4 py-3 scroll-mt-4 cc-set-row">
      <div className={stack ? "space-y-2.5" : "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"}>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium flex items-center gap-1 ${danger ? "text-destructive" : "text-foreground"}`}>
            <span className="min-w-0">{label}</span>
            {more && (
              <button
                type="button"
                data-no-sticker
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label="More about this setting"
                className={`material-symbols-outlined text-[16px] leading-none rounded-full transition-colors ${
                  open ? "text-primary" : "text-on-surface-variant/50 hover:text-primary"
                }`}
              >
                info
              </button>
            )}
          </div>
          {description && <div className="text-xs text-on-surface-variant mt-0.5 leading-snug">{description}</div>}
        </div>
        {children !== undefined && children !== null && (
          <div className={stack ? "" : "shrink-0 flex items-center gap-2 sm:max-w-[60%]"}>{children}</div>
        )}
      </div>
      {more && open && (
        <div className="mt-2 text-xs text-on-surface-variant leading-relaxed rounded-lg bg-surface-container-high/60 px-3 py-2">
          {more}
        </div>
      )}
      {after && <div className="mt-3">{after}</div>}
    </div>
  );
};

/** A row that opens to reveal more controls — for whole sub-features that
 *  most visits never need (saved-model lists, diagnostics, generators). */
export const Disclosure: React.FC<{
  id?: string;
  icon?: string;
  label: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ id, icon, label, summary, defaultOpen, children }) => (
  <details id={id ? `set-${id}` : undefined} open={defaultOpen} className="group scroll-mt-4 cc-set-row">
    <summary className="list-none cursor-pointer select-none px-4 py-3 flex items-center gap-3 hover:bg-surface-container-high/40 rounded-xl transition-colors [&::-webkit-details-marker]:hidden">
      {icon && <span className="material-symbols-outlined text-lg text-on-surface-variant" aria-hidden>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {summary && <span className="block text-xs text-on-surface-variant mt-0.5 truncate">{summary}</span>}
      </span>
      <span className="material-symbols-outlined text-lg text-on-surface-variant transition-transform group-open:rotate-90" aria-hidden>
        chevron_right
      </span>
    </summary>
    <div className="px-4 pb-4 pt-1">{children}</div>
  </details>
);

/** Small status pill: "Saved", "Not set", "Free"… */
export const Pill: React.FC<{ tone?: "ok" | "muted" | "warn"; children: React.ReactNode }> = ({ tone = "muted", children }) => (
  <span
    className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${
      tone === "ok"
        ? "bg-primary-container/25 text-primary"
        : tone === "warn"
          ? "bg-destructive/15 text-destructive"
          : "bg-surface-container-highest text-on-surface-variant"
    }`}
  >
    {children}
  </span>
);

/** Compact select that sits on the right of a row. */
export const selectCls =
  "w-full sm:w-64 max-w-full bg-surface-container-high border border-outline-variant/15 rounded-lg text-sm text-foreground py-2 px-3 truncate focus:outline-none focus:ring-1 focus:ring-primary/40";

/** Pill-style choice of a few options (Spending, reply length, hemisphere). */
export function Choice<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex flex-wrap gap-1 p-1 rounded-lg bg-surface-container-high">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            data-no-sticker
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              active ? "bg-primary-container text-on-primary-container shadow-sm" : "text-on-surface-variant hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
