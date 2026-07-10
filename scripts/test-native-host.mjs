import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "win32") {
  process.stdout.write("Native host launcher test skipped outside Windows.\n");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const temp = resolve(root, ".tmp-native-host-test");
if (!temp.startsWith(root)) throw new Error("Native host 测试目录不在项目内。");
await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });

try {
  const windows = process.env.WINDIR || "C:\\Windows";
  const csc = [
    resolve(windows, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
    resolve(windows, "Microsoft.NET/Framework/v4.0.30319/csc.exe")
  ].find(existsSync);
  if (!csc) throw new Error("找不到 C# 编译器。");

  const launcherSource = resolve(temp, "launcher.cs");
  const hostSource = resolve(temp, "host.cjs");
  const launcher = resolve(temp, "native-host-launcher.exe");
  await copyFile(resolve(root, "native-host/launcher.cs"), launcherSource);
  await copyFile(resolve(root, "native-host/host.cjs"), hostSource);
  await writeFile(resolve(temp, "launcher.config"), `${process.execPath}\n${hostSource}\n`, "utf8");
  await writeFile(resolve(temp, "config.json"), JSON.stringify({
    ffmpegPath: resolve(temp, "missing-ffmpeg.exe"),
    outputDirectory: resolve(temp, "downloads")
  }), "utf8");

  const compile = spawnSync(csc, ["/nologo", "/target:exe", `/out:${launcher}`, launcherSource], { encoding: "utf8" });
  if (compile.status !== 0 || !existsSync(launcher)) throw new Error(`Native launcher 编译失败：${compile.stdout}\n${compile.stderr}`);

  const payload = Buffer.from(JSON.stringify({ type: "ping" }), "utf8");
  const framed = Buffer.alloc(payload.length + 4);
  framed.writeUInt32LE(payload.length, 0);
  payload.copy(framed, 4);

  const output = await new Promise((resolveOutput, reject) => {
    const child = spawn(launcher, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Native host ping 超时。"));
    }, 15000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Native host 退出码 ${code}：${Buffer.concat(errors).toString("utf8")}`));
      else resolveOutput(Buffer.concat(chunks));
    });
    child.stdin.end(framed);
  });
  if (output.length < 4) throw new Error("Native host 没有返回完整消息头。");
  const length = output.readUInt32LE(0);
  const message = JSON.parse(output.subarray(4, 4 + length).toString("utf8"));
  if (!message.ok || message.ffmpeg !== false) throw new Error(`Native host ping 响应异常：${JSON.stringify(message)}`);
  process.stdout.write("Native Messaging launcher/host framing test passed.\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
