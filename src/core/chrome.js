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
