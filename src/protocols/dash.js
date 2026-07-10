import { parse as parseMpd } from "mpd-parser";
import { stableId } from "../core/url.js";
import { fetchTextResource } from "../core/http.js";

function normalizeByterange(value) {
  if (!value || !Number.isFinite(Number(value.length))) return null;
  return { length: Number(value.length), offset: Number(value.offset) || 0 };
}

function normalizeSegments(playlist) {
  return (playlist?.segments || []).map((segment, index) => ({
    id: stableId(segment.resolvedUri || segment.uri, index, segment.byterange?.offset),
    url: segment.resolvedUri || segment.uri,
    duration: Number(segment.duration) || 0,
    sequence: Number(segment.number ?? index),
    timeline: Number(segment.timeline) || 0,
    discontinuity: Boolean(segment.discontinuity),
    byterange: normalizeByterange(segment.byterange),
    map: segment.map ? {
      url: segment.map.resolvedUri || segment.map.uri,
      byterange: normalizeByterange(segment.map.byterange)
    } : null,
    key: null,
    presentationTime: Number(segment.presentationTime) || 0
  }));
}

function normalizePlaylist(playlist, type, groupId = "", streamIndex = 0) {
  const attributes = playlist?.attributes || {};
  const resolution = attributes.RESOLUTION || {};
  return {
    id: stableId(type, groupId, attributes.NAME, attributes.BANDWIDTH, playlist?.resolvedUri),
    type,
    groupId,
    streamIndex,
    name: String(attributes.NAME || ""),
    bandwidth: Number(attributes.BANDWIDTH) || 0,
    codecs: String(attributes.CODECS || ""),
    width: Number(resolution.width) || 0,
    height: Number(resolution.height) || 0,
    frameRate: Number(attributes["FRAME-RATE"]) || 0,
    language: String(attributes.LANGUAGE || ""),
    endList: Boolean(playlist?.endList),
    live: !playlist?.endList,
    targetDuration: Number(playlist?.targetDuration) || 4,
    segments: normalizeSegments(playlist),
    sidx: playlist?.sidx || null,
    raw: playlist
  };
}

function flattenDashMediaGroups(groups, type) {
  const output = [];
  for (const [groupId, labels] of Object.entries(groups || {})) {
    for (const [label, properties] of Object.entries(labels || {})) {
      for (const playlist of properties.playlists || []) {
        output.push({
          ...normalizePlaylist(playlist, type, groupId, output.length),
          label,
          language: properties.language || playlist.attributes?.LANGUAGE || "",
          default: Boolean(properties.default),
          autoselect: Boolean(properties.autoselect)
        });
      }
    }
  }
  return output;
}

export function parseDashManifest(text, url) {
  const warnings = [];
  const drm = /<ContentProtection\b/i.test(text) && /(?:cenc:default_KID|urn:uuid:|widevine|playready|fairplay)/i.test(text);
  const manifest = parseMpd(text, {
    manifestUri: url,
    eventHandler(event) {
      warnings.push(event);
    }
  });
  const variants = (manifest.playlists || []).map((playlist, index) => normalizePlaylist(playlist, "video", "", index));
  const audioTracks = flattenDashMediaGroups(manifest.mediaGroups?.AUDIO, "audio");
  const subtitleTracks = flattenDashMediaGroups(manifest.mediaGroups?.SUBTITLES, "subtitles");
  if (!variants.length && audioTracks.length) {
    variants.push(...audioTracks.map((track) => ({ ...track, type: "audio-only" })));
  }
  return {
    protocol: "dash",
    url,
    duration: Number(manifest.duration) || 0,
    live: !manifest.endList,
    endList: Boolean(manifest.endList),
    variants,
    audioTracks,
    subtitleTracks,
    drm,
    warnings,
    raw: manifest
  };
}

export function chooseDashVariant(variants, variantId) {
  return variants.find((item) => item.id === variantId) || [...variants].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0] || null;
}

export function chooseDashAudio(tracks, trackId) {
  return tracks.find((item) => item.id === trackId) || tracks.find((item) => item.default) || tracks[0] || null;
}

export function chooseDashSubtitle(tracks, trackId) {
  return trackId ? tracks.find((item) => item.id === trackId) || null : null;
}

export async function inspectDash(url, options = {}) {
  const resource = await fetchTextResource(url, {
    ...options.http,
    signal: options.signal,
    headers: { Accept: "application/dash+xml, application/xml, text/xml, */*", ...options.http?.headers }
  });
  const manifest = parseDashManifest(resource.text, resource.finalUrl);
  return {
    protocol: "dash",
    sourceUrl: url,
    manifestUrl: resource.finalUrl,
    manifest,
    variants: manifest.variants,
    audioTracks: manifest.audioTracks,
    subtitleTracks: manifest.subtitleTracks,
    duration: manifest.duration,
    live: manifest.live,
    drm: manifest.drm
  };
}

export function resolveDashPlan(inspection, options = {}) {
  const manifest = inspection.manifest;
  if (manifest.drm) throw new Error("检测到 DASH ContentProtection/DRM，本扩展不会绕过受保护媒体。");
  const video = chooseDashVariant(manifest.variants, options.variantId);
  if (!video) throw new Error("DASH 清单中没有可下载的媒体轨道。");
  const audio = video.type === "audio-only" ? null : chooseDashAudio(manifest.audioTracks, options.audioTrackId);
  const subtitle = chooseDashSubtitle(manifest.subtitleTracks, options.subtitleTrackId);
  const usesSidx = Boolean(video.sidx || audio?.sidx || subtitle?.sidx);
  return {
    protocol: "dash",
    sourceUrl: inspection.sourceUrl,
    manifestUrl: inspection.manifestUrl,
    video,
    audio,
    subtitle,
    subtitleTracks: manifest.subtitleTracks,
    duration: manifest.duration,
    live: manifest.live,
    container: "fmp4",
    requiresSeparateAudio: Boolean(audio),
    requiresNativeMerge: Boolean(audio) || usesSidx,
    usesSidx,
    drm: false
  };
}

export function formatDashVariant(variant) {
  const resolution = variant.height ? `${variant.width || "?"}×${variant.height}` : variant.type === "audio-only" ? "仅音频" : "未知分辨率";
  const bandwidth = variant.bandwidth ? `${(variant.bandwidth / 1_000_000).toFixed(2)} Mbps` : "未知码率";
  return `${resolution} · ${bandwidth}${variant.codecs ? ` · ${variant.codecs}` : ""}`;
}
