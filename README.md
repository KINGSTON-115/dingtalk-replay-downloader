# 钉钉直播回放下载器

Chrome / Edge 本地扩展，用于下载当前账号已经有权限播放的钉钉直播回放。

[下载最新版](https://github.com/KINGSTON-115/dingtalk-replay-downloader/releases/latest) · [实现原理](docs/ARCHITECTURE.md) · [MIT License](LICENSE)

> 仅用于你有权访问、保存和学习分析的回放内容。本项目不包含任何第三方商业插件代码，不修改其他扩展，不绕过商业校验、平台登录、访问控制或 DRM。

## 快速安装

1. 打开 [Releases](https://github.com/KINGSTON-115/dingtalk-replay-downloader/releases/latest)，下载 `dingtalk-replay-downloader-*.zip`。
2. 解压 zip，得到一个文件夹。
3. 打开浏览器扩展管理页：
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
4. 开启“开发者模式”。
5. 把解压后的文件夹直接拖到扩展管理页面，即可安装。

如果拖拽安装没有反应，点击“加载解压缩的扩展”，选择那个包含 `manifest.json` 的文件夹。

## 使用方法

1. 在同一个浏览器里登录钉钉网页，并确认目标回放能正常播放。
2. 打开扩展，粘贴钉钉直播回放链接。
3. 选择输出格式：
   - `MP4 via mux.js`: 尝试保存为 MP4。
   - `Merged TS`: 保存合并后的 TS。
4. 点击下载。

MP4 转封装失败时，会自动回退保存 `.ts` 文件。

## 功能

- 从回放链接提取 `roomId` 和 `liveUuid`。
- 复用当前浏览器里已经登录钉钉的 Cookie。
- 解析 `m3u8`，下载并合并 TS 分片。
- 支持可访问的 HLS `AES-128` 分片解密。
- 支持 TS 合并和 MP4 转封装。
- 支持中文 / English 切换。

## 原理简图

```text
回放链接
  -> 提取 roomId / liveUuid
  -> 读取钉钉 Cookie
  -> 请求 getOpenLiveInfo
  -> 获取 m3u8
  -> 下载 TS 分片
  -> 必要时 AES-128 解密
  -> 合并 TS
  -> 可选转封装 MP4
  -> 保存到本地
```

## 常见问题

**没有回放权限可以下载吗？**  
不可以。扩展只使用你当前浏览器已有的钉钉登录态，钉钉服务端拒绝访问的回放不会被下载。

**需要安装 Node.js 或运行构建命令吗？**  
不需要。下载 Release zip，解压后直接加载扩展即可。

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

## 开发检查

```bash
node --check downloader.js
```

## 第三方组件

本项目使用 `mux.js` 做 TS 到 MP4 的转封装。它使用 Apache-2.0 许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

MIT
