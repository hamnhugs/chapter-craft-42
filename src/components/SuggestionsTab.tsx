import React, { useEffect, useState, useCallback } from "react";
import { Loader2, ArrowRight, X, Check, Sparkles, RefreshCw, BookPlus, Activity, Split, Edit3 } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  RerouteSuggestion,
  fetchPendingReroutes,
  acceptReroute,
  dismissReroute,
  getSmartFilingEnabled,
  setSmartFilingEnabled,
  recomputeCentroids,
  WikiProposal,
  fetchPendingProposals,
  acceptProposal,
  dismissProposal,
  runIncubatorSweep,
  fetchRoutingAccuracy,
  WikiHealthAlert,
  fetchHealthAlerts,
  runDriftCheck,
  acceptRename,
  dismissHealthAlert,
} from "@/lib/smartFilingApi";




interface Props {
  onChanged?: () => void;
}

const SuggestionsTab: React.FC<Props> = ({ onChanged }) => {
  const [reroutes, setReroutes] = useState<RerouteSuggestion[]>([]);
  const [proposals, setProposals] = useState<WikiProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [drifting, setDrifting] = useState(false);
  const [healthAlerts, setHealthAlerts] = useState<WikiHealthAlert[]>([]);
  const [accuracy, setAccuracy] = useState<{ accepted: number; total: number } | null>(null);
  const [wasAutoPaused, setWasAutoPaused] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const prevEnabled = enabled;
      const [r, p, en, acc, h] = await Promise.all([
        fetchPendingReroutes(),
        fetchPendingProposals(),
        getSmartFilingEnabled(),
        fetchRoutingAccuracy(),
        fetchHealthAlerts(),
      ]);
      setReroutes(r);
      setProposals(p);
      setEnabled(en);
      setAccuracy(acc);
      setHealthAlerts(h);
      if (prevEnabled && !en && acc && acc.total >= 10 && acc.accepted / acc.total < 0.3) {
        setWasAutoPaused(true);
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to load suggestions");

    } finally {
      setLoading(false);
    }
  }, [enabled]);


  useEffect(() => { load(); }, [load]);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    try {
      await setSmartFilingEnabled(next);
      if (next) {
        toast.success("Smart Filing turned on");
        await handleRecompute();
      } else {
        toast.success("Smart Filing turned off");
      }
    } catch (err: any) {
      setEnabled(!next);
      toast.error(err.message || "Failed to update setting");
    }
  };


  const handleRecompute = async () => {
    setRecomputing(true);
    try {
      const res = await recomputeCentroids();
      toast.success(`Recomputed centroids for ${res.recomputed} of ${res.total_wikis} wikis`);
    } catch (err: any) {
      toast.error(err.message || "Recompute failed");
    } finally {
      setRecomputing(false);
    }
  };

  const handleAccept = async (s: RerouteSuggestion) => {
    setActing(s.id);
    try {
      await acceptReroute(s.id);
      toast.success(`Moved to "${s.to_wiki_name}"`);
      setReroutes((prev) => prev.filter((x) => x.id !== s.id));
      onChanged?.();
    } catch (err: any) {
      toast.error(err.message || "Move failed");
    } finally {
      setActing(null);
    }
  };

  const handleDismiss = async (s: RerouteSuggestion, kept: boolean) => {
    setActing(s.id);
    try {
      await dismissReroute(s.id, kept);
      setReroutes((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err: any) {
      toast.error(err.message || "Dismiss failed");
    } finally {
      setActing(null);
    }
  };



  const handleSweep = async () => {
    setSweeping(true);
    try {
      const res = await runIncubatorSweep();
      if (res?.proposals > 0) {
        toast.success(`Found ${res.proposals} new wiki ${res.proposals === 1 ? "proposal" : "proposals"}`);
      } else {
        toast.info("No new clusters ready yet — keep filing");
      }
      await load();
    } catch (err: any) {
      toast.error(err.message || "Sweep failed");
    } finally {
      setSweeping(false);
    }
  };

  const handleAcceptProposal = async (p: WikiProposal) => {
    setActing(p.id);
    try {
      await acceptProposal(p);
      toast.success(`Created new wiki "${p.proposed_name}"`);
      setProposals((prev) => prev.filter((x) => x.id !== p.id));
      window.dispatchEvent(new Event("wikis-changed"));
      onChanged?.();
    } catch (err: any) {
      toast.error(err.message || "Create failed");
    } finally {
      setActing(null);
    }
  };

  const handleDismissProposal = async (p: WikiProposal) => {
    setActing(p.id);
    try {
      await dismissProposal(p.id);
      setProposals((prev) => prev.filter((x) => x.id !== p.id));
    } catch (err: any) {
      toast.error(err.message || "Dismiss failed");
    } finally {
      setActing(null);
    }
  };

  const handleDrift = async () => {
    setDrifting(true);
    try {
      const res = await runDriftCheck();
      if (res.alerts > 0) toast.success(`Found ${res.alerts} health ${res.alerts === 1 ? "alert" : "alerts"}`);
      else toast.info("All wikis look healthy");
      await load();
    } catch (err: any) {
      toast.error(err.message || "Drift check failed");
    } finally {
      setDrifting(false);
    }
  };

  const handleAcceptRename = async (a: WikiHealthAlert) => {
    setActing(a.id);
    try {
      await acceptRename(a);
      toast.success(`Renamed to "${a.suggestion?.proposed_name}"`);
      setHealthAlerts((prev) => prev.filter((x) => x.id !== a.id));
      window.dispatchEvent(new Event("wikis-changed"));
      onChanged?.();
    } catch (err: any) {
      toast.error(err.message || "Rename failed");
    } finally {
      setActing(null);
    }
  };

  const handleDismissHealth = async (a: WikiHealthAlert) => {
    setActing(a.id);
    try {
      await dismissHealthAlert(a.id);
      setHealthAlerts((prev) => prev.filter((x) => x.id !== a.id));
    } catch (err: any) {
      toast.error(err.message || "Dismiss failed");
    } finally {
      setActing(null);
    }
  };

  const totalCount = reroutes.length + proposals.length + healthAlerts.length;



  return (
    <div className="space-y-6">
      {/* Header / toggle */}
      <div className="bg-surface-container-low rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border border-outline-variant/10">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-primary-container">
            <Sparkles className="w-5 h-5 text-on-primary-container" />
          </div>
          <div>
            <h3 className="font-headline font-bold text-lg text-foreground">Smart Filing</h3>
            <p className="text-sm text-on-surface-variant max-w-md">
              Suggests where new knowledge fits best — and proposes brand-new wikis when a theme appears. Nothing moves without your tap.
            </p>
            {accuracy && accuracy.total >= 5 && (
              <p className="text-xs text-on-surface-variant pt-1 font-bold">
                Routing accuracy: {Math.round((accuracy.accepted / accuracy.total) * 100)}% accepted over last {accuracy.total}
              </p>
            )}
          </div>

        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSweep}
            disabled={sweeping}
            className="text-xs font-bold text-on-surface-variant hover:text-foreground flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-surface-container disabled:opacity-50"
            title="Check the incubator for new wiki proposals"
          >
            {sweeping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookPlus className="w-3.5 h-3.5" />}
            Check incubator
          </button>
          <button
            onClick={handleDrift}
            disabled={drifting}
            className="text-xs font-bold text-on-surface-variant hover:text-foreground flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-surface-container disabled:opacity-50"
            title="Check wikis for drift (split / rename suggestions)"
          >
            {drifting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            Check drift
          </button>


          <button
            onClick={handleRecompute}
            disabled={recomputing}
            className="text-xs font-bold text-on-surface-variant hover:text-foreground flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-surface-container disabled:opacity-50"
            title="Refresh wiki centroids"
          >
            {recomputing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Recompute
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-on-surface-variant">
              {enabled ? "On" : "Off"}
            </span>
            <Switch checked={enabled} onCheckedChange={handleToggle} />
          </div>
        </div>
      </div>


      {wasAutoPaused && !enabled && (
        <div className="bg-error-container/40 text-foreground rounded-2xl p-4 border border-outline-variant/20 flex items-start justify-between gap-3">
          <div className="text-sm">
            <div className="font-bold">Smart Filing was paused automatically</div>
            <p className="text-on-surface-variant pt-0.5">
              You dismissed most recent suggestions. Toggle it back on whenever you want fresh routing help.
            </p>
          </div>
          <button
            onClick={() => setWasAutoPaused(false)}
            className="p-1 rounded-lg hover:bg-surface-container"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}



      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
        </div>
      ) : totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
          <Sparkles className="w-10 h-10 opacity-40" />
          <p className="text-sm text-center max-w-sm">
            {enabled
              ? "Smart Filing is watching. Reroute suggestions and new-wiki proposals will appear here as the system learns."
              : "Turn on Smart Filing above to start getting routing suggestions."}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* New wiki proposals */}
          {proposals.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-bold uppercase tracking-widest text-on-surface-variant px-1">
                New Wiki Proposals · {proposals.length}
              </div>
              {proposals.map((p) => (
                <div
                  key={p.id}
                  className="bg-surface-container-low rounded-2xl p-5 border border-outline-variant/10 space-y-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <BookPlus className="w-4 h-4 text-on-primary-container" />
                      <div className="font-headline font-bold text-foreground text-lg">{p.proposed_name}</div>
                      <span className="text-xs text-on-surface-variant">
                        {p.member_entry_ids.length} {p.member_entry_ids.length === 1 ? "entry" : "entries"}
                      </span>
                    </div>
                    {p.rationale && (
                      <p className="text-sm text-on-surface-variant">{p.rationale}</p>
                    )}
                    {p.sample_titles.length > 0 && (
                      <ul className="text-xs text-on-surface-variant pt-2 space-y-0.5">
                        {p.sample_titles.slice(0, 5).map((t, i) => (
                          <li key={i} className="truncate">• {t}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      onClick={() => handleAcceptProposal(p)}
                      disabled={acting === p.id}
                      className="flex-1 flex items-center justify-center gap-2 bg-primary-container text-on-primary-container px-4 py-2.5 rounded-xl font-bold text-sm active:scale-95 transition-transform disabled:opacity-50"
                    >
                      {acting === p.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      Create "{p.proposed_name}"
                    </button>
                    <button
                      onClick={() => handleDismissProposal(p)}
                      disabled={acting === p.id}
                      className="px-3 py-2.5 rounded-xl text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
                      title="Dismiss"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Reroute suggestions */}
          {reroutes.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-bold uppercase tracking-widest text-on-surface-variant px-1">
                Reroute Suggestions · {reroutes.length}
              </div>
              {reroutes.map((s) => (
                <div
                  key={s.id}
                  className="bg-surface-container-low rounded-2xl p-5 border border-outline-variant/10 space-y-3"
                >
                  <div className="space-y-1">
                    <div className="font-bold text-foreground">{s.entry_title}</div>
                    <div className="text-sm text-on-surface-variant flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded bg-surface-container text-xs">{s.from_wiki_name}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                      <span className="px-2 py-0.5 rounded bg-primary-container text-on-primary-container text-xs font-bold">
                        {s.to_wiki_name}
                      </span>
                    </div>
                    <p className="text-sm text-on-surface-variant pt-1">{s.reason}</p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      onClick={() => handleAccept(s)}
                      disabled={acting === s.id}
                      className="flex-1 flex items-center justify-center gap-2 bg-primary-container text-on-primary-container px-4 py-2.5 rounded-xl font-bold text-sm active:scale-95 transition-transform disabled:opacity-50"
                    >
                      {acting === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      Move to {s.to_wiki_name}
                    </button>
                    <button
                      onClick={() => handleDismiss(s, true)}
                      disabled={acting === s.id}
                      className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl font-bold text-sm bg-surface-container text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50"
                    >
                      Keep in {s.from_wiki_name}
                    </button>
                    <button
                      onClick={() => handleDismiss(s, false)}
                      disabled={acting === s.id}
                      className="px-3 py-2.5 rounded-xl text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
                      title="Dismiss"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};


export default SuggestionsTab;
