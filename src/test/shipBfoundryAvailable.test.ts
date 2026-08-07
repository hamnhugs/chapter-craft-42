import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * foundryAvailable() caches its answer for the session. Which failures are
 * cacheable is a correctness question, not an optimisation one: caching a
 * transient failure bricks the whole Foundry — every verb, the Settings list,
 * and the system-prompt roster — until the user reloads the app.
 */
const probe = vi.hoisted(() => ({ result: { error: null as unknown }, calls: 0 }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        limit: async () => {
          probe.calls++;
          if (probe.result.error === "throw") throw new Error("offline");
          return { data: [], error: probe.result.error };
        },
      }),
    }),
  },
}));

const { foundryAvailable, resetFoundryAvailability } = await import("@/lib/toolFoundry");

beforeEach(() => {
  resetFoundryAvailability();
  probe.calls = 0;
  probe.result.error = null;
});

describe("foundryAvailable caching", () => {
  it("probes once on success and never again", async () => {
    expect(await foundryAvailable()).toBe(true);
    expect(await foundryAvailable()).toBe(true);
    expect(probe.calls).toBe(1);
  });

  it("caches a MISSING SCHEMA answer — the migration is user-gated, so stop asking", async () => {
    probe.result.error = { code: "42P01" };
    expect(await foundryAvailable()).toBe(false);
    expect(await foundryAvailable()).toBe(false);
    expect(probe.calls).toBe(1);
  });

  it("leaves a TRANSIENT failure re-probeable, and recovers when it clears", async () => {
    probe.result.error = { code: "PGRST301", message: "JWT expired" };
    expect(await foundryAvailable()).toBe(false);
    expect(await foundryAvailable()).toBe(false);
    expect(probe.calls).toBe(2); // it really did ask again

    probe.result.error = null;
    expect(await foundryAvailable()).toBe(true);
    expect(probe.calls).toBe(3);
  });

  it("treats a thrown probe (offline) as transient too", async () => {
    probe.result.error = "throw";
    expect(await foundryAvailable()).toBe(false);
    probe.result.error = null;
    expect(await foundryAvailable()).toBe(true);
    expect(probe.calls).toBe(2);
  });

  it("collapses a burst of concurrent callers into a single probe", async () => {
    const all = await Promise.all([foundryAvailable(), foundryAvailable(), foundryAvailable()]);
    expect(all).toEqual([true, true, true]);
    expect(probe.calls).toBe(1);
  });
});
