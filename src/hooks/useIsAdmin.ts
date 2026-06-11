import { useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

// Module-level shared store: the is_admin() check runs once per signed-in
// user and every consumer (Index tab, WikiLibrary, AdminPanel) shares the
// result. The check is server-side (SECURITY DEFINER RPC) — the client can
// only ask, never assert. All admin data access is additionally re-checked
// inside the RPCs and RLS policies, so this flag is purely cosmetic gating.

interface Snapshot {
  isAdmin: boolean;
  loaded: boolean;
}

let snapshot: Snapshot = { isAdmin: false, loaded: false };
let loadedForUser: string | null | undefined = undefined;
const listeners = new Set<() => void>();

function setSnapshot(next: Snapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getSnapshot = () => snapshot;

async function ensureLoaded(userId: string | null) {
  if (loadedForUser === userId) return;
  loadedForUser = userId;
  if (!userId) {
    setSnapshot({ isAdmin: false, loaded: true });
    return;
  }
  setSnapshot({ isAdmin: false, loaded: false });
  try {
    const { data, error } = await supabase.rpc("is_admin" as any);
    if (loadedForUser !== userId) return; // user changed mid-flight
    setSnapshot({ isAdmin: !error && !!data, loaded: true });
  } catch {
    if (loadedForUser !== userId) return;
    setSnapshot({ isAdmin: false, loaded: true });
  }
}

export function useIsAdmin(): Snapshot {
  const { user } = useAuth();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void ensureLoaded(user?.id ?? null);
  }, [user?.id]);
  return snap;
}
