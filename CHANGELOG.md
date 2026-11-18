# Changelog

## 1.1.0

- Play six Apple Music live stations through TuneIn's AAC and HE-AAC broadcasts. The core verifies the first audio segment before MyGo changes its queue.
- Choose High Quality (AAC 256 kbps), Lossless (up to 48 kHz), or the highest available lossless quality for songs.
- Wait for audio output before starting the playback clock. Switching to a prepared next song reuses its buffered startup audio.
- Ignore seek and song-favorite requests for live streams. The plugin supplies live playback metadata to MyGo. The live indicator and dedicated controls require support in the MyGo app.
- Bundle Apple Music Native Core 0.2.0 for macOS ARM64, Windows x64, and Linux x64.

## 1.0.4

Start catalog songs without waiting for a second metadata lookup. Native Core 0.1.4 can prepare the beginning of the next queued song while the current song is playing, then reuse it on a matching skip or queue advance. The host still decides what plays next.

Choose the Apple Music quality in the plugin's native settings dropdown: highest available lossless or lossless up to 48 kHz. A new choice applies from the next song; seeking keeps the current quality.

## 1.0.3

Reject unsupported live stations and empty or non-song station feeds before MyGo replaces its queue. Remove the old fallback that disguised a station as a zero-duration song. Failed station requests preserve the existing song, playback position and play/pause state; API errors keep their original meaning. Recommended stations that return playable catalog songs continue to work.

Reject direct station playback before starting a new native play request, so it cannot cancel a song whose metadata is still loading. Add English and Simplified Chinese messages for unsupported stations. Native Core remains the exact 0.1.3 release.

## 1.0.2

Fix native catalog playback for HLS playlists that declare FairPlay, PlayReady and Widevine keys together. Other DRM formats no longer overwrite the selected FairPlay key.

Fetch one encrypted segment ahead and retain approximately two seconds of PCM at every source sample rate. This avoids segment-boundary stalls caused by serial network requests and buffers that became shorter at higher sample rates. Stop, seek and track replacement cancel the pending fetch.

The plugin embeds the same platform binaries, native resources and source commit as Native Core 0.1.3. Output-health snapshots are opt-in and contain counters only. The fix was exercised in the installed MyGo application with the actual account and album, including continuous 24-bit/48 kHz playback and transition to 24-bit/96 kHz; the listener confirmed smooth playback. Radio playback remains unsupported.

## 1.0.1

Restore standard macOS Edit commands in the native account window. Password, account and verification-code fields now accept paste (Command-V) and select-all (Command-A), including when password visibility is toggled. Clipboard handling stays with the native text editor. The standalone macOS demo uses the same commands; menu labels follow the English/Simplified Chinese locale.

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
