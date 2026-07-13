import { fetchTextResource } from "../core/http.js";
import { stableId } from "../core/url.js";

const API_ORIGIN = "https://lv.dingtalk.com";
const API_PATH = "/getOpenLiveInfo";
export const DINGTALK_DESKTOP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DINGTALK_NAVIGATE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
const COOKIE_URLS = [
  "https://lv.dingtalk.com/",
  "https://n.dingtalk.com/",
  "https://h5.dingtalk.com/",
  "https://login.dingtalk.com/",
  "https://www.dingtalk.com/",
  "https://dingtalk.com/"
];
const COOKIE_DOMAINS = [".dingtalk.com", "dingtalk.com", "lv.dingtalk.com", ".lv.dingtalk.com", "n.dingtalk.com", ".n.dingtalk.com", "h5.dingtalk.com", "login.dingtalk.com"];

function apiSessionHeaderVariants(cookieHeader) {
  const originalLike = [
    { header: "Cookie", operation: "set", value: cookieHeader },
    { header: "Accept-Language", operation: "set", value: "zh-CN,zh;q=0.9" },
    { header: "Sec-Fetch-Site", operation: "set", value: "none" },
    { header: "Sec-Fetch-Mode", operation: "set", value: "navigate" },
    { header: "Sec-Fetch-User", operation: "set", value: "?1" },
    { header: "Sec-Fetch-Dest", operation: "set", value: "document" },
    { header: "User-Agent", operation: "set", value: DINGTALK_DESKTOP_USER_AGENT }
  ];
  return [
    originalLike,
    originalLike.filter((item) => item.header !== "User-Agent"),
    originalLike.filter((item) => item.header === "Cookie" || item.header === "Accept-Language")
  ];
}

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
  if (jar.has("LV_PC_SESSION") && !jar.has("PC_SESSION")) jar.set("PC_SESSION", jar.get("LV_PC_SESSION"));
  if (jar.has("PC_SESSION") && !jar.has("LV_PC_SESSION")) jar.set("LV_PC_SESSION", jar.get("PC_SESSION"));

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

async function installDingtalkSessionRule(targetUrl, cookieHeader, onLog = () => {}) {
  const id = await nextSessionRuleId();
  const buildRule = (requestHeaders) => ({
    id,
    priority: 100,
    action: {
      type: "modifyHeaders",
      requestHeaders
    },
    condition: {
      urlFilter: `|${targetUrl.href}|`,
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: ["xmlhttprequest"]
    }
  });
  const variants = apiSessionHeaderVariants(cookieHeader);
  let lastError = null;
  for (const requestHeaders of variants) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [buildRule(requestHeaders)]
      });
      if (requestHeaders.length < variants[0].length) {
        onLog("DingTalk API request context installed with a reduced header set.");
      }
      return async () => {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Failed to install DingTalk API request context.");
}

export async function fetchDingtalkWithSession(rawUrl, options = {}) {
  const url = apiUrl(rawUrl);
  if (!(await dingtalkCookiePermissionGranted())) throw new Error("尚未授权读取钉钉登录 Cookie。");
  const cookies = await collectDingtalkCookieHeader({ pageUrl: options.pageUrl, sourceTabId: options.sourceTabId });
  if (!cookies.header) throw new Error("没有读取到钉钉登录 Cookie，请确认回放页确实使用当前浏览器账号播放。");

  const removeRule = await installDingtalkSessionRule(url, cookies.header, options.onLog);
  options.onLog?.(`已读取 ${cookies.count} 个钉钉会话 Cookie，并仅对本次回放信息请求生效。`);
  try {
    return await fetchTextResource(url.href, {
      ...options,
      credentials: "omit",
      cache: "no-store",
      headers: { ...options.headers, Accept: DINGTALK_NAVIGATE_ACCEPT }
    });
  } finally {
    await removeRule();
  }
}
