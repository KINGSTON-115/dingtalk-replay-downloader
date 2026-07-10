import { stableId } from "./url.js";

function addUrl(set, value) {
  try {
    const url = new URL(value);
    if (/^https?:$/.test(url.protocol)) set.add(url.href);
  } catch {
    // 忽略 data: key、空地址和损坏地址。
  }
}

function addPlaylistUrls(set, playlist) {
  if (!playlist) return;
  addUrl(set, playlist.url);
  for (const segment of playlist.segments || []) {
    addUrl(set, segment.url);
    addUrl(set, segment.map?.url);
    addUrl(set, segment.key?.uri);
  }
}

export function collectAnalysisUrls(analysis) {
  const urls = new Set();
  addUrl(urls, analysis?.resolved?.playbackUrl);
  if (analysis?.protocol === "hls") {
    addPlaylistUrls(urls, analysis.plan.playlist);
    addPlaylistUrls(urls, analysis.plan.audioPlaylist);
    addPlaylistUrls(urls, analysis.plan.subtitlePlaylist);
  } else if (analysis?.protocol === "dash") {
    for (const track of [analysis.plan.video, analysis.plan.audio, analysis.plan.subtitle]) {
      if (!track) continue;
      for (const segment of track.segments || []) {
        addUrl(urls, segment.url);
        addUrl(urls, segment.map?.url);
      }
    }
  }
  return Array.from(urls);
}

export function collectAnalysisOrigins(analysis) {
  return Array.from(new Set(collectAnalysisUrls(analysis).map((value) => `${new URL(value).origin}/*`)));
}

async function nextSessionRuleId() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(rules.map((rule) => rule.id));
  let id = 700_000_000 + (Number.parseInt(stableId(Date.now(), Math.random()), 36) % 100_000_000);
  while (used.has(id)) id += 1;
  return id;
}

export async function installRequestContext(analysis, onLog = () => {}) {
  const pageUrl = analysis?.resolved?.pageUrl;
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl) || !chrome.declarativeNetRequest) return async () => {};
  const domains = Array.from(new Set(collectAnalysisUrls(analysis).map((value) => new URL(value).hostname))).slice(0, 100);
  if (!domains.length) return async () => {};
  const id = await nextSessionRuleId();
  const referrer = new URL(pageUrl);
  const safeReferrer = `${referrer.origin}/`;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Referer", operation: "set", value: safeReferrer }]
        },
        condition: {
          requestDomains: domains,
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["xmlhttprequest", "media", "other"]
        }
      }]
    });
    onLog(`已为 ${domains.length} 个媒体域安装任务级 Referer 规则。`);
  } catch (error) {
    onLog(`无法安装 Referer 会话规则，将继续使用默认请求上下文：${error.message}`);
    return async () => {};
  }
  return async () => {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  };
}
