import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import { safeUrlTransform, safeMarkdownComponents } from "@/lib/markdownSafety";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import type { ResponseBlock } from "@/lib/responseBlocks";

// Renders the assistant's validated structured blocks with trusted components.
// No model-authored HTML is ever injected — text fields go through react-markdown.

const PALETTE = ["#7C3AED", "#06B6D4", "#F59E0B", "#EF4444", "#10B981", "#6366F1"];

const Md: React.FC<{ children: string }> = ({ children }) => (
  <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1"><ReactMarkdown urlTransform={safeUrlTransform} components={safeMarkdownComponents}>{children}</ReactMarkdown></div>
);

const CALLOUT_STYLES: Record<string, { wrap: string; icon: string; symbol: string }> = {
  info:    { wrap: "border-primary-container/40 bg-primary-container/10", icon: "text-primary-container", symbol: "info" },
  success: { wrap: "border-green-500/40 bg-green-500/10", icon: "text-green-500", symbol: "check_circle" },
  warning: { wrap: "border-amber-500/40 bg-amber-500/10", icon: "text-amber-500", symbol: "warning" },
  danger:  { wrap: "border-destructive/40 bg-destructive/10", icon: "text-destructive", symbol: "error" },
  tip:     { wrap: "border-cyan-500/40 bg-cyan-500/10", icon: "text-cyan-500", symbol: "lightbulb" },
};

const ChartBlock: React.FC<{ block: ResponseBlock & { type: "chart" } }> = ({ block }) => {
  const { chart, data, xKey, series } = block;
  const common = { data, margin: { top: 8, right: 12, bottom: 4, left: -8 } };
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-outline-variant/20" />
      <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="currentColor" className="text-on-surface-variant" />
      <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-on-surface-variant" />
      <Tooltip contentStyle={{ background: "hsl(var(--surface-container-high, 0 0% 15%))", border: "none", borderRadius: 8, fontSize: 12 }} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </>
  );
  return (
    <div className="w-full h-64 rounded-xl bg-surface-container-high/50 border border-outline-variant/10 p-3">
      <ResponsiveContainer width="100%" height="100%">
        {chart === "bar" ? (
          <BarChart {...common}>{axes}{series.map((s, i) => <Bar key={s} dataKey={s} fill={PALETTE[i % PALETTE.length]} radius={[4, 4, 0, 0]} />)}</BarChart>
        ) : chart === "line" ? (
          <LineChart {...common}>{axes}{series.map((s, i) => <Line key={s} type="monotone" dataKey={s} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />)}</LineChart>
        ) : chart === "area" ? (
          <AreaChart {...common}>{axes}{series.map((s, i) => <Area key={s} type="monotone" dataKey={s} stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]} fillOpacity={0.25} />)}</AreaChart>
        ) : (
          <PieChart>
            <Tooltip contentStyle={{ background: "hsl(var(--surface-container-high, 0 0% 15%))", border: "none", borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Pie data={data} dataKey={series[0]} nameKey={xKey} cx="50%" cy="50%" outerRadius={80} label>
              {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
          </PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
};

const QuizBlock: React.FC<{ block: ResponseBlock & { type: "quiz" } }> = ({ block }) => {
  const [picked, setPicked] = useState<number | null>(null);
  const revealed = picked !== null;
  return (
    <div className="rounded-xl bg-surface-container-high/50 border border-outline-variant/10 p-4">
      <div className="font-semibold text-sm mb-3 text-foreground"><Md>{block.question}</Md></div>
      <div className="flex flex-col gap-2">
        {block.options.map((opt, i) => {
          const correct = i === block.answerIndex;
          const state = !revealed ? "" : correct ? "border-green-500/60 bg-green-500/10" : i === picked ? "border-destructive/60 bg-destructive/10" : "opacity-60";
          return (
            <button
              key={i}
              disabled={revealed}
              onClick={() => setPicked(i)}
              className={`text-left text-sm px-3 py-2 rounded-lg border transition-colors ${state || "border-outline-variant/20 hover:border-primary-container/50 hover:bg-surface-container-high"}`}
            >
              <span className="font-mono text-xs text-on-surface-variant mr-2">{String.fromCharCode(65 + i)}</span>
              {opt}
              {revealed && correct && <span className="material-symbols-outlined text-green-500 text-base align-middle ml-2">check</span>}
            </button>
          );
        })}
      </div>
      {revealed && block.explanation && (
        <div className="mt-3 text-xs text-on-surface-variant border-t border-outline-variant/10 pt-2"><Md>{block.explanation}</Md></div>
      )}
    </div>
  );
};

const Block: React.FC<{ block: ResponseBlock }> = ({ block }) => {
  switch (block.type) {
    case "callout": {
      const s = CALLOUT_STYLES[block.variant] || CALLOUT_STYLES.info;
      return (
        <div className={`rounded-xl border p-3 flex gap-3 ${s.wrap}`}>
          <span className={`material-symbols-outlined text-lg shrink-0 ${s.icon}`}>{s.symbol}</span>
          <div className="min-w-0">
            {block.title && <div className="font-semibold text-sm mb-0.5 text-foreground">{block.title}</div>}
            <Md>{block.body}</Md>
          </div>
        </div>
      );
    }
    case "card":
      return (
        <div className="rounded-xl bg-surface-container-high/50 border border-outline-variant/10 p-4">
          <div className="font-headline font-bold text-sm mb-1 text-foreground">{block.title}</div>
          <Md>{block.body}</Md>
          {block.footer && <div className="mt-2 text-xs text-on-surface-variant border-t border-outline-variant/10 pt-2">{block.footer}</div>}
        </div>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border border-outline-variant/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-high/60">
                {block.columns.map((c, i) => <th key={i} className="text-left font-semibold px-3 py-2 text-on-surface-variant">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="border-t border-outline-variant/10">
                  {block.columns.map((_, ci) => <td key={ci} className="px-3 py-2 align-top">{row[ci] ?? ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "chart":
      return <ChartBlock block={block as ResponseBlock & { type: "chart" }} />;
    case "timeline":
      return (
        <div className="rounded-xl bg-surface-container-high/50 border border-outline-variant/10 p-4">
          <ol className="relative border-l border-outline-variant/30 ml-2">
            {block.items.map((it, i) => (
              <li key={i} className="ml-4 pb-3 last:pb-0">
                <span className="absolute -left-[5px] w-2.5 h-2.5 rounded-full bg-primary-container" />
                <div className="text-[11px] font-semibold uppercase tracking-wide text-primary-container">{it.when}</div>
                <div className="text-sm text-foreground">{it.label}</div>
              </li>
            ))}
          </ol>
        </div>
      );
    case "steps":
      return (
        block.ordered ? (
          <ol className="rounded-xl bg-surface-container-high/50 border border-outline-variant/10 p-4 list-decimal list-inside space-y-1 text-sm marker:text-primary-container marker:font-bold">
            {block.items.map((it, i) => <li key={i} className="pl-1">{it}</li>)}
          </ol>
        ) : (
          <ul className="rounded-xl bg-surface-container-high/50 border border-outline-variant/10 p-4 space-y-1 text-sm">
            {block.items.map((it, i) => <li key={i} className="flex gap-2"><span className="material-symbols-outlined text-base text-primary-container">check</span>{it}</li>)}
          </ul>
        )
      );
    case "keyValue":
      return (
        <div className="rounded-xl bg-surface-container-high/50 border border-outline-variant/10 p-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {block.pairs.map((p, i) => (
            <React.Fragment key={i}>
              <div className="font-semibold text-on-surface-variant">{p.key}</div>
              <div className="text-foreground">{p.value}</div>
            </React.Fragment>
          ))}
        </div>
      );
    case "comparison":
      return (
        <div className="overflow-x-auto rounded-xl border border-outline-variant/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-high/60">
                <th className="px-3 py-2" />
                {block.columns.map((c, i) => <th key={i} className="text-left font-semibold px-3 py-2 text-primary">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="border-t border-outline-variant/10">
                  <td className="px-3 py-2 font-semibold text-on-surface-variant align-top">{row.label}</td>
                  {block.columns.map((_, ci) => <td key={ci} className="px-3 py-2 align-top"><Md>{row.cells[ci] ?? ""}</Md></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quiz":
      return <QuizBlock block={block as ResponseBlock & { type: "quiz" }} />;
    default:
      return null;
  }
};

const ResponseBlocks: React.FC<{ blocks: ResponseBlock[] }> = ({ blocks }) => {
  if (!blocks?.length) return null;
  return <div className="flex flex-col gap-3 mt-1">{blocks.map((b, i) => <Block key={i} block={b} />)}</div>;
};

export default ResponseBlocks;
