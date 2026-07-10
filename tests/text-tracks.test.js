import { describe, expect, it } from "vitest";
import { WebVttConcatSink } from "../src/downloads/text-tracks.js";

describe("WebVTT 字幕拼接", () => {
  it("只保留一次文件头并顺序追加 cue", async () => {
    const chunks = [];
    const base = {
      filename: "sub.vtt",
      bytesWritten: 0,
      async write(bytes) {
        chunks.push(bytes);
        this.bytesWritten += bytes.byteLength;
      },
      async close() {},
      async abort() {}
    };
    const sink = new WebVttConcatSink(base);
    await sink.write(new TextEncoder().encode("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n第一句\n"));
    await sink.write(new TextEncoder().encode("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\n第二句\n"));
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
    expect(text.match(/WEBVTT/g)).toHaveLength(1);
    expect(text).toContain("第一句");
    expect(text).toContain("第二句");
  });
});
