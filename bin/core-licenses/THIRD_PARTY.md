# Third-party sources and runtime provenance

The root MIT license covers new orchestration code, not every file in this tree. Preserve file headers and component notices when redistributing source or binaries.

| Component | Source / pin | Notice |
| --- | --- | --- |
| Apple ALAC decoder, decode-only subset | `codec/` | `codec/LICENSE.Apple-ALAC`, Apache 2.0 |
| mp4ff | `github.com/Eyevinn/mp4ff` v0.50.0, Go checksum in `go.sum` | `third_party/LICENSE.mp4ff`, MIT |
| miniaudio | `audio/miniaudio.h` | `audio/LICENSE.miniaudio`, original dual-license text |
| Adam native DRM client and wrapper sources, locally patched | `silentone12725/apple-music-linux` at `dea30e5e56a05d742feb4f21c4f982b2bbd59c41` | `third_party/LICENSE.Adam`, MIT; preserve nested source headers |
| libhybris-win and Android linker sources, locally patched | `silentone12725/libhybris-win` at `606bae7cdb49eaf8be79828de6cda0ce9d414295` | all `third_party/libhybris-win/LICENSE.*` and per-file headers; includes LGPL 2.1, BSD and Apache components |
| cJSON | `third_party/cJSON.{c,h}`, `native/macos/arm-reference/cJSON.{c,h}` | MIT notice in each source header |
| macOS compatibility loader dependencies | exact repositories/revisions in `native/macos/dependencies-lock.json` | upstream source headers/notices; downloaded at build time |
| macOS loader/logger/epoll notices | `third_party/macos-notices/` | original notices from the pinned checkouts |

The source tree includes the v8 Windows instruction decoder correction, diagnostic ABI fixes and native helper lifetime/stack fixes used in the prototype. The tiny Android dependency stubs are built from `third_party/adam-drm/stubs/`; they do not contain Apple code.

The native Apple SDK shared libraries are proprietary third-party runtime dependencies. They are **not included here**, and this project does not grant rights to redistribute them. Public download origins, exact filenames and SHA-256 checksums are in `runtimefiles/locks/`. The macOS wrapper executable is also fetched separately and verified against its locked digest. The x64 loader's prebuilt Linux download is locked separately; full patched loader source is included for rebuilding it. Windows uses a native GCC-built loader from the included source.

Build bundles include this notice, license texts, the corresponding source archive, and metadata identifying the source commit. Keep these with distributed LGPL components; retain the ability to replace the dynamic loader libraries. No Apple credentials, cached accounts, ADI state, playback plans, subscriber audio, or signed CDN links belong in source/binary bundles.
