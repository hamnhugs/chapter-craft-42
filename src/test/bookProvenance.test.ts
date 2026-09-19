import { describe, it, expect } from "vitest";
import {
  ASSISTANT_TAG,
  YOUTUBE_TAG,
  bookSource,
  formatVideoDuration,
  isAssistantBook,
  isYoutubeTranscript,
  mergeReservedTags,
  provenanceLabel,
  topicTags,
  youtubeSource,
} from "@/lib/bookProvenance";

describe("YouTube transcript provenance", () => {
  const ctx = { kind: "youtube" as const, video_url: "https://www.youtube.com/watch?v=abc", channel: "Lecture Hall", duration_seconds: 754 };

  it("reads the column first, then the reserved tag", () => {
    expect(bookSource({ source: "youtube", tags: [] })).toBe("youtube");
    expect(bookSource({ tags: [YOUTUBE_TAG, "history"] })).toBe("youtube");
    expect(isYoutubeTranscript({ source: "youtube" })).toBe(true);
    expect(isYoutubeTranscript({ source: "user", tags: ["youtube"] })).toBe(false);
    expect(isAssistantBook({ source: "youtube" })).toBe(false);
    expect(bookSource({ tags: [ASSISTANT_TAG] })).toBe("assistant");
  });

  it("leaves books already in the library unmarked", () => {
    // Older importer books: an HTML file name, no source, no tag.
    expect(isYoutubeTranscript({ tags: ["video"] })).toBe(false);
    expect(youtubeSource({ tags: [] })).toBeNull();
  });

  it("exposes the video's details, rejecting non-YouTube links", () => {
    expect(youtubeSource({ source: "youtube", sourceContext: ctx })).toEqual({
      videoUrl: "https://www.youtube.com/watch?v=abc", channel: "Lecture Hall", durationSeconds: 754,
    });
    expect(youtubeSource({ source: "youtube", sourceContext: { ...ctx, video_url: "javascript:alert(1)" } })?.videoUrl).toBeNull();
    expect(youtubeSource({ tags: [YOUTUBE_TAG] })).toEqual({ videoUrl: null, channel: null, durationSeconds: null });
  });

  it("labels it for readers", () => {
    expect(provenanceLabel({ source: "youtube", sourceContext: ctx, addedAt: 0, sourceModel: null })).toBe(
      "Automatic transcript of a YouTube video by Lecture Hall — may contain transcription errors",
    );
    expect(formatVideoDuration(754)).toBe("12m 34s");
    expect(formatVideoDuration(3960)).toBe("1h 6m");
    expect(formatVideoDuration(null)).toBeNull();
  });

  it("keeps the marker through Auto-tag and hides it from topic tags", () => {
    const merged = mergeReservedTags([YOUTUBE_TAG, "old"], ["history", "source:forged"]);
    expect(merged).toEqual([YOUTUBE_TAG, "history"]);
    expect(topicTags(merged)).toEqual(["history"]);
  });
});
