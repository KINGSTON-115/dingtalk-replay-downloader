import { Parser } from "m3u8-parser";
import { fetchTextResource } from "../core/http.js";
import { resolveHttpUrl, stableId } from "../core/url.js";

function parseWithLibrary(text, url, mainDefinitions) {
  if (!/^\s*#EXTM3U/m.test(String(text || ""))) throw new Error("响应内容不是有效的 HLS 播放列表。");
  const parser = new Parser({ url, mainDefinitions });
  parser.push(text);
  parser.end();
  return parser.manifest;
}

function normalizeByterange(value) {
  if (!value || !Number.isFinite(Number(value.length))) return null;
  return {
    length: Number(value.length),
    offset: Number(value.offset) || 0
  };
}

function normalizeKey(key, baseUrl) {
  if (!key || !key.method || String(key.method).toUpperCase() === "NONE") return null;
  const method = String(key.method).toUpperCase();
  const keyFormat = String(key.keyFormat || key.KEYFORMAT || "identity");
  const rawUri = String(key.uri || "");
  return {
    method,
    uri: rawUri ? (/^data:/i.test(rawUri) ? rawUri : resolveHttpUrl(baseUrl, rawUri)) : "",
    iv: key.iv || null,
    keyFormat,
    keyFormatVersions: key.keyFormatVersions || ""
  };
}

function normalizeMap(map, baseUrl) {
  if (!map?.uri) return null;
  return {
    url: resolveHttpUrl(baseUrl, map.uri),
    byterange: normalizeByterange(map.byterange)
  };
}

function normalizeSegments(manifest, baseUrl) {
  const mediaSequence = Number(manifest.mediaSequence) || 0;
  return (manifest.segments || []).map((segment, index) => ({
    id: stableId(baseUrl, mediaSequence + index, segment.uri, segment.byterange?.offset),
    url: resolveHttpUrl(baseUrl, segment.uri),
    duration: Number(segment.duration) || 0,
    sequence: mediaSequence + index,
    timeline: Number(segment.timeline) || 0,
    discontinuity: Boolean(segment.discontinuity),
    byterange: normalizeByterange(segment.byterange),
    map: normalizeMap(segment.map, baseUrl),
    key: normalizeKey(segment.key, baseUrl),
    programDateTime: Number(segment.programDateTime) || 0
  }));
}

function normalizeVariants(manifest, baseUrl) {
  return (manifest.playlists || []).filter((playlist) => playlist.uri).map((playlist, index) => {
    const attributes = playlist.attributes || {};
    const resolution = attributes.RESOLUTION || {};
    const url = resolveHttpUrl(baseUrl, playlist.uri);
    return {
      id: stableId(url, attributes.BANDWIDTH, resolution.width, resolution.height),
      index,
      url,
      bandwidth: Number(attributes.BANDWIDTH) || 0,
      averageBandwidth: Number(attributes["AVERAGE-BANDWIDTH"]) || 0,
      width: Number(resolution.width) || 0,
      height: Number(resolution.height) || 0,
      frameRate: Number(attributes["FRAME-RATE"]) || 0,
      codecs: String(attributes.CODECS || ""),
      audioGroup: String(attributes.AUDIO || ""),
      subtitlesGroup: String(attributes.SUBTITLES || ""),
      name: String(attributes.NAME || "")
    };
  });
}

function flattenMediaGroup(group, baseUrl, type) {
  const tracks = [];
  for (const [groupId, names] of Object.entries(group || {})) {
    for (const [name, properties] of Object.entries(names || {})) {
      tracks.push({
        id: stableId(type, groupId, name, properties.uri),
        type,
        groupId,
        name,
        language: properties.language || "",
        default: Boolean(properties.default),
        autoselect: Boolean(properties.autoselect),
        forced: Boolean(properties.forced),
        characteristics: properties.characteristics || "",
        url: properties.uri ? resolveHttpUrl(baseUrl, properties.uri) : "",
        properties
      });
    }
  }
  return tracks;
}

export function parseHlsManifest(text, url, options = {}) {
  const manifest = parseWithLibrary(text, url, options.mainDefinitions);
  const variants = normalizeVariants(manifest, url);
  const segments = normalizeSegments(manifest, url);
  const audioTracks = flattenMediaGroup(manifest.mediaGroups?.AUDIO, url, "audio");
  const subtitleTracks = flattenMediaGroup(manifest.mediaGroups?.SUBTITLES, url, "subtitles");
  const contentProtection = Object.values(manifest.contentProtection || {});
  const unsupportedKeys = segments.filter((segment) => {
    const key = segment.key;
    return key && (key.method !== "AES-128" || !/^(?:identity)?$/i.test(key.keyFormat));
  });
  const container = segments.some((segment) => segment.map) || segments.some((segment) => /\.(?:m4s|mp4|cmfv|cmfa)(?:[?#]|$)/i.test(segment.url))
    ? "fmp4"
    : segments.some((segment) => /\.(?:vtt|webvtt)(?:[?#]|$)/i.test(segment.url)) ? "vtt"
      : segments.some((segment) => /\.(?:aac|m4a)(?:[?#]|$)/i.test(segment.url)) ? "aac" : "ts";

  return {
    protocol: "hls",
    url,
    isMaster: variants.length > 0,
    variants,
    audioTracks,
    subtitleTracks,
    segments,
    mediaSequence: Number(manifest.mediaSequence) || 0,
    discontinuitySequence: Number(manifest.discontinuitySequence) || 0,
    targetDuration: Number(manifest.targetDuration) || 6,
    totalDuration: Number(manifest.totalDuration) || segments.reduce((sum, segment) => sum + segment.duration, 0),
    endList: Boolean(manifest.endList),
    live: !manifest.endList,
    container,
    encrypted: segments.some((segment) => segment.key?.method === "AES-128"),
    drm: unsupportedKeys.length > 0 || contentProtection.length > 0,
    unsupportedEncryption: unsupportedKeys[0]?.key || (contentProtection[0]?.attributes ? {
      method: contentProtection[0].attributes.METHOD || "SAMPLE-AES",
      keyFormat: contentProtection[0].attributes.KEYFORMAT || "protected"
    } : null),
    definitions: manifest.definitions || {},
    raw: manifest
  };
}

export function chooseVariant(variants, variantId) {
  if (!variants?.length) return null;
  const requested = variants.find((variant) => variant.id === variantId);
  if (requested) return requested;
  return [...variants].sort((a, b) => {
    const aSupported = !a.codecs || /(?:avc1|avc3|h264|mp4a)/i.test(a.codecs);
    const bSupported = !b.codecs || /(?:avc1|avc3|h264|mp4a)/i.test(b.codecs);
    if (aSupported !== bSupported) return bSupported - aSupported;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  })[0];
}

export function chooseTrack(tracks, groupId, trackId) {
  const eligible = (tracks || []).filter((track) => !groupId || track.groupId === groupId);
  return eligible.find((track) => track.id === trackId) || eligible.find((track) => track.default) || eligible[0] || null;
}

async function fetchAndParse(url, options = {}) {
  const resource = await fetchTextResource(url, {
    ...options.http,
    signal: options.signal,
    headers: {
      Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*",
      ...options.http?.headers
    }
  });
  return {
    resource,
    manifest: parseHlsManifest(resource.text, resource.finalUrl, { mainDefinitions: options.mainDefinitions })
  };
}

export async function inspectHls(url, options = {}) {
  const { resource, manifest } = await fetchAndParse(url, options);
  return {
    protocol: "hls",
    sourceUrl: url,
    manifestUrl: resource.finalUrl,
    master: manifest,
    variants: manifest.variants,
    audioTracks: manifest.audioTracks,
    subtitleTracks: manifest.subtitleTracks,
    live: manifest.live,
    duration: manifest.totalDuration,
    drm: manifest.drm
  };
}

export async function resolveHlsPlan(inspection, options = {}) {
  let current = inspection.master;
  let selectedVariant = null;
  let depth = 0;
  const master = inspection.master;

  while (current.isMaster) {
    if (depth >= 5) throw new Error("HLS 主清单嵌套层级过多。");
    selectedVariant = chooseVariant(current.variants, options.variantId || selectedVariant?.id);
    if (!selectedVariant) throw new Error("HLS 主清单没有可用清晰度。");
    await options.ensureUrls?.([selectedVariant.url]);
    const loaded = await fetchAndParse(selectedVariant.url, {
      ...options,
      mainDefinitions: master.definitions
    });
    current = loaded.manifest;
    depth += 1;
  }

  if (!current.segments.length && !current.live) throw new Error("HLS 播放列表中没有媒体分片。");
  if (current.drm) {
    const key = current.unsupportedEncryption;
    throw new Error(`检测到不支持或受保护的 HLS 加密：${key?.method || "unknown"} / ${key?.keyFormat || "identity"}`);
  }

  const audioTrack = chooseTrack(master.audioTracks, selectedVariant?.audioGroup, options.audioTrackId);
  let audioPlaylist = null;
  if (audioTrack?.url) {
    await options.ensureUrls?.([audioTrack.url]);
    const loaded = await fetchAndParse(audioTrack.url, options);
    if (loaded.manifest.isMaster) throw new Error("暂不支持嵌套的 HLS 独立音轨主清单。");
    audioPlaylist = loaded.manifest;
  }
  const eligibleSubtitles = master.subtitleTracks.filter((track) => !selectedVariant?.subtitlesGroup || track.groupId === selectedVariant.subtitlesGroup);
  const subtitleTrack = options.subtitleTrackId ? eligibleSubtitles.find((track) => track.id === options.subtitleTrackId) || null : null;
  let subtitlePlaylist = null;
  if (subtitleTrack?.url) {
    await options.ensureUrls?.([subtitleTrack.url]);
    const loaded = await fetchAndParse(subtitleTrack.url, options);
    if (loaded.manifest.isMaster) throw new Error("暂不支持嵌套的 HLS 字幕主清单。");
    subtitlePlaylist = loaded.manifest;
  }

  return {
    protocol: "hls",
    sourceUrl: inspection.sourceUrl,
    masterUrl: inspection.manifestUrl,
    selectedVariant,
    audioTrack,
    subtitleTracks: eligibleSubtitles,
    subtitleTrack,
    subtitlePlaylist,
    playlist: current,
    audioPlaylist,
    live: current.live,
    duration: current.totalDuration,
    container: current.container,
    requiresSeparateAudio: Boolean(audioPlaylist),
    requiresNativeMerge: Boolean(audioPlaylist),
    drm: false
  };
}

export async function reloadHlsPlaylist(url, options = {}) {
  const loaded = await fetchAndParse(url, options);
  if (loaded.manifest.isMaster) throw new Error("直播媒体地址意外返回了主清单。");
  return loaded.manifest;
}

export function formatVariant(variant) {
  const resolution = variant.height ? `${variant.width || "?"}×${variant.height}` : "未知分辨率";
  const bandwidth = variant.bandwidth ? `${(variant.bandwidth / 1_000_000).toFixed(2)} Mbps` : "未知码率";
  const codec = variant.codecs ? ` · ${variant.codecs}` : "";
  return `${resolution} · ${bandwidth}${codec}`;
}
