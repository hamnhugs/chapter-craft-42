import { describe, it, expect } from "vitest";
import {
  PROGRAM_ERROR_SENTENCES, PROGRAM_UNAVAILABLE_CODES, PROGRAM_UNAVAILABLE_PREFIX,
  isProgramErrorCode, programErrorText, type ProgramErrorCode,
} from "@/lib/programRunner";

/**
 * The runner's error taxonomy holds the same two invariants the sandbox's does:
 * TOTAL (every failure path has a code) and HONEST (every sentence says what
 * happened, in words). And the "harness broke, not the program" classes are
 * marked so program-verify never scores an infra failure against the code.
 */

describe("PROGRAM_ERROR_SENTENCES", () => {
  it("has an honest, non-empty sentence for every code", () => {
    for (const [code, sentence] of Object.entries(PROGRAM_ERROR_SENTENCES)) {
      expect(sentence.length, code).toBeGreaterThan(20);
      // No shrug sentences, no bare codes.
      expect(sentence.toLowerCase()).not.toContain("unknown error");
      expect(sentence).not.toContain(code);
    }
  });

  it("recognises exactly its own codes", () => {
    for (const code of Object.keys(PROGRAM_ERROR_SENTENCES)) {
      expect(isProgramErrorCode(code)).toBe(true);
    }
    expect(isProgramErrorCode("NOT_A_CODE")).toBe(false);
    expect(isProgramErrorCode(undefined)).toBe(false);
  });

  it("composes a sentence with an optional detail", () => {
    const s = programErrorText("PROGRAM_TIMEOUT", "after 15000ms");
    expect(s).toContain("time limit");
    expect(s).toContain("after 15000ms");
  });
});

describe("the unavailable (infra, not program) classes", () => {
  it("marks every harness/infra code and NOT the program's own error", () => {
    // A program's own non-zero exit is the program's fault — never 'unavailable'.
    expect(PROGRAM_UNAVAILABLE_CODES.has("PROGRAM_ERROR")).toBe(false);
    expect(PROGRAM_UNAVAILABLE_CODES.has("PROGRAM_TIMEOUT")).toBe(false);
    expect(PROGRAM_UNAVAILABLE_CODES.has("PROGRAM_OOM")).toBe(false);
    expect(PROGRAM_UNAVAILABLE_CODES.has("PROGRAM_EGRESS_BLOCKED")).toBe(false);
    // …the runner/edge/setup classes ARE infra.
    for (const c of ["PROGRAM_NOT_MIGRATED", "PROGRAM_RUNNER_UNAVAILABLE", "PROGRAM_EDGE_UNAVAILABLE",
      "PROGRAM_SANDBOX_UNAVAILABLE", "PROGRAM_RUNNER_ERROR", "PROGRAM_REQUEST_FAILED"] as ProgramErrorCode[]) {
      expect(PROGRAM_UNAVAILABLE_CODES.has(c), c).toBe(true);
    }
  });

  it("every unavailable code is a real code", () => {
    for (const c of PROGRAM_UNAVAILABLE_CODES) expect(isProgramErrorCode(c)).toBe(true);
  });

  it("the prefix is the load-bearing marker string", () => {
    expect(PROGRAM_UNAVAILABLE_PREFIX).toMatch(/^runner unavailable/i);
  });
});
