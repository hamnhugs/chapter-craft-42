import React, { useState, useEffect, useCallback } from "react";
import { Key, Copy, Trash2, Plus, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface ApiKey {
  id: string;
  label: string;
  key_value: string;
  created_at: string;
  revoked_at: string | null;
}

const ApiKeyManager: React.FC = () => {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("api_keys")
      .select("*")
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (data) setKeys(data as ApiKey[]);
  }, [user]);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const generateKey = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "worm_";
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  const createKey = async () => {
    if (!user) return;
    setCreating(true);
    const keyValue = generateKey();
    const { error } = await supabase.from("api_keys").insert({
      user_id: user.id,
      key_value: keyValue,
      label: label.trim() || "Default",
    });
    if (error) {
      toast.error("Failed to create API key");
    } else {
      toast.success("API key created! Copy it now — it won't be shown in full again.");
      setLabel("");
      await loadKeys();
    }
    setCreating(false);
  };

  const revokeKey = async (id: string) => {
    await supabase.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
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

      {/* Existing keys */}
      {keys.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No active API keys</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{k.label}</div>
                <code className="text-[11px] text-muted-foreground font-mono">
                  {k.key_value.slice(0, 12)}...{k.key_value.slice(-4)}
                </code>
              </div>
              <button
                onClick={() => copyKey(k.key_value, k.id)}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                title="Copy full key"
              >
                {copiedId === k.id ? <Check className="w-3.5 h-3.5 text-accent" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
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
