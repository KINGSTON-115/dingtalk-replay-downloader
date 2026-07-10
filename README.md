# 网页视频下载器

一个面向**当前账号有权访问、非 DRM 内容**的本地浏览器扩展。它把通用媒体发现、HLS/DASH 下载内核与站点适配器分开，钉钉只是默认内置的适配器之一。

[实现原理](docs/ARCHITECTURE.md) · [使用说明](使用说明.html) · [MIT 许可证说明](LICENSE.zh-CN.md)

> 本项目不绕过登录、访问控制、付费限制或 DRM。请只保存你有权访问和备份的内容，并遵守网站规则与当地法律。

## 主要能力

- 从当前页的 `<video>/<audio>/<source>`、DOM 元数据、Performance 资源中发现媒体。
- 可选增强识别：从页面加载开始记录 Fetch、XHR、MSE 信号与网络响应 MIME，因此能识别大量没有 `.m3u8/.mpd/.mp4` 后缀的地址。
- 支持普通视频/音频文件，并直接交给浏览器下载器，避免把完整大文件读入扩展内存。
- 支持 HLS 主清单、多清晰度、独立音轨、字幕组、TS、fMP4、`EXT-X-MAP`、`BYTERANGE`、AES-128 和直播录制。
- 支持 DASH MPD、`SegmentTemplate`/`SegmentTimeline`、视频轨和音频轨。
- 支持钉钉回放链接与 `roomId/liveUuid` 参数，并复用浏览器现有登录会话。
- HLS/DASH 分片按有界批次并发、严格顺序流式写盘，支持真正取消、超时和自动重试。
- 可选 FFmpeg 本地增强模式：合并独立音视频轨、处理 SIDX/动态 DASH 和浏览器不适合重封装的编码。
- 任务历史只记录脱敏后的地址；未完成任务草稿仅保存在当前浏览器会话中，可从“恢复上次任务”重新开始。

## 支持边界

| 类型 | 浏览器模式 | FFmpeg 增强模式 |
| --- | --- | --- |
| 普通 MP4/WebM/MOV/MKV/音频文件 | 直接下载 | 支持 |
| HLS TS + H264/AAC | 流式保存 TS 或增量转封装 MP4 | 支持 |
| HLS fMP4 | 流式保存 MP4 | 支持 |
| HLS 独立音视频轨 | 保存为两个轨道文件 | 自动合并 |
| HLS 直播 | 持续录制，手动停止并保存 | 支持 |
| DASH 静态分片 | 保存视频轨/音频轨 | 自动合并 |
| DASH SIDX、动态 MPD | 不支持 | 支持 |
| Widevine、PlayReady、FairPlay、SAMPLE-AES DRM | 不支持 | 不支持 |

浏览器无法实现“所有网站、所有视频都能下载”。`blob:` 往往只是 MSE 临时地址，扩展会尝试捕获其底层媒体请求；受 DRM 保护的内容会被明确拒绝。

## 安装

### 使用发布包

1. 从 Releases 下载 `web-video-downloader-v*.zip`，不要下载 GitHub 自动生成的 Source code。
2. 解压 zip。
3. 打开 `chrome://extensions` 或 `edge://extensions`。
4. 开启“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的文件夹。

也可以先打开发布包内的 `使用说明.html` 查看图文式说明。

## 使用

1. 在浏览器中登录目标网站，确认视频能够正常播放。
2. 打开扩展，点击“识别当前页”；如果页面使用动态播放器，先播放几秒再识别。
3. 选择候选媒体，点击“解析媒体信息”。
4. 选择清晰度、音轨和输出方式。
5. 点击“前往任务页下载”。任务页中确认保存位置后开始下载。

下载运行在独立任务页，而不是短生命周期的扩展弹窗中。下载期间可以关闭弹窗，但不要关闭正在工作的任务页。

### 增强识别

基础模式只在用户点击时读取当前标签页。点击“增强识别”并授权后，扩展会在后续网页加载时记录媒体请求；该权限是可选的，也可以在浏览器扩展设置中随时撤销。

### FFmpeg 本地增强

需要先安装 Node.js 和 FFmpeg，并确保 `node`、`ffmpeg` 可在 PowerShell 中运行。然后复制扩展管理页显示的 32 位扩展 ID，在 `native-host` 目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File native-host/install.ps1 -ExtensionId 你的扩展ID
```

详细说明见 [native-host/README.md](native-host/README.md)。默认输出到“下载/网页视频下载器”。本地增强、Cookie 权限都需要用户单独开启；若一个媒体跨越多个 CDN 域名，扩展会拒绝向 FFmpeg 传递 Cookie，避免跨域泄露。

## 权限说明

| 权限 | 是否默认 | 用途 |
| --- | --- | --- |
| `activeTab` | 是 | 用户点击扩展后识别当前标签页 |
| `declarativeNetRequestWithHostAccess` | 是 | 仅在任务期间为扩展自身的媒体请求补充原页面 origin Referer；没有 host 权限时不能作用于网站 |
| `scripting` | 是 | 注入 DOM/Fetch/XHR/MSE 发现脚本 |
| `webRequest` | 可选 | 增强识别时读取媒体响应类型，不读取响应正文 |
| `downloads` | 是 | 保存普通文件和内存回退结果 |
| `storage` | 是 | 保存脱敏任务历史、草稿和临时候选目录 |
| `https://*.dingtalk.com/*` | 是 | 调用钉钉回放信息接口 |
| 全站 HTTP/HTTPS | 可选 | 增强识别与任意 CDN 媒体访问；与 `webRequest` 一同申请 |
| `nativeMessaging` | 可选 | 连接用户安装的 FFmpeg 本地宿主 |
| `cookies` | 可选 | 解析钉钉回放时读取钉钉会话 Cookie；或在用户主动要求时向 FFmpeg 提供当前媒体域的 Cookie |

默认安装不再同时拥有“全站访问 + Cookie”能力。

## 开发

要求 Node.js 20、22 或 24+。

```bash
npm install
npm run check
```

常用命令：

```bash
npm run build          # 构建扩展 bundle 和 PNG 图标
npm test               # 单元测试
npm run test:extension # 后台与真实 Chrome UI 冒烟测试
npm run package        # 构建并生成发布 zip
```

生成结果位于 `dist/`。扩展运行时只使用打包进本地的代码，不从 CDN 加载脚本。

## 第三方组件

运行时使用 `mux.js`、`m3u8-parser` 和 `mpd-parser`；开发阶段使用 esbuild、Vitest、Playwright 和 Sharp。许可证与版本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

MIT
