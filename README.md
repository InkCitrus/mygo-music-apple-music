# Apple Music for MyGo Music

English | [简体中文](README.zh-CN.md)

Version 0.4.0 replaces Music.app automation and browser playback with [Apple Music Native Core](https://github.com/InkCitrus/apple-music-native-core), an independent headless ALAC player for macOS ARM64, Windows x64 and Linux x64. The core repository is private during review.

The plugin retains catalog search, albums, artists, playlists, subscriber library, favorites, recommendations, recently played, Apple TTML word lyrics and LRCLIB fallback. The native core owns subscriber authorization, lossless decoding and system audio output. No browser or Music.app process is used for playback.

## Install and migrate

Requires MyGo Music 0.1.8+ and permission to start external programs. A complete package must contain `dist/`, `plugin.json`, `locales/`, `bin/apple-music-core-PLATFORM[.exe]` and `bin/native/PLATFORM/`. Building TypeScript alone does not create native executables.

Install a complete platform bundle, then click Sign In. First use downloads checksum-pinned runtime dependencies and opens local account/password/verification-code dialogs. Credentials pass to the native helper over private pipes. An active Apple Music subscription is required. Existing Music.app, browser and web-cookie sessions are not migrated; sign in once using the new native flow. Signing out stops playback and removes only the new core's dedicated account directory.

Supported: Apple Silicon/macOS 14+, Windows x64, and Linux x64/glibc 2.38+ with ALSA or PulseAudio. Linux account dialogs require `zenity` or `kdialog`. macOS Intel and Windows/Linux ARM64 are not supported yet. Choose audio output in system settings.

## Playback and quality

`audioQuality=hires` (default) selects the highest available ALAC variant; `lossless` selects ALAC up to 48 kHz. Changes apply on the next play/seek. No silent AAC or preview fallback occurs in full playback.

Play, pause, resume, seek, volume, mute and state polling use the same native interface on all supported desktops. MyGo Music owns queue order. Library songs require a catalog mapping. Live radio, uploaded-only tracks, AirPlay device enumeration, exclusive output and cross-track gapless output are not implemented. The separate `stream()` hook remains a preview-only API; full playback uses `remote*` hooks.

The underlying prototype passed real subscriber ALAC 24-bit/96 kHz playback and seeking on the three target platforms. The extracted daemon and production plugin hooks also passed muted real-session playback, pause, volume, seek and shutdown checks on macOS, using simulated host process bindings and song metadata. The complete MyGo Music UI and new Windows/Linux packages still need real-account regression. Source format does not prove physical DAC format or bit-perfect output.

## Build

Build the independent core on the target OS and synchronize its complete bundle:

```sh
python3 /path/to/apple-music-native-core/scripts/build.py
python3 /path/to/apple-music-native-core/scripts/bundle_sources.py
python3 scripts/sync_core.py /path/to/apple-music-native-core/build/bundle
npm ci
npm run typecheck
npm run build
npm test
```

Core builds require Go, a C/C++ toolchain and Python; playback does not require Python. Use native MSYS2 UCRT64 GCC on Windows, retaining the validated stack configuration and v8 TLS decoder fix. Go library packages, the versioned stdio protocol and examples live in the independent repository. The plugin controls only its own child process over private stdin/stdout and exposes no network control server.

The plugin's own code is MIT licensed. Preserve the native core/dependency notices and corresponding source archives in `bin/`. Apple runtime dependencies are downloaded separately and are not included in the source repository. This project is not affiliated with Apple Inc.
