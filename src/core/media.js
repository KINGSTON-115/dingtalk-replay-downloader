import { extensionFromUrl, sanitizeFileName, stableId, titleFromUrl } from "./url.js";

const HLS_MIMES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl"
]);
const DASH_MIMES = new Set(["application/dash+xml"]);
const DIRECT_MIME_PREFIXES = ["video/", "audio/"];
const DIRECT_EXTENSIONS = new Map([
  ["mp4", "video/mp4"], ["m4v", "video/mp4"], ["mov", "video/quicktime"],
  ["webm", "video/webm"], ["mkv", "video/x-matroska"], ["flv", "video/x-flv"],
  ["avi", "video/x-msvideo"], ["3gp", "video/3gpp"], ["ogv", "video/ogg"],
  ["mp3", "audio/mpeg"], ["m4a", "audio/mp4"], ["aac", "audio/aac"],
  ["ogg", "audio/ogg"], ["oga", "audio/ogg"], ["wav", "audio/wav"],
  ["ts", "video/mp2t"]
]);
const ALWAYS_SEGMENT_EXTENSIONS = new Set(["m4s", "cmfv", "cmfa"]);
const CONTEXTUAL_SEGMENT_EXTENSIONS = new Set(["aac", "vtt"]);

export function normalizeMime(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

export function classifyMedia({ url = "", mime = "", sourceLabel = "", resourceType = "" } = {}) {
  const normalizedMime = normalizeMime(mime);
  const extension = extensionFromUrl(url);

  if (extension === "m3u8" || HLS_MIMES.has(normalizedMime)) {
    return { kind: "hls", extension: "m3u8", mime: normalizedMime || "application/vnd.apple.mpegurl" };
  }
  if (extension === "mpd" || DASH_MIMES.has(normalizedMime)) {
    return { kind: "dash", extension: "mpd", mime: normalizedMime || "application/dash+xml" };
  }
  if (ALWAYS_SEGMENT_EXTENSIONS.has(extension) || (CONTEXTUAL_SEGMENT_EXTENSIONS.has(extension) && !/media-element|current-tab|direct/i.test(sourceLabel))) {
    return { kind: "segment", extension, mime: normalizedMime || "application/octet-stream" };
  }
  if (extension === "ts" && !/media-element|current-tab|direct/i.test(sourceLabel)) {
    return { kind: "segment", extension, mime: normalizedMime || "video/mp2t" };
  }
  if (DIRECT_EXTENSIONS.has(extension)) {
    return { kind: "file", extension, mime: normalizedMime || DIRECT_EXTENSIONS.get(extension) };
  }
  if (DIRECT_MIME_PREFIXES.some((prefix) => normalizedMime.startsWith(prefix))) {
    const inferred = normalizedMime.includes("webm") ? "webm" : normalizedMime.includes("audio") ? "m4a" : "mp4";
    const likelySegment = resourceType !== "media" && /(?:segment|chunk|frag|m4s|init)/i.test(url);
    return { kind: likelySegment ? "segment" : "file", extension: inferred, mime: normalizedMime };
  }
  if (/media-element|current-tab-media/i.test(sourceLabel) && /^https?:/i.test(url)) {
    return { kind: "file", extension: extension || "mp4", mime: normalizedMime || "video/mp4" };
  }
  return { kind: "unknown", extension, mime: normalizedMime };
}

export function normalizeCandidate(raw = {}, tab = {}) {
  const url = String(raw.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const media = classifyMedia({
    url,
    mime: raw.mime,
    sourceLabel: raw.sourceLabel,
    resourceType: raw.resourceType
  });
  if (media.kind === "unknown") return null;

  const title = sanitizeFileName(raw.title || tab.title || titleFromUrl(url));
  const candidate = {
    id: raw.id || stableId(media.kind, url),
    kind: media.kind,
    extension: raw.extension || media.extension,
    mime: media.mime,
    url,
    title,
    pageUrl: raw.pageUrl || tab.url || "",
    sourceLabel: raw.sourceLabel || "page",
    resourceType: raw.resourceType || "",
    contentLength: Number(raw.contentLength) || 0,
    statusCode: Number(raw.statusCode) || 0,
    tabId: Number.isInteger(raw.tabId) ? raw.tabId : tab.id,
    frameId: Number.isInteger(raw.frameId) ? raw.frameId : 0,
    detectedAt: Number(raw.detectedAt) || Date.now()
  };
  candidate.score = Number.isFinite(raw.score) ? raw.score : scoreCandidate(candidate);
  return candidate;
}

export function scoreCandidate(candidate) {
  let score = 0;
  if (candidate.kind === "hls" || candidate.kind === "dash") score += 100;
  else if (candidate.kind === "file") score += 70;
  else if (candidate.kind === "segment") score += 5;

  const source = String(candidate.sourceLabel || "");
  if (/dingtalk-adapter/.test(source)) score += 40;
  if (/media-element/.test(source)) score += 25;
  if (/network/.test(source)) score += 15;
  if (/page-hook/.test(source)) score += 12;
  if (/link/.test(source)) score -= 10;
  if (candidate.contentLength > 20 * 1024 * 1024) score += 10;
  if (candidate.contentLength > 0 && candidate.contentLength < 128 * 1024) score -= 20;
  if (/(?:ad[sx]?|advert|preview|trailer|sprite|thumbnail)[_.\-/]/i.test(candidate.url)) score -= 30;
  return score;
}

export function mergeCandidates(...groups) {
  const byUrl = new Map();
  for (const candidate of groups.flat()) {
    if (!candidate) continue;
    const previous = byUrl.get(candidate.url);
    if (!previous || candidate.score > previous.score || candidate.detectedAt > previous.detectedAt) {
      byUrl.set(candidate.url, previous ? { ...previous, ...candidate, score: Math.max(previous.score, candidate.score) } : candidate);
    }
  }
  return Array.from(byUrl.values()).sort((a, b) => b.score - a.score || b.detectedAt - a.detectedAt);
}

export function candidateLabel(candidate) {
  const kind = { hls: "HLS", dash: "DASH", file: String(candidate.extension || "视频").toUpperCase(), segment: "媒体分片" }[candidate.kind] || "媒体";
  const size = candidate.contentLength ? ` · ${formatBytes(candidate.contentLength)}` : "";
  return `${kind} · ${candidate.sourceLabel || "页面"}${size} · ${candidate.url}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
