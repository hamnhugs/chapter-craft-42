/**
 * Coins: the client's view of the wallet, and the Store's catalog.
 *
 * Everything here is DISPLAY and transport. Prices, pack sizes and per-token
 * rates are decided on the server (supabase/functions/_shared/coin-packs.ts,
 * coin-chat's RATES, the buy_pass SQL function); the copies below exist so
 * the Store can draw a shelf, and a mismatch can only ever mislabel a price
 * tag — it cannot change what anything costs.
 *
 * The wallet is a module-level store (same shape as useEntitlements): one
 * fetch, any component subscribes, and the chat adapter can push a new
 * balance in the moment a reply is billed.
 */

import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface CoinPack {
  id: string;
  name: string;
  coins: number;
  /** Display price, USD. */
  price: string;
  /** Material Symbols glyph. */
  icon: string;
  /** Extra coins over the smallest pack's rate, as a whole percent. */
  bonusPct: number;
  tag?: "popular" | "best";
}

export const COIN_PACKS: CoinPack[] = [
  { id: "pocketful", name: "Pocketful", coins: 500, price: "$2.99", icon: "paid", bonusPct: 0 },
  { id: "satchel", name: "Satchel", coins: 1200, price: "$5.99", icon: "savings", bonusPct: 20, tag: "popular" },
  { id: "chest", name: "Chest", coins: 2800, price: "$11.99", icon: "inventory_2", bonusPct: 40 },
  { id: "vault", name: "Vault", coins: 6500, price: "$24.99", icon: "account_balance", bonusPct: 55, tag: "best" },
];

export interface PassOffer {
  id: "pass_7d" | "pass_30d";
  name: string;
  days: number;
  coins: number;
}

export const PASS_OFFERS: PassOffer[] = [
  { id: "pass_7d", name: "Pro Pass · 7 days", days: 7, coins: 400 },
  { id: "pass_30d", name: "Pro Pass · 30 days", days: 30, coins: 1200 },
];

export const WELCOME_COINS = 100;
export const DAILY_COINS = 10;

/** Model ids are stored with this prefix (lib/providers/registry.ts). */
export const COINS_PREFIX = "coins:";

export interface CoinModel {
  /** Provider-local id — what coin-chat receives. */
  localId: string;
  label: string;
  blurb: string;
  /** Coins per 1,000 tokens in / out (display copy of coin-chat's RATES). */
  rateIn: number;
  rateOut: number;
}

export const COIN_MODELS: CoinModel[] = [
  { localId: "google/gemini-2.5-flash", label: "Swift", blurb: "Fast everyday answers. The thrifty choice.", rateIn: 0.2, rateOut: 1.5 },
  { localId: "google/gemini-3-flash-preview", label: "Sage", blurb: "Stronger reasoning for harder questions.", rateIn: 0.3, rateOut: 2 },
];

export const DEFAULT_COIN_MODEL = COINS_PREFIX + COIN_MODELS[0].localId;

/** What a typical reply costs on a model: ~6,000 tokens of context in, ~400
 *  out. A rough figure for a price tag, never used for billing. */
export function typicalReplyCost(m: CoinModel): number {
  return Math.max(1, Math.ceil(6 * m.rateIn + 0.4 * m.rateOut));
}

export const formatCoins = (n: number) => Math.max(0, Math.floor(n)).toLocaleString("en-US");

// ── wallet store ───────────────────────────────────────────────────────────

export interface Wallet {
  balance: number;
  dailyAvailable: boolean;
  /** ISO time a coin-bought Pro pass runs until, if one is running. */
  passUntil: string | null;
  /** False until the first fetch settles. */
  loaded: boolean;
  /** False when the server has no coins tables yet (migration not applied):
   *  the Store says so instead of showing a wallet that cannot work. */
  available: boolean;
}

const EMPTY: Wallet = { balance: 0, dailyAvailable: false, passUntil: null, loaded: false, available: true };

let wallet: Wallet = EMPTY;
let walletUser: string | null | undefined = undefined;
const listeners = new Set<() => void>();

function publish(next: Wallet) {
  wallet = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => wallet;

/** Missing function / table: the coins migration has not been applied. */
const isMissingSchema = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === "PGRST202" || error.code === "42883" || error.code === "42P01" || /could not find the function|does not exist/i.test(error.message || ""));

export async function refreshWallet(): Promise<Wallet> {
  const forUser = walletUser;
  try {
    const { data, error } = await supabase.rpc("my_wallet" as any);
    if (walletUser !== forUser) return wallet; // signed out / switched mid-flight
    if (error) {
      publish({ ...wallet, loaded: true, available: !isMissingSchema(error) && wallet.available });
      return wallet;
    }
    const d = (data || {}) as any;
    publish({
      balance: Number(d.balance) || 0,
      dailyAvailable: !!d.daily_available,
      passUntil: d.pass_until ?? null,
      loaded: true,
      available: true,
    });
  } catch {
    if (walletUser === forUser) publish({ ...wallet, loaded: true });
  }
  return wallet;
}

/** A balance learned out of band — the chat relay reports it with each bill. */
export function noteBalance(balance: number) {
  if (!Number.isFinite(balance)) return;
  publish({ ...wallet, balance: Math.max(0, Math.floor(balance)), loaded: true, available: true });
}

export async function claimDailyCoins(): Promise<number> {
  const { data, error } = await supabase.rpc("claim_daily_coins" as any);
  if (error) throw new Error(error.message || "Couldn't claim today's coins");
  const d = (data || {}) as any;
  publish({ ...wallet, balance: Number(d.balance) || wallet.balance, dailyAvailable: false });
  return Number(d.granted) || 0;
}

export async function buyPass(kind: PassOffer["id"]): Promise<void> {
  const { data, error } = await supabase.rpc("buy_pass" as any, { _kind: kind } as any);
  if (error) {
    throw new Error(/insufficient_coins/i.test(error.message || "") ? "Not enough coins for that pass." : error.message || "Couldn't buy the pass");
  }
  const d = (data || {}) as any;
  publish({ ...wallet, balance: Number(d.balance) || 0, passUntil: d.pass_until ?? wallet.passUntil });
}

/** Start a Stripe checkout for a coin pack. Resolves to the checkout URL. */
export async function startPackCheckout(packId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("create-checkout", { body: { pack: packId } });
  if (error || !data?.url) throw new Error(error?.message || data?.error || "Could not start checkout");
  return data.url as string;
}

/**
 * Credit any coin packs that have been paid for but not yet added to the
 * wallet. Safe to call as often as you like (the server credits each purchase
 * once). Resolves to the number of coins newly added; 0 on any failure — the
 * next call picks the purchase up.
 */
export async function claimPurchases(): Promise<number> {
  try {
    const { data, error } = await supabase.functions.invoke("claim-coins");
    if (error || !data || data.error) return 0;
    if (Number.isFinite(Number(data.balance))) noteBalance(Number(data.balance));
    return Number(data.credited) || 0;
  } catch {
    return 0;
  }
}

function ensureLoaded(userId: string | null) {
  if (walletUser === userId) return;
  walletUser = userId;
  publish(userId ? EMPTY : { ...EMPTY, loaded: true });
  if (userId) void refreshWallet();
}

export function useWallet(): Wallet {
  const { user } = useAuth();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { ensureLoaded(user?.id ?? null); }, [user?.id]);
  return snap;
}
