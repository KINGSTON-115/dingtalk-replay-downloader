import { sanitizeFileName } from "../core/url.js";

function extensionForMime(mime, fallback = "bin") {
  const normalized = String(mime || "").toLowerCase();
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mpegurl")) return "m3u8";
  if (normalized.includes("mp2t")) return "ts";
  return fallback;
}

export class FileSystemSink {
  constructor(handle, writable, filename) {
    this.handle = handle;
    this.writable = writable;
    this.filename = filename;
    this.bytesWritten = 0;
    this.closed = false;
  }

  async write(bytes) {
    if (this.closed) throw new Error("输出文件已经关闭。");
    await this.writable.write(bytes);
    this.bytesWritten += bytes.byteLength;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.writable.close();
  }

  async abort(reason) {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.writable.abort === "function") await this.writable.abort(reason).catch(() => {});
    else await this.writable.close().catch(() => {});
  }
}

export class MemorySink {
  constructor(filename, mime, maxBytes = 512 * 1024 * 1024) {
    this.filename = filename;
    this.mime = mime;
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytesWritten = 0;
    this.closed = false;
  }

  async write(bytes) {
    if (this.closed) throw new Error("输出文件已经关闭。");
    if (this.bytesWritten + bytes.byteLength > this.maxBytes) {
      throw new Error("浏览器不支持流式文件保存，且任务已超过 512 MB 内存安全限制。请使用新版 Chrome/Edge 或本地增强模式。");
    }
    this.chunks.push(bytes.slice());
    this.bytesWritten += bytes.byteLength;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const blob = new Blob(this.chunks, { type: this.mime });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const downloadId = await chrome.downloads.download({ url: objectUrl, filename: this.filename, saveAs: true });
      await waitForDownload(downloadId);
    } finally {
      URL.revokeObjectURL(objectUrl);
      this.chunks = [];
    }
  }

  async abort() {
    this.closed = true;
    this.chunks = [];
    this.bytesWritten = 0;
  }
}

function pickerTypes(descriptor) {
  const extension = `.${descriptor.extension || extensionForMime(descriptor.mime)}`;
  return [{ description: descriptor.description || "媒体文件", accept: { [descriptor.mime || "application/octet-stream"]: [extension] } }];
}

async function openSingleSink(descriptor) {
  const filename = sanitizeFileName(descriptor.filename).replace(/[. ]+$/g, "");
  if (typeof showSaveFilePicker === "function") {
    const handle = await showSaveFilePicker({ suggestedName: filename, types: pickerTypes(descriptor) });
    return new FileSystemSink(handle, await handle.createWritable(), filename);
  }
  return new MemorySink(filename, descriptor.mime);
}

async function openDirectorySinks(descriptors) {
  if (typeof showDirectoryPicker !== "function") {
    const sinks = new Map();
    for (const descriptor of descriptors) sinks.set(descriptor.role, new MemorySink(descriptor.filename, descriptor.mime));
    return sinks;
  }
  const directory = await showDirectoryPicker({ mode: "readwrite" });
  const sinks = new Map();
  for (const descriptor of descriptors) {
    const filename = sanitizeFileName(descriptor.filename);
    const handle = await directory.getFileHandle(filename, { create: true });
    sinks.set(descriptor.role, new FileSystemSink(handle, await handle.createWritable(), filename));
  }
  return sinks;
}

export async function prepareOutputSinks(descriptors) {
  if (!Array.isArray(descriptors) || !descriptors.length) throw new Error("没有可用的输出文件定义。");
  if (descriptors.length === 1) {
    const descriptor = descriptors[0];
    return new Map([[descriptor.role, await openSingleSink(descriptor)]]);
  }
  return openDirectorySinks(descriptors);
}

export async function closeSinks(sinks) {
  const results = await Promise.allSettled(Array.from(sinks.values()).map((sink) => sink.close()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

export async function abortSinks(sinks, reason) {
  await Promise.allSettled(Array.from(sinks.values()).map((sink) => sink.abort(reason)));
}

export function waitForDownload(downloadId, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(listener);
      signal?.removeEventListener("abort", abort);
    };
    const abort = async () => {
      cleanup();
      await chrome.downloads.cancel(downloadId).catch(() => {});
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.bytesReceived?.current != null) onProgress?.(delta.bytesReceived.current, delta.totalBytes?.current || 0);
      if (delta.state?.current === "complete") {
        cleanup();
        resolve(downloadId);
      } else if (delta.state?.current === "interrupted") {
        cleanup();
        reject(new Error(delta.error?.current || "浏览器下载被中断。"));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function downloadDirectFile(source, options = {}) {
  const extension = source.extension || extensionForMime(source.mime, "mp4");
  const filename = `${sanitizeFileName(source.title)}.${extension}`;
  const downloadId = await chrome.downloads.download({
    url: source.playbackUrl || source.url,
    filename,
    saveAs: true
  });
  await waitForDownload(downloadId, options);
  return { filename, downloadId };
}
