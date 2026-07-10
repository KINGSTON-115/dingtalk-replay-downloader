(() => {
  if (globalThis.__VWD_PAGE_HOOK__) return;
  globalThis.__VWD_PAGE_HOOK__ = true;

  const emit = (detail) => {
    try {
      window.postMessage({ source: "vwd-page-hook", detail }, "*");
    } catch {
      // 页面主动修改 postMessage 时不影响原页面逻辑。
    }
  };

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    const wrappedFetch = async function vwdFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        emit({ type: "fetch", url: response.url || String(args[0]?.url || args[0] || ""), mime: response.headers.get("content-type") || "" });
      } catch {
        // 透明保持 fetch 行为。
      }
      return response;
    };
    try { globalThis.fetch = wrappedFetch; } catch { /* 页面锁定 fetch 时跳过。 */ }
  }

  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function vwdOpen(method, url, ...rest) {
      let resolvedUrl = String(url || "");
      try { resolvedUrl = new URL(resolvedUrl, document.baseURI).href; } catch { /* 保留原值。 */ }
      this.__vwdRequest = { method, url: resolvedUrl };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function vwdSend(...args) {
      this.addEventListener("load", () => {
        emit({ type: "xhr", url: this.responseURL || this.__vwdRequest?.url || "", mime: this.getResponseHeader("content-type") || "" });
      }, { once: true });
      return originalSend.apply(this, args);
    };
  } catch {
    // 页面锁定 XHR 原型时跳过。
  }

  try {
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function vwdCreateObjectURL(object) {
      const url = originalCreateObjectURL(object);
      if (typeof MediaSource !== "undefined" && object instanceof MediaSource) emit({ type: "mse", url, mime: "" });
      return url;
    };
  } catch {
    // URL API 不可写时跳过。
  }

  if (typeof MediaSource !== "undefined") {
    try {
      const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function vwdAddSourceBuffer(mime) {
        emit({ type: "mse", url: location.href, mime: String(mime || "") });
        return originalAddSourceBuffer.call(this, mime);
      };
    } catch {
      // MediaSource 原型不可写时跳过。
    }
  }
})();
