import { resolveDingtalkReplay, matchesDingtalkReplay } from "../adapters/dingtalk.js";
import { fetchPrefixResource } from "./http.js";
import { classifyMedia, normalizeMime } from "./media.js";
import { fileNameFromContentDisposition, normalizeUserInput, sanitizeFileName, titleFromUrl } from "./url.js";
import { inspectHls, resolveHlsPlan } from "../protocols/hls.js";
import { inspectDash, resolveDashPlan } from "../protocols/dash.js";

function sniffBinaryMedia(bytes) {
  if (bytes.byteLength >= 12 && new TextDecoder("ascii").decode(bytes.slice(4, 8)) === "ftyp") {
    return { kind: "file", extension: "mp4", mime: "video/mp4" };
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { kind: "file", extension: "webm", mime: "video/webm" };
  }
  if (bytes.byteLength >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "FLV") {
    return { kind: "file", extension: "flv", mime: "video/x-flv" };
  }
  if (bytes.byteLength >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === "OggS") {
    return { kind: "file", extension: "ogg", mime: "audio/ogg" };
  }
  if (bytes.byteLength >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "ID3") {
    return { kind: "file", extension: "mp3", mime: "audio/mpeg" };
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { kind: "file", extension: "mp3", mime: "audio/mpeg" };
  }
  if (bytes.byteLength >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47) {
    return { kind: "file", extension: "ts", mime: "video/mp2t" };
  }
  return null;
}

export async function probeMediaUrl(url, options = {}) {
  const resource = await fetchPrefixResource(url, {
    ...options.http,
    signal: options.signal,
    headers: { Accept: "*/*", ...options.http?.headers },
    limit: 65536,
    retries: 1
  });
  const finalUrl = resource.finalUrl || url;
  const mime = normalizeMime(resource.mime);
  let media = classifyMedia({ url: finalUrl, mime, sourceLabel: "direct-probe", resourceType: "media" });
  const prefix = { bytes: resource.bytes, text: new TextDecoder().decode(resource.bytes) };
  if (media.kind === "unknown" || /(?:text|xml|json|octet-stream)/i.test(mime)) {
    if (/^\s*#EXTM3U/m.test(prefix.text)) media = { kind: "hls", extension: "m3u8", mime: mime || "application/vnd.apple.mpegurl" };
    else if (/<MPD\b/i.test(prefix.text)) media = { kind: "dash", extension: "mpd", mime: mime || "application/dash+xml" };
    else media = sniffBinaryMedia(prefix.bytes) || media;
  }
  return {
    ...media,
    finalUrl,
    mime: media.mime || mime,
    contentLength: resource.contentLength,
    contentDisposition: resource.contentDisposition,
    prefix: prefix.text
  };
}

export async function resolveInput(rawInput, options = {}) {
  const input = normalizeUserInput(rawInput);
  if (!input) throw new Error("请输入视频页面、播放清单或媒体文件地址。");
  if (/^blob:/i.test(input)) throw new Error("blob 地址只是页面内的临时句柄，请先开启识别并播放视频，以捕获其底层媒体请求。");
  if (!/^https?:\/\//i.test(input) && !matchesDingtalkReplay(input)) throw new Error("只支持 HTTP/HTTPS 媒体地址或有效的钉钉回放参数。");

  if (matchesDingtalkReplay(input)) return resolveDingtalkReplay(input, options);

  let media = classifyMedia({ url: input, sourceLabel: "direct-url", resourceType: "media" });
  let probe = null;
  if (media.kind === "unknown") {
    probe = await probeMediaUrl(input, options);
    media = probe;
  }
  if (!["hls", "dash", "file"].includes(media.kind)) {
    throw new Error("该地址没有返回可识别的 HLS、DASH 或普通媒体内容。若它是播放页面，请点击“识别当前页”。");
  }
  const finalUrl = probe?.finalUrl || input;
  const dispositionName = fileNameFromContentDisposition(probe?.contentDisposition).replace(/\.[a-z0-9]{2,6}$/i, "");
  return {
    type: media.kind,
    protocol: media.kind,
    title: sanitizeFileName(options.candidate?.title || dispositionName || titleFromUrl(finalUrl)),
    playbackUrl: finalUrl,
    playbackSource: options.candidate?.sourceLabel || "direct-url",
    pageUrl: options.candidate?.pageUrl || "",
    extension: media.extension,
    mime: media.mime,
    contentLength: probe?.contentLength || options.candidate?.contentLength || 0,
    adapter: "generic"
  };
}

export async function analyzeSource(rawInput, options = {}) {
  const resolved = await resolveInput(rawInput, options);
  return analyzeResolvedSource(resolved, options);
}

export async function analyzeResolvedSource(resolved, options = {}) {
  if (resolved.type === "unknown") {
    const probe = await probeMediaUrl(resolved.playbackUrl, options);
    if (!["hls", "dash", "file"].includes(probe.kind)) throw new Error("站点返回了无法识别的播放地址。");
    resolved = {
      ...resolved,
      type: probe.kind,
      protocol: probe.kind,
      playbackUrl: probe.finalUrl,
      extension: probe.extension,
      mime: probe.mime,
      contentLength: probe.contentLength
    };
  }
  if (resolved.type === "hls") {
    const inspection = await inspectHls(resolved.playbackUrl, options);
    const plan = await resolveHlsPlan(inspection, options);
    return { resolved, inspection, plan, protocol: "hls" };
  }
  if (resolved.type === "dash") {
    const inspection = await inspectDash(resolved.playbackUrl, options);
    const plan = resolveDashPlan(inspection, options);
    return { resolved, inspection, plan, protocol: "dash" };
  }
  return {
    resolved,
    inspection: {
      protocol: "file",
      variants: [],
      audioTracks: [],
      subtitleTracks: [],
      duration: 0,
      live: false,
      drm: false
    },
    plan: {
      protocol: "file",
      url: resolved.playbackUrl,
      mime: resolved.mime,
      extension: resolved.extension || "mp4",
      contentLength: resolved.contentLength || 0
    },
    protocol: "file"
  };
}
