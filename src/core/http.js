const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const FORBIDDEN_HEADERS = new Set(["cookie", "referer", "origin", "host", "user-agent"]);

export class HttpError extends Error {
  constructor(message, { status = 0, url = "", retryAfter = 0 } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

export function sanitizeRequestHeaders(headers = {}) {
  const safe = new Headers();
  for (const [name, value] of Object.entries(headers || {})) {
    if (value == null || FORBIDDEN_HEADERS.has(name.toLowerCase())) continue;
    safe.set(name, String(value));
  }
  return safe;
}

function retryDelay(attempt, response) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 30000));
  }
  return Math.min(750 * (2 ** attempt) + Math.random() * 400, 10000);
}

export function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function createTimedSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const abort = () => controller.abort(parentSignal?.reason || new DOMException("Aborted", "AbortError"));
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new DOMException("Request timeout", "TimeoutError")), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
  };
}

async function requestOnce(url, options, signal) {
  const response = await fetch(url, {
    method: options.method || "GET",
    credentials: options.credentials || "include",
    cache: options.cache || "default",
    redirect: "follow",
    headers: sanitizeRequestHeaders(options.headers),
    body: options.body,
    signal
  });
  if (!response.ok) {
    const error = new HttpError(`HTTP ${response.status}`, {
      status: response.status,
      url: response.url || url,
      retryAfter: retryDelay(0, response)
    });
    response.body?.cancel().catch(() => {});
    throw error;
  }
  return response;
}

function canRetry(error) {
  return error instanceof TypeError || error?.name === "TimeoutError" || (error instanceof HttpError && RETRYABLE_STATUS.has(error.status));
}

export async function fetchResponse(url, options = {}) {
  const retries = Math.max(0, Math.min(Number(options.retries ?? 3), 8));
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timed = createTimedSignal(options.signal, Number(options.timeoutMs ?? 30000));
    let response;
    try {
      response = await requestOnce(url, options, timed.signal);
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      const effectiveError = timed.signal.aborted ? timed.signal.reason || error : error;
      lastError = effectiveError;
      if (!canRetry(effectiveError) || attempt >= retries) throw effectiveError;
      const delay = Number.isFinite(Number(options.retryDelayMs)) ? Number(options.retryDelayMs) : (effectiveError.retryAfter || retryDelay(attempt));
      options.onRetry?.({ attempt: attempt + 1, error: effectiveError, delay });
      await sleep(delay, options.signal);
    } finally {
      timed.cleanup();
    }
  }
  throw lastError || new Error("请求失败");
}

async function consumeResponse(url, options, consumer) {
  const retries = Math.max(0, Math.min(Number(options.retries ?? 3), 8));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timed = createTimedSignal(options.signal, Number(options.timeoutMs ?? 30000));
    try {
      const response = await requestOnce(url, options, timed.signal);
      return await consumer(response, timed.signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      const effectiveError = timed.signal.aborted ? timed.signal.reason || error : error;
      lastError = effectiveError;
      if (!canRetry(effectiveError) || attempt >= retries) throw effectiveError;
      const delay = Number.isFinite(Number(options.retryDelayMs)) ? Number(options.retryDelayMs) : (effectiveError.retryAfter || retryDelay(attempt));
      options.onRetry?.({ attempt: attempt + 1, error: effectiveError, delay });
      await sleep(delay, options.signal);
    } finally {
      timed.cleanup();
    }
  }
  throw lastError || new Error("请求失败");
}

async function readResponseBytes(response, options = {}) {
  const reader = response.body?.getReader();
  const total = Number(response.headers.get("content-length")) || 0;
  const maxBytes = Number(options.maxBytes) || 0;
  if (maxBytes > 0 && total > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new Error(`单个资源超过安全限制（${maxBytes} 字节）。`);
  }
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes > 0 && bytes.byteLength > maxBytes) throw new Error(`单个资源超过安全限制（${maxBytes} 字节）。`);
    options.onProgress?.(bytes.byteLength, total);
    return bytes;
  }

  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (maxBytes > 0 && loaded > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error(`单个资源超过安全限制（${maxBytes} 字节）。`);
    }
    options.onProgress?.(loaded, total);
  }
  return concatBytes(chunks, loaded);
}

async function readResponsePrefix(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array((await response.arrayBuffer()).slice(0, limit));
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - total;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.byteLength;
    if (value.byteLength >= remaining) break;
  }
  reader.cancel().catch(() => {});
  return concatBytes(chunks, total);
}

export async function fetchTextResource(url, options = {}) {
  return consumeResponse(url, options, async (response) => {
    const bytes = await readResponseBytes(response, { maxBytes: Number(options.maxBytes) || 10 * 1024 * 1024 });
    return {
      text: new TextDecoder().decode(bytes),
      finalUrl: response.url || url,
      mime: response.headers.get("content-type") || "",
      contentLength: Number(response.headers.get("content-length")) || bytes.byteLength,
      contentDisposition: response.headers.get("content-disposition") || ""
    };
  });
}

export async function fetchPrefixResource(url, options = {}) {
  const limit = Math.max(512, Math.min(Number(options.limit) || 65536, 1024 * 1024));
  return consumeResponse(url, options, async (response) => ({
    bytes: await readResponsePrefix(response, limit),
    finalUrl: response.url || url,
    mime: response.headers.get("content-type") || "",
    contentLength: Number(response.headers.get("content-length")) || 0,
    contentDisposition: response.headers.get("content-disposition") || "",
    status: response.status
  }));
}

export async function fetchBytes(url, options = {}) {
  return consumeResponse(url, options, async (response) => {
    const range = options.range;
    const declaredLength = Number(response.headers.get("content-length")) || 0;
    if (range && response.status !== 206 && declaredLength && declaredLength !== Number(range.length)) {
      response.body?.cancel().catch(() => {});
      throw new Error("服务器忽略了媒体 Range 请求，为避免生成损坏文件已停止。");
    }
    const bytes = await readResponseBytes(response, options);
    if (range && response.status !== 206 && bytes.byteLength !== Number(range.length)) {
      throw new Error("服务器没有返回请求的媒体字节范围。");
    }
    return bytes;
  });
}

export function byteRangeHeader(byterange) {
  if (!byterange || !Number.isFinite(byterange.length)) return {};
  const start = Number(byterange.offset) || 0;
  return { Range: `bytes=${start}-${start + Number(byterange.length) - 1}` };
}

export function concatBytes(chunks, knownTotal) {
  const total = Number.isFinite(knownTotal) ? knownTotal : chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
