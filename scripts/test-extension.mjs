import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));

function eventTarget() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
}

async function testBackgroundBundle() {
  const webBefore = eventTarget();
  const webHeaders = eventTarget();
  const runtimeMessage = eventTarget();
  globalThis.chrome = {
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    permissions: { contains: async () => true, onAdded: eventTarget(), onRemoved: eventTarget() },
    runtime: {
      getManifest: () => manifest,
      onInstalled: eventTarget(),
      onMessage: runtimeMessage,
      onStartup: eventTarget()
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {}
    },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
    },
    tabs: { onRemoved: eventTarget() },
    webRequest: { onBeforeRequest: webBefore, onHeadersReceived: webHeaders }
  };
  await import(`${pathToFileURL(resolve(root, "build/background/service-worker.js")).href}?smoke=${Date.now()}`);
  if (webBefore.listeners.length !== 1 || webHeaders.listeners.length !== 1 || runtimeMessage.listeners.length !== 1) {
    throw new Error("后台 Service Worker 没有正确注册媒体监听器。 ");
  }
  delete globalThis.chrome;
}

function findSystemChrome() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function mimeFor(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  }[extname(path).toLowerCase()] || "application/octet-stream";
}

async function createStaticServer() {
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
      if (pathname === "favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const file = resolve(root, pathname || "downloader.html");
      if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error("invalid path");
      const body = readFileSync(file);
      response.writeHead(200, { "content-type": mimeFor(file), "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return server;
}

async function testUiBundle() {
  const executablePath = findSystemChrome();
  if (!executablePath) {
    process.stdout.write("UI smoke test skipped: no system Chrome/Edge found.\n");
    return;
  }
  const server = await createStaticServer();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.addInitScript(({ baseUrl, manifest }) => {
      const noopEvent = () => ({ addListener() {}, removeListener() {} });
      const storage = {};
      const grantedOrigins = new Set();
      const grantedPermissions = new Set();
      const getStorage = async (keys) => {
        if (keys == null) return { ...storage };
        if (typeof keys === "string") return { [keys]: storage[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, storage[key] ?? fallback]));
      };
      globalThis.chrome = {
        runtime: {
          getManifest: () => manifest,
          getURL: (path = "") => `${baseUrl}/${String(path).replace(/^\/+/, "")}`,
          sendMessage: async (message) => message?.type === "VWD_PING" ? { ok: true, version: manifest.version } : { ok: true, candidates: [] },
          sendNativeMessage: async () => { throw new Error("native host absent in smoke test"); },
          connectNative: () => { throw new Error("native host absent in smoke test"); },
          onMessage: noopEvent(),
          lastError: null
        },
        storage: {
          local: {
            get: getStorage,
            set: async (values) => Object.assign(storage, values),
            remove: async (keys) => [].concat(keys).forEach((key) => delete storage[key])
          }
        },
        tabs: {
          query: async () => [],
          get: async () => { throw new Error("tab absent"); },
          create: async () => ({}),
          sendMessage: async () => ({ ok: true, candidates: [] })
        },
        permissions: {
          contains: async (request = {}) => (request.origins || []).every((origin) => grantedOrigins.has(origin)) && (request.permissions || []).every((permission) => grantedPermissions.has(permission)),
          request: async (request = {}) => {
            (request.origins || []).forEach((origin) => grantedOrigins.add(origin));
            (request.permissions || []).forEach((permission) => grantedPermissions.add(permission));
            return true;
          }
        },
        scripting: { executeScript: async () => [] },
        downloads: {
          download: async () => 1,
          cancel: async () => {},
          onChanged: noopEvent()
        }
      };
    }, { baseUrl, manifest });
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("favicon.ico")) runtimeErrors.push(message.text());
    });
    await page.goto(`${baseUrl}/downloader.html?mode=manager`, { waitUntil: "networkidle" });
    await page.waitForSelector("body[data-mode='manager']", { timeout: 10000 });
    await page.selectOption("#engineSelect", "native");
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => ({
      title: document.title,
      heading: document.querySelector("h1")?.textContent,
      mode: document.body.dataset.mode,
      iconLoaded: document.querySelector(".brand-icon")?.naturalWidth > 0,
      managerNoticeVisible: !document.querySelector("#managerNotice")?.classList.contains("hidden"),
      nativeStatusVisible: !document.querySelector("#nativeStatus")?.classList.contains("hidden")
    }));
    if (result.title !== "网页视频下载器" || result.heading !== "网页视频下载器" || result.mode !== "manager") {
      throw new Error(`扩展 UI 初始化异常：${JSON.stringify(result)}`);
    }
    if (!result.iconLoaded || !result.managerNoticeVisible || !result.nativeStatusVisible) {
      throw new Error(`扩展 UI 状态异常：${JSON.stringify(result)}`);
    }
    await page.selectOption("#engineSelect", "browser");
    await page.fill("#sourceInput", `${baseUrl}/tests/fixtures/hls/master.m3u8`);
    await page.click("#analyzeBtn");
    await page.waitForSelector("#analysisPanel:not(.hidden)", { timeout: 10000 });
    const analysis = await page.evaluate(() => ({
      protocol: document.querySelector("#protocolBadge")?.textContent,
      qualities: document.querySelector("#qualitySelect")?.options.length,
      selectedQuality: document.querySelector("#qualitySelect")?.selectedOptions[0]?.textContent,
      audioTracks: document.querySelector("#audioSelect")?.options.length,
      subtitleTracks: document.querySelector("#subtitleSelect")?.options.length,
      warning: document.querySelector("#analysisWarning")?.textContent
    }));
    if (analysis.protocol !== "HLS" || analysis.qualities !== 2 || analysis.audioTracks !== 1 || analysis.subtitleTracks !== 2 || !analysis.selectedQuality.includes("1920×1080")) {
      throw new Error(`HLS UI 解析异常：${JSON.stringify(analysis)}`);
    }
    if (!analysis.warning.includes("独立音视频轨")) throw new Error(`HLS 独立音轨提示缺失：${JSON.stringify(analysis)}`);
    if (runtimeErrors.length) throw new Error(`扩展 UI 运行期错误：${runtimeErrors.join(" | ")}`);
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

await testBackgroundBundle();
await testUiBundle();
process.stdout.write("Extension background/UI smoke tests passed.\n");
