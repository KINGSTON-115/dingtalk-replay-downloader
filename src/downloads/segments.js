import { decryptAes128, parseIv } from "../core/crypto.js";
import { byteRangeHeader, fetchBytes } from "../core/http.js";

export class SegmentFetcher {
  constructor(options = {}) {
    this.signal = options.signal;
    this.http = options.http || {};
    this.onRetry = options.onRetry;
    this.keyCache = new Map();
    this.objectCache = new Map();
  }

  async fetchObject(object) {
    if (!object?.url) throw new Error("媒体对象缺少 URL。");
    const cacheKey = `${object.url}|${object.byterange?.offset || 0}|${object.byterange?.length || 0}`;
    if (!this.objectCache.has(cacheKey)) {
      this.objectCache.set(cacheKey, fetchBytes(object.url, {
        ...this.http,
        signal: this.signal,
        headers: { ...this.http.headers, ...byteRangeHeader(object.byterange) },
        range: object.byterange,
        maxBytes: 256 * 1024 * 1024,
        onRetry: this.onRetry
      }));
    }
    return (await this.objectCache.get(cacheKey)).slice();
  }

  async fetchMap(segment) {
    let bytes = await this.fetchObject(segment.map);
    if (!segment.key) return bytes;
    if (segment.key.method !== "AES-128" || !/^(?:identity)?$/i.test(segment.key.keyFormat || "identity")) {
      throw new Error(`不支持的初始化分片加密方式：${segment.key.method} / ${segment.key.keyFormat}`);
    }
    if (!segment.key.iv) throw new Error("加密的 EXT-X-MAP 必须提供显式 IV。");
    const key = await this.fetchKey(segment.key);
    bytes = await decryptAes128(bytes, key, parseIv(segment.key.iv, segment.sequence));
    return bytes;
  }

  async fetchKey(key) {
    if (!key?.uri) throw new Error("加密分片缺少密钥地址。");
    if (!this.keyCache.has(key.uri)) {
      this.keyCache.set(key.uri, fetchBytes(key.uri, {
        ...this.http,
        signal: this.signal,
        maxBytes: 1024 * 1024,
        onRetry: this.onRetry
      }));
    }
    return this.keyCache.get(key.uri);
  }

  async fetchSegment(segment) {
    let bytes = await fetchBytes(segment.url, {
      ...this.http,
      signal: this.signal,
      headers: { ...this.http.headers, ...byteRangeHeader(segment.byterange) },
      range: segment.byterange,
      maxBytes: 256 * 1024 * 1024,
      onRetry: this.onRetry
    });
    if (segment.key) {
      if (segment.key.method !== "AES-128" || !/^(?:identity)?$/i.test(segment.key.keyFormat || "identity")) {
        throw new Error(`不支持的媒体加密方式：${segment.key.method} / ${segment.key.keyFormat}`);
      }
      const key = await this.fetchKey(segment.key);
      bytes = await decryptAes128(bytes, key, parseIv(segment.key.iv, segment.sequence));
    }
    return bytes;
  }
}

export async function downloadOrderedSegments(segments, options = {}) {
  const total = segments.length;
  let completed = 0;
  let downloadedBytes = 0;

  for (let start = 0; start < total;) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException("Aborted", "AbortError");
    const concurrency = Math.max(1, Math.min(Number(options.getConcurrency?.() ?? options.concurrency) || 4, 12));
    const batch = segments.slice(start, start + concurrency);
    const settled = await Promise.allSettled(batch.map((segment) => options.fetcher.fetchSegment(segment)));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    for (let index = 0; index < settled.length; index += 1) {
      const bytes = settled[index].value;
      const segment = batch[index];
      await options.onSegment(bytes, segment);
      completed += 1;
      downloadedBytes += bytes.byteLength;
      options.onProgress?.({ completed, total, downloadedBytes, segment });
    }
    start += batch.length;
    options.onBatchComplete?.({ concurrency, completed, total });
  }
  return { completed, total, downloadedBytes };
}
