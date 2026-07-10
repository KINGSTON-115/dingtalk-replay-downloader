import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBytes } from "../src/core/http.js";
import { probeMediaUrl, resolveInput } from "../src/core/resolver.js";

afterEach(() => vi.unstubAllGlobals());

describe("网络读取与媒体探测", () => {
  it("服务器忽略 BYTERANGE 时停止而不是拼接损坏内容", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(100), {
      status: 200,
      headers: { "content-length": "100" }
    }));
    await expect(fetchBytes("https://cdn.example/file.mp4", {
      retries: 0,
      range: { offset: 20, length: 10 },
      headers: { Range: "bytes=20-29" }
    })).rejects.toThrow(/忽略了媒体 Range/);
  });

  it("响应正文中途失败时会重新请求", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(new TypeError("network reset"));
          }
        }), { status: 200 });
      }
      return new Response(new Uint8Array([2, 3]), { status: 200, headers: { "content-length": "2" } });
    });
    const bytes = await fetchBytes("https://cdn.example/segment", { retries: 1, retryDelayMs: 0, timeoutMs: 1000 });
    expect(Array.from(bytes)).toEqual([2, 3]);
    expect(calls).toBe(2);
  });

  it("超时信号覆盖响应正文读取阶段", async () => {
    vi.stubGlobal("fetch", async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
      }
    }), { status: 200 }));
    await expect(fetchBytes("https://cdn.example/hang", { retries: 0, timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("通过二进制签名识别无后缀 MP4", async () => {
    const bytes = new Uint8Array(32);
    bytes.set(new TextEncoder().encode("ftyp"), 4);
    vi.stubGlobal("fetch", async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) }
    }));
    const probe = await probeMediaUrl("https://cdn.example/play?id=1", { http: { retries: 0 } });
    expect(probe).toMatchObject({ kind: "file", extension: "mp4", mime: "video/mp4" });
  });

  it("Content-Disposition 文件名不会重复扩展名", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(16), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "16",
        "content-disposition": 'attachment; filename="lesson.mp4"'
      }
    }));
    const resolved = await resolveInput("https://cdn.example/play?id=2", { http: { retries: 0 } });
    expect(resolved.title).toBe("lesson");
    expect(resolved.extension).toBe("mp4");
  });
});
