/**
 * DesignStudioPanel — the chat's design UI for DesignCraft.
 *
 * Opens beside the chat when Counsel works in DesignCraft (or from the tools
 * sheet). It shows the page as it is now and puts the common moves one click
 * away: start from a saved template (with its screenshot), save the page as a
 * template, switch the look, edit each part's words and colour, swap the
 * picture, start a page size, export. Every change goes through runCraftTool —
 * the chat's own craft tool — so a button and a typed request do the same
 * thing, and the AI keeps working on the same page afterwards.
 *
 * Docked as a column on md+ (the chat stays usable beside it); full screen on
 * phones. No iframe inside, so the class swap below is the only geometry.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { useApp } from "@/context/AppContext";
import {
  PAGE_LOOKS, designState, designTemplates, runCraftTool, templateThumbUrl,
  type DesignState, type DesignTemplate,
} from "@/lib/craftApps";
import { fetchImageById, getSignedImageUrl, searchImages } from "@/lib/imageGen";

const LOOK_INFO: Record<string, string> = {
  editorial: "Magazine page, big serif headline",
  bold: "Photo over a deep colour block, huge caps",
  cinematic: "Full-page photo, movie-poster title",
  swiss: "Grid, giant tight sans, one accent",
  classic: "Cream, centred serif, double border",
  minimal: "Quiet, light type, lots of space",
  split: "Photo half, colour panel half",
  pop: "Bright field, heavy caps, tilted photo",
};
const TEXT_ROLES = ["headline", "subhead", "body", "caption", "footer"] as const;
const ROLE_LABEL: Record<string, string> = { headline: "Headline", subhead: "Subhead", body: "Body text", caption: "Caption", footer: "Footer" };
const PAGE_SIZES: [string, string][] = [["Letter", "Flyer · 8.5×11"], ["A4", "Flyer · A4"], ["Poster", "Poster · 18×24"], ["Tabloid", "Tabloid · 11×17"], ["Square", "Square post"], ["Story", "Story · 9:16"], ["Instagram", "Portrait post · 4:5"], ["Book", "Book cover · 6×9"]];
type Tab = "templates" | "looks" | "content" | "page";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Changes when the chat touched DesignCraft, so the preview follows it. */
  refreshKey: string | number;
  /** Ask Counsel in the chat (the composer's send). */
  onAsk: (text: string) => void;
  currentModel?: string;
}

const sym = (name: string, cls = "") => <span className={`material-symbols-outlined text-[18px] leading-none ${cls}`} aria-hidden>{name}</span>;

const DesignStudioPanel: React.FC<Props> = ({ open, onClose, refreshKey, onAsk, currentModel }) => {
  const { books, addBook, loadChapterText } = useApp();
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem("design_studio_tab") as Tab) || "templates");
  const [state, setState] = useState<DesignState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [templates, setTemplates] = useState<DesignTemplate[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [saveName, setSaveName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState<{ id: string; url: string; prompt?: string }[] | null>(null);
  const thumbsRef = useRef<Record<string, string>>({});
  // The colour well fires on every drag step; apply once it settles.
  const colourTimer = useRef<number | undefined>(undefined);

  useEffect(() => { try { localStorage.setItem("design_studio_tab", tab); } catch { /* private window */ } }, [tab]);

  const deps = useMemo(() => ({ books, addBook, loadChapterText, currentModel, fetchImage: fetchImageById }), [books, addBook, loadChapterText, currentModel]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await designState();
      setState(s);
      setDrafts({});
    } catch (e: any) {
      setState({ installed: false, window_open: false, document: null });
      if (open) toast.error(e?.message || "Couldn't reach DesignCraft");
    } finally { setLoading(false); }
  }, [open]);

  const loadTemplates = useCallback(async () => {
    try {
      const list = await designTemplates();
      setTemplates(list);
      for (const t of list) {
        const key = `${t.slug}@${t.created}`;
        if (thumbsRef.current[key]) continue;
        const url = await templateThumbUrl(t.slug);
        if (url) { thumbsRef.current[key] = url; setThumbs((m) => ({ ...m, [key]: url })); }
      }
    } catch { /* bridge down: the state banner says so */ }
  }, []);

  useEffect(() => { if (open) { refresh(); loadTemplates(); } }, [open, refreshKey, refresh, loadTemplates]);
  useEffect(() => () => { Object.values(thumbsRef.current).forEach((u) => URL.revokeObjectURL?.(u)); }, []);

  /** One craft action, the chat's way; then the page again. */
  const act = useCallback(async (label: string, args: any, after?: () => void) => {
    setBusy(label);
    try {
      const r = await runCraftTool({ app: "designcraft", ...args }, deps as any);
      if (!r.event.ok) toast.error(r.result?.error || r.event.summary);
      else { toast.success(r.event.summary); after?.(); }
      await refresh();
      if (args.action === "save_template" || args.action === "use_template") await loadTemplates();
    } finally { setBusy(null); }
  }, [deps, refresh, loadTemplates]);

  const page = state?.page;
  const items = page?.items || [];
  const textOf = (role: string) => items.find((i) => i.role === role)?.text ?? "";
  const placeholderIds = new Set((page?.placeholders || []).map((p) => p.id));
  const current = page?.template ? `Template: ${page.template}` : page?.look ? `Look: ${page.look}` : null;

  const openPicker = async () => {
    try {
      const rows = await searchImages(undefined, 24);
      const withUrls = await Promise.all(rows.map(async (r: any) => ({ id: r.id, prompt: r.prompt, url: await getSignedImageUrl(r.storage_path).catch(() => "") })));
      setPicker(withUrls.filter((r) => r.url));
    } catch (e: any) { toast.error(e?.message || "Couldn't load your images"); }
  };

  return (
    <aside
      className={open
        ? "fixed inset-0 z-50 flex flex-col bg-surface-container-low md:static md:z-auto md:w-[26rem] lg:w-[30rem] md:flex-shrink-0 md:border-l md:border-outline-variant/20 h-full"
        : "hidden"}
      aria-label="Design studio"
      data-testid="design-studio"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/20">
        {sym("design_services", "text-primary")}
        <div className="flex-1 min-w-0">
          <div className="font-headline font-semibold text-sm">Design studio</div>
          <div className="text-[11px] text-on-surface-variant truncate">
            {state?.document ? `${state.document}${state.pages && state.pages > 1 ? ` · page ${(page?.page ?? 0) + 1} of ${state.pages}` : ""}${current ? ` · ${current}` : ""}` : state && !state.installed ? "DesignCraft isn't installed" : "No document open yet"}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => { refresh(); loadTemplates(); }} title="Refresh" aria-label="Refresh">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : sym("refresh")}</Button>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close" aria-label="Close design studio">{sym("close")}</Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Preview */}
        <div className="px-4 pt-3">
          <div className="rounded-lg bg-surface-container-high border border-outline-variant/20 flex items-center justify-center min-h-[180px] overflow-hidden relative">
            {state?.preview ? (
              <img src={state.preview} alt="The page as it is now" className="max-h-[360px] w-auto object-contain shadow-md my-3" />
            ) : (
              <div className="text-center text-xs text-on-surface-variant p-6 space-y-2">
                <div>{state?.document ? "This page is empty." : "Pick a template or a page size to start."}</div>
                {!state?.window_open && state?.installed && (
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("Open", { action: "open" })}>{sym("open_in_new", "mr-1")}Open DesignCraft</Button>
                )}
              </div>
            )}
            {busy && <div className="absolute inset-0 bg-background/60 flex items-center justify-center text-xs gap-2"><Loader2 className="h-4 w-4 animate-spin" />{busy}…</div>}
          </div>
          {!!page?.placeholders?.length && (
            <button className="mt-2 w-full text-left text-[11px] px-2.5 py-1.5 rounded-md bg-secondary-container text-on-secondary-container" onClick={() => setTab("content")}>
              {sym("edit_note", "align-middle mr-1 text-[14px]")}{page.placeholders.length} part{page.placeholders.length === 1 ? "" : "s"} still show the template's own content: {page.placeholders.map((p) => p.role).join(", ")}. Edit them in Content.
            </button>
          )}
          {!!page?.issues?.length && <div className="mt-2 text-[11px] text-destructive">{page.issues.join(" ")}</div>}
        </div>

        {/* Tabs */}
        <div className="px-4 pt-3 flex gap-1" role="tablist">
          {(["templates", "looks", "content", "page"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`flex-1 text-xs font-semibold py-1.5 rounded-md capitalize transition-colors ${tab === t ? "bg-primary text-primary-foreground" : "text-on-surface-variant hover:bg-surface-container-high"}`}>
              {t}
            </button>
          ))}
        </div>

        <div className="px-4 py-3 space-y-3">
          {tab === "templates" && (
            <>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const n = saveName.trim(); if (n) act("Saving template", { action: "save_template", title: n }, () => setSaveName("")); }}>
                <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name this design…" className="h-8 text-xs" disabled={!state?.document} />
                <Button type="submit" size="sm" disabled={!saveName.trim() || !state?.document || !!busy} title="Save the current page, with a screenshot, as a template">{sym("bookmark_add", "mr-1")}Save</Button>
              </form>
              {templates.length === 0 ? (
                <p className="text-xs text-on-surface-variant">No templates yet. Design a page you like, name it above, and it will be here to start the next document from.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {templates.map((t) => {
                    const thumb = thumbs[`${t.slug}@${t.created}`];
                    return (
                      <div key={t.slug} className="group rounded-lg border border-outline-variant/20 bg-surface-container overflow-hidden flex flex-col">
                        <button className="aspect-[3/4] bg-surface-container-high flex items-center justify-center overflow-hidden" disabled={!!busy}
                          onClick={() => act(`Starting from ${t.name}`, { action: "use_template", title: t.name })} title={`Start a new document from "${t.name}"`}>
                          {thumb ? <img src={thumb} alt={`${t.name} template`} className="w-full h-full object-contain" /> : sym("image", "text-on-surface-variant")}
                        </button>
                        <div className="p-2 flex items-start gap-1">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold truncate">{t.name}</div>
                            <div className="text-[10px] text-on-surface-variant truncate">{[...new Set(t.parts)].join(" · ")}</div>
                          </div>
                          <button className="opacity-60 hover:opacity-100 p-0.5" title={`Delete "${t.name}"`} aria-label={`Delete ${t.name}`} disabled={!!busy}
                            onClick={() => { if (window.confirm(`Delete the "${t.name}" template? This can't be undone.`)) act("Deleting", { action: "use_template", title: t.name, options: { delete: true } }); }}>
                            {sym("delete", "text-[16px]")}
                          </button>
                        </div>
                        <Button size="sm" variant="secondary" className="m-2 mt-0 h-7 text-xs" disabled={!!busy} onClick={() => act(`Starting from ${t.name}`, { action: "use_template", title: t.name })}>Use</Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {tab === "looks" && (
            <div className="grid grid-cols-2 gap-3">
              {PAGE_LOOKS.map((l) => (
                <button key={l} disabled={!!busy || !items.length} onClick={() => act(`Applying ${l}`, { action: "send", look: l })}
                  className={`text-left rounded-lg border overflow-hidden bg-surface-container transition-colors disabled:opacity-50 ${page?.look === l && !page?.template ? "border-primary ring-1 ring-primary" : "border-outline-variant/20 hover:border-primary/50"}`}
                  title={items.length ? `Redesign the page: ${l}` : "Put something on the page first"}>
                  <img src={`/design-looks/${l}.jpg`} alt="" className="w-full aspect-[3/4] object-cover" loading="lazy" />
                  <div className="p-2">
                    <div className="text-xs font-semibold capitalize">{l}</div>
                    <div className="text-[10px] text-on-surface-variant leading-tight">{LOOK_INFO[l]}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {tab === "content" && (
            <div className="space-y-3">
              {TEXT_ROLES.map((role) => {
                const item = items.find((i) => i.role === role);
                const value = drafts[role] ?? textOf(role);
                const changed = drafts[role] != null && drafts[role] !== textOf(role);
                return (
                  <div key={role} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-semibold flex-1" htmlFor={`ds-${role}`}>
                        {ROLE_LABEL[role]}
                        {item && placeholderIds.has(item.id) && <span className="ml-1.5 text-[10px] font-normal text-primary">template text</span>}
                      </label>
                      {item && (
                        <label className="flex items-center gap-1 text-[10px] text-on-surface-variant cursor-pointer" title="Colour">
                          <input type="color" className="w-5 h-5 rounded border-0 p-0 bg-transparent cursor-pointer" defaultValue={String(item.set_by_hand?.color || "#222222")}
                            onChange={(e) => { const c = e.target.value; window.clearTimeout(colourTimer.current); colourTimer.current = window.setTimeout(() => act(`Colouring the ${role}`, { action: "send", role, options: { color: c } }), 450); }} />
                        </label>
                      )}
                      <button className="text-[10px] text-primary hover:underline" disabled={!!busy} title="Ask Counsel to write it from your book"
                        onClick={() => onAsk(`Write the ${ROLE_LABEL[role].toLowerCase()} for my DesignCraft page from the book, and put it on the page.`)}>
                        {sym("auto_awesome", "text-[14px] align-middle")} write
                      </button>
                    </div>
                    <Textarea id={`ds-${role}`} value={value} rows={role === "body" ? 4 : 2} className="text-xs min-h-0"
                      placeholder={item ? "" : `No ${ROLE_LABEL[role].toLowerCase()} yet: type one to add it`}
                      onChange={(e) => setDrafts((d) => ({ ...d, [role]: e.target.value }))} />
                    {changed && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDrafts((d) => { const n = { ...d }; delete n[role]; return n; })}>Cancel</Button>
                        <Button size="sm" className="h-7 text-xs" disabled={!!busy || !value.trim()} onClick={() => act(`Updating the ${role}`, { action: "send", role, text: value })}>{item ? "Update" : "Add"}</Button>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold flex-1">
                    Picture
                    {items.some((i) => i.role === "image" && placeholderIds.has(i.id)) && <span className="ml-1.5 text-[10px] font-normal text-primary">template picture</span>}
                  </span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!busy} onClick={openPicker}>{sym("photo_library", "mr-1 text-[16px]")}{items.some((i) => i.role === "image") ? "Replace" : "Add"} from my images</Button>
                </div>
                {picker && (
                  <div className="rounded-lg border border-outline-variant/20 p-2">
                    <div className="flex items-center mb-1"><span className="text-[11px] flex-1 text-on-surface-variant">Recent images</span><button onClick={() => setPicker(null)} aria-label="Close picker">{sym("close", "text-[16px]")}</button></div>
                    {picker.length === 0 ? <p className="text-[11px] text-on-surface-variant">No images in your library yet.</p> : (
                      <div className="grid grid-cols-4 gap-1.5">
                        {picker.map((p) => (
                          <button key={p.id} title={p.prompt || "Use this picture"} disabled={!!busy} className="aspect-square rounded overflow-hidden border border-outline-variant/20 hover:border-primary"
                            onClick={() => act("Placing the picture", { action: "send", role: "image", image_id: p.id, options: items.some((i) => i.role === "image") ? { replace: true } : {} }, () => setPicker(null))}>
                            <img src={p.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "page" && (
            <div className="space-y-4">
              <div>
                <div className="text-xs font-semibold mb-1.5">Start a new page</div>
                <div className="grid grid-cols-2 gap-2">
                  {PAGE_SIZES.map(([preset, label]) => (
                    <Button key={preset} size="sm" variant="outline" className="h-auto py-1.5 flex-col items-start text-left" disabled={!!busy}
                      onClick={() => act(`New ${preset} page`, { action: "open", options: { preset } })}>
                      <span className="text-xs font-semibold">{preset}</span><span className="text-[10px] text-on-surface-variant font-normal">{label}</span>
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold mb-1.5">Export</div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={!!busy || !state?.document} onClick={() => act("Exporting PDF", { action: "export", format: "pdf", to_library: true, title: state?.document?.replace(/\.designcraft$/, "") || "Design" })}>{sym("picture_as_pdf", "mr-1")}PDF to bookshelf</Button>
                  <Button size="sm" variant="outline" disabled={!!busy || !state?.document} onClick={() => act("Exporting image", { action: "export", format: "png", page: page?.page ?? 0, title: state?.document?.replace(/\.designcraft$/, "") || "Design" })}>{sym("image", "mr-1")}PNG to images</Button>
                  {!state?.window_open && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("Opening DesignCraft", { action: "open" })}>{sym("open_in_new", "mr-1")}Open the window</Button>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Ask Counsel */}
      <div className="border-t border-outline-variant/20 px-4 py-2.5 flex flex-wrap gap-1.5">
        {[
          ["Make it look amazing", "Make my DesignCraft page look amazing, like a pro designer made it."],
          ["Write it from my book", "Write the headline, subhead and a short body for my DesignCraft page from the book in context, and put them on the page."],
          ["3 headline ideas", "Give me 3 headline ideas for my DesignCraft page from the book; I'll pick one."],
        ].map(([label, prompt]) => (
          <button key={label} onClick={() => onAsk(prompt)} disabled={!!busy}
            className="text-[11px] px-2.5 py-1 rounded-full border border-outline-variant/30 hover:border-primary/60 hover:text-primary transition-colors">
            {sym("auto_awesome", "text-[13px] align-middle mr-0.5")}{label}
          </button>
        ))}
      </div>
    </aside>
  );
};

export default DesignStudioPanel;
