export function ensureChromeApi() {
  if (typeof chrome === "undefined" || !chrome.runtime) throw new Error("当前环境不是浏览器扩展页面。");
  return chrome;
}

export async function getActiveTab() {
  const api = ensureChromeApi();
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

export async function sendRuntimeMessage(message) {
  return ensureChromeApi().runtime.sendMessage(message);
}

export async function containsOrigins(origins) {
  return ensureChromeApi().permissions.contains({ origins });
}

export async function requestOrigins(origins) {
  return ensureChromeApi().permissions.request({ origins });
}

export async function fetchTextFromTab(tabId, url, options = {}) {
  const api = ensureChromeApi();
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId < 0) throw new Error("缺少可用的来源标签页。");
  const targetUrl = new URL(url);
  if (!/^https?:$/.test(targetUrl.protocol)) throw new Error("页面会话请求只支持 HTTP/HTTPS 地址。");
  if (options.signal?.aborted) throw options.signal.reason || new DOMException("Aborted", "AbortError");

  const headers = {};
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (name.toLowerCase() === "accept" && value != null) headers.Accept = String(value);
  }
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 30000, 120000));
  const results = await api.scripting.executeScript({
    target: { tabId: numericTabId },
    world: "MAIN",
    func: async (requestUrl, requestHeaders, requestTimeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("Request timeout", "TimeoutError")), requestTimeoutMs);
      try {
        const response = await fetch(requestUrl, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          referrer: location.href,
          headers: requestHeaders,
          signal: controller.signal
        });
        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          url: response.url || requestUrl,
          mime: response.headers.get("content-type") || "",
          contentLength: Number(response.headers.get("content-length")) || new TextEncoder().encode(text).byteLength,
          text
        };
      } finally {
        clearTimeout(timer);
      }
    },
    args: [targetUrl.href, headers, timeoutMs]
  });
  if (options.signal?.aborted) throw options.signal.reason || new DOMException("Aborted", "AbortError");
  const result = results?.find((item) => item.frameId === 0)?.result ?? results?.[0]?.result;
  if (!result) throw new Error("来源标签页没有返回会话请求结果。");
  if (!result.ok) throw new Error(`HTTP ${result.status || 0}`);
  return {
    text: String(result.text || ""),
    finalUrl: result.url || targetUrl.href,
    mime: result.mime || "",
    contentLength: Number(result.contentLength) || 0,
    contentDisposition: ""
  };
}

export async function injectDiscovery(tabId) {
  const api = ensureChromeApi();
  const target = { tabId, allFrames: true };
  await api.scripting.executeScript({ target, files: ["build/content/content-script.js"] });
  try {
    await api.scripting.executeScript({ target, files: ["build/content/page-hook.js"], world: "MAIN" });
  } catch {
    // 某些受限 frame 不允许 MAIN world 注入，DOM/网络识别仍然可用。
  }
}
