import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

/**
 * Memory A/B harness (src/harness/memory) — pointer vs full memory context
 * on the LOCAL stack (real notes, real retrieval, local Ollama model).
 * Separate from the default suite: it needs the local services running and
 * takes several minutes. Run with `npm run eval:memory`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/harness/memory/**/*.e2run.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
