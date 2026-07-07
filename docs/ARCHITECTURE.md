# 实现原理

本文档解释这个扩展的核心实现路径。它只依赖浏览器扩展能力和当前浏览器里的钉钉登录态，不依赖任何第三方商业插件代码或服务。

## 模块

- `manifest.json`：浏览器扩展配置，声明入口、权限和扩展名称。
- `downloader.html`：弹窗界面结构。
- `styles.css`：界面样式。
- `downloader.js`：主要业务逻辑，包括链接解析、Cookie 收集、钉钉接口请求、m3u8 解析、分片下载、AES-128 解密、合并和保存。
- `vendor/mux.min.js`：开源 `mux.js`，用于可选的 TS 到 MP4 转封装。

## 下载流程

1. `extractParamsFromUrl()` 从输入中解析 `roomId` 和 `liveUuid`。
2. `collectDingtalkCookies()` 通过 `chrome.cookies.getAll()` 收集钉钉相关 Cookie。
3. `getOpenLiveInfo()` 请求 `https://lv.dingtalk.com/getOpenLiveInfo`。
4. `pickPlaybackUrl()` 从返回数据中选择可用回放地址。
5. `fetchAndParseM3u8()` 读取并解析 HLS 播放列表。
6. `downloadSegments()` 按并发数下载 TS 分片。
7. `downloadOneSegment()` 在需要时调用 `aes128Decrypt()` 解密 AES-128 分片。
8. `concatBytes()` 合并 TS。
9. `transmuxTsToMp4()` 使用 `mux.js` 可选转封装 MP4。
10. `saveBlob()` 调用 `chrome.downloads.download()` 保存文件。

## 权限边界

扩展不会获得额外的钉钉权限。它使用的是当前浏览器会话里已经存在的登录 Cookie。因此：

- 你能在网页正常播放的回放，才可能被解析和下载。
- 钉钉服务端拒绝的回放，扩展也会失败。
- 如果播放列表中的 key、分片或回放 URL 有过期时间，下载也会受同样限制。

## HLS 与 AES-128

HLS 回放通常由一个 `m3u8` 播放列表和多个 `.ts` 分片组成。部分播放列表包含：

```text
#EXT-X-KEY:METHOD=AES-128,URI="...",IV=...
```

当 key URL 对当前登录态可访问时，扩展会用 Web Crypto API 做本地 AES-CBC 解密。这里没有绕过加密；它只使用播放列表明确提供且当前授权会话可以访问的 key。

## MP4 转封装

TS 与 MP4 是容器格式差异。`mux.js` 做的是转封装：把 H264/AAC 等媒体数据从 TS 容器重封装到 MP4 容器。它不是重新编码，所以速度较快，但也可能因为源流格式不规范而失败。失败时保存 `.ts` 是预期回退路径。

## 安全与合规

这个项目面向协议学习、浏览器扩展学习和个人授权内容备份研究。请遵守所在组织、平台服务条款、课程或会议资料规则以及当地法律。
