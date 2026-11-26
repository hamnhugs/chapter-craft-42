import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import BookWorm from "@/components/BookWorm";
import { getLink, parseLinkCode, refreshHealth, setLink, useEquilibriumHealth } from "@/lib/equilibriumLink";

/** Settings → Account: link Equilibrium (the worm wears its health, and Chat
 *  gets the calendar tool), or unlink it. */
export default function EquilibriumLinkRow() {
  const health = useEquilibriumHealth();
  const [code, setCode] = useState("");
  const [linked, setLinked] = useState(() => !!getLink());

  const link = async () => {
    const parsed = parseLinkCode(code);
    if (!parsed) {
      toast.error("That is not an Equilibrium link code. Make one on Equilibrium's Health tab.");
      return;
    }
    setLink(parsed);
    setLinked(true);
    setCode("");
    const err = await refreshHealth();
    if (err) toast.error(err);
    else toast.success("Linked. The worm shows how your schedule is going, and Chat can manage your calendar.");
  };

  if (linked) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <BookWorm mood="idle" health={health?.health} size={44} className="shrink-0 h-auto" />
        <div className="min-w-0 flex-1 text-sm">
          {health ? (
            <>
              <span className="font-medium">{health.label || "Linked"}</span>{" "}
              <span className="text-muted-foreground">· health {health.health} of 100</span>
            </>
          ) : (
            <span className="text-muted-foreground">Linked. Waiting for Equilibrium to answer.</span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refreshHealth().then((e) => e && toast.error(e))}>
          Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setLink(null);
            setLinked(false);
          }}
        >
          Unlink
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          Chat can look at and change this calendar: ask what is on today, or to add, move or finish a task. To let it look only, turn off “Change your calendar” in AI permissions.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Paste the link code (eqw1.…)"
        className="min-w-0 flex-1"
        aria-label="Equilibrium link code"
      />
      <Button size="sm" onClick={() => void link()} disabled={!code.trim()}>
        Link
      </Button>
    </div>
  );
}
