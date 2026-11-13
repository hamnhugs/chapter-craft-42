// claim-coins: credit the caller's wallet for every coin pack they have paid
// for.
//
// There is no webhook to miss. Like check-subscription's lifetime check, this
// RE-DERIVES the truth from Stripe each time it runs: list the customer's
// paid checkout sessions tagged `coins:<pack>` and credit each one. The
// ledger's unique `ref` (the Stripe session id) makes a credit happen exactly
// once however often this is called — on the payment-success page, and again
// whenever the Store opens, so a closed tab between paying and returning
// never loses a purchase.
//
// The number of coins comes from the pack table on the server, checked
// against the amount Stripe says was actually paid.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { COIN_PACKS } from "../_shared/coin-packs.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user?.email) return json({ error: "Unauthorized" }, 401);

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    let credited = 0;
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    if (customers.data.length > 0) {
      const sessions = await stripe.checkout.sessions.list({ customer: customers.data[0].id, limit: 100 });
      for (const s of sessions.data) {
        const product = s.metadata?.product || "";
        if (s.mode !== "payment" || s.payment_status !== "paid" || !product.startsWith("coins:")) continue;
        // The session must have been created for THIS account, not merely
        // for a customer sharing its email.
        if (s.metadata?.user_id !== user.id) continue;
        const pack = COIN_PACKS[product.slice("coins:".length)];
        if (!pack) continue;
        // A promotion code may lower the total; a pack is still a pack. But a
        // session whose pre-discount price is not the pack's is not ours.
        if ((s.amount_subtotal ?? 0) !== pack.unit_amount) continue;
        const { data: before } = await service.from("coin_wallets").select("balance").eq("user_id", user.id).maybeSingle();
        const { data: after, error } = await service.rpc("coin_apply", {
          _user_id: user.id,
          _delta: pack.coins,
          _kind: "purchase",
          _ref: `stripe:${s.id}`,
          _note: pack.name,
          _clamp: false,
        });
        if (error) {
          console.error("claim-coins credit failed:", s.id, error.message);
          continue;
        }
        credited += Math.max(0, Number(after ?? 0) - Number(before?.balance ?? 0));
      }
    }

    const { data: wallet } = await service.from("coin_wallets").select("balance").eq("user_id", user.id).maybeSingle();
    return json({ credited, balance: Number(wallet?.balance ?? 0) });
  } catch (e) {
    console.error("claim-coins error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
