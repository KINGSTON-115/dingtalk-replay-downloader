import { fetchBytes, sleep } from "../core/http.js";
import { formatBytes } from "../core/media.js";
import { sanitizeFileName, stableId } from "../core/url.js";
import { reloadHlsPlaylist } from "../protocols/hls.js";
import { SegmentFetcher, downloadOrderedSegments } from "./segments.js";
import { WebVttConcatSink } from "./text-tracks.js";
import { closeSinks, abortSinks, downloadDirectFile } from "./sinks.js";

function descriptor(role, title, extension, mime, transform = "copy") {
  const suffix = role === "main" ? "" : role === "video" ? ".video" : role === "audio" ? ".audio" : `.${role}`;
  return {
    role,
    filename: `${sanitizeFileName(title)}${suffix}.${extension}`,
    extension,
    mime,
    transform,
    description: role === "audio" ? "音频轨" : role === "video" ? "视频轨" : role === "subtitle" ? "字幕轨" : "视频文件"
  };
}

function hlsTrackDescriptor(role, title, playlist) {
  if (playlist.container === "vtt") return descriptor(role, title, "vtt", "text/vtt", "vtt-concat");
  if (playlist.container === "fmp4") return descriptor(role, title, role === "audio" ? "m4a" : "mp4", role === "audio" ? "audio/mp4" : "video/mp4", "fmp4-copy");
  if (playlist.container === "aac") return descriptor(role, title, "aac", "audio/aac", "copy");
  return descriptor(role, title, "ts", "video/mp2t", "copy");
}

export function describeOutputs(analysis) {
  const title = analysis.resolved.title;
  if (analysis.protocol === "file") {
    return [descriptor("main", title, analysis.plan.extension || "mp4", analysis.plan.mime || "video/mp4", "browser-download")];
  }
  if (analysis.protocol === "hls") {
    const outputs = [];
    if (analysis.plan.audioPlaylist) {
      outputs.push(
        hlsTrackDescriptor("video", title, analysis.plan.playlist),
        hlsTrackDescriptor("audio", title, analysis.plan.audioPlaylist)
      );
    } else {
      outputs.push(hlsTrackDescriptor("main", title, analysis.plan.playlist));
    }
    if (analysis.plan.subtitlePlaylist) outputs.push(hlsTrackDescriptor("subtitle", title, analysis.plan.subtitlePlaylist));
    return outputs;
  }
  if (analysis.protocol === "dash") {
    const outputs = [];
    if (analysis.plan.audio) {
      outputs.push(
        descriptor("video", title, "mp4", "video/mp4", "fmp4-copy"),
        descriptor("audio", title, "m4a", "audio/mp4", "fmp4-copy")
      );
    } else {
      const audioOnly = analysis.plan.video.type === "audio-only";
      outputs.push(descriptor("main", title, audioOnly ? "m4a" : "mp4", audioOnly ? "audio/mp4" : "video/mp4", "fmp4-copy"));
    }
    if (analysis.plan.subtitle) {
      const vtt = analysis.plan.subtitle.segments.some((segment) => /\.(?:vtt|webvtt)(?:[?#]|$)/i.test(segment.url));
      outputs.push(descriptor("subtitle", title, vtt ? "vtt" : "mp4", vtt ? "text/vtt" : "application/mp4", vtt ? "vtt-concat" : "fmp4-copy"));
    }
    return outputs;
  }
  throw new Error(`未知下载协议：${analysis.protocol}`);
}

async function writeMapIfNeeded(segment, state, sink, fetcher) {
  if (!segment.map) return;
  const id = stableId(segment.map.url, segment.map.byterange?.offset, segment.map.byterange?.length);
  if (state.mapId === id) return;
  if (state.mapId && state.mapId !== id) throw new Error("媒体中途更换了初始化分片，需要本地增强模式重新封装。");
  await sink.write(await fetcher.fetchMap(segment));
  state.mapId = id;
}

async function downloadPlaylistOnce(playlist, sink, descriptorInfo, options) {
  const adaptive = {
    value: Math.max(1, Math.min(Number(options.concurrency) || 4, 12)),
    cleanBatches: 0,
    throttle(error) {
      if (![429, 503].includes(Number(error?.status))) return;
      const previous = this.value;
      this.value = Math.max(1, Math.floor(this.value / 2));
      this.cleanBatches = 0;
      if (this.value !== previous) options.onLog?.(`服务器限流，并发已从 ${previous} 自动降低到 ${this.value}。`);
    },
    recover() {
      this.cleanBatches += 1;
      if (this.cleanBatches >= 3 && this.value < Math.min(Number(options.concurrency) || 4, 12)) {
        this.value += 1;
        this.cleanBatches = 0;
      }
    }
  };
  const fetcher = new SegmentFetcher({
    signal: options.signal,
    http: options.http,
    onRetry: ({ attempt, error, delay }) => {
      adaptive.throttle(error);
      options.onLog?.(`分片请求失败，${Math.round(delay / 100) / 10} 秒后进行第 ${attempt} 次重试：${error.message}`);
    }
  });
  const writableSink = descriptorInfo.transform === "vtt-concat" ? new WebVttConcatSink(sink) : sink;
  const mapState = { mapId: "" };
  await downloadOrderedSegments(playlist.segments, {
    concurrency: options.concurrency,
    getConcurrency: () => adaptive.value,
    onBatchComplete: () => adaptive.recover(),
    signal: options.signal,
    fetcher,
    async onSegment(bytes, segment) {
      if (descriptorInfo.transform === "fmp4-copy") await writeMapIfNeeded(segment, mapState, writableSink, fetcher);
      await writableSink.write(bytes, { discontinuity: segment.discontinuity });
    },
    onProgress(progress) {
      options.onTrackProgress?.(progress);
    }
  });
  return writableSink;
}

async function recordLivePlaylist(initialPlaylist, sink, descriptorInfo, options) {
  const adaptive = {
    value: Math.max(1, Math.min(Number(options.concurrency) || 4, 12)),
    throttle(error) {
      if ([429, 503].includes(Number(error?.status))) this.value = Math.max(1, Math.floor(this.value / 2));
    }
  };
  const fetcher = new SegmentFetcher({
    signal: options.signal,
    http: options.http,
    onRetry(info) {
      adaptive.throttle(info.error);
      options.onLog?.(`直播分片请求重试：${info.error.message}`);
    }
  });
  const writableSink = descriptorInfo.transform === "vtt-concat" ? new WebVttConcatSink(sink) : sink;
  const mapState = { mapId: "" };
  const seen = new Set();
  let playlist = initialPlaylist;
  let completed = 0;
  let downloadedBytes = 0;

  while (true) {
    const fresh = playlist.segments.filter((segment) => !seen.has(segment.id));
    for (const segment of fresh) seen.add(segment.id);
    if (fresh.length) {
      await downloadOrderedSegments(fresh, {
        concurrency: options.concurrency,
        getConcurrency: () => adaptive.value,
        signal: options.signal,
        fetcher,
        async onSegment(bytes, segment) {
          if (descriptorInfo.transform === "fmp4-copy") await writeMapIfNeeded(segment, mapState, writableSink, fetcher);
          await writableSink.write(bytes, { discontinuity: segment.discontinuity });
        },
        onProgress(progress) {
          completed += 1;
          downloadedBytes += progress.segment ? 0 : progress.downloadedBytes;
          options.onTrackProgress?.({ completed, total: 0, downloadedBytes: Math.max(downloadedBytes, writableSink.bytesWritten || 0), live: true });
        }
      });
    }
    if (playlist.endList) break;
    await sleep(Math.max(1000, playlist.targetDuration * 500), options.signal);
    playlist = await reloadHlsPlaylist(playlist.url, { signal: options.signal, http: options.http });
  }
  return writableSink;
}

async function downloadHls(analysis, descriptors, sinks, options) {
  const tracks = [{ role: analysis.plan.audioPlaylist ? "video" : "main", playlist: analysis.plan.playlist }];
  if (analysis.plan.audioPlaylist) tracks.push({ role: "audio", playlist: analysis.plan.audioPlaylist });
  if (analysis.plan.subtitlePlaylist) tracks.push({ role: "subtitle", playlist: analysis.plan.subtitlePlaylist });
  const progress = new Map();
  await Promise.all(tracks.map(async ({ role, playlist }) => {
    const descriptorInfo = descriptors.find((item) => item.role === role);
    const sink = sinks.get(role);
    const trackOptions = {
      ...options,
      onTrackProgress(value) {
        progress.set(role, value);
        const values = Array.from(progress.values());
        const total = values.reduce((sum, item) => sum + (item.total || 0), 0);
        const completed = values.reduce((sum, item) => sum + (item.completed || 0), 0);
        const downloadedBytes = values.reduce((sum, item) => sum + (item.downloadedBytes || 0), 0);
        options.onProgress?.({ completed, total, downloadedBytes, live: analysis.plan.live });
      }
    };
    if (playlist.live) await recordLivePlaylist(playlist, sink, descriptorInfo, trackOptions);
    else await downloadPlaylistOnce(playlist, sink, descriptorInfo, trackOptions);
  }));
}

async function downloadDashTrack(track, sink, descriptorInfo, options) {
  if (track.sidx) throw new Error("该 DASH 使用 SegmentBase/SIDX，需要本地增强模式。");
  if (!track.segments.length) throw new Error("DASH 轨道没有可下载的分片。");
  const playlist = { ...track, container: "fmp4" };
  await downloadPlaylistOnce(playlist, sink, descriptorInfo, options);
}

async function downloadDash(analysis, descriptors, sinks, options) {
  if (analysis.plan.live) throw new Error("动态 DASH 录制需要本地增强模式。");
  const tracks = [{ role: analysis.plan.audio ? "video" : "main", track: analysis.plan.video }];
  if (analysis.plan.audio) tracks.push({ role: "audio", track: analysis.plan.audio });
  if (analysis.plan.subtitle) tracks.push({ role: "subtitle", track: analysis.plan.subtitle });
  const progress = new Map();
  await Promise.all(tracks.map(async ({ role, track }) => {
    await downloadDashTrack(track, sinks.get(role), descriptors.find((item) => item.role === role), {
      ...options,
      onTrackProgress(value) {
        progress.set(role, value);
        const values = Array.from(progress.values());
        options.onProgress?.({
          completed: values.reduce((sum, item) => sum + item.completed, 0),
          total: values.reduce((sum, item) => sum + item.total, 0),
          downloadedBytes: values.reduce((sum, item) => sum + item.downloadedBytes, 0)
        });
      }
    });
  }));
}

export async function runDownload(analysis, descriptors, sinks, options = {}) {
  if (analysis.protocol === "file") {
    const result = await downloadDirectFile(analysis.resolved, {
      signal: options.signal,
      onProgress(loaded, total) {
        options.onProgress?.({ completed: loaded, total, downloadedBytes: loaded });
      }
    });
    options.onLog?.(`浏览器下载完成：${result.filename}`);
    return result;
  }

  let completed = false;
  try {
    if (analysis.protocol === "hls") await downloadHls(analysis, descriptors, sinks, options);
    else if (analysis.protocol === "dash") await downloadDash(analysis, descriptors, sinks, options);
    else throw new Error(`不支持的下载协议：${analysis.protocol}`);
    await closeSinks(sinks);
    completed = true;
    const bytes = Array.from(sinks.values()).reduce((sum, sink) => sum + (sink.bytesWritten || 0), 0);
    options.onLog?.(`媒体写入完成：${formatBytes(bytes)}`);
    return { bytes, files: descriptors.map((item) => item.filename) };
  } catch (error) {
    if (options.keepPartialOnAbort && options.signal?.aborted) {
      await closeSinks(sinks);
      return { stopped: true, files: descriptors.map((item) => item.filename) };
    }
    await abortSinks(sinks, error);
    throw error;
  } finally {
    if (!completed && !options.signal?.aborted) options.onLog?.("任务未完成，已清理未完成的输出。");
  }
}
