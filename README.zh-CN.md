# Apple Music for MyGo Music

简体中文 | [English](./README.md)

为 [MyGo Music](https://github.com/egoist/mygo-music) 打造的 Apple Music 插件 —— **无需 Apple 开发者账号**即可网页登录订阅账户，支持个人资料库与歌单、Apple 原生逐字卡拉 OK 歌词（含翻译），并通过受控联动 macOS 自带 `Music.app` 实现完整订阅曲目播放与 AirPlay 设备切换。

> [!NOTE]
> 本插件与 Apple Inc. 无关，亦未获其背书。插件通过 Apple Music Web API 获取曲库与个人资料库数据，并在 macOS 上通过 AppleScript 控制内置“音乐 (`Music.app`)”完成正版 FairPlay 订阅音频播放。

## 安装

需要 **MyGo Music 0.1.8 及以上版本**，完整曲目播放需在 **macOS** 系统上使用（系统自带“音乐”应用已登录 Apple Music 订阅账号）。

点击下方协议链接一键安装：

[mygo-music://install-plugin?repo=InkCitrus/mygo-music-apple-music](mygo-music://install-plugin?repo=InkCitrus/mygo-music-apple-music)

或在 MyGo Music 的 **设置 > 插件 > +** 中粘贴仓库地址安装：

[https://github.com/InkCitrus/mygo-music-apple-music](https://github.com/InkCitrus/mygo-music-apple-music)

### 启用与配置步骤

1. 打开 **设置 > 插件 > Apple Music**，开启 **允许此插件启动外部程序**（插件仅声明了 `/usr/bin/osascript` 权限，用于控制本机 `Music.app`）。
2. 确保 macOS 系统自带的 **音乐 (`Music.app`)** 已登录你的 Apple Music 订阅账号。首次播放时若系统弹出“自动化”权限提示，请点击 **允许**。
3. 点击插件页的 **登录 (Sign In)** 按钮，在弹出的 `music.apple.com` 窗口中登录你的 Apple 账号（也可在设置中手动粘贴 `media-user-token`），即可同步个人歌单、收藏、最近播放与逐字歌词。

## 登录说明

无需注册付费的 Apple Developer 开发者账号，也无需手动申请 MusicKit 私钥。点击 **登录** 后，插件会打开内置网页登录窗口并在本地保存 `media-user-token` 会话，同时自动识别你的订阅国家/地区（如 `cn`、`us`、`jp`，也可在插件设置中手动指定 Storefront 代码）。

点击退出登录即可清除本地保存的会话凭据。

## 支持的功能

- **未登录状态**：全曲库搜索与搜索联想建议、主页推荐与排行榜（热门歌曲 / 热门专辑 / 热门歌单）、专辑详情、艺人主页、官方精选歌单，以及基于 LRCLIB 的同步滚动歌词。
- **已登录订阅账号**：个人资料库歌单（支持分页加载）、新建歌单与添加歌曲、喜欢的音乐、收藏的专辑、最近播放、个性化“为你推荐”、红心喜欢歌曲、收藏专辑，以及 Apple Music 官方 TTML **逐字音节歌词与双语翻译**。
- **完整曲目播放 (macOS)**：无缝控制 macOS 原生 `Music.app`（播放、暂停、继续、拖动进度条、音量调节、列表自动切歌，以及 **AirPlay 扬声器/耳机切换**）。资料库内曲目支持毫秒级直连秒播，曲库流媒体曲目通过 `music://` 协议唤醒播放并自动保持 MyGo Music 窗口焦点。
- **多语言界面**：完整支持简体中文 (`zh-CN`) 与英文界面。

## 播放原理说明

Apple Music 完整流媒体受商业级 FairPlay Streaming DRM 硬件加密保护，非苹果商业签名的第三方内核无法直接解密音频流。本插件遵循 MyGo Music 官方提供的 `"playback": "remote"` 远程播放架构，在后台通过 `/usr/bin/osascript` 驱动 macOS 原生 `Music.app` 解码输出，既能享受正版无损/高品质音频与原生 AirPlay 生态，又能在 MyGo Music 中统一完成搜索、歌单管理、队列切歌与逐字歌词展示。

## 歌词支持

登录后优先从 Apple Music 官方 `/syllable-lyrics` 与 `/lyrics` 接口获取 TTML 逐字时间轴歌词及翻译；若曲目无官方歌词或未登录，则自动回退至 [LRCLIB](https://lrclib.net) 获取同步 LRC 歌词。

## 本地开发与测试

```bash
npm install
npm run typecheck
npm run build
npm test
```

## 开源协议

[MIT](./LICENSE)
