import { classifyMedia, normalizeCandidate } from "../core/media.js";

(() => {
  if (globalThis.__VWD_CONTENT_SCRIPT__) return;
  globalThis.__VWD_CONTENT_SCRIPT__ = true;

  const signals = [];
  const seen = new Set();
  let mseDetected = false;

  function addRaw(raw, report = true) {
    if (!raw?.url || !/^https?:\/\//i.test(raw.url)) return null;
    const candidate = normalizeCandidate({
      ...raw,
      title: raw.title || document.title || "网页视频",
      pageUrl: raw.pageUrl || location.href,
      detectedAt: Date.now()
    });
    if (!candidate || seen.has(candidate.url)) return candidate;
    seen.add(candidate.url);
    signals.unshift(candidate);
    if (signals.length > 200) signals.length = 200;
    if (report) chrome.runtime.sendMessage({ type: "VWD_RECORD_CANDIDATES", candidates: [candidate] }).catch(() => {});
    return candidate;
  }

  function addValue(value, sourceLabel, mime = "") {
    if (!value) return;
    try {
      const url = new URL(String(value), document.baseURI).href;
      addRaw({ url, sourceLabel, mime });
    } catch {
      // 页面经常包含不完整或模板化 URL，直接忽略。
    }
  }

  function scanDom() {
    document.querySelectorAll("video,audio,source").forEach((node) => {
      addValue(node.currentSrc || node.src || node.getAttribute("src") || node.getAttribute("data-src"), "media-element", node.type || "");
    });
    document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[name="twitter:player:stream"]').forEach((node) => {
      addValue(node.content, "media-meta", node.getAttribute("content-type") || "");
    });
    document.querySelectorAll("[data-video-url],[data-media-url],[data-play-url]").forEach((node) => {
      addValue(node.dataset.videoUrl || node.dataset.mediaUrl || node.dataset.playUrl, "media-data");
    });
    document.querySelectorAll("a[href]").forEach((node) => {
      const href = node.href || node.getAttribute("href");
      const media = classifyMedia({ url: href, sourceLabel: "link" });
      if (media.kind !== "unknown" && media.kind !== "segment") addValue(href, "link");
    });
  }

  function scanPerformance() {
    performance.getEntriesByType("resource").forEach((entry) => {
      const media = classifyMedia({ url: entry.name, sourceLabel: "performance", resourceType: entry.initiatorType });
      if (media.kind !== "unknown") {
        addRaw({
          url: entry.name,
          sourceLabel: `performance:${entry.initiatorType || "resource"}`,
          resourceType: entry.initiatorType || "",
          contentLength: Number(entry.transferSize) || Number(entry.encodedBodySize) || 0
        }, false);
      }
    });
  }

  function collect() {
    scanDom();
    scanPerformance();
    return {
      title: document.title || "网页视频",
      pageUrl: location.href,
      mseDetected,
      candidates: signals.slice()
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "vwd-page-hook") return;
    const detail = event.data.detail || {};
    if (detail.type === "mse") {
      mseDetected = true;
      return;
    }
    addRaw({
      url: detail.url,
      mime: detail.mime,
      sourceLabel: `page-hook:${detail.type || "request"}`,
      resourceType: detail.type || ""
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "VWD_COLLECT_PAGE") return false;
    sendResponse({ ok: true, ...collect() });
    return false;
  });

  let mutationTimer = 0;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(scanDom, 250);
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-src"] });
  scanDom();
})();
