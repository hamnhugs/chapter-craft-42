import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

export default defineConfig(({ mode }) => ({
  base: "./",
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Spark and react-force-graph-3d both depend on three. Two copies would be
    // two different WebGLRenderer classes, which fails silently at instanceof
    // checks rather than erroring — force a single instance.
    dedupe: ["three"],
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          supabase: ["@supabase/supabase-js"],
          pdf: ["pdfjs-dist", "react-pdf"],
          // ~1.78 MB gzipped — isolated so it only loads when a user opens a
          // 3D model, never as part of first paint.
          spark: ["@sparkjsdev/spark"],
        },
      },
    },
  },
}));
