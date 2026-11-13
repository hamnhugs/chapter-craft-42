import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { COIN_PACKS } from "../_shared/coin-packs.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Prices live server-side only — the client may pick a plan name, never an amount.
const PLANS = {
  monthly: {
    name: "Bookworm Pro — Monthly (BYOK)",
    description: "Unlimited neurons, Deep Research, no ads. Bring your own API keys — pay only for what you use.",
    unit_amount: 499,
    mode: "subscription" as const,
  },
  lifetime: {
    name: "Bookworm Lifetime",
    description: "Everything in Pro, forever, including all future updates. One payment.",
    unit_amount: 19700,
    mode: "payment" as const,
  },
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user?.email) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { plan, pack } = await req.json();
    // Two kinds of purchase share this function: a plan (monthly / lifetime)
    // or a coin pack. Either way the client sends a NAME; the price is looked
    // up here.
    const coinPack = typeof pack === "string" ? COIN_PACKS[pack] : undefined;
    if (!coinPack && plan !== "monthly" && plan !== "lifetime") {
      return new Response(JSON.stringify({ error: pack ? "Invalid coin pack" : "Invalid plan" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const planDef = coinPack
      ? {
          name: coinPack.name,
          description: `${coinPack.coins.toLocaleString("en-US")} coins for Bookworm AI and Pro passes.`,
          unit_amount: coinPack.unit_amount,
          mode: "payment" as const,
        }
      : PLANS[plan as keyof typeof PLANS];
    const product = coinPack ? `coins:${coinPack.id}` : plan;

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY is not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    // Reuse the existing Stripe customer for this email if there is one.
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    const customerId = customers.data.length > 0 ? customers.data[0].id : undefined;

    const origin = req.headers.get("origin") || "";
    const session = await stripe.checkout.sessions.create({
      ...(customerId
        ? { customer: customerId }
        : {
            customer_email: user.email,
            // Payment mode would otherwise create a guest customer that the
            // email lookup in check-subscription can never find again.
            ...(planDef.mode === "payment" ? { customer_creation: "always" as const } : {}),
          }),
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: planDef.name, description: planDef.description },
            unit_amount: planDef.unit_amount,
            ...(planDef.mode === "subscription" ? { recurring: { interval: "month" as const } } : {}),
          },
          quantity: 1,
        },
      ],
      mode: planDef.mode,
      ...(planDef.mode === "payment" ? { invoice_creation: { enabled: true } } : {}),
      allow_promotion_codes: true,
      client_reference_id: user.id,
      metadata: { user_id: user.id, product },
      success_url: `${origin}/#/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#/`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-checkout error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
