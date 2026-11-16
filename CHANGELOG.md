# Changelog

## 1.0.0

Desktop playback now uses Apple Music Native Core on macOS ARM64, Windows x64 and Linux x64. The plugin no longer drives Music.app or a browser. Catalog/library features and lyrics remain in the plugin; native authorization, ALAC decoding and audio output live in the independent core.

Account connection is attributed to MyGo Music. The macOS native window keeps credentials, verification, progress and manual retry in one window. Account text follows the host language, with English and Simplified Chinese resources.

This is a breaking playback-backend update. Sign out of the old web session and connect once through the native account window. An active subscription is required. The first connection downloads checksum-pinned runtime dependencies separately. Existing Music.app and browser sessions are not migrated.

- Full playback selects ALAC; `hires` chooses the highest available variant and `lossless` chooses up to 48 kHz.
- Play, pause/resume, seek, mute/volume, library-to-catalog mapping and state polling share one native interface.
- Output follows system audio settings. Source quality is reported separately from system output; exclusive and bit-perfect output are not implemented/verified.
- macOS Intel, Windows/Linux ARM64, radio, uploaded-only tracks, AirPlay enumeration and gapless cross-track output are not supported.
- Supported systems: macOS 14+ on Apple Silicon; Windows x64; Linux x64 with glibc 2.38+, ALSA/PulseAudio and zenity or kdialog for sign-in.

Validation: 313 plugin checks, native builds and portable core tests passed on all three operating systems. The extracted core and direct Go example passed real-account muted ALAC 24-bit/96 kHz playback and transport checks on macOS. Windows/Linux real-account playback passed in the preceding prototype; the complete new packages still need target-system real-account regression.
