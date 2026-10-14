import React, { useEffect, useMemo, useState } from "react";
import { useChat } from "@/context/ChatContext";
import { deleteDesignTemplate, designTemplateThumb, listDesignTemplates, type DesignTemplate } from "@/lib/craftApps";
import { useTemplateMessage } from "@/lib/templatePicker";

/**
 * The DesignCraft template picker, shown inside a chat reply (templatePicker.ts
 * says when). Each saved layout is a picture with its name; picking one sends
 * 'Use my "<name>" template.' as the user's next message, so the AI opens it and
 * fills it with what the conversation is about. Templates are saved with the
 * bookmark beside each page in DesignCraft's Pages panel, or from the chat.
 *
 * The list is read live from the craft bridge, not from the tool result, so a
 * picker scrolled back to still shows what exists now.
 */

const PT_PER_IN = 72;
const inches = (pt: number) => (Math.round((pt / PT_PER_IN) * 10) / 10).toString().replace(/\.0$/, "");

const Thumb: React.FC<{ t: DesignTemplate }> = ({ t }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    designTemplateThumb(t.slug)
      .then((u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u); })
      .catch(() => live && setFailed(true));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [t.slug]);
  const ratio = t.width > 0 && t.height > 0 ? `${t.width} / ${t.height}` : "3 / 4";
  return (
    <div className="w-full rounded-md overflow-hidden bg-surface-container-highest/60 border border-outline-variant/30 flex items-center justify-center" style={{ aspectRatio: ratio }}>
      {url ? (
        <img src={url} alt={`The ${t.name} layout`} className="w-full h-full object-contain" draggable={false} />
      ) : (
        <span className={`material-symbols-outlined text-on-surface-variant/50 ${failed ? "" : "animate-pulse"}`}>{failed ? "image_not_supported" : "dashboard"}</span>
      )}
    </div>
  );
};

const TemplatePickerCard: React.FC = () => {
  const { sendMessage, isLoading } = useChat();
  const [templates, setTemplates] = useState<DesignTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    listDesignTemplates()
      .then((all) => live && setTemplates(all))
      .catch((e) => live && setError(e?.message || "Couldn't read your templates."));
    return () => { live = false; };
  }, [reload]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!templates) return [];
    return q ? templates.filter((t) => `${t.name} ${t.parts.join(" ")}`.toLowerCase().includes(q)) : templates;
  }, [templates, query]);

  const pick = (t: DesignTemplate) => {
    if (picked || isLoading) return;
    setPicked(t.name);
    void sendMessage(useTemplateMessage(t.name));
  };

  const remove = async (t: DesignTemplate) => {
    if (confirmDelete !== t.slug) { setConfirmDelete(t.slug); return; }
    setConfirmDelete(null);
    try {
      await deleteDesignTemplate(t.name);
      setTemplates((all) => (all || []).filter((x) => x.slug !== t.slug));
    } catch (e: any) {
      setError(e?.message || "Couldn't delete it.");
    }
  };

  return (
    <div className="rounded-xl border border-primary-container/40 bg-surface-container-high/50 p-3 mt-1 mb-2 flex flex-col gap-2.5 min-w-0" data-testid="template-picker">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary-container" aria-hidden="true">dashboard_customize</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Your layout templates</p>
          <p className="text-xs text-on-surface-variant">
            {picked ? <>Designing with <span className="font-semibold text-foreground">{picked}</span>…</> : "Pick one and the AI designs your page around it."}
          </p>
        </div>
        {templates && templates.length > 6 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search templates"
            className="w-28 sm:w-36 rounded-md bg-surface-container-highest/70 border border-outline-variant/40 px-2 py-1 text-xs text-foreground placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary-container"
          />
        )}
      </div>

      {error && (
        <div className="text-xs text-destructive flex items-center gap-2">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setReload((n) => n + 1)} className="shrink-0 underline text-on-surface-variant hover:text-foreground">Try again</button>
        </div>
      )}

      {!templates && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" aria-hidden="true">
          {[0, 1, 2].map((i) => <div key={i} className="rounded-md bg-surface-container-highest/50 animate-pulse" style={{ aspectRatio: "3 / 4" }} />)}
        </div>
      )}

      {templates && templates.length === 0 && (
        <div className="text-xs text-on-surface-variant flex flex-col gap-1">
          <p className="text-foreground font-medium">No templates yet.</p>
          <p>
            In DesignCraft, click the <span className="material-symbols-outlined text-[14px] align-[-3px]" aria-hidden="true">bookmark</span> beside a
            page in the Pages panel to save its layout. You can also ask here: "save this page as a template called …"
          </p>
        </div>
      )}

      {templates && templates.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {shown.map((t) => {
              const isPicked = picked === t.name;
              return (
                <div key={t.slug} className={`group relative rounded-lg p-1.5 border transition-colors ${isPicked ? "border-primary-container bg-primary-container/10" : "border-transparent hover:border-outline-variant/50 hover:bg-surface-container-highest/40"} ${picked && !isPicked ? "opacity-50" : ""}`}>
                  <button
                    type="button"
                    onClick={() => pick(t)}
                    disabled={!!picked || isLoading}
                    title={t.about}
                    className="w-full text-left flex flex-col gap-1 disabled:cursor-default"
                  >
                    <Thumb t={t} />
                    <span className="text-xs font-semibold text-foreground truncate">{t.name}</span>
                    <span className="text-[10px] text-on-surface-variant truncate">
                      {t.width && t.height ? `${inches(t.width)} × ${inches(t.height)} in` : ""}
                      {t.twoSided ? " · front & back" : (t.pages ?? 1) > 1 ? ` · ${t.pages} pages` : ""}
                      {t.parts.length ? ` · ${Array.from(new Set(t.parts)).join(", ")}` : ""}
                    </span>
                    {!picked && (
                      <span className="mt-0.5 text-[11px] font-semibold text-primary-container opacity-80 group-hover:opacity-100">Use this layout →</span>
                    )}
                    {isPicked && <span className="mt-0.5 text-[11px] font-semibold text-primary-container">Using this layout</span>}
                  </button>
                  {!picked && (
                    <button
                      type="button"
                      onClick={() => void remove(t)}
                      onBlur={() => setConfirmDelete((s) => (s === t.slug ? null : s))}
                      aria-label={confirmDelete === t.slug ? `Really delete ${t.name}` : `Delete ${t.name}`}
                      title={confirmDelete === t.slug ? "Click again to delete" : "Delete template"}
                      className={`absolute top-2.5 right-2.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold flex items-center gap-0.5 transition-opacity ${confirmDelete === t.slug ? "bg-destructive text-destructive-foreground opacity-100" : "bg-surface-container-high/90 text-on-surface-variant opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
                    >
                      <span className="material-symbols-outlined text-[13px]" aria-hidden="true">delete</span>
                      {confirmDelete === t.slug && "Delete?"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {shown.length === 0 && <p className="text-xs text-on-surface-variant">No template matches "{query}".</p>}
          {!picked && (
            <p className="text-[10px] text-on-surface-variant/70">
              Save more from DesignCraft: the <span className="material-symbols-outlined text-[12px] align-[-2px]" aria-hidden="true">bookmark</span> beside each page in the Pages panel.
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default TemplatePickerCard;
