import React, { useEffect, useState } from "react";
import { getSignedImageUrl } from "@/lib/imageGen";

/** Renders an image from the private generated-images bucket via a cached
 *  signed URL. Used in chat bubbles and the neuron detail gallery. */
const GeneratedImage: React.FC<{
  storagePath: string;
  alt: string;
  caption?: string | null;
  className?: string;
}> = ({ storagePath, alt, caption, className }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    getSignedImageUrl(storagePath).then((u) => {
      if (cancelled) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => { cancelled = true; };
  }, [storagePath]);

  if (failed) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-surface-container-high/60 border border-outline-variant/20 p-3 text-xs text-on-surface-variant">
        <span className="material-symbols-outlined text-base">broken_image</span>
        Image unavailable
      </div>
    );
  }

  return (
    <figure className={className || "my-1"}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open full size">
          <img
            src={url}
            alt={alt}
            loading="lazy"
            className="rounded-xl max-h-80 w-auto max-w-full border border-outline-variant/20 shadow-sm"
          />
        </a>
      ) : (
        <div className="rounded-xl bg-surface-container-high/60 border border-outline-variant/20 h-48 w-64 max-w-full animate-pulse flex items-center justify-center">
          <span className="material-symbols-outlined text-on-surface-variant/40 text-3xl">image</span>
        </div>
      )}
      {caption && (
        <figcaption className="mt-1 text-[11px] text-on-surface-variant/70 max-w-sm truncate">{caption}</figcaption>
      )}
    </figure>
  );
};

export default GeneratedImage;
