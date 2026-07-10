import { fetchTextResource } from "../core/http.js";
import { stableId } from "../core/url.js";

const API_ORIGIN = "https://lv.dingtalk.com";
const API_PATH = "/getOpenLiveInfo";
const COOKIE_URLS = [
  "https://dingtalk.com/",
  "https://www.dingtalk.com/",
  "https://n.dingtalk.com/",
  "https://lv.dingtalk.com/",
  "https://login.dingtalk.com/",
  "https://h5.dingtalk.com/"
];
const COOKIE_DOMAINS = [".dingtalk.com", "dingtalk.com", "lv.dingtalk.com", "n.dingtalk.com", "login.dingtalk.com"];

function apiUrl(value) {
  const url = new URL(value);
  if (url.origin !== API_ORIGIN || url.pathname !== API_PATH) throw new Error("拒绝把钉钉登录会话发送到非回放信息接口。");
  return url;
}

function safePageOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && /(?:^|\.)dingtalk\.com$/i.test(url.hostname)) return url.origin;
  } catch {
    // 使用钉钉回放页的默认 origin。
  }
  return "https://n.dingtalk.com";
}

export async function dingtalkCookiePermissionGranted() {
  return chrome.permissions.contains({ permissions: ["cookies"] });
}

export async function requestDingtalkCookiePermission() {
  return chrome.permissions.request({ permissions: ["cookies"] });
}

async function cookieStoreIdForTab(tabId) {
  if (!Number.isInteger(Number(tabId)) || typeof chrome.cookies.getAllCookieStores !== "function") return "";
  const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
  return stores.find((store) => store.tabIds?.includes(Number(tabId)))?.id || "";
}

async function readCookies(details) {
  try {
    return await chrome.cookies.getAll(details);
  } catch {
    return [];
  }
}

export async function collectDingtalkCookieHeader({ pageUrl = "", sourceTabId = null } = {}) {
  if (!(await dingtalkCookiePermissionGranted())) return { header: "", count: 0 };
  const storeId = await cookieStoreIdForTab(sourceTabId);
  const withStore = (details) => storeId ? { ...details, storeId } : details;
  const jar = new Map();
  const add = (cookies) => {
    for (const cookie of cookies || []) {
      const domain = String(cookie.domain || "").replace(/^\./, "");
      if (!cookie.name || !cookie.value || !/(?:^|\.)dingtalk\.com$/i.test(domain)) continue;
      jar.set(cookie.name, cookie.value);
    }
  };

  for (const domain of COOKIE_DOMAINS) add(await readCookies(withStore({ domain })));
  for (const url of [...COOKIE_URLS, pageUrl].filter((value) => /^https:\/\//i.test(value || ""))) {
    add(await readCookies(withStore({ url })));
  }
  add(await readCookies(withStore({ url: `${API_ORIGIN}/` })));

  const header = Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
  return { header, count: jar.size };
}

async function nextSessionRuleId() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(rules.map((rule) => rule.id));
  let id = 600_000_000 + (Number.parseInt(stableId(Date.now(), Math.random()), 36) % 90_000_000);
  while (used.has(id)) id += 1;
  return id;
}

async function installDingtalkSessionRule(targetUrl, cookieHeader, pageUrl) {
  const id = await nextSessionRuleId();
  const pageOrigin = safePageOrigin(pageUrl);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 100,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Cookie", operation: "set", value: cookieHeader },
          { header: "Referer", operation: "set", value: `${pageOrigin}/` }
        ]
      },
      condition: {
        urlFilter: `|${targetUrl.href}|`,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest"]
      }
    }]
  });
  return async () => {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  };
}

export async function fetchDingtalkWithSession(rawUrl, options = {}) {
  const url = apiUrl(rawUrl);
  if (!(await dingtalkCookiePermissionGranted())) throw new Error("尚未授权读取钉钉登录 Cookie。");
  const cookies = await collectDingtalkCookieHeader({ pageUrl: options.pageUrl, sourceTabId: options.sourceTabId });
  if (!cookies.header) throw new Error("没有读取到钉钉登录 Cookie，请确认回放页确实使用当前浏览器账号播放。");

  const removeRule = await installDingtalkSessionRule(url, cookies.header, options.pageUrl);
  options.onLog?.(`已读取 ${cookies.count} 个钉钉会话 Cookie，并仅对本次回放信息请求生效。`);
  try {
    return await fetchTextResource(url.href, {
      ...options,
      headers: { Accept: "application/json, text/plain, */*", ...options.headers }
    });
  } finally {
    await removeRule();
  }
}
