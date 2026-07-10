import { classifyMedia, mergeCandidates, normalizeCandidate } from "../core/media.js";

const CATALOG_PREFIX = "vwd.catalog.";
const MAX_CANDIDATES = 250;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ENHANCED_ORIGINS = ["http://*/*", "https://*/*"];
const REGISTERED_SCRIPT_IDS = ["vwd-content", "vwd-page-hook"];
const catalogCache = new Map();

function headerValue(headers, name) {
  const entry = (headers || []).find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return entry?.value || "";
}

async function loadCatalog(tabId) {
  if (catalogCache.has(tabId)) return catalogCache.get(tabId);
  const key = `${CATALOG_PREFIX}${tabId}`;
  const stored = await chrome.storage.session.get(key);
  const candidates = Array.isArray(stored[key]) ? stored[key].filter((item) => Date.now() - item.detectedAt < MAX_AGE_MS) : [];
  catalogCache.set(tabId, candidates);
  return candidates;
}

async function saveCatalog(tabId, candidates) {
  const key = `${CATALOG_PREFIX}${tabId}`;
  const trimmed = candidates.slice(0, MAX_CANDIDATES);
  catalogCache.set(tabId, trimmed);
  await chrome.storage.session.set({ [key]: trimmed });
  const visibleCount = trimmed.filter((item) => item.kind !== "segment").length;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: visibleCount ? String(Math.min(visibleCount, 99)) : "" }).catch(() => {});
}

async function clearCatalog(tabId) {
  catalogCache.delete(tabId);
  await chrome.storage.session.remove(`${CATALOG_PREFIX}${tabId}`);
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

async function addCandidates(tabId, rawCandidates, senderTab = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return [];
  const normalized = rawCandidates.map((raw) => normalizeCandidate({ ...raw, tabId }, senderTab)).filter(Boolean);
  if (!normalized.length) return loadCatalog(tabId);
  const existing = await loadCatalog(tabId);
  const merged = mergeCandidates(normalized, existing).filter((item) => Date.now() - item.detectedAt < MAX_AGE_MS);
  await saveCatalog(tabId, merged);
  return merged;
}

function networkCandidate(details, responseHeaders = []) {
  const mime = headerValue(responseHeaders, "content-type");
  const contentLength = Number(headerValue(responseHeaders, "content-length")) || 0;
  const media = classifyMedia({
    url: details.url,
    mime,
    sourceLabel: "network",
    resourceType: details.type
  });
  if (media.kind === "unknown") return null;
  return {
    url: details.url,
    kind: media.kind,
    extension: media.extension,
    mime: media.mime,
    pageUrl: details.initiator || details.documentUrl || "",
    sourceLabel: `network:${details.type}`,
    resourceType: details.type,
    contentLength,
    statusCode: details.statusCode || 0,
    frameId: details.frameId,
    detectedAt: Date.now()
  };
}

function onBeforeRequest(details) {
  if (details.tabId < 0) return;
  if (details.type === "main_frame") {
    void clearCatalog(details.tabId);
    return;
  }
  const candidate = networkCandidate(details);
  if (candidate?.kind === "hls" || candidate?.kind === "dash" || candidate?.kind === "file") {
    void addCandidates(details.tabId, [candidate]);
  }
}

function onHeadersReceived(details) {
  if (details.tabId < 0 || details.type === "main_frame") return;
  const candidate = networkCandidate(details, details.responseHeaders);
  if (candidate) void addCandidates(details.tabId, [candidate]);
}

let networkListenersRegistered = false;
async function syncNetworkListeners() {
  const permitted = await chrome.permissions.contains({ permissions: ["webRequest"] });
  if (permitted && !networkListenersRegistered) {
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["<all_urls>"] });
    chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, { urls: ["<all_urls>"] }, ["responseHeaders"]);
    networkListenersRegistered = true;
  } else if (!permitted && networkListenersRegistered) {
    chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
    networkListenersRegistered = false;
  }
}

async function registerEnhancedContentScripts() {
  const permitted = await chrome.permissions.contains({ origins: ENHANCED_ORIGINS, permissions: ["webRequest"] });
  if (!permitted) return false;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: REGISTERED_SCRIPT_IDS });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: REGISTERED_SCRIPT_IDS });
  await chrome.scripting.registerContentScripts([
    {
      id: "vwd-content",
      matches: ENHANCED_ORIGINS,
      js: ["build/content/content-script.js"],
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: true
    },
    {
      id: "vwd-page-hook",
      matches: ENHANCED_ORIGINS,
      js: ["build/content/page-hook.js"],
      allFrames: true,
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: true
    }
  ]);
  return true;
}

async function unregisterEnhancedContentScripts() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: REGISTERED_SCRIPT_IDS });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: REGISTERED_SCRIPT_IDS });
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "VWD_GET_CANDIDATES": {
      const tabId = Number(message.tabId ?? sender.tab?.id);
      const candidates = await loadCatalog(tabId);
      return { ok: true, candidates: candidates.filter((item) => message.includeSegments || item.kind !== "segment") };
    }
    case "VWD_RECORD_CANDIDATES": {
      const tabId = Number(sender.tab?.id ?? message.tabId);
      const candidates = await addCandidates(tabId, message.candidates || [], sender.tab || {});
      return { ok: true, count: candidates.length };
    }
    case "VWD_CLEAR_CANDIDATES":
      await clearCatalog(Number(message.tabId));
      return { ok: true };
    case "VWD_ENABLE_ENHANCED":
      await syncNetworkListeners();
      return { ok: await registerEnhancedContentScripts() };
    case "VWD_ENHANCED_STATUS":
      return { ok: true, enabled: await chrome.permissions.contains({ origins: ENHANCED_ORIGINS, permissions: ["webRequest"] }) };
    case "VWD_PING":
      return { ok: true, version: chrome.runtime.getManifest().version };
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => void clearCatalog(tabId));
chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.permissions?.includes("webRequest") || permissions.origins?.some((origin) => ENHANCED_ORIGINS.includes(origin))) {
    void unregisterEnhancedContentScripts();
    void syncNetworkListeners();
  }
});
chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.permissions?.includes("webRequest")) void syncNetworkListeners();
});

chrome.runtime.onInstalled.addListener(() => void registerEnhancedContentScripts());
chrome.runtime.onStartup.addListener(() => void registerEnhancedContentScripts());
void syncNetworkListeners();
