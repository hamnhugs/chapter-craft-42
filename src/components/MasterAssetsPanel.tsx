import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import GeneratedImage from "@/components/GeneratedImage";
import {
  type MasterAssetRow,
  listMasterAssets,
  updateMasterAsset,
  deleteMasterAsset,
  normalizeHex,
} from "@/lib/masterAssets";
import { fetchImageById, type ImageAttachmentRow } from "@/lib/imageGen";

/**
 * Master-asset browser/editor — the first UI surface for locked masters, which
 * until now could only be inspected or repaired by asking the model in chat.
 *
 * Mounted like ImagesPanel (right-side Sheet, open/onOpenChange), because a
 * master is the same species of thing: a durable generated asset the user
 * wants to browse outside the conversation. Editing here is limited to the
 * prose/list fields (tech pack, tag, palette, negatives) — the blueprint stays
 * read-only because its validation and view re-projection live in chat.
 */

interface MasterAssetsPanelProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const formatRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
};

// Section label style shared with WorkspacePanel.
const LABEL_CLS = "text-[10px] font-bold uppercase tracking-widest text-on-surface-variant";

/** Tiny presence badge for the list cards (hero / splat / blueprint / views). */
const Badge: React.FC<{ icon: string; label: string }> = ({ icon, label }) => (
  <span className="inline-flex items-center gap-0.5 rounded-md bg-surface-container-high px-1.5 py-0.5 text-[10px] font-semibold text-on-surface-variant border border-outline-variant/20">
    <span className="material-symbols-outlined text-[12px] leading-none">{icon}</span>
    {label}
  </span>
);

/** Palette swatch — the pixels-not-text law means the swatch IS the data, so
 *  always show the actual color, with the hex as a label when asked. */
const Swatch: React.FC<{ hex: string; showHex?: boolean; onRemove?: () => void }> = ({
  hex,
  showHex,
  onRemove,
}) => (
  <span className="inline-flex items-center gap-1 rounded-md bg-surface-container-high border border-outline-variant/20 px-1 py-0.5">
    <span
      className="inline-block w-4 h-4 rounded ring-1 ring-outline-variant/30 shrink-0"
      style={{ backgroundColor: hex }}
      title={hex}
    />
    {showHex && <span className="text-[10px] font-mono text-on-surface-variant">{hex}</span>}
    {onRemove && (
      <button
        onClick={onRemove}
        aria-label={`Remove ${hex} from palette`}
        className="inline-flex items-center justify-center h-4 w-4 rounded text-on-surface-variant hover:text-destructive transition-colors"
      >
        <span className="material-symbols-outlined text-[12px] leading-none">close</span>
      </button>
    )}
  </span>
);

const MasterAssetsPanel: React.FC<MasterAssetsPanelProps> = ({ open, onOpenChange }) => {
  const [masters, setMasters] = useState<MasterAssetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MasterAssetRow | null>(null);

  // Editable copies of the prose fields; dirty = differs from the saved row.
  const [techPack, setTechPack] = useState("");
  const [assemblyTag, setAssemblyTag] = useState("");
  const [newHex, setNewHex] = useState("");
  const [newNegative, setNewNegative] = useState("");
  const [newBanned, setNewBanned] = useState("");
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // image id -> attachment row (null = fetched but missing, e.g. a dangling
  // reference; undefined = not fetched yet). Cached across masters by id.
  const [images, setImages] = useState<Record<string, ImageAttachmentRow | null>>({});

  const resetDetail = () => {
    setSelected(null);
    setTechPack("");
    setAssemblyTag("");
    setNewHex("");
    setNewNegative("");
    setNewBanned("");
    setBlueprintOpen(false);
    setConfirmName("");
  };

  useEffect(() => {
    if (!open) {
      // Full reset on close so a reopen starts from fresh data — images may
      // have been deleted or repaired in chat while the sheet was away.
      resetDetail();
      setMasters([]);
      setImages({});
      return;
    }
    setLoading(true);
    // listMasterAssets swallows {error} into [] — the empty state covers both
    // "no masters yet" and "table not migrated yet" with the same guidance.
    void listMasterAssets()
      .then((list) => setMasters(list))
      .finally(() => setLoading(false));
  }, [open]);

  // Fetch the attachment rows for the selected master's hero + views so we can
  // render them through GeneratedImage (which signs the private-bucket URLs).
  useEffect(() => {
    if (!selected) return;
    const ids = [selected.hero_image_id, ...(selected.view_image_ids || [])]
      .filter((id): id is string => Boolean(id))
      .filter((id) => !(id in images));
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      const fetched = await Promise.all(
        ids.map(async (id) => [id, await fetchImageById(id)] as const),
      );
      if (cancelled) return;
      setImages((prev) => {
        const next = { ...prev };
        for (const [id, row] of fetched) next[id] = row;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const openMaster = (m: MasterAssetRow) => {
    setSelected(m);
    setTechPack(m.tech_pack_text || "");
    setAssemblyTag(m.assembly_tag || "");
    setNewHex("");
    setNewNegative("");
    setNewBanned("");
    setBlueprintOpen(false);
    setConfirmName("");
  };

  /** All UI edits funnel through here so the saved-row state, the list, and
   *  the {error} toast behave identically for every field. */
  const applyUpdate = async (
    patch: Parameters<typeof updateMasterAsset>[1],
    okMsg: string,
  ) => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const updated = await updateMasterAsset(selected.id, patch);
      if (!updated) {
        throw new Error("Master not found — it may have been deleted in another tab.");
      }
      setSelected(updated);
      setMasters((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      toast.success(okMsg);
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const addHex = () => {
    if (!selected || !newHex.trim()) return;
    try {
      // normalizeHex throws on non-hex input — same validation the create path uses.
      const hex = normalizeHex(newHex);
      if ((selected.palette || []).includes(hex)) {
        setNewHex("");
        return;
      }
      void applyUpdate({ palette: [...(selected.palette || []), hex] }, "Palette updated");
      setNewHex("");
    } catch (e: any) {
      toast.error(e?.message || "Invalid hex color");
    }
  };

  const removeHex = (hex: string) => {
    if (!selected) return;
    void applyUpdate(
      { palette: (selected.palette || []).filter((h) => h !== hex) },
      "Palette updated",
    );
  };

  const addListItem = (field: "negative_constraints" | "banned_traits", raw: string) => {
    if (!selected) return;
    // Mirror the create path's per-item cap so UI edits can't exceed what a
    // chat-created master is allowed to hold.
    const s = raw.trim().slice(0, 200);
    if (!s) return;
    const cur = selected[field] || [];
    const clear = field === "negative_constraints" ? setNewNegative : setNewBanned;
    if (cur.includes(s)) {
      clear("");
      return;
    }
    if (cur.length >= 20) {
      toast.error("Limit of 20 entries — remove one first.");
      return;
    }
    const patch =
      field === "negative_constraints"
        ? { negative_constraints: [...cur, s] }
        : { banned_traits: [...cur, s] };
    void applyUpdate(patch, "Saved");
    clear("");
  };

  const removeListItem = (field: "negative_constraints" | "banned_traits", item: string) => {
    if (!selected) return;
    const next = (selected[field] || []).filter((x) => x !== item);
    const patch =
      field === "negative_constraints"
        ? { negative_constraints: next }
        : { banned_traits: next };
    void applyUpdate(patch, "Saved");
  };

  const copyBlueprint = async () => {
    if (!selected?.blueprint) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected.blueprint, null, 2));
      toast.success("Blueprint JSON copied");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  // Typed-name confirmation: deleting a master silently orphans every future
  // "@name" reference in prompts, so make the user spell out what they lose.
  const confirmMatches = useMemo(
    () =>
      !!selected &&
      confirmName.trim().replace(/^@/, "").toLowerCase() === selected.name,
    [selected, confirmName],
  );

  const handleDelete = async () => {
    if (!selected || !confirmMatches || deleting) return;
    setDeleting(true);
    try {
      await deleteMasterAsset(selected.id);
      toast.success(`Deleted @${selected.name}`);
      setMasters((prev) => prev.filter((m) => m.id !== selected.id));
      resetDetail();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const techDirty = !!selected && techPack !== (selected.tech_pack_text || "");
  const tagDirty = !!selected && assemblyTag !== (selected.assembly_tag || "");

  const heroRow = selected?.hero_image_id ? images[selected.hero_image_id] : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-0 flex flex-col bg-surface text-on-surface"
      >
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-outline-variant/20">
          <SheetTitle className="flex items-center gap-2 text-on-surface">
            <span className="material-symbols-outlined text-xl">fingerprint</span>
            {selected ? (
              <>
                <button
                  onClick={resetDetail}
                  aria-label="Back to all masters"
                  className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                </button>
                <span className="truncate">@{selected.name}</span>
              </>
            ) : (
              <>
                Master Assets
                {masters.length > 0 && (
                  <span className="text-xs font-normal text-on-surface-variant">
                    ({masters.length})
                  </span>
                )}
              </>
            )}
          </SheetTitle>
          <SheetDescription className="text-on-surface-variant">
            {selected
              ? `Locked identity bundle · ${selected.style_lock} · created ${formatRelative(selected.created_at)}`
              : "Locked character/asset bundles that generations reference by @name."}
          </SheetDescription>
        </SheetHeader>

        {selected ? (
          /* ------------------------------ Detail view ------------------------------ */
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            {/* Hero */}
            <section>
              <p className={`${LABEL_CLS} mb-1.5`}>Hero image</p>
              {!selected.hero_image_id ? (
                <p className="text-xs text-on-surface-variant">
                  No hero image — this master locks identity to its splat.
                </p>
              ) : heroRow === undefined ? (
                <div className="rounded-xl bg-surface-container-high h-40 animate-pulse" />
              ) : heroRow === null ? (
                <p className="text-xs text-destructive">
                  Hero image {selected.hero_image_id} was not found — it may have been
                  deleted. Ask the assistant to repair this master.
                </p>
              ) : (
                <GeneratedImage
                  storagePath={heroRow.storage_path}
                  alt={`@${selected.name} hero`}
                  className="!my-0"
                />
              )}
            </section>

            {/* View pack */}
            {(selected.view_image_ids || []).length > 0 && (
              <section>
                <p className={`${LABEL_CLS} mb-1.5`}>
                  View pack ({selected.view_image_ids.length})
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {selected.view_image_ids.map((id) => {
                    const row = images[id];
                    return (
                      <div
                        key={id}
                        className="aspect-square rounded-xl overflow-hidden border border-outline-variant/20 bg-surface-container-high flex items-center justify-center"
                      >
                        {row === undefined ? (
                          <div className="w-full h-full animate-pulse" />
                        ) : row === null ? (
                          <span
                            className="material-symbols-outlined text-on-surface-variant/50"
                            title={`View ${id} not found`}
                          >
                            broken_image
                          </span>
                        ) : (
                          <GeneratedImage
                            storagePath={row.storage_path}
                            alt={`@${selected.name} view`}
                            className="!my-0 w-full h-full [&_img]:!max-h-none [&_img]:w-full [&_img]:h-full [&_img]:object-cover [&_img]:!rounded-none [&_img]:!border-0 [&_img]:!shadow-none"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Assembly tag */}
            <section>
              <p className={`${LABEL_CLS} mb-1.5`}>Assembly tag</p>
              <div className="flex items-center gap-2">
                <Input
                  value={assemblyTag}
                  onChange={(e) => setAssemblyTag(e.target.value)}
                  maxLength={300}
                  placeholder="Short discriminative identity tag"
                  className="h-9 text-sm"
                />
                {tagDirty && (
                  <button
                    onClick={() =>
                      void applyUpdate(
                        { assembly_tag: assemblyTag.trim().slice(0, 300) },
                        "Assembly tag saved",
                      )
                    }
                    disabled={saving}
                    className="shrink-0 px-3 h-9 rounded-lg bg-primary-container text-on-primary-container text-xs font-bold active:scale-95 transition-transform disabled:opacity-50"
                  >
                    Save
                  </button>
                )}
              </div>
            </section>

            {/* Palette */}
            <section>
              <p className={`${LABEL_CLS} mb-1.5`}>Palette</p>
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                {(selected.palette || []).length === 0 && (
                  <span className="text-xs text-on-surface-variant">No locked colors.</span>
                )}
                {(selected.palette || []).map((hex) => (
                  <Swatch key={hex} hex={hex} showHex onRemove={() => removeHex(hex)} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={newHex}
                  onChange={(e) => setNewHex(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addHex();
                  }}
                  placeholder="#RRGGBB"
                  className="h-8 text-sm font-mono flex-1"
                />
                <button
                  onClick={addHex}
                  disabled={saving || !newHex.trim()}
                  className="shrink-0 px-3 h-8 rounded-lg bg-surface-container-high border border-outline-variant/20 text-xs font-bold hover:bg-surface-container-highest active:scale-95 transition-transform disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </section>

            {/* Negatives / banned traits */}
            {(
              [
                ["negative_constraints", "Negative constraints", newNegative, setNewNegative],
                ["banned_traits", "Banned traits", newBanned, setNewBanned],
              ] as const
            ).map(([field, label, value, setValue]) => (
              <section key={field}>
                <p className={`${LABEL_CLS} mb-1.5`}>{label}</p>
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {(selected[field] || []).length === 0 && (
                    <span className="text-xs text-on-surface-variant">None.</span>
                  )}
                  {(selected[field] || []).map((item) => (
                    <span
                      key={item}
                      className="inline-flex items-center gap-1 rounded-md bg-surface-container-high border border-outline-variant/20 px-1.5 py-0.5 text-[11px] text-on-surface"
                    >
                      <span className="max-w-[180px] truncate" title={item}>
                        {item}
                      </span>
                      <button
                        onClick={() => removeListItem(field, item)}
                        aria-label={`Remove "${item}"`}
                        className="inline-flex items-center justify-center h-4 w-4 rounded text-on-surface-variant hover:text-destructive transition-colors"
                      >
                        <span className="material-symbols-outlined text-[12px] leading-none">
                          close
                        </span>
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addListItem(field, value);
                    }}
                    placeholder={
                      field === "negative_constraints"
                        ? "e.g. no text overlays"
                        : "e.g. beard"
                    }
                    className="h-8 text-sm flex-1"
                  />
                  <button
                    onClick={() => addListItem(field, value)}
                    disabled={saving || !value.trim()}
                    className="shrink-0 px-3 h-8 rounded-lg bg-surface-container-high border border-outline-variant/20 text-xs font-bold hover:bg-surface-container-highest active:scale-95 transition-transform disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </section>
            ))}

            {/* Tech pack */}
            <section>
              <p className={`${LABEL_CLS} mb-1.5`}>Tech pack</p>
              <Textarea
                value={techPack}
                onChange={(e) => setTechPack(e.target.value)}
                maxLength={8000}
                rows={10}
                className="text-xs font-mono leading-relaxed resize-y"
                placeholder="Human-readable spec used for QC checklists and negatives."
              />
              {techDirty && (
                <button
                  onClick={() =>
                    void applyUpdate(
                      { tech_pack_text: techPack.slice(0, 8000) },
                      "Tech pack saved",
                    )
                  }
                  disabled={saving}
                  className="mt-2 px-3 h-9 rounded-lg bg-primary-container text-on-primary-container text-xs font-bold active:scale-95 transition-transform disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save tech pack"}
                </button>
              )}
            </section>

            {/* Blueprint (read-only) */}
            <section>
              <button
                onClick={() => setBlueprintOpen((v) => !v)}
                disabled={!selected.blueprint}
                className="flex items-center gap-1.5 w-full text-left disabled:opacity-100"
              >
                <span className={LABEL_CLS}>Blueprint</span>
                {selected.blueprint ? (
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant">
                    {blueprintOpen ? "expand_less" : "expand_more"}
                  </span>
                ) : (
                  <span className="text-[10px] text-on-surface-variant normal-case tracking-normal font-normal">
                    — none (created before the blueprint pipeline)
                  </span>
                )}
              </button>
              {selected.blueprint && blueprintOpen && (
                <div className="mt-2">
                  <div className="relative">
                    <pre className="rounded-xl bg-surface-container-high border border-outline-variant/20 p-3 pr-10 text-[11px] font-mono leading-relaxed overflow-auto max-h-64">
                      {JSON.stringify(selected.blueprint, null, 2)}
                    </pre>
                    <button
                      onClick={() => void copyBlueprint()}
                      title="Copy blueprint JSON"
                      className="absolute top-2 right-2 inline-flex items-center justify-center h-7 w-7 rounded-lg bg-surface/80 backdrop-blur text-on-surface-variant hover:bg-surface-container-highest transition-colors"
                    >
                      <span className="material-symbols-outlined text-[16px]">content_copy</span>
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-on-surface-variant">
                    Read-only here — edit the blueprint in chat, where schema validation
                    and view re-projection live.
                  </p>
                </div>
              )}
            </section>

            {/* Danger zone */}
            <section className="rounded-xl border border-destructive/30 p-3">
              <p className={`${LABEL_CLS} mb-1.5 !text-destructive`}>Delete master</p>
              <p className="text-[11px] text-on-surface-variant mb-2">
                Removes the bundle only — its images, splat and memory entry are kept.
                Type <span className="font-mono font-semibold">@{selected.name}</span> to
                confirm.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={`@${selected.name}`}
                  className="h-9 text-sm font-mono flex-1"
                />
                <button
                  onClick={() => void handleDelete()}
                  disabled={!confirmMatches || deleting}
                  className="shrink-0 inline-flex items-center gap-1 px-3 h-9 rounded-lg bg-destructive text-destructive-foreground text-xs font-bold active:scale-95 transition-transform disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </section>
          </div>
        ) : (
          /* ------------------------------- List view ------------------------------- */
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-20 rounded-xl bg-surface-container-high animate-pulse" />
                ))}
              </div>
            ) : masters.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 px-4 text-on-surface-variant">
                <span className="material-symbols-outlined text-5xl mb-3 opacity-40">
                  fingerprint
                </span>
                <p className="font-semibold text-on-surface mb-1">No master assets yet</p>
                <p className="text-sm">
                  Masters are created in chat — ask the assistant to lock a master asset.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {masters.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => openMaster(m)}
                    className="group flex flex-col gap-1.5 w-full text-left rounded-xl bg-surface-container-high/50 border border-outline-variant/15 p-3 hover:border-primary-container/50 hover:bg-surface-container-high transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-bold text-on-surface truncate">
                        @{m.name}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-on-surface-variant">
                        {formatRelative(m.created_at)}
                      </span>
                    </div>
                    {m.assembly_tag && (
                      <p className="text-[11px] text-on-surface-variant line-clamp-2 leading-tight">
                        {m.assembly_tag}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {m.hero_image_id && <Badge icon="image" label="Hero" />}
                      {m.splat_id && <Badge icon="deployed_code" label="Splat" />}
                      {m.blueprint && <Badge icon="schema" label="Blueprint" />}
                      {(m.view_image_ids || []).length > 0 && (
                        <Badge
                          icon="photo_library"
                          label={`${m.view_image_ids.length} view${m.view_image_ids.length > 1 ? "s" : ""}`}
                        />
                      )}
                      {(m.palette || []).length > 0 && (
                        <span className="inline-flex items-center gap-1 ml-0.5">
                          {(m.palette || []).slice(0, 6).map((hex) => (
                            <Swatch key={hex} hex={hex} />
                          ))}
                          {(m.palette || []).length > 6 && (
                            <span className="text-[10px] text-on-surface-variant">
                              +{m.palette.length - 6}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

export default MasterAssetsPanel;
