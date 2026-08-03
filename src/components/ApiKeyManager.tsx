import React, { useState, useEffect, useCallback } from "react";
import { Key, Copy, Trash2, Plus, Check, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

// Keys are stored server-side as SHA-256 digests only (migration
// 20260802150000). The plaintext exists exactly once, in memory, between
// generation and the one-time reveal below — it can never be re-fetched.
interface ApiKey {
  id: string;
  label: string;
  key_prefix: string | null;
  created_at: string;
  revoked_at: string | null;
}

const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_LENGTH = 32;
const KEY_PREFIX_CHARS = 10;

const generateKey = () => {
  // Rejection sampling: 248 is the largest multiple of 62 that fits in a
  // byte, so bytes 248–255 are discarded to keep every character equally
  // likely (a bare `byte % 62` would bias toward the early alphabet).
  let secret = "";
  const buf = new Uint8Array(KEY_LENGTH * 2);
  while (secret.length < KEY_LENGTH) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= 248) continue;
      secret += KEY_CHARS[byte % 62];
      if (secret.length === KEY_LENGTH) break;
    }
  }
  return `worm_${secret}`;
};

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// The hash columns arrive with migration 20260802150000. Inserting before it
// is applied fails with undefined_column — surface that plainly rather than
// ever falling back to plaintext storage.
const isMissingHashColumn = (error: { code?: string; message?: string }) =>
  error.code === "42703" || /key_hash|key_prefix/.test(error.message ?? "");

const ApiKeyManager: React.FC = () => {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    if (!user) return;
    // "*" (not explicit columns) so the list keeps rendering during the
    // window before the migration adds key_prefix. Cast: generated types
    // predate the hash columns.
    const { data } = await (supabase.from("api_keys" as any) as any)
      .select("*")
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (data) setKeys(data as ApiKey[]);
  }, [user]);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const createKey = async () => {
    if (!user) return;
    setCreating(true);
    const keyValue = generateKey();
    const { error } = await (supabase.from("api_keys" as any) as any).insert({
      user_id: user.id,
      key_hash: await sha256Hex(keyValue),
      key_prefix: keyValue.slice(0, KEY_PREFIX_CHARS),
      label: label.trim() || "Default",
    });
    if (error) {
      if (isMissingHashColumn(error)) {
        toast.error("API key storage needs migration 20260802150000 applied first — ask Lovable to run it.");
      } else {
        toast.error("Failed to create API key");
      }
    } else {
      toast.success("API key created");
      setRevealedKey(keyValue);
      setLabel("");
      await loadKeys();
    }
    setCreating(false);
  };

  const revokeKey = async (id: string) => {
    const { error } = await supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      toast.error(`Failed to revoke API key: ${error.message}`);
      return;
    }
    toast.success("API key revoked");
    await loadKeys();
  };

  const copyKey = (key: string, id: string) => {
    navigator.clipboard.writeText(key);
    setCopiedId(id);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-display font-semibold text-foreground">
        <Key className="w-4 h-4 text-accent" />
        API Keys
      </div>

      <p className="text-xs text-muted-foreground">
        Generate API keys for bot access. Include the key as <code className="bg-secondary px-1 py-0.5 rounded text-xs">x-api-key</code> header in requests.
      </p>

      {/* Create new key */}
      <div className="flex gap-2">
        <Input
          placeholder="Key label (e.g. Wormy)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="text-sm h-8"
        />
        <Button size="sm" onClick={createKey} disabled={creating} className="shrink-0 h-8">
          <Plus className="w-3.5 h-3.5 mr-1" />
          Generate
        </Button>
      </div>

      {/* One-time reveal — the only place the full key ever appears */}
      {revealedKey && (
        <div className="p-2 rounded-md border border-accent/50 bg-accent/10 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <AlertTriangle className="w-3.5 h-3.5 text-accent shrink-0" />
            Copy this key now — it cannot be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 text-[11px] text-foreground font-mono break-all">
              {revealedKey}
            </code>
            <button
              onClick={() => copyKey(revealedKey, "revealed")}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Copy full key"
            >
              {copiedId === "revealed" ? <Check className="w-3.5 h-3.5 text-accent" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setRevealedKey(null)} className="w-full h-6 text-xs">
            Done — I copied it
          </Button>
        </div>
      )}

      {/* Existing keys — only the stored prefix is available to show */}
      {keys.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No active API keys</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{k.label}</div>
                <code className="text-[11px] text-muted-foreground font-mono">
                  {k.key_prefix ?? "worm_"}…
                </code>
              </div>
              <button
                onClick={() => revokeKey(k.id)}
                className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                title="Revoke key"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ApiKeyManager;
