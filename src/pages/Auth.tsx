import React, { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

const Auth: React.FC = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

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
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      toast({ title: "Google sign in failed", description: error.message, variant: "destructive" });
    }
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
            <h1 className="font-headline font-bold text-4xl tracking-tight text-primary">Chapter Craft</h1>
            <p className="text-secondary italic font-headline text-lg">Curate your intellectual legacy.</p>
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
                  placeholder="scholar@chaptercraft.com"
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
              type="button" onClick={handleGoogleSignIn}
              className="w-full py-3 bg-surface-container-high text-foreground border border-outline-variant/20 font-medium rounded-xl flex items-center justify-center gap-3 hover:bg-surface-container-highest transition-colors active:scale-95"
            >
              <span className="material-symbols-outlined">account_circle</span>
              Google Account
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
