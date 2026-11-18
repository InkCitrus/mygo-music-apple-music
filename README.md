# Apple Music for MyGo Music

English | [简体中文](README.zh-CN.md)

Version 1.0.0 replaces Music.app automation and browser playback with [Apple Music Native Core](https://github.com/InkCitrus/apple-music-native-core), an independent headless ALAC player for macOS ARM64, Windows x64 and Linux x64.

The plugin retains catalog search, albums, artists, playlists, subscriber library, favorites, recommendations, recently played, Apple TTML word lyrics and LRCLIB fallback. The native core owns subscriber authorization, lossless decoding and system audio output. No browser or Music.app process is used for playback.

## Install and migrate

Requires MyGo Music 0.1.8+ and permission to start external programs. A complete package must contain `dist/`, `plugin.json`, `locales/`, `bin/apple-music-core-PLATFORM[.exe]` and `bin/native/PLATFORM/`. Building TypeScript alone does not create native executables.

Install a complete platform bundle, then click Sign In. First use downloads checksum-pinned runtime dependencies and opens local account/password/verification-code dialogs. Credentials pass to the native helper over private pipes. An active Apple Music subscription is required. Existing Music.app, browser and web-cookie sessions are not migrated; sign in once using the new native flow. Signing out stops playback and removes only the new core's dedicated account directory.

The account connection window is attributed to MyGo Music. macOS keeps credentials, verification, progress and manual error retry in one native window. Account prompts follow the host language, with English and Simplified Chinese resources and English fallback.

Supported: Apple Silicon/macOS 14+, Windows x64, and Linux x64/glibc 2.38+ with ALSA or PulseAudio. Linux account dialogs require `zenity` or `kdialog`. macOS Intel and Windows/Linux ARM64 are not supported yet. Choose audio output in system settings.

## Playback and quality

Use **Apple Music Playback Quality** in the plugin settings. **Highest available lossless** (default) selects the highest available ALAC variant; **Lossless (up to 48 kHz)** limits the source sample rate. Changes apply when you start another song. MyGo's global Playback Quality setting applies to sources that supply a stream to MyGo; it doesn't control playback by this plugin's native core.

Play, pause, resume, seek, volume, mute and state polling use the same native interface on all supported desktops. MyGo Music owns queue order. Library songs require a catalog mapping. Recommended stations can play when their feed returns catalog songs. Unsupported station requests leave the current song and queue unchanged. Live radio, uploaded-only tracks, AirPlay device enumeration, exclusive output and cross-track gapless output are not implemented. The separate `stream()` hook remains a preview-only API; full playback uses `remote*` hooks.

The underlying prototype passed real subscriber ALAC 24-bit/96 kHz playback and seeking on the three target platforms. The 1.0.2 playback fixes were also exercised in the installed MyGo Music application on macOS, including continuous 24-bit/48 kHz playback and transition to 24-bit/96 kHz; the listener confirmed smooth playback. The current Windows/Linux packages pass cloud builds and automated checks but still need real-account listening regression. Source format does not prove physical DAC format or bit-perfect output.

## GitHub Actions builds

The independent core is compiled, tested and packaged on GitHub Actions for each supported platform. This plugin's workflow downloads the exact public release recorded in `core-lock.json`, verifies its SHA-256 hashes, builds and tests the JavaScript, then packages all desktop bundles. It does not rebuild the core. Each artifact includes a build report comparing the embedded core and native resources with the upstream release. Pushes to `main` and manual workflow runs produce downloadable artifacts without account credentials or subscriber sessions. For development without local compilation, run the workflow on a branch and download `mygo-apple-music-javascript`; review and commit its `index.js` into `dist/` before updating `main`, where the generated JavaScript must match.

## Local development

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
