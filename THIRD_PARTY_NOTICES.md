# 第三方组件说明

本项目整体使用 MIT 许可证。以下组件仍分别遵循其上游许可证。

## 运行时组件

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [mux.js](https://github.com/videojs/mux.js) | 7.1.0 | Apache-2.0 | TS 到 fragmented MP4 转封装 |
| [m3u8-parser](https://github.com/videojs/m3u8-parser) | 7.2.0 | Apache-2.0 | HLS 清单解析 |
| [mpd-parser](https://github.com/videojs/mpd-parser) | 1.4.0 | Apache-2.0 | DASH MPD 解析 |
| `@babel/runtime` | 7.29.7 | MIT | 解析器运行时依赖 |
| `@videojs/vhs-utils` | 4.1.2 | MIT | Video.js 解析工具 |
| `@xmldom/xmldom` | 0.8.13 | MIT | MPD XML 解析 |
| `global` | 4.4.0 | MIT | 浏览器全局对象兼容层 |
| `min-document` | 2.19.2 | MIT | `global` 的 DOM 兼容依赖 |
| `dom-walk` | 0.1.2 | MIT | `min-document` 依赖 |
| `process` | 0.11.10 | MIT | 浏览器 process 兼容层 |

仓库内的 `vendor/mux.min.js` 保留上游标识：

```text
@name mux.js @version 7.1.0 @license Apache-2.0
```

其余运行时依赖由 esbuild 打包进 `build/ui/downloader.js`，构建时保留许可证注释。

## 开发工具

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| esbuild | MIT | 扩展构建 |
| Vitest | MIT | 单元测试 |
| Playwright | Apache-2.0 | Chrome/Edge UI 冒烟测试 |
| Sharp | Apache-2.0 | 从 SVG 生成扩展 PNG 图标 |

FFmpeg 与 Node.js 不包含在扩展发布包中。用户可自行安装 FFmpeg 并遵循其所选构建版本对应的许可证。
