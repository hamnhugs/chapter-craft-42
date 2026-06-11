// OpenRouter OAuth PKCE — the no-copy-paste path for non-technical users.
// "Connect" sends them to openrouter.ai, which creates an API key for them
// and redirects back with a one-time code we exchange for the key, entirely
// client-side. Manual key paste remains available as a fallback.

const VERIFIER_KEY = "or_oauth_verifier";

function base64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/**
 * Begin the connect flow. Returns "redirected" when this window navigated to
 * OpenRouter, or "popup" when a new tab was opened instead (used inside the
 * Lovable preview iframe, where external sites refuse to load in-frame).
 */
export async function startOpenRouterConnect(): Promise<"redirected" | "popup"> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  localStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = base64url(await sha256(verifier));
  // Callback to the app origin (before the hash) — the wizard picks the
  // ?code= up on load and finishes the exchange.
  const callback = `${window.location.origin}${window.location.pathname}`;
  const url =
    `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  if (window.self !== window.top) {
    window.open(url, "_blank");
    return "popup";
  }
  window.location.href = url;
  return "redirected";
}

/**
 * Call on app load: if OpenRouter redirected back with a ?code=, exchange it
 * for an API key, clean the URL, and return the key. Returns null when there
 * is nothing to complete.
 */
export async function completeOpenRouterConnect(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!code || !verifier) return null;

  // Clean the URL immediately so a refresh doesn't retry a used code.
  localStorage.removeItem(VERIFIER_KEY);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash || "#/"}`);

  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new Error("OpenRouter key exchange failed — try connecting again.");
  const data = await res.json();
  return typeof data?.key === "string" ? data.key : null;
}

/** Validate a key with a real (free) API call. */
export async function testOpenRouterKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: "OpenRouter rejected this key — double-check you copied the whole thing." };
    return { ok: false, error: `OpenRouter returned an error (${res.status}). Try again in a moment.` };
  } catch {
    return { ok: false, error: "Couldn't reach OpenRouter — check your connection." };
  }
}

export function looksLikeOpenRouterKey(key: string): boolean {
  return key.trim().startsWith("sk-or-");
}
