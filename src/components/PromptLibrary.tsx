import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { PromptPreset, PromptScope, usePromptPresets } from "@/hooks/usePromptPresets";
import { useApp } from "@/context/AppContext";
import { PERMISSION_GROUPS } from "@/lib/toolPermissions";
import {
  acceptPromptProposal,
  dismissPromptProposal,
  fetchPromptProposals,
  promptRoutingAccuracy,
  runPromptIncubatorSweep,
  type PromptProposal,
} from "@/lib/promptRoutingApi";

interface Props {
  /** Use this to show a small helper sentence at the top. */
  scopeHint?: "chat" | "voice";
}

const SCOPE_LABEL: Record<PromptScope, string> = {
  both: "Chat + Voice",
  chat: "Chat only",
  voice: "Voice only",
};

type Draft = {
  name: string; body: string; scope: PromptScope; when_to_use: string; routing_enabled: boolean;
  neuron_ids: string[]; book_id: string | null; tool_permissions: Record<string, boolean> | null;
};
const EMPTY_DRAFT: Draft = {
  name: "", body: "", scope: "both", when_to_use: "", routing_enabled: false,
  neuron_ids: [], book_id: null, tool_permissions: null,
};

/** Turning a GROUP off writes `false` for each of its permissions. Narrowing
 *  is expressed per-permission because that is what the tool gate reads; the
 *  group is only how a person thinks about it. */
const groupIsOff = (perms: Record<string, boolean> | null, ids: string[]) =>
  !!perms && ids.length > 0 && ids.every((id) => perms[id] === false);

/**
 * Prompt Library — saved system prompts, and the controls that let the
 * assistant pick between them.
 *
 * The proposal cards at the top are the ONLY way a prompt the assistant wrote
 * can become a prompt the assistant uses. Until Approve is pressed, the text
 * lives in `prompt_proposals`, a table the prompt builder never reads.
 */
const PromptLibrary: React.FC<Props> = ({ scopeHint }) => {
  const {
    presets, savePreset, deletePreset, setActive, refresh,
    routingEnabled, plainOnRecall, routingSchemaReady, setRoutingEnabled, setPlainOnRecall,
  } = usePromptPresets();
  const { wikis, books } = useApp();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [proposals, setProposals] = useState<PromptProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [autoPaused, setAutoPaused] = useState(false);

  const loadProposals = useCallback(async () => {
    setProposals(routingSchemaReady ? await fetchPromptProposals() : []);
  }, [routingSchemaReady]);
  useEffect(() => { loadProposals(); }, [loadProposals]);
  // Opening this panel is the only moment a new suggestion can be seen, so it
  // is the only moment worth paying to look for one. Throttled per device.
  useEffect(() => {
    if (!routingSchemaReady) return;
    let cancelled = false;
    runPromptIncubatorSweep().then(() => { if (!cancelled) loadProposals(); });
    return () => { cancelled = true; };
  }, [routingSchemaReady, loadProposals]);

  // Auto-pause. A router the user keeps overruling should stop routing rather
  // than keep arguing — the same self-limiting loop Smart Filing has. Checked
  // when the panel opens, which is where the explanation can be read.
  useEffect(() => {
    if (!routingSchemaReady || !routingEnabled) return;
    let cancelled = false;
    promptRoutingAccuracy().then((acc) => {
      if (cancelled || !acc) return;
      // Ten is enough to mean something; half is a coin toss, and a coin toss
      // is not worth changing someone's voice over.
      if (acc.switches >= 10 && acc.corrected / acc.switches > 0.5) {
        setAutoPaused(true);
        setRoutingEnabled(false);
      }
    });
    return () => { cancelled = true; };
  }, [routingSchemaReady, routingEnabled, setRoutingEnabled]);

  const beginNew = () => { setDraft(EMPTY_DRAFT); setEditingId("new"); };
  const beginEdit = (p: PromptPreset) => {
    setDraft({
      name: p.name, body: p.body, scope: p.scope, when_to_use: p.when_to_use, routing_enabled: p.routing_enabled,
      neuron_ids: p.neuron_ids, book_id: p.book_id, tool_permissions: p.tool_permissions,
    });
    setEditingId(p.id);
  };

  const toggleNeuron = (id: string) => setDraft((d) => ({
    ...d,
    neuron_ids: d.neuron_ids.includes(id) ? d.neuron_ids.filter((x) => x !== id) : [...d.neuron_ids, id],
  }));

  const toggleToolGroup = (ids: string[]) => setDraft((d) => {
    const off = groupIsOff(d.tool_permissions, ids);
    const next = { ...(d.tool_permissions || {}) };
    // Turning a group back ON DELETES the keys rather than writing `true`:
    // this map may only ever remove tools, so "not mentioned" is the only way
    // to say "leave the user's own setting alone".
    for (const id of ids) { if (off) delete next[id]; else next[id] = false; }
    return { ...d, tool_permissions: Object.keys(next).length > 0 ? next : null };
  });
  const cancel = () => { setEditingId(null); setDraft(EMPTY_DRAFT); };
  const submit = async () => {
    if (!draft.name.trim() && !draft.body.trim()) { cancel(); return; }
    await savePreset({
      id: editingId === "new" ? undefined : (editingId as string),
      name: draft.name, body: draft.body, scope: draft.scope,
      ...(routingSchemaReady ? {
        when_to_use: draft.when_to_use, routing_enabled: draft.routing_enabled,
        neuron_ids: draft.neuron_ids, book_id: draft.book_id, tool_permissions: draft.tool_permissions,
      } : {}),
    });
    cancel();
  };

  const onAccept = async (p: PromptProposal) => {
    setBusyId(p.id);
    try {
      await acceptPromptProposal(p);
      toast.success(`"${p.proposed_name}" saved to your library — switch to it whenever you want.`);
      await Promise.all([refresh(), loadProposals()]);
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusyId(null);
    }
  };
  const onDismiss = async (p: PromptProposal) => {
    setBusyId(p.id);
    try {
      await dismissPromptProposal(p.id);
      await loadProposals();
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="p-3 md:p-4 rounded-xl bg-surface-container-low space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center gap-1">
            <span className="material-symbols-outlined text-xs align-middle">psychology</span>Prompt Library
          </label>
          <p className="text-[10px] text-on-surface-variant px-1 mt-1">
            Save multiple system prompts. The active one is prepended to {scopeHint === "voice" ? "Voice" : scopeHint === "chat" ? "Chat" : "every"} reply.
            Switch between them from Counsel, or with ⌘K.
          </p>
        </div>
        {editingId === null && (
          <Button size="sm" onClick={beginNew} className="shrink-0">
            <Plus className="w-4 h-4" /> New
          </Button>
        )}
      </div>

      {/* ── Proposals: drafted by the assistant, inert until approved ── */}
      {proposals.map((p) => (
        <div key={p.id} className="rounded-lg border border-primary-container/40 bg-primary-container/10 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-primary-container text-base">lightbulb</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">Suggested prompt: {p.proposed_name}</p>
              <p className="text-[11px] text-on-surface-variant">{p.rationale}</p>
            </div>
          </div>
          {p.sample_gists.length > 0 && (
            <div className="text-[11px] text-on-surface-variant">
              <span className="font-semibold text-foreground">Drafted from your messages: </span>
              {p.sample_gists.slice(0, 3).map((g, i) => (
                <span key={i} className="block truncate pl-2 opacity-80">“{g}”</span>
              ))}
            </div>
          )}
          {/* The exact text, before approval — the same rule the Program
              Foundry card follows for code. A suggestion you cannot read in
              full is one you cannot consent to. */}
          <pre className="text-[11px] bg-surface-container-low rounded-lg p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap"><code>{p.proposed_body}</code></pre>
          <p className="text-[10px] text-on-surface-variant">
            The AI wrote this. Approving saves it to your library — it does not turn it on.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busyId === p.id} onClick={() => onAccept(p)}>
              <Check className="w-4 h-4" /> Save to my library
            </Button>
            <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => onDismiss(p)}>
              <X className="w-4 h-4" /> Dismiss
            </Button>
          </div>
        </div>
      ))}

      {autoPaused && !routingEnabled && (
        <div className="rounded-lg border border-outline-variant/20 bg-error-container/40 p-3 flex items-start justify-between gap-3">
          <div className="text-xs">
            <p className="font-bold text-foreground">Prompt routing was paused automatically</p>
            <p className="text-on-surface-variant pt-0.5">
              You put the prompt back most of the times it switched, so it stopped. Turn it on again whenever
              you want — or give your prompts sharper “use this when…” descriptions first.
            </p>
          </div>
          <button onClick={() => setAutoPaused(false)} className="p-1 rounded-lg hover:bg-surface-container" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Routing ── */}
      {routingSchemaReady && (
        <div className="rounded-lg bg-surface-container-high p-3 space-y-2.5 border border-outline-variant/15">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Let the AI pick the prompt</p>
              <p className="text-[11px] text-on-surface-variant">
                Matches each message against the “use this when…” description on your prompts and switches when
                something clearly fits better. It tells you every time, under the reply, with an undo.
              </p>
            </div>
            <Switch checked={routingEnabled} onCheckedChange={setRoutingEnabled} aria-label="Let the AI pick the prompt" />
          </div>
          {routingEnabled && (
            <div className="flex items-start justify-between gap-3 pt-1 border-t border-outline-variant/10">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Plain voice for factual questions</p>
                <p className="text-[11px] text-on-surface-variant">
                  Don’t apply a persona when a message is mostly recalling what you’ve saved. Personas measurably
                  cost accuracy on recall, and help on writing and formatting — this keeps both.
                </p>
              </div>
              <Switch checked={plainOnRecall} onCheckedChange={setPlainOnRecall} aria-label="Plain voice for factual questions" />
            </div>
          )}
        </div>
      )}

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
          {routingSchemaReady && (
            <>
              <Textarea
                value={draft.when_to_use}
                onChange={(e) => setDraft(d => ({ ...d, when_to_use: e.target.value }))}
                placeholder="Use this when… e.g. 'the user wants feedback on prose they wrote themselves'"
                rows={2}
                className="bg-surface-container-low border-none text-sm"
              />
              <label className="flex items-center gap-2 text-[11px] text-on-surface-variant cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.routing_enabled}
                  onChange={(e) => setDraft(d => ({ ...d, routing_enabled: e.target.checked }))}
                  disabled={!draft.when_to_use.trim()}
                />
                <span>
                  Let the AI choose this one automatically
                  {!draft.when_to_use.trim() && <span className="opacity-70"> — needs a “use this when…” description first</span>}
                </span>
              </label>

              {/* ── Context this prompt brings with it ──
                  Loaded when YOU switch to this prompt, never by the router:
                  changing what the assistant can see is a bigger thing than
                  changing how it sounds, and it should take a tap. */}
              <div className="rounded-lg bg-surface-container-low p-2.5 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
                  Bring context with it
                </p>
                <p className="text-[10px] text-on-surface-variant">
                  Applied when you switch to this prompt yourself. The AI never loads these on its own.
                </p>

                {wikis.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {wikis.map((w) => {
                      const on = draft.neuron_ids.includes(w.id);
                      return (
                        <button
                          key={w.id}
                          onClick={() => toggleNeuron(w.id)}
                          aria-pressed={on}
                          className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${on ? "bg-primary-container text-on-primary-container border-primary-container" : "bg-surface-container-high text-on-surface-variant border-outline-variant/20 hover:text-primary"}`}
                        >
                          {w.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                {books.length > 0 && (
                  <select
                    value={draft.book_id || ""}
                    onChange={(e) => setDraft((d) => ({ ...d, book_id: e.target.value || null }))}
                    className="w-full text-xs rounded-md bg-surface-container-high border border-outline-variant/20 px-2 py-1.5 text-foreground"
                    aria-label="Book to open with this prompt"
                  >
                    <option value="">No particular book</option>
                    {books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                  </select>
                )}

                <details>
                  <summary className="cursor-pointer text-[11px] text-on-surface-variant hover:text-primary">
                    Limit what the AI can do while this prompt is on
                  </summary>
                  <p className="text-[10px] text-on-surface-variant mt-1.5">
                    Switching a group off removes those tools for every turn this prompt is in force. It can only
                    ever take tools away — never grant one you have turned off in Settings.
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {PERMISSION_GROUPS.map((g) => {
                      const ids = g.items.map((i) => i.id);
                      const off = groupIsOff(draft.tool_permissions, ids);
                      return (
                        <button
                          key={g.group}
                          onClick={() => toggleToolGroup(ids)}
                          aria-pressed={off}
                          title={off ? `${g.group} is blocked while this prompt is on` : `${g.group} follows your normal settings`}
                          className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${off ? "bg-error-container/40 text-foreground border-outline-variant/30 line-through" : "bg-surface-container-high text-on-surface-variant border-outline-variant/20 hover:text-primary"}`}
                        >
                          {g.group}
                        </button>
                      );
                    })}
                  </div>
                </details>
              </div>
            </>
          )}
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
                  {p.routing_enabled && (
                    <span className="text-[10px] uppercase tracking-wider text-primary shrink-0" title="The AI may choose this one on its own">auto</span>
                  )}
                  {(p.neuron_ids.length > 0 || p.book_id) && (
                    <span className="material-symbols-outlined text-[13px] text-on-surface-variant shrink-0" title="Switching to this prompt also loads its neurons or book" aria-label="brings context">hub</span>
                  )}
                  {p.tool_permissions && (
                    <span className="material-symbols-outlined text-[13px] text-on-surface-variant shrink-0" title="This prompt limits which tools the AI can use" aria-label="limits tools">lock</span>
                  )}
                  {/* Provenance is never hidden: a prompt the AI drafted must
                      not become indistinguishable from one you wrote. */}
                  {p.origin === "assistant" && (
                    <span className="text-[10px] uppercase tracking-wider text-on-surface-variant shrink-0" title="Drafted by the AI, approved by you">ai</span>
                  )}
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
