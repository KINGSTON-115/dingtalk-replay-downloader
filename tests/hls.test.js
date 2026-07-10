import { describe, expect, it } from "vitest";
import { chooseTrack, chooseVariant, parseHlsManifest } from "../src/protocols/hls.js";

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="audio/zh.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文",LANGUAGE="zh",URI="subs/zh.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"
1080/index.m3u8`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin",IV=0x0000000000000000000000000000000A
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
media.mp4
#EXT-X-DISCONTINUITY
#EXTINF:4,
#EXT-X-BYTERANGE:1200@1720
media.mp4
#EXT-X-ENDLIST`;

describe("HLS 解析", () => {
  it("解析多清晰度、独立音轨与字幕", () => {
    const parsed = parseHlsManifest(MASTER, "https://cdn.example/root/master.m3u8");
    expect(parsed.isMaster).toBe(true);
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.audioTracks[0]).toMatchObject({ language: "zh", default: true, url: "https://cdn.example/root/audio/zh.m3u8" });
    expect(parsed.subtitleTracks).toHaveLength(1);
    expect(chooseVariant(parsed.variants).height).toBe(1080);
    expect(chooseTrack(parsed.audioTracks, "audio").name).toBe("中文");
  });

  it("解析 fMP4 map、Range、AES 与 discontinuity", () => {
    const parsed = parseHlsManifest(MEDIA, "https://cdn.example/root/video.m3u8");
    expect(parsed.container).toBe("fmp4");
    expect(parsed.encrypted).toBe(true);
    expect(parsed.drm).toBe(false);
    expect(parsed.segments[0].sequence).toBe(10);
    expect(parsed.segments[0].byterange).toEqual({ length: 1000, offset: 720 });
    expect(parsed.segments[0].map).toEqual({ url: "https://cdn.example/root/init.mp4", byterange: { length: 720, offset: 0 } });
    expect(parsed.segments[1].discontinuity).toBe(true);
  });

  it("把 SAMPLE-AES/非 identity KEYFORMAT 标记为 DRM 或不支持", () => {
    const text = `#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts`;
    const parsed = parseHlsManifest(text, "https://cdn.example/a.m3u8");
    expect(parsed.drm).toBe(true);
  });
});
