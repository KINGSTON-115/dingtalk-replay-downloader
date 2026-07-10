import { fetchTextResource } from "../core/http.js";
import { classifyMedia } from "../core/media.js";
import { normalizeUserInput, sanitizeFileName, stableId } from "../core/url.js";

const API_URL = "https://lv.dingtalk.com/getOpenLiveInfo";
const CANONICAL_URL = "https://n.dingtalk.com/dingding/live-room/index.html";

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (originalError) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw originalError;
  }
}

function decodeSafely(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeDingtalkInput(rawInput) {
  let input = normalizeUserInput(rawInput);
  if (/roomId=|liveUuid=/i.test(input) && !/^https?:\/\//i.test(input)) {
    input = `${CANONICAL_URL}?${input.replace(/^\?/, "")}`;
  }
  return input;
}

export function extractDingtalkParams(rawInput) {
  const input = normalizeDingtalkInput(rawInput);
  let roomId = "";
  let liveUuid = "";
  try {
    const url = new URL(input);
    const sets = [url.searchParams];
    if (url.hash) {
      const hash = url.hash.slice(1);
      const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash;
      sets.push(new URLSearchParams(query));
      const decodedHash = decodeSafely(hash);
      if (decodedHash !== hash) sets.push(new URLSearchParams(decodedHash.split("?").pop()));
    }
    for (const params of sets) {
      roomId ||= params.get("roomId") || params.get("roomid") || "";
      liveUuid ||= params.get("liveUuid") || params.get("liveuuid") || "";
    }
    const decoded = decodeSafely(url.href);
    roomId ||= decoded.match(/(?:roomId|roomid)=([^&#\s]+)/i)?.[1] || "";
    liveUuid ||= decoded.match(/liveUuid=([^&#\s]+)/i)?.[1] || "";
  } catch {
    roomId = input.match(/(?:roomId|roomid)=([^&#\s]+)/i)?.[1] || "";
    liveUuid = input.match(/liveUuid=([^&#\s]+)/i)?.[1] || "";
  }
  roomId = decodeSafely(String(roomId).trim());
  liveUuid = decodeSafely(String(liveUuid).trim());
  return { input, roomId, liveUuid };
}

export function matchesDingtalkReplay(rawInput) {
  const { input, roomId, liveUuid } = extractDingtalkParams(rawInput);
  if (!roomId || !liveUuid) return false;
  try {
    return /(?:^|\.)dingtalk\.com$/i.test(new URL(input).hostname);
  } catch {
    return true;
  }
}

function parseNested(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function collectPlaybackUrls(value, path = "model", output = [], depth = 0) {
  if (depth > 7 || value == null) return output;
  const parsed = parseNested(value);
  if (typeof parsed === "string") {
    let url = parsed.trim();
    if (url.startsWith("//")) url = `https:${url}`;
    const match = url.match(/https?:\/\/[^\s"']+/i);
    if (match && /(?:play|video|stream|m3u8|mpd|\.mp4|\.webm)/i.test(`${path} ${match[0]}`)) {
      output.push({ url: match[0].replace(/\\u0026/g, "&").replace(/\\\//g, "/"), source: path });
    }
    return output;
  }
  if (Array.isArray(parsed)) {
    parsed.forEach((item, index) => collectPlaybackUrls(item, `${path}[${index}]`, output, depth + 1));
    return output;
  }
  if (typeof parsed === "object") {
    for (const [key, item] of Object.entries(parsed)) {
      if (/^(?:cover|coverUrl|poster|posterUrl|avatar|avatarUrl|thumbnail|thumbnailUrl|spriteUrl|spriteImage)$/i.test(key)) continue;
      collectPlaybackUrls(item, `${path}.${key}`, output, depth + 1);
    }
  }
  return output;
}

export function parseDingtalkResponse(body, params) {
  if (body?.isLogined === false) throw new Error("钉钉返回当前浏览器未登录，请先在同一浏览器登录并确认回放可播放。");
  const model = body?.openLiveDetailModel || body?.data?.openLiveDetailModel || body?.result?.openLiveDetailModel || body?.openLiveModel || body?.data || body?.result;
  if (!model || typeof model !== "object") throw new Error("钉钉响应中没有可识别的回放信息。");

  const seen = new Set();
  const playbackCandidates = collectPlaybackUrls(model).filter((item) => {
    if (!/^https?:\/\//i.test(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).map((item) => {
    const media = classifyMedia({ url: item.url, sourceLabel: "dingtalk-adapter" });
    return {
      id: stableId(item.url),
      url: item.url,
      kind: media.kind,
      extension: media.extension,
      mime: media.mime,
      source: item.source
    };
  });

  if (!playbackCandidates.length) {
    if (Number(model.playbackDuration) > 0 || Number(model.status) === 3) {
      throw new Error("回放存在，但当前账号或当前状态没有返回播放地址。");
    }
    throw new Error("钉钉没有返回回放播放地址，直播可能尚未结束或未开启回放。");
  }

  playbackCandidates.sort((a, b) => {
    const rank = { hls: 3, dash: 2, file: 1, unknown: 0 };
    return (rank[b.kind] || 0) - (rank[a.kind] || 0);
  });
  return {
    title: sanitizeFileName(model.title || model.liveTitle || model.name || "dingtalk-replay"),
    duration: Number(model.playbackDuration) || 0,
    playbackCandidates,
    roomId: params.roomId,
    liveUuid: params.liveUuid
  };
}

export async function resolveDingtalkReplay(rawInput, options = {}) {
  const params = extractDingtalkParams(rawInput);
  if (!params.roomId || !params.liveUuid) throw new Error("没有找到完整的 roomId 和 liveUuid。");
  const url = new URL(API_URL);
  url.searchParams.set("roomId", params.roomId);
  url.searchParams.set("liveUuid", params.liveUuid);
  const resource = await fetchTextResource(url.href, {
    ...options.http,
    signal: options.signal,
    headers: { Accept: "application/json, text/plain, */*", ...options.http?.headers }
  });
  const replay = parseDingtalkResponse(parseJsonLoose(resource.text), params);
  const selected = replay.playbackCandidates[0];
  return {
    type: selected.kind,
    protocol: selected.kind,
    title: replay.title,
    playbackUrl: selected.url,
    playbackSource: selected.source,
    pageUrl: params.input,
    alternatives: replay.playbackCandidates,
    adapter: "dingtalk",
    metadata: { roomId: params.roomId, liveUuid: params.liveUuid, duration: replay.duration }
  };
}
