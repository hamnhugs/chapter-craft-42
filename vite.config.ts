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
/** Every remote origin the app may fetch from at runtime. Kept as an array so
 *  the assertion below can check it against the provider registry — a missing
 *  origin here fails ONLY in production builds (dev has no CSP), which is the
 *  most expensive kind of bug this project has shipped. */
const CONNECT_ORIGINS = [
  "'self'",
  // data:/blob: are REQUIRED and safe: fetch() of either is self-contained —
  // no request leaves the browser, so neither is an exfiltration channel.
  // Without them, storeGeneratedImage/imageUpload (fetch(dataUrl) → Blob) and
  // pdf.js (fetches the book's object URL internally) break in production
  // while working fine in dev, where no CSP applies.
  "data:",
  "blob:",
  "https://ktzaysdkdkocqhewwtnn.supabase.co",
  "wss://ktzaysdkdkocqhewwtnn.supabase.co",
  "https://tmagmbmitnvcwubxcwoc.supabase.co", // Burplexity (web search)
  "https://api.tavily.com", // free web-search tier
  "https://openrouter.ai",
  "https://generativelanguage.googleapis.com", // Gemini — browser-direct, no relay
  "https://queue.fal.run",
  "https://fal.media",
  "https://*.fal.media",
  "https://cdn.jsdelivr.net", // lazy VAD + onnxruntime
  // transformers.js downloads the video-QC vision model from the HF hub at
  // first use. QC is ON by default, so omitting these silently broke identity
  // checks in every production build.
  "https://huggingface.co",
  "https://cdn-lfs.huggingface.co",
  "https://cdn-lfs-us-1.huggingface.co",
];

// Production Content-Security-Policy. Every origin here is load-bearing —
// audit before removing: Supabase project (API/storage/functions + realtime
// websocket), Burplexity's Supabase instance (bot-ask/bot-search), OpenRouter
// (chat/image/video), Gemini (chat/images/search grounding), fal (video/splat
// queue + result CDN), jsDelivr (lazy VAD + onnxruntime for barge-in),
// Hugging Face (video-QC model weights), Google Fonts (index.css + themes.ts).
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
  `connect-src ${CONNECT_ORIGINS.join(" ")}`,
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Build-time guard: every provider base URL must be reachable under the CSP.
 *  A provider added without its origin works perfectly in dev and dies in
 *  production — this turns that into a build failure instead. */
const PROVIDER_ORIGINS = [
  "https://openrouter.ai",
  "https://generativelanguage.googleapis.com",
  // NVIDIA is deliberately absent: it is CORS-blocked and reached only
  // through the Supabase relay, whose origin is already listed.
];
for (const origin of PROVIDER_ORIGINS) {
  if (!CONNECT_ORIGINS.includes(origin)) {
    throw new Error(
      `CSP: provider origin ${origin} is missing from connect-src. ` +
      `Add it to CONNECT_ORIGINS in vite.config.ts — without it the provider ` +
      `works in dev and fails only in production builds.`,
    );
  }
}

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
    // The QuickJS emscripten glue carries exactly one `import.meta.url` — a
    // no-op `new URL(".", …)` probe already wrapped in try/catch. That single
    // token is a hard SyntaxError ("Cannot use 'import.meta' outside a
    // module") in a CLASSIC worker, which pins the sandbox transport to
    // { type: "module" } for no benefit at all. After inlineDynamicImports the
    // bundle has no import/export statements left, so this token is the only
    // thing standing between it and a classic-worker-compatible script — which
    // the opaque-origin iframe may need. `location.href` is the same value
    // inside a worker, blob-hosted or not.
    //
    // The chunk also embeds the whole QuickJS WASM as a string literal, and a
    // blind rewrite inside THAT would corrupt the engine silently. The token
    // does not occur there (QuickJS's own diagnostics are "import.meta not
    // supported in this context" / "import.meta only valid in module code" —
    // no `.url`), so the expected count is exactly one. More than one means
    // something changed under us; fail the build rather than gamble.
    plugins: () => [
      {
        name: "sandbox-worker-drop-import-meta",
        enforce: "post",
        renderChunk(code: string) {
          const hits = code.split("import.meta.url").length - 1;
          if (hits === 0) return null;
          if (hits > 1) {
            throw new Error(
              `sandbox-worker-drop-import-meta: expected at most 1 import.meta.url in the worker ` +
              `chunk, found ${hits}. Confirm none of them sits inside the embedded WASM string ` +
              `literal before widening this rewrite — corrupting it fails at runtime, not here.`,
            );
          }
          return { code: code.split("import.meta.url").join("(location.href)"), map: null };
        },
      } as Plugin,
    ],
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
