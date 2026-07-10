# 架构说明

## 设计目标

项目面向当前浏览器会话有权访问的非 DRM 媒体。通用能力按“发现、站点解析、协议处理、输出”分层，钉钉不会与 HLS/DASH 下载内核耦合。

```text
DOM / Performance / Fetch-XHR-MSE / webRequest
                       ↓
                标签页媒体候选目录
                       ↓
          通用解析器 + 站点适配器注册表
                       ↓
          Direct / HLS / DASH 下载计划
                       ↓
 浏览器下载器 / File System 流 / FFmpeg 本地宿主
```

## 目录

- `src/background/service-worker.js`：后台媒体目录、响应 MIME 监听、动态内容脚本注册和徽标。
- `src/content/content-script.js`：隔离世界中的 DOM、Performance 和页面信号收集。
- `src/content/page-hook.js`：MAIN world 中透明观察 Fetch、XHR 与 MSE，不复制媒体正文。
- `src/adapters/dingtalk.js`：钉钉参数、接口响应与播放地址解析。
- `src/adapters/dingtalk-session.js`：按需读取钉钉 Cookie，并用短生命周期 DNR 规则限定到回放信息接口。
- `src/protocols/hls.js`：基于 `m3u8-parser` 的 HLS 清单标准化。
- `src/protocols/dash.js`：基于 `mpd-parser` 的 MPD 标准化。
- `src/downloads/`：流式输出、分片调度、AES-128、TS 转封装与下载任务引擎。
- `src/ui/downloader.js`：弹窗/任务页共用 UI、权限申请、任务状态与历史。
- `src/native/client.js`、`native-host/`：可选 Native Messaging + FFmpeg 增强路径。
- `scripts/build.mjs`：将模块和本地依赖打包为 MV3 可运行文件，并生成图标。
- `tests/`：URL、媒体分类、钉钉、HLS、DASH、AES、并发顺序和 Manifest 测试。

## 生命周期

Manifest V3 Service Worker 会被浏览器挂起，因此它只保存候选目录和协调消息，不执行长时间下载。

弹窗用于快速识别和配置。用户开始下载时，扩展打开独立任务页；真正的网络读取、流式写盘和转封装都在任务页内执行。关闭弹窗不会中断任务，关闭任务页则会结束任务。

普通媒体文件直接调用 `chrome.downloads.download()`，交给浏览器原生下载器处理。HLS/DASH 会优先使用 File System Access API 边下载边写入；没有该 API 时才启用带 512 MB 安全上限的内存回退。

## 媒体发现

### 基础模式

用户点击“识别当前页”后，扩展使用 `activeTab` 临时权限注入两个脚本：

1. 隔离世界脚本读取 `<video>/<audio>/<source>`、Open Graph 媒体元数据、常见 data 属性和 Performance 资源。
2. MAIN world 脚本观察之后发生的 Fetch、XHR 和 MediaSource 信号。

所有 frame 都会被扫描。候选按协议、来源、内容大小和常见广告特征评分去重。

### 增强模式

用户主动授予可选 HTTP/HTTPS 全站权限和可选 `webRequest` 权限后，后台注册持久内容脚本，并通过 `webRequest.onHeadersReceived` 读取响应 MIME、长度和请求类型。这样可以识别没有扩展名的 `application/vnd.apple.mpegurl`、`application/dash+xml` 和 `video/*` 响应。

后台不读取响应正文。候选只写入 `chrome.storage.session`，按标签页隔离、最多 250 项、两小时自动过期。

## 站点适配器

站点适配器只负责把页面/站点 API 转换为标准播放地址和元数据。钉钉适配器严格要求同时存在 `roomId` 与 `liveUuid`，不会把任意 `dingtalk.com` 页面视为回放。

钉钉接口的登录判定不能只依赖扩展页的 `credentials: include`。用户首次解析钉钉回放时会单独确认 `cookies` 权限；扩展读取钉钉域 Cookie 后安装一条短生命周期 DNR 规则，仅为 `https://lv.dingtalk.com/getOpenLiveInfo` 附加 Cookie 和回放页 origin Referer，请求完成后立即删除。页面会话请求和普通扩展请求仅作为兼容后备。适配器会递归检查常见嵌套响应字段并返回多个候选，协议层再负责 HLS/DASH/文件处理。

后续站点只需新增适配器，不需要复制分片下载、AES 或输出代码。

## HLS

`m3u8-parser` 负责标准标签解析，本项目将结果归一化为：

- 主清单清晰度、分辨率、码率、编码、音频组和字幕组；
- 媒体序列、目标时长、直播/点播状态；
- 分片 URI、`BYTERANGE`、`EXT-X-MAP`、discontinuity 和时间线；
- `AES-128` key、IV 和 key format。

AES-128 使用 Web Crypto API 本地解密，key 请求按 URI 去重。`SAMPLE-AES`、非 identity key format 等会被标记为受保护或不支持，不进入下载流程。

TS 输出可以直接流式写入；MP4 输出使用 `mux.js` 逐分片转成 fragmented MP4。fMP4 则写入一次初始化分片后顺序追加媒体片段。初始化分片中途更换时会要求 FFmpeg 增强模式，防止生成静默损坏的文件。

直播清单会按目标时长轮询、按分片 ID 去重，用户点击“停止并保存”后关闭当前输出。

## DASH

`mpd-parser` 将 MPD 的 `SegmentTemplate`、`SegmentTimeline`、BaseURL 和媒体组转换为与 HLS 类似的分片模型。

浏览器模式可以流式保存静态 fMP4 视频轨和音频轨。独立音视频、SegmentBase/SIDX 与动态 MPD 会提示使用 FFmpeg 增强模式。MPD 中出现 Widevine、PlayReady 等常见 `ContentProtection` 标记时直接拒绝。

## 下载调度

分片采用小批次并发：每批最多 12 个请求，全部结束后按清单顺序写入，再进入下一批。因此即使前部请求较慢，内存上限仍约等于一个并发批次，而不会积累整个视频。

请求特性：

- `AbortController` 贯穿清单、key、map 和分片请求；
- 单请求超时与 408/425/429/5xx 指数退避；
- Range 请求支持；
- 单资源 256 MB 安全上限，key 为 1 MB；
- 同一批请求使用 `Promise.allSettled`，失败时等待其余请求收尾，避免旧 worker 污染下一任务。

部分 CDN 要求原播放页 `Referer`。任务开始时，扩展使用 `declarativeNetRequestWithHostAccess` 创建 session rule，仅发送播放页的 origin（不包含路径和查询参数）；规则同时限制为本次媒体域名和扩展自身 initiator，任务结束后立即删除。没有对应 host permission 时该权限不能修改网站请求，也不会获得额外站点访问能力。

## 输出与本地增强

File System Access API 需要用户在任务页明确选择文件或目录。独立音视频轨在浏览器模式下写为两个文件。

本地增强使用 Native Messaging 连接用户自行安装的 Node.js 宿主，由宿主以参数数组启动 FFmpeg，不使用 shell 拼接。宿主只接受 HTTP/HTTPS URL，清理输出文件名，并将临时文件限制在配置的下载目录。扩展 ID 会在安装时写入 Native Messaging `allowed_origins`。

Cookie 与 Native Messaging 都是可选权限。钉钉适配器仅在用户确认后读取钉钉域 Cookie，并把它限定到回放信息接口；FFmpeg Cookie 增强则只有用户主动勾选后才读取实际媒体 URL 所适用的 Cookie 并发送给本机宿主。若下载计划跨越多个 CDN hostname，Cookie 增强会被拒绝，避免 FFmpeg 将同一 Cookie header 复用到其他域。

## 隐私与权限

- 默认没有全站 host permission，也没有 Cookie permission。
- 历史记录只保存脱敏 URL；签名、token、credential 等查询参数被替换为 `***`。
- 原始媒体候选和未完成任务草稿只存在 session storage，浏览器会话结束后消失。
- 页面钩子只上报 URL、MIME 和 MSE 信号，不复制 Fetch/XHR 响应正文或 SourceBuffer 数据。
- 代码不会尝试处理 EME 许可证、CDM、Widevine、PlayReady 或 FairPlay。

## 构建与验证

`npm run build` 使用 esbuild 生成后台、内容脚本和 UI bundle；运行时代码全部位于扩展包内。Sharp 根据 `assets/icon.svg` 确定性生成 16/32/48/128 PNG。

`npm run check` 顺序执行构建、Vitest 单元测试以及后台/UI 冒烟测试。UI 测试使用系统 Chrome/Edge 加载真实构建产物并模拟最小扩展 API，同时通过本地 HLS fixture 验证清晰度和独立音轨解析。
