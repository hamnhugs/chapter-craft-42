import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

const Auth: React.FC = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    // OAuth failures come back as redirect params, never through the
    // signInWithOAuth() call — surface them, else "nothing happens".
    // (main.tsx rewrites bare #error=... fragments to #/auth?... so this
    // page actually mounts to see them.)
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(
      window.location.hash.replace(/^#\/?/, "").split("?").pop() ?? "",
    );
    const desc = search.get("error_description") || hash.get("error_description");
    if (desc) {
      // The param is attacker-craftable (any link can carry it), so cap the
      // length and strip URLs rather than relaying arbitrary copy inside a
      // trusted error toast.
      const clean = desc.replace(/\+/g, " ").replace(/https?:\/\/\S+/gi, "").slice(0, 160).trim();
      toast({ title: "Google sign in failed", description: clean, variant: "destructive" });
      window.history.replaceState(null, "", `${window.location.pathname}#/auth`);
      return;
    }

    // A ?code= still in the URL after client init means the PKCE exchange
    // couldn't run here — the one-shot verifier only exists in the browser
    // where the flow started (e.g. a confirmation email opened on another
    // device). Without this the page just sits there, silently signed out.
    if (search.get("code")) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!session) {
          toast({
            title: "Almost there",
            description:
              "That link couldn't finish signing you in on this device. Your email is confirmed — sign in here to continue.",
          });
          window.history.replaceState(null, "", `${window.location.pathname}#/auth`);
        }
      });
      return;
    }

    // Hand-off arrival from the embedded editor preview (see
    // handleGoogleSignIn): this tab is top-level, start the real redirect.
    if (window.self === window.top && hash.get("google") === "1") {
      window.history.replaceState(null, "", `${window.location.pathname}#/auth`);
      void handleGoogleSignIn();
    }
    // Runs once on mount; toast is stable and handleGoogleSignIn is
    // intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the user presses Back from Google's consent screen, the browser can
  // restore this page from the back/forward cache with googleLoading still
  // true — re-enable the button so sign-in can be retried.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setGoogleLoading(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    if (isLogin) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        toast({ title: "Login failed", description: error.message, variant: "destructive" });
      }
    } else {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) {
        toast({ title: "Sign up failed", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Check your email", description: "We sent you a confirmation link." });
      }
    }

    setLoading(false);
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    // A stale OpenRouter verifier makes SetupWizard's ?code= handler consume
    // Supabase's OAuth code on the way back in. Clear it at the only moment
    // it can do harm — right before Supabase's own ?code= round trip — so an
    // OpenRouter connect interrupted by a session drop can still complete
    // after a password re-login.
    localStorage.removeItem("or_oauth_verifier");

    // Inside the Lovable editor the app runs in a cross-site iframe: Google
    // refuses to render its consent screen in a frame, and browser storage
    // partitioning traps the PKCE verifier in the iframe's own bucket, so a
    // flow started here can never be finished elsewhere. Hand off to our own
    // auth page in a top-level tab and let THAT tab run the whole flow.
    if (window.self !== window.top) {
      window.open(`${window.location.origin}${window.location.pathname}#/auth?google=1`, "_blank");
      setGoogleLoading(false);
      toast({
        title: "Continue in the new tab",
        description:
          "Finish signing in there and keep using the app in that tab — this embedded preview can't share the session.",
      });
      return;
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      toast({ title: "Google sign in failed", description: error.message, variant: "destructive" });
      setGoogleLoading(false);
    }
    // On success the page is navigating to Google; the pageshow handler
    // re-enables the button if the user comes Back instead.
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 z-0 opacity-20 pointer-events-none" style={{ backgroundImage: "radial-gradient(circle at 50% 50%, hsl(43 100% 50%) 0%, transparent 70%)" }} />

      <main className="w-full max-w-md z-10 flex flex-col gap-8">
        {/* Header */}
        <header className="flex flex-col items-center text-center gap-4">
          <div className="w-16 h-16 rounded-xl bg-primary-container flex items-center justify-center shadow-[0px_10px_40px_rgba(255,191,0,0.2)]">
            <span className="material-symbols-outlined text-on-primary-container text-4xl">menu_book</span>
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="font-headline font-bold text-4xl tracking-tight text-primary">Bookworm Studio</h1>
            <p className="text-secondary italic font-headline text-lg">{"\n"}</p>
          </div>
        </header>

        {/* Form */}
        <section className="glass-panel rounded-xl p-8 shadow-[0px_10px_40px_rgba(0,0,0,0.5)] border border-outline-variant/10">
          {/* Toggle */}
          <div className="flex mb-8 bg-surface-container-lowest rounded-lg p-1">
            <button
              onClick={() => setIsLogin(true)}
              className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${isLogin ? "bg-primary-container text-on-primary-container" : "text-on-surface-variant hover:text-primary"}`}
            >
              Sign In
            </button>
            <button
              onClick={() => setIsLogin(false)}
              className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${!isLogin ? "bg-primary-container text-on-primary-container" : "text-on-surface-variant hover:text-primary"}`}
            >
              Sign Up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant ml-1">Email Address</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant text-xl">alternate_email</span>
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                  className="w-full bg-surface-container-low border-none rounded-xl py-4 pl-12 pr-4 text-foreground placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary/40 transition-all"
                  placeholder="scholar@bookwormstudio.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant ml-1">Password</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant text-xl">lock</span>
                <input
                  type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                  className="w-full bg-surface-container-low border-none rounded-xl py-4 pl-12 pr-4 text-foreground placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary/40 transition-all"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit" disabled={loading}
              className="w-full py-4 bg-primary-container text-on-primary-container font-bold rounded-xl shadow-lg active:scale-95 transition-transform duration-150 disabled:opacity-50"
            >
              {loading ? "Loading…" : isLogin ? "Sign In to Library" : "Create Account"}
            </button>

            <div className="relative py-2">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-outline-variant/20" /></div>
              <div className="relative flex justify-center text-xs uppercase tracking-[0.2em]">
                <span className="bg-surface-container px-4 text-on-surface-variant">Or continue with</span>
              </div>
            </div>

            <button
              type="button" onClick={handleGoogleSignIn} disabled={googleLoading}
              className="w-full py-3 bg-surface-container-high text-foreground border border-outline-variant/20 font-medium rounded-xl flex items-center justify-center gap-3 hover:bg-surface-container-highest transition-colors active:scale-95 disabled:opacity-60 disabled:cursor-wait"
            >
              {googleLoading ? (
                <span className="material-symbols-outlined animate-spin text-xl">progress_activity</span>
              ) : (
                // Official multicolor "G" — Google's sign-in branding guidelines
                <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                </svg>
              )}
              {googleLoading ? "Opening Google…" : "Continue with Google"}
            </button>
          </form>
        </section>

      </main>

      {/* Decorative */}
      <div className="absolute -bottom-12 -left-12 w-48 h-48 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -top-12 -right-12 w-64 h-64 bg-secondary/5 rounded-full blur-3xl pointer-events-none" />
    </div>
  );
};

export default Auth;
