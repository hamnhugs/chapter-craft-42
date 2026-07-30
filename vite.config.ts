import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Production Content-Security-Policy. Every origin here is load-bearing —
// audit before removing: Supabase project (API/storage/functions + realtime
// websocket), Burplexity's Supabase instance (bot-ask/bot-search), OpenRouter
// (chat/image/video), fal (video/splat queue + result CDN), jsDelivr (lazy
// VAD + onnxruntime for barge-in), Google Fonts (index.css + themes.ts).
// img-src is the exfiltration backstop behind markdownSafety.tsx — do NOT
// widen it to https:. Injected at build only so Vite dev/HMR (inline
// react-refresh preamble, localhost websocket) keeps working unrestricted.
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://ktzaysdkdkocqhewwtnn.supabase.co https://media.giphy.com",
  "media-src 'self' blob: data: https://ktzaysdkdkocqhewwtnn.supabase.co",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://ktzaysdkdkocqhewwtnn.supabase.co wss://ktzaysdkdkocqhewwtnn.supabase.co https://tmagmbmitnvcwubxcwoc.supabase.co https://openrouter.ai https://queue.fal.run https://fal.media https://*.fal.media https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const cspPlugin = (): Plugin => ({
  name: "csp-meta",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html) => ({
      html,
      tags: [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: PROD_CSP },
          injectTo: "head-prepend",
        },
      ],
    }),
  },
});

export default defineConfig(({ mode }) => ({
  base: "./",
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
  plugins: [
    react(),
    cspPlugin(),
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
  worker: {
    // The Foundry sandbox worker must be ONE self-contained file: its built
    // text is fetched and re-instantiated as a blob Worker inside the
    // opaque-origin iframe (connect-src 'none'), where relative chunk imports
    // could never resolve. ES + inlineDynamicImports collapses the QuickJS
    // variant's dynamic import into a single module.
    format: "es",
    rollupOptions: { output: { inlineDynamicImports: true } },
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
