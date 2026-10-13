import { describe, it, expect, vi, afterEach } from "vitest";

const auth = {
  getSession: vi.fn(),
  signInWithPassword: vi.fn(),
};
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("@/lib/localAutoSignIn");
}

afterEach(() => {
  vi.unstubAllEnvs();
  auth.getSession.mockReset();
  auth.signInWithPassword.mockReset();
});

const LOCAL = {
  VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  VITE_LOCAL_AUTO_EMAIL: "owner@chapter-craft.local",
  VITE_LOCAL_AUTO_PASSWORD: "pw",
};

describe("local auto sign-in", () => {
  it("signs in once with the owner account when there is no session", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } });
    auth.signInWithPassword.mockResolvedValue({ error: null });
    const m = await load(LOCAL);
    expect(m.localAutoSignInEnabled()).toBe(true);
    await Promise.all([m.ensureLocalSession(), m.ensureLocalSession()]);
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "owner@chapter-craft.local", password: "pw" });
  });

  it("leaves an existing session alone", async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u" } } } });
    const m = await load(LOCAL);
    await m.ensureLocalSession();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("never runs against a hosted backend, even with credentials present", async () => {
    const m = await load({ ...LOCAL, VITE_SUPABASE_URL: "https://ktzaysdkdkocqhewwtnn.supabase.co" });
    expect(m.localAutoSignInEnabled()).toBe(false);
    await m.ensureLocalSession();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("a failed sign-in resolves (the sign-in page then shows) instead of hanging", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } });
    auth.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await load(LOCAL);
    await expect(m.ensureLocalSession()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
