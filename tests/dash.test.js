import { describe, expect, it } from "vitest";
import { parseDashManifest, resolveDashPlan } from "../src/protocols/dash.js";

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
      <Representation id="v1" bandwidth="800000" width="1280" height="720">
        <BaseURL>video/</BaseURL>
        <SegmentTemplate timescale="1" duration="4" initialization="init.mp4" media="$Number$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="zh">
      <Representation id="a1" bandwidth="128000">
        <BaseURL>audio/</BaseURL>
        <SegmentTemplate timescale="1" duration="4" initialization="init.mp4" media="$Number$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe("DASH 解析", () => {
  it("生成可下载的视频与音频分片计划", () => {
    const manifest = parseDashManifest(MPD, "https://cdn.example/path/manifest.mpd");
    expect(manifest.duration).toBe(12);
    expect(manifest.variants[0].segments).toHaveLength(3);
    expect(manifest.variants[0].segments[0].map.url).toBe("https://cdn.example/path/video/init.mp4");
    expect(manifest.audioTracks[0].segments).toHaveLength(3);
    const plan = resolveDashPlan({ sourceUrl: manifest.url, manifestUrl: manifest.url, manifest });
    expect(plan.requiresNativeMerge).toBe(true);
    expect(plan.audio.language).toBe("zh");
  });

  it("拒绝带常见 DRM 标记的 MPD", () => {
    const encrypted = MPD.replace("<Period>", '<Period><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" cenc:default_KID="abc"/>');
    const manifest = parseDashManifest(encrypted, "https://cdn.example/manifest.mpd");
    expect(manifest.drm).toBe(true);
    expect(() => resolveDashPlan({ sourceUrl: manifest.url, manifestUrl: manifest.url, manifest })).toThrow(/DRM/);
  });
});
