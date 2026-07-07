const API_URL = "https://lv.dingtalk.com/getOpenLiveInfo";
const CANONICAL_REPLAY_URL = "https://n.dingtalk.com/dingding/live-room/index.html";
const COOKIE_URLS = [
  "https://dingtalk.com/",
  "https://www.dingtalk.com/",
  "https://n.dingtalk.com/",
  "https://lv.dingtalk.com/",
  "https://login.dingtalk.com/",
  "https://h5.dingtalk.com/"
];
const COOKIE_DOMAINS = [
  ".dingtalk.com",
  "dingtalk.com",
  "lv.dingtalk.com",
  "n.dingtalk.com",
  "login.dingtalk.com"
];

const I18N = {
  zh: {
    pageTitle: "钉钉直播回放下载器",
    eyebrow: "本地扩展",
    appTitle: "钉钉直播回放",
    openTab: "独立页",
    localOnly: "本地处理",
    authorizedOnly: "已授权回放",
    noServerAccount: "无插件账号系统",
    sourceTitle: "回放来源",
    sourceHint: "粘贴回放链接，或直接输入 roomId 与 liveUuid。",
    useCurrentTab: "当前页",
    replayLink: "回放链接",
    replayPlaceholder: "https://n.dingtalk.com/... 或 roomId=...&liveUuid=...",
    inputHint: "支持钉钉回放链接或 roomId=...&liveUuid=...",
    clear: "清空",
    settingsTitle: "下载设置",
    output: "输出格式",
    mp4Option: "MP4",
    tsOption: "TS",
    concurrency: "并发数",
    download: "开始下载",
    cancel: "取消任务",
    activityLog: "运行日志",
    logEmpty: "等待下载任务...",
    statusIdle: "就绪",
    statusPreparing: "准备中",
    statusReadingCookies: "读取钉钉 Cookie",
    statusResolving: "解析回放地址",
    statusParsingM3u8: "解析 m3u8",
    statusDownloadingSegments: "下载分片 {completed}/{total}",
    statusMerging: "合并分片",
    statusTransmuxing: "转封装 MP4",
    statusDone: "完成",
    statusFailed: "失败",
    logSelectedVariant: "选择媒体列表：{url}",
    logDownloadedSegments: "下载进度：{completed}/{total}",
    logCollectedCookies: "读取 Cookie：{count} 个",
    logTitle: "标题：{title}",
    logPlaybackSource: "地址来源：{source}",
    logPlaybackUrl: "回放地址：{url}",
    logSegments: "分片：{count} 个",
    logEncrypted: "加密：{value}",
    logMergedTsSize: "TS 大小：{size}",
    logMp4Failed: "MP4 转封装失败：{message}",
    logSavingTs: "改为保存 TS。",
    logSaved: "保存完成：{filename}（{size}）",
    logCancelRequested: "正在取消...",
    yes: "是",
    no: "否",
    errMissingParams: "回放链接中没有找到 roomId 和 liveUuid。",
    errNotLoggedIn: "钉钉返回当前浏览器未登录。请先在这个浏览器里打开钉钉并登录。",
    errMissingModel: "钉钉响应中没有 openLiveDetailModel。",
    errReplayRestricted: "回放存在，但钉钉没有返回播放地址。可能是回放不可用或权限受限。",
    errEmptyPlayback: "回放播放地址为空。直播可能尚未结束，或没有开启回放。",
    errNotM3u8: "这看起来不是 m3u8 播放列表。",
    errTooManyNestedM3u8: "m3u8 嵌套层级过多。",
    errNoSegments: "m3u8 中没有找到视频分片。",
    errAesKeyLength: "AES-128 密钥必须是 16 字节。",
    errUnsupportedEncryption: "暂不支持的 HLS 加密方式：{method}",
    errNoCookies: "没有找到钉钉 Cookie。请先在这个浏览器里登录钉钉。",
    errCancelled: "下载已取消。",
    errMuxUnavailable: "mux.js 不可用。",
    errMuxNoData: "mux.js 没有生成 MP4 数据。",
    errorPrefix: "错误：{message}"
  }
};

const els = {
  replayUrl: document.getElementById("replayUrl"),
  outputOptions: Array.from(document.querySelectorAll('input[name="outputFormat"]')),
  concurrency: document.getElementById("concurrency"),
  startBtn: document.getElementById("startBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  openTabBtn: document.getElementById("openTabBtn"),
  useCurrentTabBtn: document.getElementById("useCurrentTabBtn"),
  clearBtn: document.getElementById("clearBtn"),
  statusText: document.getElementById("statusText"),
  progressText: document.getElementById("progressText"),
  progressBar: document.getElementById("progressBar"),
  log: document.getElementById("log")
};

let activeRun = null;
let currentStatus = { key: "statusIdle", params: {}, percent: 0 };

function t(key, params = {}) {
  const table = I18N.zh;
  const fallback = I18N.zh[key] || key;
  return String(table[key] || fallback).replace(/\{(\w+)\}/g, (match, name) => {
    return params[name] == null ? "" : String(params[name]);
  });
}

function applyLocale() {
  document.documentElement.lang = "zh-CN";
  document.title = t("pageTitle");

  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });

  document.querySelectorAll("[data-i18n-empty]").forEach((node) => {
    node.dataset.empty = t(node.dataset.i18nEmpty);
  });

  els.statusText.textContent = t(currentStatus.key, currentStatus.params);
}

function chromeCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  els.log.textContent += `[${time}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(key, percent, params = {}) {
  currentStatus = { key, params, percent };
  els.statusText.textContent = t(key, params);
  if (typeof percent === "number") {
    const safe = Math.max(0, Math.min(100, percent));
    els.progressText.textContent = `${Math.round(safe)}%`;
    els.progressBar.style.width = `${safe}%`;
  }
}

function sanitizeFileName(value) {
  const cleaned = String(value || "dingtalk-replay")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ");
  return cleaned || "dingtalk-replay";
}

function normalizeReplayInput(input) {
  let text = String(input || "").trim().replace(/\u200b/g, "");
  if (!text) return "";

  const urlMatch = text.match(/https?:\/\/[^\s<>"']+/i);
  if (urlMatch) {
    text = urlMatch[0].replace(/[)\]}>，。；、]+$/g, "");
  } else if (/^[\w.-]+\.[\w.-]+/.test(text) || text.includes("dingtalk.com")) {
    text = text.replace(/^\/+/, "");
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  } else if (/roomId=|liveUuid=/i.test(text)) {
    const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
    text = `${CANONICAL_REPLAY_URL}?${query.replace(/^\?+/, "")}`;
  }

  return text.trim();
}

function extractParamsFromUrl(rawInput) {
  const input = normalizeReplayInput(rawInput);
  let roomId = "";
  let liveUuid = "";

  try {
    const url = new URL(input);
    roomId = url.searchParams.get("roomId") || "";
    liveUuid = url.searchParams.get("liveUuid") || "";

    if ((!roomId || !liveUuid) && url.hash) {
      const hash = url.hash.replace(/^#/, "");
      const queryIndex = hash.indexOf("?");
      if (queryIndex >= 0) {
        const params = new URLSearchParams(hash.slice(queryIndex + 1));
        roomId ||= params.get("roomId") || "";
        liveUuid ||= params.get("liveUuid") || "";
      }

      const parts = hash.split("/");
      for (let i = 0; i < parts.length; i += 1) {
        const key = parts[i].toLowerCase();
        if ((key === "room" || key === "roomid") && parts[i + 1]) roomId ||= parts[i + 1];
        if (key === "liveuuid" && parts[i + 1]) liveUuid ||= parts[i + 1];
      }
    }

    if (!roomId || !liveUuid) {
      const parts = url.pathname.split("/");
      for (let i = 0; i < parts.length; i += 1) {
        const key = parts[i].toLowerCase();
        if ((key === "room" || key === "roomid") && parts[i + 1]) roomId ||= parts[i + 1];
        if (key === "liveuuid" && parts[i + 1]) liveUuid ||= parts[i + 1];
      }
    }
  } catch (error) {
    const roomMatch = input.match(/(?:roomId|roomid)=([^&#\s]+)/i);
    const liveMatch = input.match(/liveUuid=([^&#\s]+)/i);
    roomId = roomMatch ? roomMatch[1] : "";
    liveUuid = liveMatch ? liveMatch[1] : "";
  }

  roomId = decodeURIComponent(String(roomId || "").trim());
  liveUuid = decodeURIComponent(String(liveUuid || "").trim());

  if (!roomId || !liveUuid) {
    throw new Error(t("errMissingParams"));
  }

  return { input, roomId, liveUuid };
}

async function getCookies(details) {
  if (!chrome.cookies || !chrome.cookies.getAll) return [];
  try {
    return await chromeCall(chrome.cookies.getAll, details);
  } catch (error) {
    return [];
  }
}

async function collectDingtalkCookies() {
  const jar = new Map();

  for (const url of COOKIE_URLS) {
    const cookies = await getCookies({ url });
    for (const cookie of cookies) jar.set(cookie.name, cookie.value);
  }

  for (const domain of COOKIE_DOMAINS) {
    const cookies = await getCookies({ domain });
    for (const cookie of cookies) jar.set(cookie.name, cookie.value);
  }

  return jar;
}

function buildCookieHeader(cookieMap) {
  return Array.from(cookieMap.entries())
    .filter(([name, value]) => name && value)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function requestHeaders(extraHeaders = {}, cookieHeader = "", referer = "") {
  const headers = {
    "Accept": "*/*",
    ...extraHeaders
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (referer) headers.Referer = referer;
  return headers;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    credentials: options.credentials || "include",
    headers: requestHeaders(options.headers, options.cookieHeader, options.referer)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
  return response.text();
}

async function fetchBuffer(url, options = {}) {
  const response = await fetch(url, {
    credentials: options.credentials || "include",
    headers: requestHeaders(options.headers, options.cookieHeader, options.referer)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
  return response.arrayBuffer();
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw error;
  }
}

function parseNestedJson(value) {
  if (!value) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function normalizePlaybackUrl(value) {
  let url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("//")) url = `https:${url}`;
  const httpIndex = url.search(/https?:\/\//i);
  if (httpIndex > 0) url = url.slice(httpIndex);
  return url;
}

function extractPlaybackUrlFromModel(model) {
  if (!model) return { url: "", source: "" };

  const directCandidates = [
    ["playbackUrl", model.playbackUrl],
    ["playback_url", model.playback_url],
    ["playUrl", model.playUrl],
    ["url", model.url],
    ["videoUrl", model.videoUrl]
  ];

  for (const [source, value] of directCandidates) {
    const url = normalizePlaybackUrl(value);
    if (url) return { url, source };
  }

  const extension = parseNestedJson(model.extension) || model.extension;
  const sprites = extension && (parseNestedJson(extension.sprites) || extension.sprites);
  if (sprites) {
    const spriteCandidates = [
      ["extension.sprites.playUrlWithoutAuthKey", sprites.playUrlWithoutAuthKey],
      ["extension.sprites.playUrl", sprites.playUrl],
      ["extension.sprites.url", sprites.url]
    ];
    for (const [source, value] of spriteCandidates) {
      const url = normalizePlaybackUrl(value);
      if (url) return { url, source };
    }
  }

  const list = model.playbackUrls || model.playbackUrlList || model.urls;
  if (Array.isArray(list)) {
    for (const item of list) {
      const url = normalizePlaybackUrl(typeof item === "string" ? item : item && (item.url || item.playbackUrl));
      if (url) return { url, source: "playbackUrls" };
    }
  }

  return { url: "", source: "" };
}

function parseOpenLiveInfoBody(body, roomId, liveUuid) {
  if (body && body.isLogined === false) {
    throw new Error(t("errNotLoggedIn"));
  }

  const model = body.openLiveDetailModel ||
    (body.data && body.data.openLiveDetailModel) ||
    (body.result && body.result.openLiveDetailModel) ||
    body.openLiveModel ||
    body.data ||
    body.result;

  if (!model || typeof model !== "object") {
    throw new Error(t("errMissingModel"));
  }

  const playback = extractPlaybackUrlFromModel(model);
  if (!playback.url) {
    if (model.playbackDuration > 0 || model.status === 3) {
      throw new Error(t("errReplayRestricted"));
    }
    throw new Error(t("errEmptyPlayback"));
  }

  return {
    title: sanitizeFileName(model.title || model.liveTitle || model.name || "dingtalk-replay"),
    playbackUrl: playback.url,
    playbackSource: playback.source,
    roomId,
    liveUuid,
    uuid: model.uuid || liveUuid
  };
}

async function getOpenLiveInfo(roomId, liveUuid, pageUrl, cookieHeader) {
  const url = new URL(API_URL);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("liveUuid", liveUuid);

  const text = await fetchText(url.href, {
    cookieHeader,
    referer: pageUrl,
    headers: {
      "Accept": "application/json, text/plain, */*"
    }
  });

  return parseOpenLiveInfoBody(parseJsonLoose(text), roomId, liveUuid);
}

function resolveUrl(baseUrl, value) {
  if (!value) return "";
  return new URL(value, baseUrl).href;
}

const ATTRIBUTE_RE = /([a-zA-Z0-9-]+)=("[^"]*"|[^,]*)/g;

function parseAttributes(line) {
  const result = Object.create(null);
  ATTRIBUTE_RE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_RE.exec(line)) !== null) {
    result[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
  }
  return result;
}

function parseM3u8(text, m3u8Url) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.some((line) => line.includes("#EXTM3U"))) {
    throw new Error(t("errNotM3u8"));
  }

  const variants = [];
  const segments = [];
  let currentKey = null;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.slice(line.indexOf(":") + 1), 10) || 0;
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributes(line);
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith("#")) {
          variants.push({
            url: resolveUrl(m3u8Url, lines[j]),
            bandwidth: parseInt(attrs.BANDWIDTH || "0", 10) || 0
          });
          break;
        }
      }
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line);
      const method = String(attrs.METHOD || "NONE").toUpperCase();
      if (method === "NONE") {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: attrs.URI ? resolveUrl(m3u8Url, attrs.URI) : "",
          iv: attrs.IV || ""
        };
      }
      continue;
    }

    if (!line.startsWith("#")) {
      segments.push({
        url: resolveUrl(m3u8Url, line),
        sequence: mediaSequence + segments.length,
        key: currentKey ? { ...currentKey } : null
      });
    }
  }

  return { variants, segments, mediaSequence };
}

async function fetchAndParseM3u8(m3u8Url, cookieHeader, depth = 0) {
  if (depth > 5) throw new Error(t("errTooManyNestedM3u8"));

  const text = await fetchText(m3u8Url, {
    cookieHeader,
    referer: m3u8Url,
    headers: {
      "Accept": "application/vnd.apple.mpegurl, application/x-mpegURL, */*"
    }
  });
  const parsed = parseM3u8(text, m3u8Url);

  if (parsed.variants.length) {
    const selected = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    log(t("logSelectedVariant", { url: selected.url }));
    return fetchAndParseM3u8(selected.url, cookieHeader, depth + 1);
  }

  if (!parsed.segments.length) throw new Error(t("errNoSegments"));

  return {
    m3u8Url,
    m3u8Content: text,
    segments: parsed.segments,
    encrypted: parsed.segments.some((segment) => segment.key && segment.key.method === "AES-128")
  };
}

function hexToBytes(value) {
  const hex = String(value || "").replace(/^0x/i, "").replace(/\s/g, "");
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function sequenceToIv(sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence >>> 0, false);
  return iv;
}

function ivBytes(iv, sequence) {
  if (!iv) return sequenceToIv(sequence);
  const bytes = hexToBytes(iv);
  if (bytes.length === 16) return bytes;
  return sequenceToIv(sequence);
}

async function aes128Decrypt(buffer, keyBytes, iv) {
  if (keyBytes.byteLength !== 16) {
    throw new Error(t("errAesKeyLength"));
  }
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, buffer);
  return new Uint8Array(decrypted);
}

function stripBeforeTsSync(bytes) {
  if (!bytes || !bytes.length) return bytes;
  for (let i = 0; i < Math.min(bytes.length, 188); i += 1) {
    if (bytes[i] === 0x47) return bytes.slice(i);
  }
  return bytes;
}

async function fetchKeyBytes(key, cookieHeader, cache) {
  if (!key || !key.uri) return null;
  if (cache.has(key.uri)) return cache.get(key.uri);
  const buffer = await fetchBuffer(key.uri, {
    cookieHeader,
    referer: key.uri
  });
  const bytes = new Uint8Array(buffer);
  cache.set(key.uri, bytes);
  return bytes;
}

async function downloadOneSegment(segment, playlistUrl, cookieHeader, keyCache) {
  const buffer = await fetchBuffer(segment.url, {
    cookieHeader,
    referer: playlistUrl
  });
  let bytes = new Uint8Array(buffer);

  if (segment.key && segment.key.method === "AES-128") {
    const keyBytes = await fetchKeyBytes(segment.key, cookieHeader, keyCache);
    bytes = await aes128Decrypt(bytes, keyBytes, ivBytes(segment.key.iv, segment.sequence));
  } else if (segment.key && segment.key.method && segment.key.method !== "NONE") {
    throw new Error(t("errUnsupportedEncryption", { method: segment.key.method }));
  }

  return stripBeforeTsSync(bytes);
}

async function downloadSegments(parsed, cookieHeader, concurrency, run) {
  const total = parsed.segments.length;
  const results = new Array(total);
  const keyCache = new Map();
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < total) {
      if (run.cancelled) throw new Error(t("errCancelled"));
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await downloadOneSegment(parsed.segments[index], parsed.m3u8Url, cookieHeader, keyCache);
      completed += 1;
      setStatus("statusDownloadingSegments", 20 + (completed / total) * 60, { completed, total });
      if (completed === 1 || completed % 10 === 0 || completed === total) {
        log(t("logDownloadedSegments", { completed, total }));
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function transmuxTsToMp4(tsBytes) {
  if (!window.muxjs || !window.muxjs.mp4 || !window.muxjs.mp4.Transmuxer) {
    throw new Error(t("errMuxUnavailable"));
  }

  return new Promise((resolve, reject) => {
    const transmuxer = new window.muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
    const chunks = [];

    transmuxer.on("data", (segment) => {
      if (segment.initSegment) chunks.push(segment.initSegment);
      if (segment.data) chunks.push(segment.data);
    });
    transmuxer.on("done", () => {
      if (!chunks.length) reject(new Error(t("errMuxNoData")));
      else resolve(concatBytes(chunks));
    });

    try {
      transmuxer.push(tsBytes);
      transmuxer.flush();
    } catch (error) {
      reject(error);
    }
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function saveBlob(bytes, title, extension, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const filename = `${sanitizeFileName(title)}.${extension}`;
  try {
    await chromeCall(chrome.downloads.download, {
      url,
      filename,
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return { filename, size: blob.size };
}

async function runDownload() {
  const run = { cancelled: false };
  activeRun = run;
  els.log.textContent = "";
  setStatus("statusPreparing", 0);

  const outputFormat = document.querySelector('input[name="outputFormat"]:checked')?.value || "mp4";
  const concurrency = parseInt(els.concurrency.value, 10) || 4;
  const params = extractParamsFromUrl(els.replayUrl.value);
  log(`roomId=${params.roomId}`);
  log(`liveUuid=${params.liveUuid}`);

  setStatus("statusReadingCookies", 5);
  const cookieMap = await collectDingtalkCookies();
  const cookieHeader = buildCookieHeader(cookieMap);
  if (!cookieHeader) {
    throw new Error(t("errNoCookies"));
  }
  log(t("logCollectedCookies", { count: cookieMap.size }));

  setStatus("statusResolving", 10);
  const replay = await getOpenLiveInfo(params.roomId, params.liveUuid, params.input, cookieHeader);
  log(t("logTitle", { title: replay.title }));
  log(t("logPlaybackSource", { source: replay.playbackSource }));
  log(t("logPlaybackUrl", { url: replay.playbackUrl }));

  if (run.cancelled) throw new Error(t("errCancelled"));

  setStatus("statusParsingM3u8", 16);
  const parsed = await fetchAndParseM3u8(replay.playbackUrl, cookieHeader);
  log(t("logSegments", { count: parsed.segments.length }));
  log(t("logEncrypted", { value: parsed.encrypted ? t("yes") : t("no") }));

  if (run.cancelled) throw new Error(t("errCancelled"));

  const chunks = await downloadSegments(parsed, cookieHeader, concurrency, run);
  setStatus("statusMerging", 84);
  const tsBytes = concatBytes(chunks);
  log(t("logMergedTsSize", { size: formatBytes(tsBytes.byteLength) }));

  if (run.cancelled) throw new Error(t("errCancelled"));

  if (outputFormat === "mp4") {
    setStatus("statusTransmuxing", 90);
    try {
      const mp4Bytes = await transmuxTsToMp4(tsBytes);
      const saved = await saveBlob(mp4Bytes, replay.title, "mp4", "video/mp4");
      setStatus("statusDone", 100);
      log(t("logSaved", { filename: saved.filename, size: formatBytes(saved.size) }));
      return;
    } catch (error) {
      log(t("logMp4Failed", { message: error.message }));
      log(t("logSavingTs"));
    }
  }

  const saved = await saveBlob(tsBytes, replay.title, "ts", "video/mp2t");
  setStatus("statusDone", 100);
  log(t("logSaved", { filename: saved.filename, size: formatBytes(saved.size) }));
}

async function fillCurrentTabUrl() {
  try {
    const tabs = await chromeCall(chrome.tabs.query, { active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (tab && tab.url && /dingtalk\.com/i.test(tab.url)) {
      els.replayUrl.value = tab.url;
      return true;
    }
  } catch (error) {
    // 用户仍可手动粘贴链接。
  }
  return false;
}

function setBusy(isBusy) {
  els.startBtn.disabled = isBusy;
  els.cancelBtn.disabled = !isBusy;
  els.replayUrl.disabled = isBusy;
  els.outputOptions.forEach((input) => {
    input.disabled = isBusy;
  });
  els.concurrency.disabled = isBusy;
  els.useCurrentTabBtn.disabled = isBusy;
  els.clearBtn.disabled = isBusy;
}

els.startBtn.addEventListener("click", async () => {
  setBusy(true);
  try {
    await runDownload();
  } catch (error) {
    setStatus("statusFailed", 0);
    log(t("errorPrefix", { message: error.message || error }));
  } finally {
    activeRun = null;
    setBusy(false);
  }
});

els.cancelBtn.addEventListener("click", () => {
  if (activeRun) activeRun.cancelled = true;
  els.cancelBtn.disabled = true;
  log(t("logCancelRequested"));
});

els.openTabBtn.addEventListener("click", async () => {
  const url = chrome.runtime.getURL("downloader.html");
  await chromeCall(chrome.tabs.create, { url });
});

els.useCurrentTabBtn.addEventListener("click", fillCurrentTabUrl);

els.clearBtn.addEventListener("click", () => {
  els.replayUrl.value = "";
  els.replayUrl.focus();
});

applyLocale();
fillCurrentTabUrl();
