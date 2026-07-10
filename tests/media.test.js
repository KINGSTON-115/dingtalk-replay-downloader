import { describe, expect, it } from "vitest";
import { classifyMedia, mergeCandidates, normalizeCandidate } from "../src/core/media.js";

describe("媒体分类与候选排序", () => {
  it("通过 MIME 识别无后缀 HLS 与 DASH", () => {
    expect(classifyMedia({ url: "https://x/play?id=1", mime: "application/vnd.apple.mpegurl" }).kind).toBe("hls");
    expect(classifyMedia({ url: "https://x/play?id=2", mime: "application/dash+xml" }).kind).toBe("dash");
  });

  it("把 m4s 与网络 ts 识别为分片", () => {
    expect(classifyMedia({ url: "https://x/1.m4s" }).kind).toBe("segment");
    expect(classifyMedia({ url: "https://x/1.ts", sourceLabel: "network" }).kind).toBe("segment");
    expect(classifyMedia({ url: "https://x/movie.ts", sourceLabel: "direct-url" }).kind).toBe("file");
    expect(classifyMedia({ url: "https://x/audio.aac", sourceLabel: "direct-url" }).kind).toBe("file");
  });

  it("优先主清单和媒体元素并按 URL 去重", () => {
    const hls = normalizeCandidate({ url: "https://x/a.m3u8", sourceLabel: "network" });
    const file = normalizeCandidate({ url: "https://x/a.mp4", sourceLabel: "link" });
    const betterFile = normalizeCandidate({ url: "https://x/a.mp4", sourceLabel: "media-element" });
    const merged = mergeCandidates(file, hls, betterFile);
    expect(merged[0].kind).toBe("hls");
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.kind === "file").sourceLabel).toBe("media-element");
  });
});
