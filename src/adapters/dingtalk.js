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
  if (body?.isLogined === false) {
    throw new Error("钉钉接口返回“未登录”（页面账号可能仍已登录）。请保持可正常播放的回放标签页打开，从该页点击插件后重新识别。");
  }
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
  const requestOptions = {
    ...options.http,
    signal: options.signal,
    headers: { Accept: "application/json, text/plain, */*", ...options.http?.headers }
  };
  const transports = [];
  if (typeof options.authenticatedFetchText === "function") {
    transports.push({
      label: "钉钉 Cookie 会话",
      fetch: () => options.authenticatedFetchText(url.href, { ...requestOptions, pageUrl: params.input })
    });
  }
  if (typeof options.pageFetchText === "function") {
    transports.push({
      label: "当前钉钉标签页会话",
      fetch: () => options.pageFetchText(url.href, { ...requestOptions, pageUrl: params.input })
    });
  }
  transports.push({ label: "扩展默认请求", fetch: () => fetchTextResource(url.href, requestOptions) });

  let loginRejected = false;
  let authenticatedError = null;
  let lastRequestError = null;
  for (const transport of transports) {
    let resource;
    try {
      resource = await transport.fetch();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      if (transport.label === "钉钉 Cookie 会话") authenticatedError = error;
      lastRequestError = error;
      options.onLog?.(`${transport.label}失败：${error.message}`);
      continue;
    }
    const body = parseJsonLoose(resource.text);
    if (body?.isLogined === false) {
      loginRejected = true;
      options.onLog?.(`${transport.label}未被钉钉接口识别为已登录，继续尝试兼容路径。`);
      continue;
    }
    options.onLog?.(`${transport.label}已成功取得回放信息。`);
    const replay = parseDingtalkResponse(body, params);
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
  if (authenticatedError) throw new Error(`钉钉 Cookie 会话请求失败：${authenticatedError.message}`);
  if (loginRejected) throw new Error("钉钉接口仍未接受当前登录会话。请重新加载钉钉回放页并确认可播放后再试。");
  throw lastRequestError || new Error("钉钉回放信息请求失败。");
}
