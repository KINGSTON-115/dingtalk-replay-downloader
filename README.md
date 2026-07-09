# 钉钉直播回放下载器

一个本地浏览器扩展，用来下载当前钉钉账号已经有权限播放的直播回放。适用于 Chrome 和 Edge。

[下载最新版](https://github.com/KINGSTON-115/dingtalk-replay-downloader/releases/latest) · [实现原理](docs/ARCHITECTURE.md) · [MIT 许可证说明](LICENSE.zh-CN.md)

> 仅用于你有权访问、保存和学习分析的回放内容。本项目不包含任何第三方商业插件代码，不修改其他扩展，不绕过商业校验、平台登录、访问控制或 DRM。

## 一分钟安装

1. 打开 [最新版发布页](https://github.com/KINGSTON-115/dingtalk-replay-downloader/releases/latest)。
2. 下载附件里的 `dingtalk-replay-downloader-v*.zip`，不要下载 GitHub 自动生成的 `Source code`。
3. 解压 zip，得到 `钉钉直播回放下载器-v*.*.*` 文件夹。
4. 打开文件夹里的 `使用说明.html`，按页面提示安装。

最短流程就是：解压 -> 打开浏览器扩展管理页 -> 开启开发者模式 -> 把整个文件夹拖进去。

如果拖拽没有反应，点击“加载解压缩的扩展”，选择那个包含 `manifest.json` 的文件夹。

## 使用方法

1. 在同一个浏览器里登录钉钉网页，并确认目标回放能正常播放。
2. 打开扩展，粘贴钉钉直播回放链接，或在回放页点击“使用当前页”。
3. 选择 `MP4` 或 `TS`。
4. 点击“开始下载回放”。

MP4 转封装失败时，会自动回退保存 `.ts` 文件。

## 功能

- 从回放链接提取 `roomId` 和 `liveUuid`。
- 复用当前浏览器里已经登录钉钉的 Cookie。
- 解析 `m3u8`，下载并合并 TS 分片。
- 支持可访问的 HLS `AES-128` 分片解密。
- 支持 TS 合并和 MP4 转封装。
- 界面、文档和发布说明均以中文维护。

## 常见问题

**没有回放权限可以下载吗？**
不可以。扩展只使用你当前浏览器已有的钉钉登录态，钉钉服务端拒绝访问的回放不会被下载。

**需要安装 Node.js 或运行命令吗？**
普通使用不需要。下载发布页附件里的 zip，解压后按 `使用说明.html` 安装即可。

**为什么有时只能保存 TS？**
TS 到 MP4 是转封装，不是重新编码。源流不规范或浏览器环境不支持时可能失败，此时保存 TS 是预期回退。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `cookies` | 读取钉钉相关 Cookie，用于访问已授权回放 |
| `downloads` | 保存视频文件 |
| `tabs` | 从当前标签页辅助填充回放链接 |
| `https://*.dingtalk.com/*` | 请求钉钉回放信息接口 |
| `<all_urls>` | 访问钉钉返回的 HLS/CDN 分片与 key 地址 |

## 开发与打包

语法检查：

```bash
node --check downloader.js
```

生成发布 zip：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

生成结果在 `dist/` 目录。

## 第三方组件

本项目使用 `mux.js` 做 TS 到 MP4 的转封装。它使用 Apache-2.0 许可证，详见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。

## 许可证

MIT
