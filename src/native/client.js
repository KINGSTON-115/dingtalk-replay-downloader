import { redactUrl } from "../core/url.js";
import { collectAnalysisUrls } from "../core/request-context.js";

export const NATIVE_HOST_NAME = "com.kingston.web_video_downloader";

export async function nativePermissionGranted() {
  return chrome.permissions.contains({ permissions: ["nativeMessaging"] });
}

export async function cookiePermissionGranted() {
  return chrome.permissions.contains({ permissions: ["cookies"] });
}

export async function checkNativeHost() {
  if (!(await nativePermissionGranted())) return { available: false, reason: "permission" };
  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "ping" });
    return { available: Boolean(response?.ok && response.ffmpeg), ...response };
  } catch (error) {
    return { available: false, reason: "not-installed", error: error.message };
  }
}

export async function exactCookieHeader(url) {
  if (!(await cookiePermissionGranted())) return "";
  const cookies = await chrome.cookies.getAll({ url });
  return cookies
    .sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function nativeCookieScopeSafe(analysis) {
  const hosts = new Set(collectAnalysisUrls(analysis).map((value) => new URL(value).hostname));
  return hosts.size <= 1;
}

function safeReferrer(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? `${url.origin}/` : "";
  } catch {
    return "";
  }
}

export function runNativeDownload(analysis, options = {}) {
  if (options.includeCookies && !nativeCookieScopeSafe(analysis)) {
    return Promise.reject(new Error("该媒体跨越多个 CDN 域名。为避免把 Cookie 发送到其他域，已拒绝 Cookie 增强；请改用地址签名或浏览器模式。"));
  }
  const sourceUrl = analysis.resolved.playbackUrl;
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  let settled = false;

  return new Promise(async (resolve, reject) => {
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      try {
        port.disconnect();
      } catch {
        // Native port 可能已由宿主关闭。
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => {
      try {
        port.postMessage({ type: "cancel" });
      } catch {
        // 宿主已退出时直接结束任务。
      }
      finish(reject, options.signal.reason || new DOMException("Aborted", "AbortError"));
    };

    port.onMessage.addListener((message) => {
      if (message?.type === "progress") options.onProgress?.(message);
      else if (message?.type === "log") options.onLog?.(message.message);
      else if (message?.type === "complete") finish(resolve, message);
      else if (message?.type === "error") finish(reject, new Error(message.message || "本地增强下载失败。"));
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      const error = chrome.runtime.lastError?.message || "本地增强宿主意外断开。";
      finish(reject, new Error(error));
    });
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      let inputs = [{ url: sourceUrl, role: "main" }];
      const selection = {};
      if (analysis.protocol === "hls") {
        inputs = [{ url: analysis.plan.playlist.url, role: "video" }];
        if (analysis.plan.audioPlaylist) inputs.push({ url: analysis.plan.audioPlaylist.url, role: "audio" });
        if (analysis.plan.subtitlePlaylist) inputs.push({ url: analysis.plan.subtitlePlaylist.url, role: "subtitle" });
      } else if (analysis.protocol === "dash") {
        if (analysis.plan.video.type === "audio-only") selection.audioStream = analysis.plan.video.streamIndex || 0;
        else selection.videoStream = analysis.plan.video.streamIndex || 0;
        if (analysis.plan.audio) selection.audioStream = analysis.plan.audio.streamIndex || 0;
        if (analysis.plan.subtitle) selection.subtitleStream = analysis.plan.subtitle.streamIndex || 0;
      }
      if (options.includeCookies) {
        inputs = await Promise.all(inputs.map(async (input) => ({ ...input, cookieHeader: await exactCookieHeader(input.url) })));
      }
      if (settled) return;
      port.postMessage({
        type: "start",
        url: sourceUrl,
        inputs,
        selection,
        displayUrl: redactUrl(sourceUrl),
        title: analysis.resolved.title,
        format: options.outputFormat === "mkv" ? "mkv" : "mp4",
        duration: Number(analysis.plan.duration || analysis.inspection.duration) || 0,
        referer: safeReferrer(analysis.resolved.pageUrl),
        userAgent: navigator.userAgent,
        cookieHeader: inputs[0]?.cookieHeader || ""
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}
