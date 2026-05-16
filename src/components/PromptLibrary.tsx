import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { PromptPreset, PromptScope, usePromptPresets } from "@/hooks/usePromptPresets";

interface Props {
  /** Use this to show a small helper sentence at the top. */
  scopeHint?: "chat" | "voice";
}

const SCOPE_LABEL: Record<PromptScope, string> = {
  both: "Chat + Voice",
  chat: "Chat only",
  voice: "Voice only",
};

const PromptLibrary: React.FC<Props> = ({ scopeHint }) => {
  const { presets, savePreset, deletePreset, setActive } = usePromptPresets();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<{ name: string; body: string; scope: PromptScope }>({
    name: "", body: "", scope: "both",
  });

  const beginNew = () => {
    setDraft({ name: "", body: "", scope: "both" });
    setEditingId("new");
  };
  const beginEdit = (p: PromptPreset) => {
    setDraft({ name: p.name, body: p.body, scope: p.scope });
    setEditingId(p.id);
  };
  const cancel = () => { setEditingId(null); setDraft({ name: "", body: "", scope: "both" }); };
  const submit = async () => {
    if (!draft.name.trim() && !draft.body.trim()) { cancel(); return; }
    await savePreset({
      id: editingId === "new" ? undefined : (editingId as string),
      name: draft.name, body: draft.body, scope: draft.scope,
    });
    cancel();
  };

  return (
    <section className="p-3 md:p-4 rounded-xl bg-surface-container-low space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center gap-1">
            <span className="material-symbols-outlined text-xs align-middle">psychology</span>Prompt Library
          </label>
          <p className="text-[10px] text-on-surface-variant px-1 mt-1">
            Save multiple system prompts. The active one is prepended to {scopeHint === "voice" ? "Voice" : scopeHint === "chat" ? "Chat" : "every"} reply. Set scope per preset.
          </p>
        </div>
        {editingId === null && (
          <Button size="sm" onClick={beginNew} className="shrink-0">
            <Plus className="w-4 h-4" /> New
          </Button>
        )}
      </div>

      {editingId !== null && (
        <div className="rounded-lg bg-surface-container-high p-3 space-y-2 border border-outline-variant/15">
          <Input
            value={draft.name}
            onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="Preset name (e.g. Literary Critic)"
            className="bg-surface-container-low border-none text-sm"
          />
          <Textarea
            value={draft.body}
            onChange={(e) => setDraft(d => ({ ...d, body: e.target.value }))}
            placeholder="Instructions to prepend, e.g. 'Always reference page numbers.'"
            rows={4}
            className="bg-surface-container-low border-none text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">Scope:</span>
            {(["both", "chat", "voice"] as PromptScope[]).map(s => (
              <button
                key={s}
                onClick={() => setDraft(d => ({ ...d, scope: s }))}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${draft.scope === s ? "bg-primary-container text-on-primary-container" : "bg-surface-container-low text-on-surface-variant hover:text-primary"}`}
              >
                {SCOPE_LABEL[s]}
              </button>
            ))}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={cancel}><X className="w-4 h-4" /></Button>
              <Button size="sm" onClick={submit}><Check className="w-4 h-4" /> Save</Button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {presets.length === 0 && editingId === null && (
          <p className="text-xs text-on-surface-variant/80 italic px-1">No prompts saved yet — tap “New” to create one.</p>
        )}
        {presets.map((p) => {
          const isActive = p.is_active;
          const inScope = scopeHint ? (p.scope === "both" || p.scope === scopeHint) : true;
          return (
            <div
              key={p.id}
              className={`flex items-center gap-2 rounded-lg p-2.5 border transition-colors ${isActive ? "bg-primary-container/15 border-primary-container/40" : "bg-surface-container-high border-outline-variant/10"}`}
            >
              <button
                onClick={() => setActive(isActive ? null : p.id)}
                title={isActive ? "Deactivate" : (inScope ? "Set active" : "Active but not used in this tab (scope mismatch)")}
                className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors ${isActive ? "bg-primary text-primary-foreground" : "bg-surface-container-low text-on-surface-variant hover:text-primary"}`}
                aria-label={isActive ? "Deactivate prompt" : "Activate prompt"}
              >
                {isActive ? <Check className="w-4 h-4" /> : <span className="material-symbols-outlined text-base">radio_button_unchecked</span>}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground truncate">{p.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-on-surface-variant shrink-0">{SCOPE_LABEL[p.scope]}</span>
                  {isActive && !inScope && scopeHint && (
                    <span className="text-[10px] text-amber-500 shrink-0">(not used here)</span>
                  )}
                </div>
                {p.body && <p className="text-xs text-on-surface-variant truncate">{p.body}</p>}
              </div>
              <button
                onClick={() => beginEdit(p)}
                className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-highest shrink-0"
                title="Edit" aria-label="Edit prompt"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => deletePreset(p.id)}
                className="w-7 h-7 rounded-md flex items-center justify-center text-on-surface-variant hover:text-destructive hover:bg-surface-container-highest shrink-0"
                title="Delete" aria-label="Delete prompt"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default PromptLibrary;
