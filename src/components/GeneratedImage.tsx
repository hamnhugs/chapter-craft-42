import React, { useEffect, useState } from "react";
import { getSignedImageUrl } from "@/lib/imageGen";
import { useMediaHeightTier } from "@/components/MediaFrame";

/** Renders an image from the private generated-images bucket via a cached
 *  signed URL. Used in chat bubbles and the neuron detail gallery. With
 *  `resizable` (chat), the shared S/M/L/XL image height tier applies and a
 *  small overlay button cycles it; without it (galleries), the markup and
 *  sizing are exactly the classic fixed layout, which ImagesPanel restyles
 *  through the figure with [&_img] selectors. */
const GeneratedImage: React.FC<{
  storagePath: string;
  alt: string;
  caption?: string | null;
  className?: string;
  resizable?: boolean;
}> = ({ storagePath, alt, caption, className, resizable }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { maxHeight, tierLabel, cycle } = useMediaHeightTier("image");

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

  const picture = url ? (
    <a href={url} target="_blank" rel="noreferrer" title="Open full size">
      <img
        src={url}
        alt={alt}
        loading="lazy"
        style={resizable ? { maxHeight } : undefined}
        className={`rounded-xl w-auto max-w-full border border-outline-variant/20 shadow-sm ${resizable ? "" : "max-h-80"}`}
      />
    </a>
  ) : (
    <div className="rounded-xl bg-surface-container-high/60 border border-outline-variant/20 h-48 w-64 max-w-full animate-pulse flex items-center justify-center">
      <span className="material-symbols-outlined text-on-surface-variant/40 text-3xl">image</span>
    </div>
  );

  return (
    <figure className={className || "my-1"}>
      {resizable ? (
        // The wrapper shrink-wraps to the image so the size button sits on the
        // picture itself, not at the far edge of the bubble.
        <div className="relative inline-block max-w-full align-top">
          {picture}
          {url && (
            <button
              onClick={cycle}
              title={`Display size: ${tierLabel} — click to cycle (tap the image for full size)`}
              aria-label={`Display size ${tierLabel}, click to change`}
              className="absolute top-1.5 right-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm hover:bg-black/75 transition-colors"
            >
              <span className="material-symbols-outlined text-[11px] leading-none">aspect_ratio</span>
              {tierLabel}
            </button>
          )}
        </div>
      ) : (
        picture
      )}
      {caption && (
        <figcaption className="mt-1 text-[11px] text-on-surface-variant/70 max-w-sm truncate">{caption}</figcaption>
      )}
    </figure>
  );
};

export default GeneratedImage;
