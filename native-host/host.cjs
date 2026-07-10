const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, extname, join, resolve } = require("node:path");

const CONFIG_PATH = join(__dirname, "config.json");
let inputBuffer = Buffer.alloc(0);
let activeProcess = null;
let activeTempPath = "";

process.stdout.on("error", () => process.exit(0));

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  try {
    process.stdout.write(Buffer.concat([header, payload]));
  } catch {
    process.exit(0);
  }
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {
      ffmpegPath: "ffmpeg",
      outputDirectory: join(homedir(), "Downloads", "网页视频下载器")
    };
  }
}

function sanitizeName(value) {
  let cleaned = String(value || "web-video")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || "web-video";
}

function availablePath(directory, baseName, extension) {
  let index = 0;
  while (index < 10000) {
    const suffix = index ? ` (${index})` : "";
    const candidate = join(directory, `${baseName}${suffix}.${extension}`);
    if (!existsSync(candidate) && !existsSync(`${candidate}.partial`)) return candidate;
    index += 1;
  }
  throw new Error("无法生成可用的输出文件名。");
}

function cleanupPartial() {
  if (activeTempPath && existsSync(activeTempPath)) {
    try {
      unlinkSync(activeTempPath);
    } catch {
      // 文件可能仍被 ffmpeg 占用，退出后由用户手动清理。
    }
  }
  activeTempPath = "";
}

function startDownload(message) {
  if (activeProcess) throw new Error("本地宿主当前已有任务在运行。");
  const rawInputs = Array.isArray(message.inputs) && message.inputs.length ? message.inputs : [{ url: message.url, role: "main", cookieHeader: message.cookieHeader }];
  if (rawInputs.length > 4) throw new Error("本地宿主最多接受 4 个媒体输入。");
  const inputs = rawInputs.map((input) => {
    const url = new URL(String(input.url || ""));
    if (!/^https?:$/.test(url.protocol)) throw new Error("本地宿主只接受 HTTP/HTTPS 媒体地址。");
    return { ...input, url };
  });

  const config = loadConfig();
  const ffmpegPath = resolve(config.ffmpegPath || "ffmpeg");
  if (!existsSync(ffmpegPath)) throw new Error(`找不到 FFmpeg：${ffmpegPath}`);
  const outputDirectory = resolve(config.outputDirectory || join(homedir(), "Downloads", "网页视频下载器"));
  mkdirSync(outputDirectory, { recursive: true });
  const format = message.format === "mkv" ? "mkv" : "mp4";
  const outputPath = availablePath(outputDirectory, sanitizeName(message.title), format);
  activeTempPath = `${outputPath}.partial.${format}`;

  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const input of inputs) {
    if (message.userAgent) args.push("-user_agent", String(message.userAgent));
    if (message.referer && /^https?:\/\//i.test(message.referer)) args.push("-referer", String(message.referer));
    if (input.cookieHeader) args.push("-headers", `Cookie: ${String(input.cookieHeader).replace(/[\r\n]/g, "")}\r\n`);
    args.push("-i", input.url.href);
  }
  const videoInput = inputs.findIndex((input) => input.role === "video");
  const audioInput = inputs.findIndex((input) => input.role === "audio");
  const subtitleInput = inputs.findIndex((input) => input.role === "subtitle");
  if (videoInput >= 0) args.push("-map", `${videoInput}:v?`);
  else if (message.selection && Number.isInteger(message.selection.videoStream)) args.push("-map", `0:v:${message.selection.videoStream}?`);
  else args.push("-map", "0:v?");
  if (audioInput >= 0) args.push("-map", `${audioInput}:a?`);
  else if (message.selection && Number.isInteger(message.selection.audioStream)) args.push("-map", `0:a:${message.selection.audioStream}?`);
  else args.push("-map", "0:a?");
  if (subtitleInput >= 0) args.push("-map", `${subtitleInput}:s?`);
  else if (message.selection && Number.isInteger(message.selection.subtitleStream)) args.push("-map", `0:s:${message.selection.subtitleStream}?`);
  args.push("-c:v", "copy", "-c:a", "copy");
  if (format === "mp4") args.push("-c:s", "mov_text");
  else args.push("-c:s", "copy");
  if (format === "mp4") args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:2", "-nostats", activeTempPath);

  send({ type: "log", message: `FFmpeg 开始处理：${message.displayUrl || inputs[0].url.origin}` });
  const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  activeProcess = child;
  let stderrBuffer = "";
  const errorLines = [];
  const progress = {};

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      const match = line.match(/^([a-z_]+)=(.*)$/i);
      if (match) {
        progress[match[1]] = match[2];
        if (match[1] === "progress") {
          const outTimeSeconds = Number(progress.out_time_us || progress.out_time_ms || 0) / 1_000_000;
          const duration = Number(message.duration) || 0;
          send({
            type: "progress",
            outTimeSeconds,
            totalBytes: Number(progress.total_size) || 0,
            speed: progress.speed || "",
            percent: duration > 0 ? Math.min(99, (outTimeSeconds / duration) * 100) : 0
          });
        }
      } else if (line.trim()) {
        errorLines.push(line.trim());
        if (errorLines.length > 30) errorLines.shift();
      }
    }
  });
  child.on("error", (error) => {
    activeProcess = null;
    cleanupPartial();
    send({ type: "error", message: error.message });
  });
  child.on("exit", (code, signal) => {
    activeProcess = null;
    if (code === 0 && existsSync(activeTempPath)) {
      renameSync(activeTempPath, outputPath);
      activeTempPath = "";
      send({ type: "complete", path: outputPath, filename: outputPath.slice(dirname(outputPath).length + 1) });
    } else {
      cleanupPartial();
      send({ type: "error", message: signal ? `FFmpeg 被终止：${signal}` : `FFmpeg 退出码 ${code}：${errorLines.slice(-5).join(" | ")}` });
    }
  });
}

function handle(message) {
  if (message?.type === "ping") {
    const config = loadConfig();
    const ffmpegPath = resolve(config.ffmpegPath || "ffmpeg");
    send({ ok: true, ffmpeg: existsSync(ffmpegPath), ffmpegPath, outputDirectory: config.outputDirectory || "" });
    return;
  }
  if (message?.type === "cancel") {
    if (activeProcess) activeProcess.kill("SIGTERM");
    return;
  }
  if (message?.type === "start") {
    try {
      startDownload(message);
    } catch (error) {
      send({ type: "error", message: error.message });
    }
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (length > 1024 * 1024) {
      send({ type: "error", message: "Native Messaging 消息超过 1 MB 限制。" });
      process.exit(1);
    }
    if (inputBuffer.length < 4 + length) break;
    const payload = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    try {
      handle(JSON.parse(payload.toString("utf8")));
    } catch (error) {
      send({ type: "error", message: error.message });
    }
  }
});

process.stdin.on("end", () => {
  if (activeProcess) activeProcess.kill("SIGTERM");
});
