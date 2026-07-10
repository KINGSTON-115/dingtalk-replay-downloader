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
    const corsHeaders = {
      "access-control-allow-origin": baseUrl,
      "access-control-allow-credentials": "true",
      "cache-control": "no-store"
    };
    const hlsFixtureRoot = resolve(root, "tests/fixtures/hls");
    let dingtalkApiRequests = 0;
    await page.route("https://lv.dingtalk.com/getOpenLiveInfo*", async (route) => {
      dingtalkApiRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: corsHeaders,
        body: JSON.stringify({ isLogined: false })
      });
    });
    await page.route(/^https:\/\/cdn\.example\.test\/hls\//, async (route) => {
      const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
      const relativePath = pathname.replace(/^\/hls\//, "");
      const file = resolve(hlsFixtureRoot, relativePath);
      if (file === hlsFixtureRoot || !file.startsWith(`${hlsFixtureRoot}${sep}`) || !existsSync(file)) {
        await route.fulfill({ status: 404, body: "not found", headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/vnd.apple.mpegurl; charset=utf-8",
        headers: corsHeaders,
        body: readFileSync(file)
      });
    });
    await page.addInitScript(({ baseUrl, manifest }) => {
      const noopEvent = () => ({ addListener() {}, removeListener() {} });
      const dingtalkTab = {
        id: 77,
        title: "DingTalk permission fixture",
        url: "https://n.dingtalk.com/dingding/live-room/index.html?roomId=room-fixture&liveUuid=live-fixture"
      };
      const storage = { "vwd.draft": { tabId: dingtalkTab.id, input: "" } };
      const grantedOrigins = new Set();
      const grantedPermissions = new Set();
      globalThis.__dingtalkPageFetches = 0;
      let directUserGesture = false;
      const originalAddEventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function addEventListenerWithGesture(type, listener, options) {
        if (!["click", "change"].includes(type) || typeof listener !== "function") {
          return originalAddEventListener.call(this, type, listener, options);
        }
        return originalAddEventListener.call(this, type, function gestureListener(event) {
          const previousGesture = directUserGesture;
          directUserGesture = true;
          try {
            return listener.call(this, event);
          } finally {
            directUserGesture = previousGesture;
          }
        }, options);
      };
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
          get: async (tabId) => {
            if (tabId === dingtalkTab.id) return dingtalkTab;
            throw new Error("tab absent");
          },
          create: async () => ({}),
          sendMessage: async () => ({ ok: true, candidates: [] })
        },
        permissions: {
          contains: async (request = {}) => (request.origins || []).every((origin) => grantedOrigins.has(origin)) && (request.permissions || []).every((permission) => grantedPermissions.has(permission)),
          request: async (request = {}) => {
            if (!directUserGesture) throw new Error("This function must be called during a user gesture");
            (request.origins || []).forEach((origin) => grantedOrigins.add(origin));
            (request.permissions || []).forEach((permission) => grantedPermissions.add(permission));
            return true;
          }
        },
        scripting: {
          executeScript: async (details = {}) => {
            if (typeof details.func !== "function") return [];
            globalThis.__dingtalkPageFetches += 1;
            return [{
              frameId: 0,
              result: {
                ok: true,
                status: 200,
                url: details.args[0],
                mime: "application/json; charset=utf-8",
                text: JSON.stringify({
                  isLogined: true,
                  openLiveDetailModel: {
                    title: "DingTalk permission fixture",
                    playbackDuration: 30,
                    playbackUrl: "https://cdn.example.test/hls/master.m3u8"
                  }
                })
              }
            }];
          }
        },
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
    await page.waitForSelector("#grantOriginBtn:not(.hidden)", { timeout: 10000 });
    const beforeDirectGrant = await page.evaluate(() => ({
      analysisVisible: !document.querySelector("#analysisPanel")?.classList.contains("hidden"),
      grantVisible: !document.querySelector("#grantOriginBtn")?.classList.contains("hidden"),
      status: document.querySelector("#statusText")?.textContent
    }));
    if (beforeDirectGrant.analysisVisible || !beforeDirectGrant.grantVisible || beforeDirectGrant.status !== "等待媒体域名授权") {
      throw new Error(`Direct media permission was not staged for an explicit click: ${JSON.stringify(beforeDirectGrant)}`);
    }
    await page.click("#grantOriginBtn");
    try {
      await page.waitForSelector("#analysisPanel:not(.hidden)", { timeout: 10000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        grantVisible: !document.querySelector("#grantOriginBtn")?.classList.contains("hidden"),
        status: document.querySelector("#statusText")?.textContent,
        log: document.querySelector("#log")?.textContent
      }));
      throw new Error(`Direct media analysis did not resume after permission grant: ${JSON.stringify({ diagnostic, runtimeErrors, cause: error.message })}`);
    }
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

    await page.fill("#sourceInput", "https://n.dingtalk.com/dingding/live-room/index.html?roomId=room-fixture&liveUuid=live-fixture");
    await page.click("#analyzeBtn");
    await page.waitForSelector("#grantOriginBtn:not(.hidden)", { timeout: 10000 });
    const beforeDingtalkGrant = await page.evaluate(() => ({
      analysisVisible: !document.querySelector("#analysisPanel")?.classList.contains("hidden"),
      grantVisible: !document.querySelector("#grantOriginBtn")?.classList.contains("hidden"),
      status: document.querySelector("#statusText")?.textContent,
      pageFetches: globalThis.__dingtalkPageFetches
    }));
    if (beforeDingtalkGrant.analysisVisible || !beforeDingtalkGrant.grantVisible || beforeDingtalkGrant.status !== "等待媒体域名授权" || beforeDingtalkGrant.pageFetches !== 1 || dingtalkApiRequests !== 0) {
      throw new Error(`DingTalk CDN permission was not staged after resolving playback: ${JSON.stringify({ ...beforeDingtalkGrant, dingtalkApiRequests })}`);
    }
    await page.click("#grantOriginBtn");
    await page.waitForSelector("#analysisPanel:not(.hidden)", { timeout: 10000 });
    const dingtalkAnalysis = await page.evaluate(() => ({
      protocol: document.querySelector("#protocolBadge")?.textContent,
      grantVisible: !document.querySelector("#grantOriginBtn")?.classList.contains("hidden"),
      source: document.querySelector("#sourceSummary")?.textContent,
      pageFetches: globalThis.__dingtalkPageFetches
    }));
    if (dingtalkAnalysis.protocol !== "HLS" || dingtalkAnalysis.grantVisible || !dingtalkAnalysis.source.includes("DingTalk permission fixture") || dingtalkAnalysis.pageFetches !== 2 || dingtalkApiRequests !== 0) {
      throw new Error(`DingTalk permission retry did not complete analysis: ${JSON.stringify({ ...dingtalkAnalysis, dingtalkApiRequests })}`);
    }
    if (runtimeErrors.length) throw new Error(`扩展 UI 运行期错误：${runtimeErrors.join(" | ")}`);
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

await testBackgroundBundle();
await testUiBundle();
process.stdout.write("Extension background/UI smoke tests passed.\n");
