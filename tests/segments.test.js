import { describe, expect, it } from "vitest";
import { downloadOrderedSegments } from "../src/downloads/segments.js";

describe("有界并发分片下载", () => {
  it("即使请求乱序完成也严格按清单顺序写入", async () => {
    const segments = Array.from({ length: 7 }, (_, index) => ({ id: String(index), sequence: index }));
    const written = [];
    const fetcher = {
      async fetchSegment(segment) {
        await new Promise((resolve) => setTimeout(resolve, (3 - (segment.sequence % 3)) * 2));
        return new Uint8Array([segment.sequence]);
      }
    };
    const result = await downloadOrderedSegments(segments, {
      concurrency: 3,
      fetcher,
      async onSegment(bytes) {
        written.push(bytes[0]);
      }
    });
    expect(written).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.completed).toBe(7);
  });

  it("等待同一批请求结束后再抛出错误，不遗留后台 worker", async () => {
    let completed = 0;
    const fetcher = {
      async fetchSegment(segment) {
        await new Promise((resolve) => setTimeout(resolve, 3));
        completed += 1;
        if (segment.sequence === 1) throw new Error("broken segment");
        return new Uint8Array([segment.sequence]);
      }
    };
    await expect(downloadOrderedSegments([{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }], {
      concurrency: 3,
      fetcher,
      onSegment() {}
    })).rejects.toThrow("broken segment");
    expect(completed).toBe(3);
  });

  it("允许服务器限流后动态降低后续批次并发", async () => {
    const batchSizes = [];
    let concurrency = 3;
    await downloadOrderedSegments(Array.from({ length: 6 }, (_, sequence) => ({ sequence })), {
      getConcurrency: () => concurrency,
      fetcher: { fetchSegment: async (segment) => new Uint8Array([segment.sequence]) },
      onSegment() {},
      onBatchComplete(batch) {
        batchSizes.push(batch.concurrency);
        concurrency = 1;
      }
    });
    expect(batchSizes).toEqual([3, 1, 1, 1]);
  });
});
