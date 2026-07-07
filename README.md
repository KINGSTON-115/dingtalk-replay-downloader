# DingTalk Replay Local Learning Downloader

一个本地运行的 Chrome/Edge Manifest V3 学习项目，用来研究“已授权钉钉直播回放”从回放链接解析到 HLS 分片下载、合并和转封装的完整流程。

> 仅用于你有权访问、保存和学习分析的回放内容。本项目不包含任何第三方商业插件代码，不修改其他扩展，不绕过任何商业校验、平台登录、访问控制或 DRM。

## 功能

- 输入钉钉回放链接，或包含 `roomId=...&liveUuid=...` 的参数文本。
- 读取当前浏览器中已经登录钉钉网页的 Cookie。
- 调用 `https://lv.dingtalk.com/getOpenLiveInfo` 解析回放信息。
- 解析 HLS `m3u8`，支持 master playlist 自动选择高码率媒体列表。
- 下载 TS 分片，支持可配置并发数。
- 支持 HLS `AES-128` 分片解密，前提是播放列表中公开给当前授权会话的 key 可访问。
- 合并为 `.ts`，或通过开源 `mux.js` 转封装为 `.mp4`。
- 支持中文 / English 界面切换。

## 安装

1. 下载或克隆这个仓库。
2. 打开 Chrome/Edge 的扩展管理页：
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. 开启“开发者模式”。
4. 点击“加载解压缩的扩展”。
5. 选择本仓库目录，也就是包含 `manifest.json` 的目录。
6. 在同一个浏览器中登录钉钉网页版，并确认你可以正常播放目标回放。

## 使用

1. 打开扩展弹窗。
2. 粘贴钉钉直播回放链接。
3. 选择输出格式：
   - `MP4 via mux.js`: 尝试转封装为 MP4。
   - `Merged TS`: 直接保存合并后的 TS。
4. 设置下载并发数。默认 `4`，网络或机器较弱时可以调低。
5. 点击下载按钮。

如果 MP4 转封装失败，扩展会自动回退保存 `.ts` 文件。

## 原理

简化流程如下：

```text
回放链接
  -> 提取 roomId / liveUuid
  -> 读取浏览器钉钉 Cookie
  -> 请求 getOpenLiveInfo
  -> 获得 playbackUrl / m3u8
  -> 解析 playlist / key / TS 分片
  -> 下载分片
  -> 必要时 AES-128 解密
  -> 合并 TS
  -> 可选 mux.js 转封装 MP4
  -> chrome.downloads 保存文件
```

更多实现细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 权限说明

`manifest.json` 中声明的权限用途：

- `cookies`: 读取当前浏览器中钉钉相关 Cookie，用于访问你已经有权限播放的回放。
- `downloads`: 保存合并后的视频文件。
- `tabs`: 从当前标签页辅助填充回放链接。
- `https://*.dingtalk.com/*`: 访问钉钉回放信息接口。
- `<all_urls>`: HLS 分片和 key 可能位于钉钉返回的不同 CDN 域名。

## 限制

- 只适用于当前登录账号本来就能播放的回放。
- 无权限、过期、被删除、组织策略禁止访问的回放不会被下载。
- 不处理 DRM 或浏览器加密媒体扩展保护的内容。
- 当前实现会在内存中合并分片，超长回放可能占用较多内存。
- 钉钉接口、字段或鉴权策略变化时，解析逻辑可能需要更新。

## 开发检查

```bash
node --check downloader.js
```

## 第三方组件

本项目使用 `mux.js` 做 TS 到 MP4 的转封装。它使用 Apache-2.0 许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

MIT
