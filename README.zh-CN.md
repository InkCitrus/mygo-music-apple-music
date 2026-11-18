# Apple Music for MyGo Music

[English](README.md) | 简体中文

在 MyGo Music 里播放 Apple Music 曲库和六路直播电台，支持 macOS ARM64、Windows x64 和 Linux x64。[Apple Music Native Core](https://github.com/InkCitrus/apple-music-native-core) 负责原生账号授权、ALAC 与 AAC 解码及系统音频输出，播放无需浏览器或系统“音乐”应用。

插件支持曲库浏览和搜索、个人资料库、歌单、收藏、个性化推荐，以及 Apple Music 逐字歌词和 LRCLIB 歌词补充。

## 安装与迁移

需要 MyGo Music 0.1.8+，并允许 Apple Music 插件启动外部程序。安装包必须同时包含 `dist/`、`plugin.json`、`locales/`、对应平台的 `bin/apple-music-core-*` 和 `bin/native/平台/`；仅构建 TypeScript 不会生成原生核心。

1. 安装对应平台的完整构建包，保留上述目录结构。
2. 点击登录。首次使用会下载并校验原生运行库，随后在本机账号窗口中输入 Apple 账号、密码及验证码。账号信息只通过本机进程管道交给原生授权库。
3. 有效订阅登录后即可播放曲库歌曲；输出设备通过系统声音设置选择。

原来的 Music.app、浏览器和插件网页登录会话不会自动迁移，需要通过新的原生入口登录一次。旧的 `playbackBackend` 与 Music.app 交叉渐变设置已移除。退出登录会停止播放并删除新核心专用的账号目录；运行库可以继续使用。

账号连接窗口明确标注由 MyGo Music 提供；macOS 在同一原生窗口内输入账号密码、验证码并显示进度与错误重试。文案跟随 MyGo Music 语言，支持简体中文和英文，其他语言回退英文。

macOS 要求 Apple Silicon 与 macOS 14+；Windows 使用 x64 原生构建；Linux 需要 x64、glibc 2.38+、ALSA/PulseAudio，登录窗口需要 `zenity` 或 `kdialog`。macOS Intel、Windows/Linux ARM64 暂不支持。

## 音质与功能范围

在插件设置里选择 **Apple Music 播放音质**。**最高可用无损**（默认）选择歌曲提供的最高 ALAC 规格；**无损（最高 48 kHz）**限制源采样率。**高音质（AAC 256 kbps）**使用 Apple 提供的原始立体声 AAC，流量更少。切换音质从下一首歌起生效。MyGo 的全局播放音质设置用于向 MyGo 提供音频流的音源，本插件由独立核心播放，使用自己的音质选择。

支持播放、暂停、继续、拖动、音量、静音和曲目状态。MyGo Music 管理队列和下一首。资料库歌曲需要能映射到曲库 ID。推荐电台返回曲库歌曲时可以播放。自行上传且无曲库映射的歌曲、AirPlay 设备枚举、独占输出和跨曲无缝播放尚未实现。`stream()` 提供试听，完整播放使用 `remote*` 钩子调用原生核心。

打开 **广播**，可以收听 Apple Music 1、Hits、Country、Club、Chill 和 Música Uno。[TuneIn](https://tunein.com/radio/Stream-Apple-Music-a178680/) 提供 AAC 或 HE-AAC 直播音频。首段音频验证成功后，MyGo 才会切换队列。电台暂时不可用时会继续当前播放。「直播」标记和专用播放控件需要 MyGo 主程序支持。电台节目回放暂不支持。

此前核心实验已在三平台完成真实订阅 ALAC 24-bit/96 kHz 播放与拖动验证。1.0.2 的播放修复还在 macOS 实际安装的 MyGo Music 中验证了 24-bit/48 kHz 连续播放及切换到 24-bit/96 kHz，听者确认已流畅。当前 Windows/Linux 安装包通过了云端构建和自动检查，仍需真实账号试听回归。源音质并不等于声卡最终输出格式，尚不宣称 bit-perfect。

## GitHub Actions 构建

独立核心在 GitHub Actions 上分平台编译、测试和打包。插件工作流下载 `core-lock.json` 指定的公开核心版本，校验 SHA-256，再构建、测试 JavaScript 并打包所有桌面安装包，不重复编译核心。构建产物附带报告，核对内嵌核心与原生资源是否和独立版本一致。推送到 `main` 或手动运行工作流即可下载产物，无需账号资料或订阅会话。不在本地编译时，可以先在分支手动运行工作流，下载 `mygo-apple-music-javascript`，审阅后将其 `index.js` 提交到 `dist/`；`main` 的构建会检查生成文件是否一致。

## 本地开发

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
