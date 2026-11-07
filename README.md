# Apple Music for MyGo Music

[简体中文](./README.zh-CN.md) | English

Plays Apple Music in [MyGo Music](https://github.com/egoist/mygo-music) — with subscriber web sign-in (**no Apple Developer account needed**), personal library & playlists, word-by-word TTML karaoke lyrics, and full-track subscriber playback on macOS via `Music.app` remote control.

> [!NOTE]
> This plugin is not affiliated with or endorsed by Apple Inc. It uses Apple Music's web catalog/library APIs and controls macOS's built-in `Music.app` via AppleScript for full-track FairPlay playback.

## Install

Requires **MyGo Music 0.1.8 or later** and **macOS** (with an Apple Music subscription signed in to the built-in `Music.app` for full-track playback).

Install with the deeplink:

[mygo-music://install-plugin?repo=InkCitrus/mygo-music-apple-music](mygo-music://install-plugin?repo=InkCitrus/mygo-music-apple-music)

Or paste the GitHub URL in **Settings > Plugins > +**:

[https://github.com/InkCitrus/mygo-music-apple-music](https://github.com/InkCitrus/mygo-music-apple-music)

### Setup

1. In **Settings > Plugins > Apple Music**, enable **Allow this plugin to start programs** (only `/usr/bin/osascript` is permitted, used to control `Music.app`).
2. Make sure macOS **Music.app** is signed in to your Apple Music subscriber account. On first playback, approve the macOS Automation prompt allowing MyGo Music / `osascript` to control `Music.app`.
3. To load your personal library, playlists, recommendations, and Apple word-by-word lyrics, click **Sign In** and log in on `music.apple.com` in the window that opens (or paste your `media-user-token` cookie into the optional setting).

## Signing In

No Apple Developer account or MusicKit key is required. When you click **Sign In**, the plugin opens `https://music.apple.com` inside MyGo Music's sign-in window and captures your `media-user-token` subscriber session cookie locally. Your storefront region (e.g. `cn`, `us`, `jp`) is detected automatically and can also be overridden in plugin settings.

Signing out clears the stored session from your machine.

## What Works

- **Signed out**: Catalog search & search suggestions, Home & Charts (`Top Songs`, `Top Albums`, `Top Playlists`), albums, artists, editorial playlists, and synced lyrics via LRCLIB.
- **Signed in**: Personal library playlists (`p.*`), creating playlists & adding tracks, Liked Songs, Saved Albums, Recently Played, personalized Home recommendations, liking/favoriting tracks, saving albums, and Apple Music word-by-word TTML syllable lyrics (with translations).
- **Full-track playback (macOS)**: Seamless remote control of macOS `Music.app` (`play`, `pause`, `resume`, `seek`, `volume`, queue progression, and **AirPlay speaker switching**). Library tracks start instantaneously via `Music.app` database lookup; non-library catalog tracks open directly via `music://` deep-link while keeping window focus on MyGo Music.
- **Localization**: English and Simplified Chinese (`zh-CN`).

## How It Plays

Commercial Apple Music streams are encrypted with Apple FairPlay Streaming DRM, which third-party runtimes cannot decrypt directly. Like MyGo Music's Spotify remote playback architecture, this plugin declares `"playback": "remote"` and drives macOS's native `Music.app` in the background via `/usr/bin/osascript` (`host.spawn`), giving you genuine lossless/high-quality subscriber audio and native AirPlay output while browsing, searching, queueing, and reading karaoke lyrics inside MyGo Music.

## Lyrics

Fetched from Apple Music's `/syllable-lyrics` and `/lyrics` TTML endpoints (supporting word-by-word karaoke timing and translations) when signed in, with automatic fallback to [LRCLIB](https://lrclib.net).

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

[MIT](./LICENSE)
