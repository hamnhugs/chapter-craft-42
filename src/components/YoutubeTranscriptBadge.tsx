import React from "react";
import type { BookDocument } from "@/types/library";
import { formatVideoDuration, youtubeSource } from "@/lib/bookProvenance";

/**
 * The mark on every book the From YouTube importer saved: it is an automatic
 * transcript of a video, not a document the user uploaded.
 *
 * - "chip": compact label for lists and covers.
 * - "banner": full notice for the reader, with the channel, length and a link
 *   back to the video.
 */
const YoutubeTranscriptBadge: React.FC<{
  book: Pick<BookDocument, "source" | "tags" | "sourceContext">;
  variant?: "chip" | "banner";
  className?: string;
}> = ({ book, variant = "chip", className = "" }) => {
  const yt = youtubeSource(book);
  if (!yt) return null;

  const icon = (
    <svg viewBox="0 0 24 24" aria-hidden className="w-3.5 h-3.5 shrink-0" fill="currentColor">
      <path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8ZM9.7 15.1V8.9l5.8 3.1-5.8 3.1Z" />
    </svg>
  );

  if (variant === "chip") {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#c4302b] text-white text-[10px] font-bold uppercase tracking-wide whitespace-nowrap ${className}`}
        title={`Automatic transcript of a YouTube video${yt.channel ? ` by ${yt.channel}` : ""}`}
      >
        {icon}
        YouTube transcript
      </span>
    );
  }

  const details = [yt.channel, formatVideoDuration(yt.durationSeconds)].filter(Boolean).join(" · ");
  return (
    <div
      role="note"
      className={`flex items-center gap-3 px-4 py-2 border-l-4 border-[#c4302b] bg-[#c4302b]/10 text-xs ${className}`}
    >
      <span className="text-[#c4302b]">{icon}</span>
      <p className="flex-1 min-w-0 text-foreground">
        <span className="font-bold">YouTube transcript</span>
        <span className="text-on-surface-variant">
          {" "}— automatically transcribed{details ? ` from ${details}` : ""}; may contain errors.
        </span>
      </p>
      {yt.videoUrl && (
        <a
          href={yt.videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-semibold text-primary hover:underline"
        >
          Watch video ↗
        </a>
      )}
    </div>
  );
};

export default YoutubeTranscriptBadge;
