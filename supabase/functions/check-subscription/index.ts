import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Plan = "free" | "monthly" | "lifetime" | "lifetime_admin";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user?.email) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service role to write the subscribers cache (clients are read-only via RLS).
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY is not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    let plan: Plan = "free";
    let subscribed = false;
    let subscriptionEnd: string | null = null;
    let billingIssue = false;
    let cancelAtPeriodEnd = false;
    let customerId: string | null = null;

    // Preserve admin-granted lifetime access — never downgrade these from Stripe polling.
    const { data: existingRow } = await serviceClient
      .from("subscribers")
      .select("plan, granted_by_admin_id")
      .or(`user_id.eq.${user.id},email.eq.${user.email}`)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingRow?.plan === "lifetime_admin") {
      return new Response(
        JSON.stringify({
          subscribed: true,
          plan: "lifetime_admin",
          subscription_end: null,
          billing_issue: false,
          cancel_at_period_end: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;

      // Monthly subscription: active/trialing are entitled; past_due gets a
      // grace period (Stripe Smart Retries may still recover the payment).
      const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
      const entitled = subs.data.find((s) => s.status === "active" || s.status === "trialing");
      const pastDue = subs.data.find((s) => s.status === "past_due");
      const sub = entitled || pastDue;
      if (sub) {
        plan = "monthly";
        subscribed = true;
        billingIssue = !entitled;
        subscriptionEnd = new Date(sub.current_period_end * 1000).toISOString();
        cancelAtPeriodEnd = !!sub.cancel_at_period_end;
      }

      // Lifetime: any paid one-time checkout tagged at creation. Re-derived on
      // every poll so a missed success redirect can never lose the purchase.
      const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 100 });
      const lifetime = sessions.data.find(
        (s) => s.mode === "payment" && s.payment_status === "paid" && s.metadata?.product === "lifetime",
      );
      if (lifetime) {
        plan = "lifetime";
        subscribed = true;
        billingIssue = false;
        subscriptionEnd = null;
        cancelAtPeriodEnd = false;
      }
    }

    await serviceClient.from("subscribers").upsert(
      {
        email: user.email,
        user_id: user.id,
        stripe_customer_id: customerId,
        subscribed,
        plan,
        subscription_end: subscriptionEnd,
        billing_issue: billingIssue,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" },
    );

    return new Response(
      JSON.stringify({
        subscribed,
        plan,
        subscription_end: subscriptionEnd,
        billing_issue: billingIssue,
        cancel_at_period_end: cancelAtPeriodEnd,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("check-subscription error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
