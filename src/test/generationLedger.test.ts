import { describe, it, expect } from "vitest";
import {
  REJECTION_REASONS, ledgerMigrated, recordGeneration, decideGeneration, ledgerStats,
  type RejectionReason, type LedgerKind, type LedgerStatus,
} from "@/lib/generationLedger";

// The ledger's database functions need a signed-in Supabase session, and no
// test in this suite mocks the Supabase client — so, matching the rest of the
// suite, these tests cover only the pure surface: the rejection taxonomy and
// the exported shape. The taxonomy is worth pinning because it is what turns
// the ledger from bookkeeping into a steering wheel ("this model fails
// structurally, that one on identity") — a renamed reason would silently
// orphan every verdict already recorded under the old name.

describe("rejection taxonomy", () => {
  it("carries the documented production post-mortem categories", () => {
    expect([...REJECTION_REASONS]).toEqual([
      "structural",
      "identity",
      "temporal",
      "compositional",
      "prompt_miss",
      "policy",
      "aesthetic",
    ]);
  });

  it("holds one-tap-sized snake_case tokens with no duplicates", () => {
    // These render as tap targets and land in a DB column — shape matters.
    expect(new Set(REJECTION_REASONS).size).toBe(REJECTION_REASONS.length);
    for (const reason of REJECTION_REASONS) {
      expect(reason).toMatch(/^[a-z][a-z_]*$/);
      expect(reason.length).toBeLessThanOrEqual(20);
    }
  });

  it("includes 'aesthetic', the fallback decideGeneration records for a bare rejection", () => {
    expect(REJECTION_REASONS).toContain("aesthetic");
  });
});

describe("exported surface", () => {
  it("exports the ledger operations as functions", () => {
    expect(typeof ledgerMigrated).toBe("function");
    expect(typeof recordGeneration).toBe("function");
    expect(typeof decideGeneration).toBe("function");
    expect(typeof ledgerStats).toBe("function");
  });

  it("keeps the union types assignable from their documented members", () => {
    // Compile-time checks: a drifted union breaks the build here, not at a
    // call site three files away.
    const reason: RejectionReason = "temporal";
    const kind: LedgerKind = "splat";
    const status: LedgerStatus = "candidate";
    expect([reason, kind, status]).toEqual(["temporal", "splat", "candidate"]);
  });
});
