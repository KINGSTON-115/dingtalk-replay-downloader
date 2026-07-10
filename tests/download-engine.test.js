import { afterEach, describe, expect, it, vi } from "vitest";
import { sequenceToIv } from "../src/core/crypto.js";
import { describeOutputs, runDownload } from "../src/downloads/engine.js";

afterEach(() => vi.unstubAllGlobals());

function fakeSink(filename) {
  return {
    filename,
    bytesWritten: 0,
    chunks: [],
    closed: false,
    aborted: false,
    async write(bytes) {
      this.chunks.push(bytes.slice());
      this.bytesWritten += bytes.byteLength;
    },
    async close() { this.closed = true; },
    async abort() { this.aborted = true; }
  };
}

function response(bytes, status = 200) {
  return new Response(bytes, { status, headers: { "content-length": String(bytes.byteLength) } });
}

describe("下载引擎集成", () => {
  it("fMP4 只写一次初始化分片并保持媒体顺序", async () => {
    const resources = new Map([
      ["https://cdn.example/init.mp4", new Uint8Array([0, 1])],
      ["https://cdn.example/1.m4s", new Uint8Array([1, 1])],
      ["https://cdn.example/2.m4s", new Uint8Array([2, 2])]
    ]);
    vi.stubGlobal("fetch", async (url) => {
      if (String(url).endsWith("1.m4s")) await new Promise((resolve) => setTimeout(resolve, 5));
      return response(resources.get(String(url)));
    });
    const analysis = {
      protocol: "hls",
      resolved: { title: "课程", playbackUrl: "https://cdn.example/media.m3u8" },
      inspection: { live: false },
      plan: {
        live: false,
        playlist: {
          container: "fmp4",
          live: false,
          segments: [1, 2].map((sequence) => ({
            id: String(sequence),
            sequence,
            url: `https://cdn.example/${sequence}.m4s`,
            map: { url: "https://cdn.example/init.mp4", byterange: null },
            key: null,
            byterange: null,
            discontinuity: false
          }))
        },
        audioPlaylist: null,
        subtitlePlaylist: null
      }
    };
    const descriptors = describeOutputs(analysis, { outputFormat: "auto" });
    const sink = fakeSink(descriptors[0].filename);
    await runDownload(analysis, descriptors, new Map([["main", sink]]), { concurrency: 2 });
    expect(sink.chunks.map((chunk) => Array.from(chunk))).toEqual([[0, 1], [1, 1], [2, 2]]);
    expect(sink.closed).toBe(true);
    expect(sink.aborted).toBe(false);
  });

  it("并发 AES-128 分片共享 key 请求并输出解密内容", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const plaintexts = [new TextEncoder().encode("first authorized segment"), new TextEncoder().encode("second authorized segment")];
    const encrypted = [];
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
    for (let index = 0; index < plaintexts.length; index += 1) {
      encrypted.push(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: sequenceToIv(20 + index) }, key, plaintexts[index])));
    }
    let keyRequests = 0;
    vi.stubGlobal("fetch", async (url) => {
      const value = String(url);
      if (value.endsWith("key.bin")) {
        keyRequests += 1;
        return response(keyBytes);
      }
      const index = value.endsWith("1.ts") ? 0 : 1;
      return response(encrypted[index]);
    });
    const analysis = {
      protocol: "hls",
      resolved: { title: "加密课程", playbackUrl: "https://cdn.example/media.m3u8" },
      inspection: { live: false },
      plan: {
        live: false,
        playlist: {
          container: "ts",
          live: false,
          segments: [0, 1].map((index) => ({
            id: String(index),
            sequence: 20 + index,
            url: `https://cdn.example/${index + 1}.ts`,
            map: null,
            byterange: null,
            discontinuity: false,
            key: { method: "AES-128", uri: "https://cdn.example/key.bin", iv: null, keyFormat: "identity" }
          }))
        },
        audioPlaylist: null,
        subtitlePlaylist: null
      }
    };
    const descriptors = describeOutputs(analysis, { outputFormat: "ts" });
    const sink = fakeSink(descriptors[0].filename);
    await runDownload(analysis, descriptors, new Map([["main", sink]]), { concurrency: 2 });
    expect(keyRequests).toBe(1);
    expect(sink.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["first authorized segment", "second authorized segment"]);
  });
});
