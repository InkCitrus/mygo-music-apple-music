# Apple Music for MyGo Music

[English](README.md) | 简体中文

1.0.0 将完整曲目播放统一交给 [Apple Music Native Core](https://github.com/InkCitrus/apple-music-native-core)。macOS ARM64、Windows x64 和 Linux x64 使用同一套 ALAC 播放接口，无需后台浏览器或控制系统“音乐”应用。

搜索、专辑、艺人、歌单、个人资料库、收藏、最近播放、个性化推荐、Apple TTML 逐字歌词及 LRCLIB 歌词回退继续由插件提供。播放核心负责原生订阅授权、ALAC 解码和系统音频输出。

## 安装与迁移

需要 MyGo Music 0.1.8+，并允许 Apple Music 插件启动外部程序。安装包必须同时包含 `dist/`、`plugin.json`、`locales/`、对应平台的 `bin/apple-music-core-*` 和 `bin/native/平台/`；仅构建 TypeScript 不会生成原生核心。

1. 安装对应平台的完整构建包，保留上述目录结构。
2. 点击登录。首次使用会下载并校验原生运行库，随后在本机账号窗口中输入 Apple 账号、密码及验证码。账号信息只通过本机进程管道交给原生授权库。
3. 有效订阅登录后即可播放曲库歌曲；输出设备通过系统声音设置选择。

原来的 Music.app、浏览器和插件网页登录会话不会自动迁移，需要通过新的原生入口登录一次。旧的 `playbackBackend` 与 Music.app 交叉渐变设置已移除。退出登录会停止播放并删除新核心专用的账号目录；运行库可以继续使用。

账号连接窗口明确标注由 MyGo Music 提供；macOS 在同一原生窗口内输入账号密码、验证码并显示进度与错误重试。文案跟随 MyGo Music 语言，支持简体中文和英文，其他语言回退英文。

macOS 要求 Apple Silicon 与 macOS 14+；Windows 使用 x64 原生构建；Linux 需要 x64、glibc 2.38+、ALSA/PulseAudio，登录窗口需要 `zenity` 或 `kdialog`。macOS Intel、Windows/Linux ARM64 暂不支持。

## 音质与功能范围

设置 `audioQuality` 为 `hires`（默认）选择最高可用 ALAC 音质，`lossless` 选择不超过 48 kHz 的 ALAC；设置在下次播放或拖动时生效。核心不会静默降级为 AAC 或试听片段。

支持播放、暂停、继续、拖动、音量、静音和曲目状态；MyGo Music 管理队列和下一首。资料库歌曲需要能映射到曲库 ID。电台直播、自行上传且无曲库映射的歌曲、AirPlay 设备枚举、独占输出和跨曲无缝播放尚未实现。`stream()` 仅保留明确的试听接口，完整播放使用 `remote*` 钩子调用原生核心。

此前核心实验已在三平台完成真实订阅 ALAC 24-bit/96 kHz 播放与拖动验证。提取后的核心和实际插件接口也已在 macOS 上通过真实订阅静音播放、暂停、音量、拖动和退出检查；该接口检查使用模拟的宿主进程接口及歌曲资料。完整 MyGo Music 窗口和新版 Windows/Linux 包仍需真实账号回归。源音质并不等于声卡最终输出格式，尚不宣称 bit-perfect。

## 本地构建

先在对应系统构建独立核心，再同步完整构建目录：

```sh
python3 /path/to/apple-music-native-core/scripts/build.py
python3 /path/to/apple-music-native-core/scripts/bundle_sources.py
python3 scripts/sync_core.py /path/to/apple-music-native-core/build/bundle
npm ci
npm run typecheck
npm run build
npm test
```

构建核心需要 Go、C/C++ 工具链和 Python；播放不需要安装 Python。Windows 核心必须用原生 MSYS2 UCRT64 GCC 构建，保留已验证的 Windows 栈配置及 v8 TLS 修复。

新核心提供 Go 库与有版本号的 JSONL 接口，其他程序无需依赖 MyGo Music，见独立仓库的 `docs/PROTOCOL.md` 和调用示例。插件只通过私有标准输入/输出连接自己的子进程，不开放网络控制端口。

插件自身采用 MIT 协议；核心及其依赖的授权说明和对应源代码位于 `bin/` 的声明及源码包中。Apple 运行库单独下载，不随源码仓库分发。本项目与 Apple Inc. 无关联。
