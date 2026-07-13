import { extractDingtalkParams, matchesDingtalkReplay } from "../adapters/dingtalk.js";
import { DINGTALK_DESKTOP_USER_AGENT, collectDingtalkCookieHeader, dingtalkCookiePermissionGranted, fetchDingtalkWithSession, requestDingtalkCookiePermission } from "../adapters/dingtalk-session.js";
import { fetchTextFromTab, getActiveTab, injectDiscovery, requestOrigins, sendRuntimeMessage } from "../core/chrome.js";
import { candidateLabel, classifyMedia, formatBytes, mergeCandidates, normalizeCandidate } from "../core/media.js";
import { analyzeResolvedSource, resolveInput } from "../core/resolver.js";
import { collectAnalysisOrigins, createRequestContext, installRequestContext } from "../core/request-context.js";
import { clearDraft, clearTasks, createTask, listTasks, loadDraft, saveDraft, updateTask } from "../core/task-store.js";
import { normalizeUserInput, originPattern, redactUrl, sanitizeFileName, stableId } from "../core/url.js";
import { describeOutputs, runDownload } from "../downloads/engine.js";
import { prepareOutputSinks } from "../downloads/sinks.js";
import { checkNativeHost, runNativeDownload } from "../native/client.js";
import { formatDashVariant } from "../protocols/dash.js";
import { formatVariant } from "../protocols/hls.js";

const params = new URLSearchParams(location.search);
const managerMode = params.get("mode") === "manager";
const ENHANCED_ORIGINS = ["http://*/*", "https://*/*"];

const els = Object.fromEntries([
  "enhancedBtn", "openManagerBtn", "modeBadge", "managerNotice", "detectBtn", "sourceInput",
  "candidateArea", "candidateSelect", "candidateHint", "analyzeBtn", "grantOriginBtn", "clearBtn",
  "resumeDraftBtn",
  "analysisPanel", "sourceSummary", "protocolBadge", "qualityField", "qualitySelect", "audioField",
  "audioSelect", "subtitleField", "subtitleSelect", "analysisWarning", "engineSelect", "outputFormat", "concurrency", "cookieField",
  "nativeCookies", "nativeStatus", "startBtn", "cancelBtn", "statusDot", "statusText", "progressText",
  "progressBar", "speedText", "bytesText", "log", "clearHistoryBtn", "taskHistory"
].map((id) => [id, document.getElementById(id)]));

const state = {
  targetTab: null,
  candidates: [],
  analysis: null,
  pendingOrigins: [],
  activeController: null,
  currentTask: null,
  busy: false,
  lastProgressAt: 0,
  lastProgressBytes: 0,
  nativeAvailable: false,
  requestedSelections: {},
  savedDraft: null
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanLogMessage(value) {
  return String(value || "").replace(/https?:\/\/[^\s]+/g, (url) => redactUrl(url));
}

function log(message) {
  const lines = els.log.textContent ? els.log.textContent.split("\n") : [];
  lines.push(`[${new Date().toLocaleTimeString()}] ${cleanLogMessage(message)}`);
  els.log.textContent = lines.slice(-200).join("\n");
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, percent = null, tone = "normal") {
  els.statusText.textContent = text;
  els.statusDot.dataset.tone = tone;
  if (typeof percent === "number") {
    const safe = Math.max(0, Math.min(100, percent));
    els.progressText.textContent = `${Math.round(safe)}%`;
    els.progressBar.style.width = `${safe}%`;
  }
}

function reportAnalysisError(error, failureText = "解析失败") {
  if (error?.code === "DINGTALK_COOKIE_PERMISSION") {
    setStatus("等待钉钉会话授权", 0, "normal");
    log(`提示：${error.message}`);
    return;
  }
  const waitingForPermission = state.pendingOrigins.length > 0;
  setStatus(waitingForPermission ? "等待媒体域名授权" : failureText, 0, waitingForPermission ? "normal" : "error");
  log(`${waitingForPermission ? "提示" : "错误"}：${error.message}`);
}

function resetProgress() {
  state.lastProgressAt = performance.now();
  state.lastProgressBytes = 0;
  els.speedText.textContent = "";
  els.bytesText.textContent = "";
  setStatus("就绪", 0);
}

function updateProgress(progress = {}) {
  const now = performance.now();
  const bytes = Number(progress.downloadedBytes ?? progress.totalBytes) || 0;
  const elapsed = (now - state.lastProgressAt) / 1000;
  if (elapsed >= 0.7 && bytes >= state.lastProgressBytes) {
    const speed = (bytes - state.lastProgressBytes) / elapsed;
    els.speedText.textContent = speed > 0 ? `${formatBytes(speed)}/s` : "";
    state.lastProgressAt = now;
    state.lastProgressBytes = bytes;
  }
  if (bytes) els.bytesText.textContent = formatBytes(bytes);

  let percent = Number(progress.percent) || 0;
  if (!percent && Number(progress.total) > 0) percent = (Number(progress.completed) / Number(progress.total)) * 100;
  if (progress.live) {
    els.progressText.textContent = "LIVE";
    els.progressBar.style.width = "100%";
    els.progressBar.classList.add("indeterminate");
    setStatus(`直播录制中 · ${progress.completed || 0} 个分片`, null, "running");
  } else {
    els.progressBar.classList.remove("indeterminate");
    setStatus(progress.total ? `下载分片 ${progress.completed}/${progress.total}` : "正在下载", percent, "running");
  }
  persistTaskProgress(percent, bytes);
}

let lastPersistAt = 0;
function persistTaskProgress(percent, bytes) {
  if (!state.currentTask || Date.now() - lastPersistAt < 700) return;
  lastPersistAt = Date.now();
  void updateTask(state.currentTask.id, { progress: Math.round(percent || 0), downloadedBytes: bytes || 0 });
}

function setBusy(busy) {
  state.busy = busy;
  for (const element of [els.sourceInput, els.candidateSelect, els.analyzeBtn, els.detectBtn, els.engineSelect, els.outputFormat, els.concurrency, els.qualitySelect, els.audioSelect, els.subtitleSelect, els.startBtn, els.clearBtn]) {
    if (element) element.disabled = busy;
  }
  els.cancelBtn.disabled = !busy;
}

function currentCandidate() {
  const url = normalizeUserInput(els.sourceInput.value);
  return state.candidates.find((candidate) => candidate.url === url) || null;
}

function candidateOptionLabel(candidate) {
  if (candidate.kind === "dingtalk") return `钉钉回放页 · ${candidate.title || "回放"}`;
  return candidateLabel(candidate);
}

function renderCandidates(candidates, mseDetected = false) {
  state.candidates = mergeCandidates(candidates).filter((candidate) => candidate.kind !== "segment").slice(0, 100);
  els.candidateSelect.textContent = "";
  for (const candidate of state.candidates) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = candidateOptionLabel(candidate);
    els.candidateSelect.appendChild(option);
  }
  els.candidateArea.classList.toggle("hidden", !state.candidates.length);
  els.candidateHint.textContent = state.candidates.length
    ? `共 ${state.candidates.length} 个候选，已按播放清单、媒体元素和响应大小排序。`
    : mseDetected ? "检测到 MSE/blob 播放器，但尚未捕获底层地址。请保持识别开启并重新播放视频。" : "当前页暂未发现媒体请求。请先播放视频后重试。";
  if (state.candidates.length && !els.sourceInput.value.trim()) selectCandidate(state.candidates[0].id);
}

function selectCandidate(id) {
  const candidate = state.candidates.find((item) => item.id === id);
  if (!candidate) return;
  els.candidateSelect.value = candidate.id;
  els.sourceInput.value = candidate.url;
  clearAnalysis();
}

function clearAnalysis() {
  state.analysis = null;
  state.pendingOrigins = [];
  els.grantOriginBtn.classList.add("hidden");
  els.analysisPanel.classList.add("hidden");
  els.qualityField.classList.add("hidden");
  els.audioField.classList.add("hidden");
  els.subtitleField.classList.add("hidden");
  els.analysisWarning.classList.add("hidden");
}

async function targetTab() {
  if (state.targetTab?.id) {
    try {
      state.targetTab = await chrome.tabs.get(state.targetTab.id);
      return state.targetTab;
    } catch {
      state.targetTab = null;
    }
  }
  const tab = await getActiveTab();
  if (tab?.url?.startsWith(chrome.runtime.getURL(""))) return null;
  state.targetTab = tab;
  return tab;
}

function isDingtalkPageUrl(value) {
  try {
    return /(?:^|\.)dingtalk\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function findDingtalkSourceTab(preferredPageUrl = "") {
  const current = await targetTab();
  const preferred = extractDingtalkParams(preferredPageUrl);
  const matchesPreferredReplay = (tab) => {
    const candidate = extractDingtalkParams(tab.url || "");
    return preferred.roomId && preferred.liveUuid && candidate.roomId === preferred.roomId && candidate.liveUuid === preferred.liveUuid;
  };
  if (current?.id && isDingtalkPageUrl(current.url) && matchesPreferredReplay(current)) return current;
  const tabs = await chrome.tabs.query({ url: ["https://*.dingtalk.com/*", "https://dingtalk.com/*"] }).catch(() => []);
  const exact = tabs.find(matchesPreferredReplay);
  const selected = exact || (current?.id && isDingtalkPageUrl(current.url) ? current : null) || tabs.find((tab) => isDingtalkPageUrl(tab.url));
  if (selected) state.targetTab = selected;
  return selected || null;
}

async function fetchTextFromSourceTab(url, options = {}) {
  const tab = await findDingtalkSourceTab(options.pageUrl);
  if (!tab?.id) {
    throw new Error("没有可复用登录态的钉钉回放标签页。");
  }
  return fetchTextFromTab(tab.id, url, options);
}

async function fetchDingtalkAuthenticated(url, options = {}) {
  const tab = await findDingtalkSourceTab(options.pageUrl);
  return fetchDingtalkWithSession(url, { ...options, sourceTabId: tab?.id ?? null, onLog: log });
}

function requestContextOptionsForResolved(resolved) {
  if (resolved?.adapter !== "dingtalk") return {};
  return {
    referrer: resolved.pageUrl,
    requestHeaders: [
      { header: "Origin", value: "https://n.dingtalk.com" },
      { header: "Accept-Language", value: "zh-CN,zh;q=0.9" },
      { header: "User-Agent", value: DINGTALK_DESKTOP_USER_AGENT }
    ],
    cookieDomains: ["dingtalk.com"]
  };
}

function dingtalkMediaHttpOptions() {
  return {
    credentials: "omit",
    headers: {
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9"
    }
  };
}

async function requestContextOptionsForDingtalk(resolved) {
  const options = requestContextOptionsForResolved(resolved);
  if (resolved?.adapter !== "dingtalk") return options;
  try {
    const tab = await findDingtalkSourceTab(resolved.pageUrl);
    const cookies = await collectDingtalkCookieHeader({ pageUrl: resolved.pageUrl, sourceTabId: tab?.id ?? null });
    if (cookies.header) options.cookieHeader = cookies.header;
  } catch {
    // Cookie-bearing media headers are a compatibility boost, not a hard requirement.
  }
  return options;
}

async function ensureDingtalkSessionPermission(input, interactive = false) {
  if (!matchesDingtalkReplay(input)) return;
  const granted = interactive
    ? await requestDingtalkCookiePermission()
    : await dingtalkCookiePermissionGranted();
  if (granted) return;
  const error = new Error("需要授权读取钉钉登录 Cookie 才能解析回放；该权限只用于当前账号有权播放的钉钉内容。");
  error.code = "DINGTALK_COOKIE_PERMISSION";
  throw error;
}

async function collectCurrentPage({ inject = true } = {}) {
  const tab = await targetTab();
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) throw new Error("当前没有可识别的网页标签页。");
  setStatus("正在识别当前页", 3, "running");
  if (inject) {
    await injectDiscovery(tab.id);
    await sleep(200);
  }

  let pageResult = null;
  try {
    pageResult = await chrome.tabs.sendMessage(tab.id, { type: "VWD_COLLECT_PAGE" });
  } catch {
    // 后台网络目录仍可能包含候选。
  }
  const catalogResult = await sendRuntimeMessage({ type: "VWD_GET_CANDIDATES", tabId: tab.id });
  const candidates = [];
  if (matchesDingtalkReplay(tab.url)) {
    candidates.push({
      id: stableId("dingtalk", tab.url),
      kind: "dingtalk",
      url: tab.url,
      title: sanitizeFileName(tab.title || "钉钉回放"),
      pageUrl: tab.url,
      sourceLabel: "dingtalk-page",
      score: 160,
      detectedAt: Date.now(),
      tabId: tab.id
    });
  }
  const tabMedia = classifyMedia({ url: tab.url, sourceLabel: "current-tab-media", resourceType: "media" });
  if (tabMedia.kind !== "unknown" && tabMedia.kind !== "segment") {
    candidates.push(normalizeCandidate({ url: tab.url, title: tab.title, pageUrl: tab.url, sourceLabel: "current-tab-media", tabId: tab.id }, tab));
  }
  candidates.push(...(pageResult?.candidates || []), ...(catalogResult?.candidates || []));
  renderCandidates(candidates, Boolean(pageResult?.mseDetected));
  log(`识别完成：${state.candidates.length} 个可下载候选。`);
  setStatus("识别完成", 0, "success");
}

async function ensureOriginPermission(url) {
  if (!/^https?:\/\//i.test(url || "")) return true;
  const pattern = originPattern(url);
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  state.pendingOrigins = [pattern];
  els.grantOriginBtn.classList.remove("hidden");
  return false;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (!value) return "未知时长";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function renderAnalysis(analysis) {
  const inspection = analysis.inspection;
  els.analysisPanel.classList.remove("hidden");
  els.protocolBadge.textContent = analysis.protocol.toUpperCase();
  const live = inspection.live ? "直播/动态清单" : formatDuration(inspection.duration || analysis.plan.duration);
  els.sourceSummary.textContent = `${analysis.resolved.title} · ${live} · ${analysis.resolved.playbackSource || "通用解析"}`;

  const variants = inspection.variants || [];
  els.qualitySelect.textContent = "";
  if (variants.length) {
    for (const variant of variants) {
      const option = document.createElement("option");
      option.value = variant.id;
      option.textContent = analysis.protocol === "dash" ? formatDashVariant(variant) : formatVariant(variant);
      els.qualitySelect.appendChild(option);
    }
    const selectedId = analysis.plan.selectedVariant?.id || analysis.plan.video?.id || variants[0].id;
    els.qualitySelect.value = selectedId;
    els.qualityField.classList.remove("hidden");
  } else {
    els.qualityField.classList.add("hidden");
  }

  const audioTracks = inspection.audioTracks || [];
  els.audioSelect.textContent = "";
  if (audioTracks.length) {
    for (const track of audioTracks) {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = `${track.name || track.label || track.language || "默认音轨"}${track.language ? ` · ${track.language}` : ""}${track.bandwidth ? ` · ${(track.bandwidth / 1000).toFixed(0)} kbps` : ""}`;
      els.audioSelect.appendChild(option);
    }
    els.audioSelect.value = analysis.plan.audioTrack?.id || analysis.plan.audio?.id || audioTracks[0].id;
    els.audioField.classList.remove("hidden");
  } else {
    els.audioField.classList.add("hidden");
  }

  const subtitleTracks = inspection.subtitleTracks || [];
  els.subtitleSelect.textContent = "";
  if (subtitleTracks.length) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "不下载字幕";
    els.subtitleSelect.appendChild(none);
    for (const track of subtitleTracks) {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = `${track.name || track.label || track.language || "字幕"}${track.language ? ` · ${track.language}` : ""}`;
      els.subtitleSelect.appendChild(option);
    }
    els.subtitleSelect.value = analysis.plan.subtitleTrack?.id || analysis.plan.subtitle?.id || "";
    els.subtitleField.classList.remove("hidden");
  } else {
    els.subtitleField.classList.add("hidden");
  }

  const warnings = [];
  if (analysis.plan.requiresSeparateAudio) warnings.push("该清单使用独立音视频轨：浏览器模式会保存为两个文件，本地增强模式可自动合并。");
  if (analysis.plan.usesSidx) warnings.push("该 DASH 使用 SIDX，需要 FFmpeg 本地增强模式。");
  if (subtitleTracks.length && !analysis.plan.subtitleTrack && !analysis.plan.subtitle) warnings.push(`检测到 ${subtitleTracks.length} 条字幕轨，可在上方选择后单独保存或交给 FFmpeg 合并。`);
  if (inspection.live) warnings.push("这是动态媒体：浏览器 HLS 模式会持续录制，点击“停止并保存”结束。动态 DASH 请使用本地增强模式。");
  els.analysisWarning.textContent = warnings.join(" ");
  els.analysisWarning.classList.toggle("hidden", !warnings.length);
  log(`媒体解析完成：${analysis.protocol.toUpperCase()}，${variants.length || 1} 个视频选项。`);
}

async function analyzeCurrent({ interactiveDingtalkSession = false } = {}) {
  const input = normalizeUserInput(els.sourceInput.value);
  if (!input) throw new Error("请先输入地址或识别当前页。");
  await ensureDingtalkSessionPermission(input, interactiveDingtalkSession);
  clearAnalysis();
  setStatus("正在解析媒体", 8, "running");
  const candidate = currentCandidate();
  if (/^https?:\/\//i.test(input) && !matchesDingtalkReplay(input)) {
    if (!(await ensureOriginPermission(input))) throw new Error("需要先授权该媒体域名。");
  }

  const controller = new AbortController();
  let analysisRequestContext = null;
  const common = {
    candidate,
    signal: controller.signal,
    variantId: els.qualitySelect.value || state.requestedSelections.qualityId || "",
    audioTrackId: els.audioSelect.value || state.requestedSelections.audioTrackId || "",
    subtitleTrackId: els.subtitleSelect.value || state.requestedSelections.subtitleTrackId || "",
    authenticatedFetchText: fetchDingtalkAuthenticated,
    pageFetchText: fetchTextFromSourceTab,
    onLog: log,
    async ensureUrls(urls) {
      const origins = Array.from(new Set((urls || []).filter((url) => /^https?:\/\//i.test(url)).map(originPattern)));
      if (!origins.length) return;
      if (!(await chrome.permissions.contains({ origins }))) {
        state.pendingOrigins = origins;
        els.grantOriginBtn.classList.remove("hidden");
        throw new Error("需要先授权 HLS 子清单所在的媒体域名，然后重新解析。");
      }
      await analysisRequestContext?.addUrls(urls);
    },
    http: {
      onRetry({ attempt, delay, error }) {
        log(`请求失败，${Math.round(delay / 100) / 10} 秒后进行第 ${attempt} 次重试：${error.message}`);
      }
    }
  };
  const resolved = await resolveInput(input, common);
  if (!(await ensureOriginPermission(resolved.playbackUrl))) throw new Error("需要授权实际媒体所在的 CDN 域名。");
  if (resolved.adapter === "dingtalk") Object.assign(common.http, dingtalkMediaHttpOptions());
  analysisRequestContext = await createRequestContext(resolved.pageUrl, log, await requestContextOptionsForDingtalk(resolved));
  try {
    await analysisRequestContext.addUrls([resolved.playbackUrl]);
    state.analysis = await analyzeResolvedSource(resolved, common);
  } finally {
    await analysisRequestContext.cleanup();
    analysisRequestContext = null;
  }
  renderAnalysis(state.analysis);
  const allOrigins = collectAnalysisOrigins(state.analysis);
  let waitingForAdditionalOrigins = false;
  if (allOrigins.length && !(await chrome.permissions.contains({ origins: allOrigins }))) {
    state.pendingOrigins = allOrigins;
    els.grantOriginBtn.classList.remove("hidden");
    waitingForAdditionalOrigins = true;
    log(`该媒体还需要授权 ${allOrigins.length} 个清单/分片域名。`);
  } else {
    state.pendingOrigins = [];
    els.grantOriginBtn.classList.add("hidden");
  }
  state.requestedSelections = {};
  setStatus(waitingForAdditionalOrigins ? "等待媒体域名授权" : "媒体解析完成", 0, waitingForAdditionalOrigins ? "normal" : "success");
  return state.analysis;
}

function settingsDraft() {
  return {
    input: els.sourceInput.value.trim(),
    candidate: currentCandidate(),
    tabId: state.targetTab?.id || null,
    engine: els.engineSelect.value,
    outputFormat: els.outputFormat.value,
    concurrency: Math.max(1, Math.min(Number(els.concurrency.value) || 4, 12)),
    qualityId: els.qualitySelect.value || "",
    audioTrackId: els.audioSelect.value || "",
    subtitleTrackId: els.subtitleSelect.value || "",
    includeCookies: els.nativeCookies.checked
  };
}

async function openManager() {
  if (!els.sourceInput.value.trim()) throw new Error("请先输入地址或识别当前页。");
  await saveDraft(settingsDraft());
  const url = chrome.runtime.getURL("downloader.html?mode=manager");
  await chrome.tabs.create({ url });
}

async function refreshHistory() {
  const tasks = await listTasks();
  els.taskHistory.textContent = "";
  els.taskHistory.classList.toggle("empty", !tasks.length);
  if (!tasks.length) {
    els.taskHistory.textContent = "暂无任务";
    return;
  }
  const statusText = { pending: "等待", running: "进行中", complete: "完成", failed: "失败", cancelled: "已取消", stopped: "已停止" };
  for (const task of tasks.slice(0, 12)) {
    const row = document.createElement("article");
    row.className = `task-row status-${task.status}`;
    const main = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = task.title;
    const source = document.createElement("span");
    source.textContent = `${task.protocol.toUpperCase()} · ${task.sourceUrl || "本地任务"}`;
    main.append(title, source);
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const status = document.createElement("span");
    status.textContent = statusText[task.status] || task.status;
    const size = document.createElement("span");
    size.textContent = task.downloadedBytes ? formatBytes(task.downloadedBytes) : `${task.progress || 0}%`;
    meta.append(status, size);
    row.append(main, meta);
    if (task.error) row.title = task.error;
    els.taskHistory.appendChild(row);
  }
}

async function runBrowserTask(analysis, controller) {
  const descriptors = describeOutputs(analysis, { outputFormat: els.outputFormat.value });
  const sinks = analysis.protocol === "file" ? new Map() : await prepareOutputSinks(descriptors);
  const removeRequestContext = await installRequestContext(analysis, log, await requestContextOptionsForDingtalk(analysis.resolved));
  try {
    return await runDownload(analysis, descriptors, sinks, {
      signal: controller.signal,
      concurrency: Math.max(1, Math.min(Number(els.concurrency.value) || 4, 12)),
      outputFormat: els.outputFormat.value,
      http: analysis.resolved.adapter === "dingtalk" ? dingtalkMediaHttpOptions() : undefined,
      keepPartialOnAbort: Boolean(analysis.inspection.live),
      onProgress: updateProgress,
      onLog: log
    });
  } finally {
    await removeRequestContext();
  }
}

async function runNativeTask(analysis, controller) {
  const status = await checkNativeHost();
  if (!status.available) throw new Error("FFmpeg 本地增强宿主未安装或不可用，请按 native-host/README.md 完成安装。");
  return runNativeDownload(analysis, {
    signal: controller.signal,
    outputFormat: els.outputFormat.value,
    includeCookies: els.nativeCookies.checked,
    onProgress(progress) {
      updateProgress({ percent: progress.percent, totalBytes: progress.totalBytes });
      if (progress.speed) els.speedText.textContent = progress.speed;
    },
    onLog: log
  });
}

async function startTask() {
  if (!managerMode) {
    await openManager();
    return;
  }
  if (!state.analysis) throw new Error("请先点击“解析媒体信息”，确认清晰度和音轨后再开始。");
  if (state.pendingOrigins.length) throw new Error("请先点击“授权媒体域名”，允许访问清单中的 CDN、分片和密钥域名。");
  const analysis = state.analysis;
  const controller = new AbortController();
  state.activeController = controller;
  state.currentTask = await createTask({
    title: analysis.resolved.title,
    sourceUrl: analysis.resolved.playbackUrl,
    protocol: analysis.protocol
  });
  await updateTask(state.currentTask.id, { status: "running" });
  resetProgress();
  setBusy(true);
  els.cancelBtn.textContent = analysis.inspection.live && els.engineSelect.value === "browser" ? "停止并保存" : "取消任务";
  log(`任务开始：${analysis.resolved.title}`);

  try {
    const result = els.engineSelect.value === "native"
      ? await runNativeTask(analysis, controller)
      : await runBrowserTask(analysis, controller);
    const stopped = Boolean(result?.stopped);
    setStatus(stopped ? "已停止并保存" : "下载完成", 100, "success");
    await updateTask(state.currentTask.id, {
      status: stopped ? "stopped" : "complete",
      progress: 100,
      downloadedBytes: Number(result?.bytes || result?.totalBytes) || state.lastProgressBytes
    });
    log(stopped ? "直播录制已停止，现有内容已保存。" : `任务完成${result?.path ? `：${result.path}` : "。"}`);
    await clearDraft();
  } catch (error) {
    const cancelled = controller.signal.aborted || error?.name === "AbortError";
    const safeError = cleanLogMessage(error.message || String(error));
    setStatus(cancelled ? "任务已取消" : "任务失败", 0, cancelled ? "normal" : "error");
    await updateTask(state.currentTask.id, { status: cancelled ? "cancelled" : "failed", error: safeError });
    log(`${cancelled ? "取消" : "错误"}：${safeError}`);
  } finally {
    state.activeController = null;
    state.currentTask = null;
    els.cancelBtn.textContent = "取消任务";
    setBusy(false);
    await refreshHistory();
  }
}

async function updateEnhancedStatus() {
  const enabled = await chrome.permissions.contains({ origins: ENHANCED_ORIGINS, permissions: ["webRequest"] });
  els.enhancedBtn.textContent = enabled ? "增强识别已开启" : "增强识别";
  els.enhancedBtn.classList.toggle("enabled", enabled);
}

async function enableEnhanced() {
  const granted = await chrome.permissions.request({ origins: ENHANCED_ORIGINS, permissions: ["webRequest"] });
  if (!granted) throw new Error("未获得全站媒体监听权限。基础的当前页识别仍然可用。");
  await sendRuntimeMessage({ type: "VWD_ENABLE_ENHANCED" });
  await updateEnhancedStatus();
  log("增强识别已开启；后续网页会从加载开始记录媒体请求。");
  await collectCurrentPage({ inject: true }).catch(() => {});
}

async function updateNativeStatus(interactive = false) {
  const permitted = interactive
    ? await chrome.permissions.request({ permissions: ["nativeMessaging"] })
    : await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  if (!permitted) {
    state.nativeAvailable = false;
    els.nativeStatus.textContent = "本地增强尚未授权。选择该模式时会单独请求 Native Messaging 权限。";
    els.nativeStatus.classList.remove("hidden");
    return false;
  }
  const status = await checkNativeHost();
  state.nativeAvailable = status.available;
  els.nativeStatus.textContent = status.available
    ? `FFmpeg 本地增强可用，输出目录：${status.outputDirectory || "由宿主配置"}`
    : "未检测到本地增强宿主。请查看 native-host/README.md 安装 Node.js/FFmpeg 宿主。";
  els.nativeStatus.classList.remove("hidden");
  return status.available;
}

function updateOutputOptions() {
  const native = els.engineSelect.value === "native";
  const mkv = Array.from(els.outputFormat.options).find((option) => option.value === "mkv");
  const ts = Array.from(els.outputFormat.options).find((option) => option.value === "ts");
  if (mkv) mkv.disabled = !native;
  if (ts) ts.disabled = native;
  if ((!native && els.outputFormat.value === "mkv") || (native && els.outputFormat.value === "ts")) {
    els.outputFormat.value = native ? "mp4" : "auto";
  }
}

async function initialize() {
  document.body.dataset.mode = managerMode ? "manager" : "popup";
  els.modeBadge.textContent = managerMode ? "任务管理页" : "快速面板";
  els.managerNotice.classList.toggle("hidden", !managerMode);
  els.openManagerBtn.classList.toggle("hidden", managerMode);
  els.startBtn.textContent = managerMode ? "选择保存位置并下载" : "前往任务页下载";
  updateOutputOptions();
  await Promise.all([refreshHistory(), updateEnhancedStatus()]);

  if (managerMode) {
    const draft = await loadDraft();
    if (draft) {
      els.sourceInput.value = draft.input || "";
      els.engineSelect.value = draft.engine || "browser";
      els.outputFormat.value = draft.outputFormat || "auto";
      els.concurrency.value = String(draft.concurrency || 4);
      els.nativeCookies.checked = Boolean(draft.includeCookies);
      updateOutputOptions();
      if (draft.tabId) state.targetTab = { id: draft.tabId };
      state.requestedSelections = {
        qualityId: draft.qualityId || "",
        audioTrackId: draft.audioTrackId || "",
        subtitleTrackId: draft.subtitleTrackId || ""
      };
      if (draft.candidate) renderCandidates([draft.candidate]);
      if (els.engineSelect.value === "native") {
        els.cookieField.classList.remove("hidden");
        void updateNativeStatus(false);
      }
      if (draft.input) {
        await analyzeCurrent().catch((error) => reportAnalysisError(error));
      }
    }
  } else {
    state.savedDraft = await loadDraft();
    els.resumeDraftBtn.classList.toggle("hidden", !state.savedDraft?.input);
    const tab = await getActiveTab();
    if (tab && !tab.url?.startsWith(chrome.runtime.getURL(""))) {
      state.targetTab = tab;
      await collectCurrentPage({ inject: false }).catch(() => {});
    }
  }
}

els.detectBtn.addEventListener("click", () => collectCurrentPage({ inject: true }).catch((error) => {
  setStatus("识别失败", 0, "error");
  log(`错误：${error.message}`);
}));
els.candidateSelect.addEventListener("change", () => selectCandidate(els.candidateSelect.value));
els.sourceInput.addEventListener("input", () => {
  state.requestedSelections = {};
  clearAnalysis();
});
els.analyzeBtn.addEventListener("click", () => analyzeCurrent({ interactiveDingtalkSession: true }).catch((error) => {
  reportAnalysisError(error);
}));
els.qualitySelect.addEventListener("change", () => analyzeCurrent().catch((error) => reportAnalysisError(error, "重新解析失败")));
els.audioSelect.addEventListener("change", () => analyzeCurrent().catch((error) => reportAnalysisError(error, "重新解析失败")));
els.subtitleSelect.addEventListener("change", () => analyzeCurrent().catch((error) => reportAnalysisError(error, "重新解析失败")));
els.grantOriginBtn.addEventListener("click", async () => {
  try {
    const granted = await requestOrigins(state.pendingOrigins);
    if (!granted) throw new Error("媒体域名授权被拒绝。");
    state.pendingOrigins = [];
    els.grantOriginBtn.classList.add("hidden");
    await analyzeCurrent();
  } catch (error) {
    setStatus("媒体域名授权失败", 0, "error");
    log(`错误：${error.message}`);
  }
});
els.resumeDraftBtn.addEventListener("click", async () => {
  if (!state.savedDraft?.input) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL("downloader.html?mode=manager") });
});
els.enhancedBtn.addEventListener("click", () => enableEnhanced().catch((error) => log(`错误：${error.message}`)));
els.openManagerBtn.addEventListener("click", () => openManager().catch((error) => log(`错误：${error.message}`)));
els.startBtn.addEventListener("click", () => startTask().catch((error) => {
  setStatus("无法开始", 0, "error");
  log(`错误：${error.message}`);
}));
els.cancelBtn.addEventListener("click", () => {
  if (state.activeController) state.activeController.abort(new DOMException("用户取消任务", "AbortError"));
  els.cancelBtn.disabled = true;
  log("正在停止任务...");
});
els.clearBtn.addEventListener("click", () => {
  els.sourceInput.value = "";
  renderCandidates([]);
  clearAnalysis();
  resetProgress();
});
els.clearHistoryBtn.addEventListener("click", async () => {
  await clearTasks();
  await refreshHistory();
});
els.engineSelect.addEventListener("change", async () => {
  const native = els.engineSelect.value === "native";
  updateOutputOptions();
  els.cookieField.classList.toggle("hidden", !native);
  if (native) await updateNativeStatus(true);
  else els.nativeStatus.classList.add("hidden");
});
els.nativeCookies.addEventListener("change", async () => {
  if (!els.nativeCookies.checked) return;
  const granted = await chrome.permissions.request({ permissions: ["cookies"] });
  if (!granted) {
    els.nativeCookies.checked = false;
    log("未授予 Cookie 权限，本地增强将仅使用播放地址中的授权信息。");
  }
});

initialize().catch((error) => {
  setStatus("初始化失败", 0, "error");
  log(`错误：${error.message}`);
});
