import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import {
  Announcement,
  fetchAnnouncementsAndReceipts,
  recordAnnouncementSeen,
  dismissAnnouncement,
  acceptWelcome,
  isSafeHttpsUrl,
} from "@/lib/announcementsApi";

// First-login privacy gate + admin-managed splash announcements.
//
// Welcome (kind='welcome', require_ack): a true clickwrap — blocking dialog,
// unticked accept toggle, disabled continue button, ESC/outside-click do
// nothing, and acceptance is recorded server-side with the policy version
// (Meyer v. Uber / Berman line: conspicuous notice + unambiguous affirmative
// act + a record of assent). Bumping policy_version re-prompts everyone.
//
// Splash announcements: NN/g guidance — at most ONE modal per session, shown
// at login (the least disruptive moment), freely dismissible (ESC, outside
// click, button), dismissal recorded server-side so it follows the user
// across devices. If the welcome gate ran this session, splashes wait for
// the next one.

const SPLASH_SESSION_KEY = "bw_splash_shown";

// --- consent store: SetupWizard waits for this before auto-opening --------
let consentState = { resolved: false };
const consentListeners = new Set<() => void>();
function markConsentResolved() {
  if (consentState.resolved) return;
  consentState = { resolved: true };
  consentListeners.forEach((l) => l());
}
const subscribeConsent = (l: () => void) => {
  consentListeners.add(l);
  return () => { consentListeners.delete(l); };
};
const getConsentState = () => consentState;

/** True once the privacy gate is satisfied (accepted, not required, or unavailable). */
export function useConsentResolved(): boolean {
  return useSyncExternalStore(subscribeConsent, getConsentState, getConsentState).resolved;
}

// --- safe GIF / image block (shared with the admin preview) ----------------
export const AnnouncementGif: React.FC<{ announcement: Announcement }> = ({ announcement: a }) => {
  const [revealed, setRevealed] = useState(false);
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );
  if (!isSafeHttpsUrl(a.gif_url)) return null;

  // WCAG 2.2.2: with reduced motion on, don't auto-play a looping GIF —
  // show a click-to-reveal placeholder instead.
  if (reducedMotion && !revealed) {
    return (
      <button
        onClick={() => setRevealed(true)}
        className="w-full h-36 rounded-xl bg-surface-container-high border border-outline-variant/20 flex flex-col items-center justify-center gap-2 text-on-surface-variant hover:text-primary transition-colors"
      >
        <span className="material-symbols-outlined text-3xl" aria-hidden>play_circle</span>
        <span className="text-xs font-bold uppercase tracking-widest">Show animation</span>
      </button>
    );
  }

  const img = (
    <img
      src={a.gif_url!}
      alt={a.gif_alt || a.title || "Announcement image"}
      referrerPolicy="no-referrer"
      className="w-full max-h-64 object-contain rounded-xl bg-surface-container-high"
    />
  );

  if (a.gif_clickable && isSafeHttpsUrl(a.gif_link_url)) {
    return (
      <a
        href={a.gif_link_url!}
        target={a.gif_new_tab ? "_blank" : "_self"}
        rel="noopener noreferrer"
        title={a.gif_link_url!}
        className="block rounded-xl ring-offset-2 hover:ring-2 hover:ring-primary/50 transition-shadow"
      >
        {img}
      </a>
    );
  }
  return img;
};

// ---------------------------------------------------------------------------

const WelcomeGate: React.FC = () => {
  const { user } = useAuth();
  const [welcome, setWelcome] = useState<Announcement | null>(null);
  const [splash, setSplash] = useState<Announcement | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const { announcements, receipts } = await fetchAnnouncementsAndReceipts(user.id);
        if (cancelled) return;
        const receiptFor = (id: string) => receipts.find((r) => r.announcement_id === id);

        const welcomeRow = announcements.find((a) => a.kind === "welcome" && a.is_active);
        const wReceipt = welcomeRow ? receiptFor(welcomeRow.id) : undefined;
        const welcomePending =
          !!welcomeRow &&
          welcomeRow.require_ack &&
          (!wReceipt?.acknowledged_at || wReceipt.policy_version < welcomeRow.policy_version);

        if (welcomePending) {
          setWelcome(welcomeRow!);
          return; // splash waits for the next session — one modal at a time
        }
        markConsentResolved();

        // One splash per browser session, highest priority first.
        if (sessionStorage.getItem(SPLASH_SESSION_KEY)) return;
        const next = announcements.find((a) => {
          if (a.kind !== "announcement" || !a.is_active) return false;
          const r = receiptFor(a.id);
          return !r?.dismissed_at || r.policy_version < a.policy_version;
        });
        if (next) {
          sessionStorage.setItem(SPLASH_SESSION_KEY, next.id);
          setSplash(next);
          recordAnnouncementSeen(user.id, next).catch(() => {});
        }
      } catch {
        // Migration not applied yet (or offline) — never block the app.
        if (!cancelled) markConsentResolved();
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  const handleAccept = async () => {
    if (!user || !welcome || !accepted) return;
    setSaving(true);
    try {
      await acceptWelcome(user.id, welcome);
      setWelcome(null);
      markConsentResolved();
    } catch (err: any) {
      toast.error(err.message || "Could not record your acceptance — please try again");
    } finally {
      setSaving(false);
    }
  };

  const closeSplash = (record: boolean) => {
    if (record && user && splash) {
      dismissAnnouncement(user.id, splash).catch(() => {});
    }
    setSplash(null);
  };

  return (
    <>
      {/* Blocking privacy/welcome gate — no escape hatch until accepted */}
      <Dialog open={!!welcome}>
        <DialogContent
          className="max-w-lg max-h-[90vh] overflow-y-auto [&>button]:hidden"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {welcome && (
            <>
              <DialogHeader>
                <DialogTitle className="font-headline text-3xl">{welcome.title}</DialogTitle>
                <DialogDescription className="sr-only">
                  Privacy statement — please read and accept to continue.
                </DialogDescription>
              </DialogHeader>

              <AnnouncementGif announcement={welcome} />

              <div className="text-sm text-on-surface-variant whitespace-pre-wrap leading-relaxed">
                {welcome.body}
              </div>

              <div className="flex items-start justify-between gap-4 p-3 rounded-lg bg-surface-container-high border border-outline-variant/10">
                <label htmlFor="welcome-accept" className="text-sm font-medium text-foreground cursor-pointer">
                  I have read and accept the privacy statement above.
                </label>
                <Switch id="welcome-accept" checked={accepted} onCheckedChange={setAccepted} />
              </div>

              <DialogFooter>
                <Button onClick={handleAccept} disabled={!accepted || saving} className="w-full gap-2">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Accept & continue"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Splash announcement — freely dismissible */}
      <Dialog open={!!splash} onOpenChange={(o) => !o && closeSplash(true)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          {splash && (
            <>
              <DialogHeader>
                <DialogTitle className="font-headline text-3xl">{splash.title}</DialogTitle>
                <DialogDescription className="sr-only">Announcement</DialogDescription>
              </DialogHeader>

              <AnnouncementGif announcement={splash} />

              {splash.body && (
                <div className="text-sm text-on-surface-variant whitespace-pre-wrap leading-relaxed">
                  {splash.body}
                </div>
              )}

              <DialogFooter className="gap-2">
                {splash.gif_clickable && isSafeHttpsUrl(splash.gif_link_url) && (
                  <Button asChild variant="outline" className="gap-1.5">
                    <a href={splash.gif_link_url!} target={splash.gif_new_tab ? "_blank" : "_self"} rel="noopener noreferrer">
                      Learn more <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </Button>
                )}
                <Button onClick={() => closeSplash(true)}>Got it</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default WelcomeGate;
