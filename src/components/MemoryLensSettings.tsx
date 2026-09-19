import React, { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useChatSettings } from "@/hooks/useChatSettings";
import { listSuppressed, setSuppressed, type SuppressedImage } from "@/lib/memoryLens";
import { getSignedImageUrl } from "@/lib/imageGen";

/** Settings → Memory Lens: the auto-show toggle plus the undo list for images
 *  muted with "don't show this again" (a permanent choice needs a visible
 *  escape hatch — Google/Apple photo-memory convention). */
const MemoryLensSettings: React.FC = () => {
  const { autoShowMemoryImages, setAutoShowMemoryImages } = useChatSettings();
  const [muted, setMuted] = useState<SuppressedImage[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    listSuppressed().then(async (rows) => {
      if (!alive) return;
      setMuted(rows);
      setLoaded(true);
      const t: Record<string, string> = {};
      await Promise.all(rows.slice(0, 12).map(async (r) => {
        if (!r.storage_path) return;
        const u = await getSignedImageUrl(r.storage_path).catch(() => null);
        if (u) t[r.id] = u;
      }));
      if (alive) setThumbs(t);
    });
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Auto-show memory images</p>
          <p className="text-xs text-on-surface-variant">
            When a recalled memory has a picture you've never seen, it appears with the reply — once.
            Repeats collapse to small chips. Off = chips only, never full images.
          </p>
        </div>
        <Switch checked={autoShowMemoryImages} onCheckedChange={setAutoShowMemoryImages} aria-label="Auto-show memory images" />
      </div>
      {loaded && muted.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant mb-2">Muted images</p>
          <ul className="flex flex-col gap-2">
            {muted.map((m) => (
              <li key={m.id} className="flex items-center gap-2 rounded-lg bg-surface-container-high/50 border border-outline-variant/15 px-2 py-1.5">
                {thumbs[m.id] ? (
                  <img src={thumbs[m.id]} alt="" className="w-8 h-8 rounded object-cover" loading="lazy" />
                ) : (
                  <span className="material-symbols-outlined text-base text-on-surface-variant">hide_image</span>
                )}
                <span className="text-xs text-on-surface-variant truncate flex-1">{m.prompt || "image"}</span>
                <button
                  onClick={async () => {
                    await setSuppressed(m.id, false);
                    setMuted((prev) => prev.filter((x) => x.id !== m.id));
                    toast.success("Image can auto-show again");
                  }}
                  className="text-[10px] font-bold uppercase tracking-widest text-primary hover:underline"
                >
                  Unmute
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default MemoryLensSettings;
