# FFmpeg 本地增强模式

本地增强模式用于合并 DASH/HLS 的独立音视频轨、处理浏览器内不适合重封装的编码，以及录制动态 DASH。它不会绕过 DRM，也不会获得网站之外的访问权限。

前置条件：已安装 Node.js 与 FFmpeg，并且 `node`、`ffmpeg` 可以在 PowerShell 中直接运行。

1. 在 `chrome://extensions` 或 `edge://extensions` 复制本扩展的 32 位扩展 ID。
2. 在本目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId 你的扩展ID
```

默认输出到 `下载/网页视频下载器`。卸载：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

只有用户在扩展中主动启用“本地增强”时，扩展才会连接该宿主。若媒体必须依赖 Cookie，扩展会再次单独请求 Cookie 权限。
