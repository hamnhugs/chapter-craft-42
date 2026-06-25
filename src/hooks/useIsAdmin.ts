// Backwards-compatible wrapper around the unified useEntitlements() hook.
// Mirrors the previous useIsAdmin contract so existing components keep working.
import { useEntitlements } from "@/hooks/useEntitlements";

export function useIsAdmin() {
  const e = useEntitlements();
  return { isAdmin: e.isAdmin, loaded: e.loaded };
}
