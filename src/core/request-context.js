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

async function nextSessionRuleId(excluded = []) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set([...rules.map((rule) => rule.id), ...excluded.filter(Boolean)]);
  let id = 700_000_000 + (Number.parseInt(stableId(Date.now(), Math.random()), 36) % 100_000_000);
  while (used.has(id)) id += 1;
  return id;
}

function emptyRequestContext() {
  return { addUrls: async () => {}, cleanup: async () => {} };
}

function safeHeaderValue(value) {
  const text = String(value || "");
  return text && !/[\r\n]/.test(text) ? text : "";
}

function isCookieDomain(hostname, allowedDomains) {
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export async function createRequestContext(pageUrl, onLog = () => {}, options = {}) {
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl) || !chrome.declarativeNetRequest) return emptyRequestContext();
  const context = emptyRequestContext();
  const referrer = new URL(pageUrl);
  let safeReferrer = `${referrer.origin}/`;
  if (options.referrer) {
    try {
      const requestedReferrer = new URL(options.referrer);
      requestedReferrer.hash = "";
      if (/^https?:$/.test(requestedReferrer.protocol)) safeReferrer = requestedReferrer.href;
    } catch {
      // 保留 origin 级 Referer。
    }
  }
  const requestHeaders = [{ header: "Referer", operation: "set", value: safeReferrer }];
  const allowedExtraHeaders = new Set(["origin", "accept-language", "user-agent"]);
  for (const entry of options.requestHeaders || []) {
    const name = String(entry?.header || "");
    const value = safeHeaderValue(entry?.value);
    if (!allowedExtraHeaders.has(name.toLowerCase()) || !value || /[\r\n]/.test(value)) continue;
    requestHeaders.push({ header: name, operation: "set", value });
  }
  const fallbackRequestHeaders = requestHeaders.filter((entry) => entry.header.toLowerCase() !== "user-agent");
  const cookieHeader = safeHeaderValue(options.cookieHeader);
  const cookieDomains = (options.cookieDomains || []).map((value) => String(value || "").replace(/^\./, "").toLowerCase()).filter(Boolean);
  const domains = new Map();
  let refererRuleId = null;
  let cookieRuleId = null;

  context.addUrls = async (values = []) => {
    const additions = [];
    const pendingDomains = new Set();
    for (const value of values) {
      try {
        const url = new URL(value);
        if (/^https?:$/.test(url.protocol) && !domains.has(url.hostname) && !pendingDomains.has(url.hostname) && additions.length + domains.size < 100) {
          additions.push({ domain: url.hostname, url: url.href });
          pendingDomains.add(url.hostname);
        }
      } catch {
        // 忽略 data:、空地址和损坏地址。
      }
    }
    if (!additions.length) return;

    const proposedDomains = new Map(domains);
    additions.forEach((entry) => proposedDomains.set(entry.domain, entry.url));
    if (!refererRuleId) refererRuleId = await nextSessionRuleId();
    const cookieEligibleDomains = cookieHeader && cookieDomains.length
      ? Array.from(proposedDomains.keys()).filter((domain) => isCookieDomain(domain.toLowerCase(), cookieDomains))
      : [];
    if (cookieEligibleDomains.length && !cookieRuleId) cookieRuleId = await nextSessionRuleId([refererRuleId]);
    const buildRefererRule = (headers) => ({
      id: refererRuleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: headers
      },
      condition: {
        requestDomains: Array.from(proposedDomains.keys()),
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest", "media", "other"]
      }
    });
    const buildRules = (headers) => {
      const rules = [buildRefererRule(headers)];
      if (cookieEligibleDomains.length) {
        rules.push({
          id: cookieRuleId,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Cookie", operation: "set", value: cookieHeader }]
          },
          condition: {
            requestDomains: cookieEligibleDomains,
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest", "media", "other"]
          }
        });
      }
      return rules;
    };
    const removeRuleIds = [refererRuleId, cookieRuleId].filter(Boolean);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds,
        addRules: buildRules(requestHeaders)
      });
      additions.forEach((entry) => domains.set(entry.domain, entry.url));
      onLog(`已为 ${domains.size} 个媒体域安装请求上下文。`);
    } catch (error) {
      if (fallbackRequestHeaders.length !== requestHeaders.length) {
        try {
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds,
            addRules: buildRules(fallbackRequestHeaders)
          });
          additions.forEach((entry) => domains.set(entry.domain, entry.url));
          onLog(`已为 ${domains.size} 个媒体域安装请求上下文（未设置 User-Agent）。`);
          return;
        } catch (fallbackError) {
          onLog(`无法安装媒体请求上下文，将继续使用默认请求：${fallbackError.message}`);
          return;
        }
      }
      onLog(`无法安装媒体请求上下文，将继续使用默认请求：${error.message}`);
    }
  };
  context.cleanup = async () => {
    const ids = [refererRuleId, cookieRuleId].filter(Boolean);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});
  };
  return context;
}

export async function installRequestContext(analysis, onLog = () => {}, options = {}) {
  const context = await createRequestContext(analysis?.resolved?.pageUrl, onLog, options);
  await context.addUrls(collectAnalysisUrls(analysis));
  return context.cleanup;
}
