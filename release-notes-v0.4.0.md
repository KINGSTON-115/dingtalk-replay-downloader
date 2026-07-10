# v0.4.0

本版本把项目从钉钉专用工具升级为通用、模块化的非 DRM 网页视频下载器。

- 新增后台网络媒体目录，可按响应 MIME 识别无后缀 HLS、DASH 和媒体文件。
- 新增页面 MAIN world Fetch/XHR/MSE 信号识别，并保留 DOM、Performance 和多 frame 发现。
- 钉钉改为独立站点适配器，不再把任意钉钉页面误判为回放。
- 使用成熟解析库支持 HLS 多清晰度、独立音轨、字幕组、fMP4、Range、AES-128 和直播清单。
- 新增 DASH MPD、视频轨和音频轨解析，并明确拒绝 DRM ContentProtection。
- 下载任务迁移到独立任务页，支持流式写盘、真正取消、超时、重试和脱敏历史。
- 普通文件直接交给浏览器下载器，避免先把完整文件读入扩展内存。
- 新增可选 FFmpeg Native Messaging 增强宿主，用于合并独立音视频轨和处理动态 DASH。
- 默认权限不再包含全站 Cookie；全站识别、Cookie 和本地增强均按需单独授权。
- 钉钉解析会复用已打开回放标签页的真实登录会话，避免扩展页请求被误判为未登录。
- 媒体域名和 Native Messaging 权限改为严格从用户点击中申请，并在授权后自动继续解析。
- 新增任务级 origin Referer 会话规则、字幕轨下载、跨域 Cookie 防泄漏和 429/503 自适应并发。
- 新增构建脚本、37 项单元测试、后台/UI 冒烟测试、Native Messaging framing 测试和确定性扩展图标。
