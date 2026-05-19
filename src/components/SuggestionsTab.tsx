import React, { useEffect, useState, useCallback } from "react";
import { Loader2, ArrowRight, X, Check, Sparkles, RefreshCw } from "lucide-react";
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
} from "@/lib/smartFilingApi";

interface Props {
  onChanged?: () => void;
}

const SuggestionsTab: React.FC<Props> = ({ onChanged }) => {
  const [reroutes, setReroutes] = useState<RerouteSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, en] = await Promise.all([fetchPendingReroutes(), getSmartFilingEnabled()]);
      setReroutes(r);
      setEnabled(en);
    } catch (err: any) {
      toast.error(err.message || "Failed to load suggestions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    try {
      await setSmartFilingEnabled(next);
      if (next) {
        toast.success("Smart Filing turned on");
        // Kick off centroid build so future entries can be routed.
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
              Suggests where new knowledge fits best — across all your wikis. Never moves anything without your tap.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
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

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
        </div>
      ) : reroutes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
          <Sparkles className="w-10 h-10 opacity-40" />
          <p className="text-sm text-center max-w-sm">
            {enabled
              ? "Smart Filing is watching. Suggestions will appear here as the system learns where new knowledge belongs."
              : "Turn on Smart Filing above to start getting routing suggestions."}
          </p>
        </div>
      ) : (
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
  );
};

export default SuggestionsTab;
