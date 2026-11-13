import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { usePlan, refreshPlan } from "@/hooks/usePlan";
import { useChatSettings } from "@/hooks/useChatSettings";
import { openExternal, openPricing } from "@/components/PricingDialog";
import { OPEN_ACCESS } from "@/lib/openAccess";
import {
  COIN_MODELS, COIN_PACKS, COINS_PREFIX, DAILY_COINS, PASS_OFFERS,
  buyPass, claimDailyCoins, claimPurchases, formatCoins, refreshWallet, startPackCheckout, typicalReplyCost, useWallet,
  type PassOffer,
} from "@/lib/coins";

/**
 * The Store.
 *
 * Three shelves, top to bottom in the order people need them:
 *
 *   1. Coins — what they are for (Bookworm AI, the built-in models that need
 *      no API key), today's free coins, and the packs.
 *   2. Pro passes — Pro for a week or a month, paid in coins.
 *   3. Plans — the subscription and lifetime plans, paid in money.
 *
 * Nothing here decides a price. Packs, passes and per-reply rates are all set
 * on the server; this component draws the shelf and sends the name of the
 * thing picked.
 */

interface LedgerRow {
  id: string;
  delta: number;
  kind: string;
  note: string | null;
  created_at: string;
}

const KIND_LABEL: Record<string, string> = {
  welcome: "Welcome coins",
  daily: "Daily coins",
  purchase: "Coin pack",
  spend_ai: "Bookworm AI",
  spend_pass: "Pro pass",
  admin: "Adjustment",
  refund: "Refund",
};

const Coin: React.FC<{ className?: string }> = ({ className = "" }) => (
  <span className={`cc-coin ${className}`} aria-hidden>c</span>
);

const SectionTitle: React.FC<{ icon: string; children: React.ReactNode; aside?: React.ReactNode }> = ({ icon, children, aside }) => (
  <div className="cc-banner">
    <span className="material-symbols-outlined text-accent" aria-hidden>{icon}</span>
    <h2 className="text-base">{children}</h2>
    {aside && <span className="ml-auto text-xs font-semibold text-on-surface-variant">{aside}</span>}
  </div>
);

const StorePanel: React.FC = () => {
  const { user } = useAuth();
  const wallet = useWallet();
  const { isPaid, plan, loaded: planLoaded } = usePlan();
  const { selectedModel, savedModels, addModel, setSelectedModel, apiKey, geminiApiKey, nvidiaKeyLast4 } = useChatSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  // A purchase finishes in another tab. Whenever the Store is opened or the
  // window comes back into focus, ask the server to credit anything paid for
  // and not yet in the wallet — each purchase can only ever be credited once.
  const sync = useCallback(async () => {
    const credited = await claimPurchases();
    if (credited > 0) toast.success(`${formatCoins(credited)} coins added to your wallet`);
    await refreshWallet();
  }, []);
  useEffect(() => {
    if (!user) return;
    void sync();
    const onFocus = () => { void sync(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [user, sync]);

  const loadLedger = useCallback(async () => {
    const { data, error } = await supabase
      .from("coin_ledger" as any)
      .select("id, delta, kind, note, created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    setLedger(error ? [] : ((data as unknown as LedgerRow[]) || []));
  }, []);
  useEffect(() => { if (ledgerOpen) void loadLedger(); }, [ledgerOpen, loadLedger, wallet.balance]);

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(null); }
  };

  const claimDaily = () => run("daily", async () => {
    const got = await claimDailyCoins();
    if (got > 0) toast.success(`+${got} coins`);
    else toast("Today's coins are already in your wallet.");
  });

  const buyPack = (id: string) => run(`pack:${id}`, async () => {
    const url = await startPackCheckout(id);
    openExternal(url);
    toast("Opening checkout. Your coins land here as soon as you pay.");
  });

  const buyPassOffer = (offer: PassOffer) => run(offer.id, async () => {
    await buyPass(offer.id);
    await refreshPlan();
    toast.success(`${offer.name} is active`);
  });

  const pickCoinModel = (localId: string) => {
    const id = COINS_PREFIX + localId;
    if (savedModels.includes(id)) setSelectedModel(id);
    else addModel(id);
  };

  const hasOwnKey = !!(apiKey || geminiApiKey || nvidiaKeyLast4);
  const usingCoins = selectedModel.startsWith(COINS_PREFIX);
  const passDate = wallet.passUntil ? new Date(wallet.passUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  const lifetime = plan === "lifetime" || plan === "lifetime_admin";

  return (
    <div className="h-full overflow-auto">
      <main className="cc-page-main max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6 w-full">
        {/* Wallet */}
        <header className="relative overflow-hidden rounded-2xl p-5 sm:p-6 bg-gradient-to-br from-surface-container-highest to-surface-container-low shadow-[inset_0_0_0_1.5px_hsl(var(--outline-variant)/0.4)]">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
            <div className="min-w-0">
              <h1 className="cc-page-title font-headline text-3xl sm:text-4xl font-bold tracking-tight text-primary">Store</h1>
              <p className="mt-1 text-sm text-on-surface-variant max-w-md">
                Coins pay for Bookworm AI — chat with no API key — and for Pro passes.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <div className="text-right">
                <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Your coins</div>
                <div className="flex items-center justify-end gap-2 text-3xl font-black tabular-nums text-foreground" aria-live="polite">
                  <Coin className="!text-base" />
                  {wallet.loaded ? formatCoins(wallet.balance) : "…"}
                </div>
              </div>
              <button
                type="button"
                className="cc-btn3d"
                data-tone={wallet.dailyAvailable ? "accent" : "quiet"}
                disabled={!wallet.available || !wallet.dailyAvailable || busy !== null}
                onClick={claimDaily}
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden>redeem</span>
                {wallet.dailyAvailable ? `Claim +${DAILY_COINS}` : "Claimed today"}
              </button>
            </div>
          </div>
          {wallet.loaded && !wallet.available && (
            <p className="mt-4 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive" role="status">
              Coins aren't switched on for this app yet — the server is missing the coins update. Nothing here can be
              bought until it is applied; your own API key in Settings works as before.
            </p>
          )}
        </header>

        {/* Bookworm AI */}
        <section className="flex flex-col gap-3" aria-label="Bookworm AI">
          <SectionTitle icon="smart_toy" aside={usingCoins ? "In use for chat" : hasOwnKey ? "You're using your own key" : undefined}>
            Bookworm AI
          </SectionTitle>
          <p className="text-sm text-on-surface-variant">
            The built-in models. No account anywhere else, no key to paste — each reply costs a few coins, taken as it is written.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {COIN_MODELS.map((m) => {
              const active = selectedModel === COINS_PREFIX + m.localId;
              return (
                <div key={m.localId} className="cc-offer !items-stretch !text-left" data-featured={active || undefined}>
                  <div className="flex items-start gap-3">
                    <span className="cc-offer-icon !w-11 !h-11 shrink-0">
                      <span className="material-symbols-outlined" aria-hidden>{m.label === "Swift" ? "bolt" : "school"}</span>
                    </span>
                    <div className="min-w-0">
                      <div className="font-black text-foreground">{m.label}</div>
                      <div className="text-xs text-on-surface-variant">{m.blurb}</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-foreground">
                      <Coin /> about {typicalReplyCost(m)} a reply
                    </span>
                    <button
                      type="button"
                      className="cc-btn3d"
                      data-size="sm"
                      data-tone={active ? "quiet" : undefined}
                      disabled={active}
                      onClick={() => pickCoinModel(m.localId)}
                    >
                      {active ? "In use" : "Use for chat"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Coin packs */}
        <section className="flex flex-col gap-3" aria-label="Coin packs">
          <SectionTitle icon="paid">Coins</SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {COIN_PACKS.map((p) => (
              <div key={p.id} className="cc-offer" data-featured={p.tag === "best" || undefined}>
                {p.tag && <span className="cc-ribbon">{p.tag === "best" ? "Best value" : "Popular"}</span>}
                <span className="cc-offer-icon">
                  <span className="material-symbols-outlined text-[30px]" aria-hidden>{p.icon}</span>
                </span>
                <div className="font-black text-foreground">{p.name}</div>
                <div className="flex items-center gap-1.5 text-xl font-black tabular-nums text-foreground">
                  <Coin className="!text-xs" /> {formatCoins(p.coins)}
                </div>
                <div className="h-4 text-[11px] font-bold text-accent">{p.bonusPct > 0 ? `+${p.bonusPct}% more coins` : ""}</div>
                <button
                  type="button"
                  className="cc-btn3d w-full"
                  data-tone="accent"
                  disabled={!wallet.available || busy !== null}
                  onClick={() => buyPack(p.id)}
                  aria-label={`Buy ${p.name}: ${formatCoins(p.coins)} coins for ${p.price}`}
                >
                  {busy === `pack:${p.id}` ? "Opening…" : p.price}
                </button>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-on-surface-variant">
            Payments are processed by Stripe. Coins don't expire. If a purchase doesn't show up, reopen the Store — it checks again every time.
          </p>
        </section>

        {/* Pro passes */}
        <section className="flex flex-col gap-3" aria-label="Pro passes">
          <SectionTitle icon="workspace_premium" aside={passDate ? `Pass runs until ${passDate}` : undefined}>
            Pro passes
          </SectionTitle>
          <p className="text-sm text-on-surface-variant">
            {OPEN_ACCESS
              ? "Everything in Pro is free for everyone right now, so there is nothing to unlock. Passes go on sale if that changes."
              : "Everything in Pro — unlimited notebooks, Deep Research, automatic chapters, no ads — for a set time, paid in coins. Buying another extends the one you have."}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {PASS_OFFERS.map((o) => {
              const short = wallet.balance < o.coins;
              const blocked = OPEN_ACCESS || lifetime || (isPaid && !wallet.passUntil);
              return (
                <div key={o.id} className="cc-offer !flex-row !items-center !text-left !gap-3">
                  <span className="cc-offer-icon !w-12 !h-12 shrink-0">
                    <span className="material-symbols-outlined" aria-hidden>workspace_premium</span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-black text-foreground">{o.name}</div>
                    <div className="text-xs text-on-surface-variant">
                      {OPEN_ACCESS ? "Included for everyone" : lifetime ? "You have Lifetime" : isPaid && !wallet.passUntil ? "You already have Pro" : short ? `${formatCoins(o.coins - wallet.balance)} coins short` : `${o.days} days of Pro`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cc-btn3d shrink-0"
                    disabled={blocked || short || !wallet.available || !planLoaded || busy !== null}
                    onClick={() => buyPassOffer(o)}
                    aria-label={`Buy ${o.name} for ${formatCoins(o.coins)} coins`}
                  >
                    <Coin /> {formatCoins(o.coins)}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Plans */}
        {!OPEN_ACCESS && (
          <section className="flex flex-col gap-3" aria-label="Plans">
            <SectionTitle icon="stars" aside={isPaid ? (lifetime ? "Lifetime" : "Pro") : "Free plan"}>Plans</SectionTitle>
            <div className="cc-offer !flex-row !items-center !text-left !gap-3">
              <span className="cc-offer-icon !w-12 !h-12 shrink-0">
                <span className="material-symbols-outlined" aria-hidden>stars</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-black text-foreground">Pro and Lifetime</div>
                <div className="text-xs text-on-surface-variant">Pro monthly, or pay once and keep it forever.</div>
              </div>
              <button type="button" className="cc-btn3d shrink-0" data-tone="accent" onClick={() => openPricing()}>
                {isPaid ? "Manage" : "See plans"}
              </button>
            </div>
          </section>
        )}

        {/* History */}
        <section className="flex flex-col gap-2" aria-label="Coin history">
          <button
            type="button"
            onClick={() => setLedgerOpen((o) => !o)}
            aria-expanded={ledgerOpen}
            className="self-start inline-flex items-center gap-1 text-sm font-bold text-on-surface-variant hover:text-foreground"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden>{ledgerOpen ? "expand_less" : "expand_more"}</span>
            Coin history
          </button>
          {ledgerOpen && (
            ledger === null ? (
              <p className="text-sm text-on-surface-variant">Loading…</p>
            ) : ledger.length === 0 ? (
              <p className="text-sm text-on-surface-variant">Nothing yet.</p>
            ) : (
              <ul className="rounded-xl bg-surface-container-low border border-outline-variant/15 divide-y divide-outline-variant/10">
                {ledger.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className={`w-16 shrink-0 text-right font-black tabular-nums ${r.delta >= 0 ? "text-primary" : "text-on-surface-variant"}`}>
                      {r.delta >= 0 ? "+" : "−"}{formatCoins(Math.abs(r.delta))}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {KIND_LABEL[r.kind] || r.kind}
                      {r.note && r.kind !== "welcome" && r.kind !== "daily" && (
                        <span className="text-on-surface-variant"> · {r.note}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-on-surface-variant">
                      {new Date(r.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </li>
                ))}
              </ul>
            )
          )}
        </section>
      </main>
    </div>
  );
};

export default StorePanel;
