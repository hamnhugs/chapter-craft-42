import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

/**
 * E2 harness config — the Card Catalog quality gate (full vs catalog A/B).
 *
 * DELIBERATELY separate from vitest.config.ts: harness entry files are named
 * *.e2run.ts so the default suite can never collect them (they hit the live
 * OpenRouter API with the user's key and run for many minutes), and this
 * config exists so they run ONLY on an explicit
 *
 *   npm run e2 -- src/harness/e2/answer.e2run.ts
 *
 * Serial on purpose: one conversation at a time keeps provider rate limits,
 * checkpoint writes, and cost attribution simple.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/harness/e2/**/*.e2run.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    // Must clear the answer phase's own 450s per-question abort budget plus
    // retries and the checkpoint append — vitest must never be the thing
    // that kills a question AFTER the provider spend but BEFORE its row
    // lands (that row is what makes reruns free).
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
