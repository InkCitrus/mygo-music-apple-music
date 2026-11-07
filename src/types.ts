// ============================================================================
// Host Environment Global Declarations & APIs (internal/plugin/host.go)
// ============================================================================

export interface HostStorage {
  get<T = any>(key: string): T | Promise<T> | undefined;
  set(key: string, value: any): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export interface WebSignInOptions {
  url: string;
  cookiesOf: string;
  until: string[];
  userAgent?: string;
}

export interface WebSignInResult {
  cookie: string;
}

export interface WaitForRedirectOptions {
  port: number;
  path: string;
  timeout?: number;
  page?: string;
}

export interface ProcessHandle {
  pid?: number;
  write(text: string): void;
  closeStdin(): void;
  readLine(): Promise<string | null>;
  errorOutput(): string;
  wait(): Promise<number | void>;
  kill(): void;
}

export interface HostCrypto {
  md5(text: string): string;
  aesEcbEncrypt(key: string, text: string): string;
}

export interface HostSignInPrompt {
  qr?: string;
  text?: string;
}

export interface Host {
  platform: "darwin" | "linux" | "windows" | string;
  arch: "arm64" | "amd64" | "x86" | string;
  dir: string;
  dataDir: string;
  storage: HostStorage;
  language(): "en" | "zh-CN" | string;
  t(text: string): string;
  setting(key: string): string;
  openURL(url: string): void;
  signInPrompt(prompt: HostSignInPrompt): void;
  crypto: HostCrypto;
  removeDataDir(subpath: string): void;
  waitForRedirect(options: WaitForRedirectOptions): Promise<Record<string, string>>;
  webSignIn(options: WebSignInOptions): Promise<WebSignInResult>;
  spawn(command: string, args?: string[]): ProcessHandle;
  _setSetting?(key: string, value: string): void;
}

declare global {
  const host: Host;
}

// ============================================================================
// MyGo Music Core Domain Models (internal/music/music.go)
// ============================================================================

export interface Artist {
  id: string;
  name: string;
  imageUrl?: string;
  following?: boolean;
}

export interface Album {
  id: string;
  name: string;
  imageUrl?: string;
  artists?: Artist[];
  released?: string;
  saved?: boolean;
}

export interface Track {
  id: string;
  source?: string;
  name: string;
  artists: Artist[];
  album: Album;
  duration: number; // in milliseconds
  url?: string;
  unavailable?: boolean;
  showId?: string;
  description?: string;
  published?: string;
}

export interface Page {
  tracks?: Track[];
  more?: boolean;
}

export interface AlbumList {
  albums?: Album[];
  more?: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  imageUrl?: string;
  description?: string;
  owner?: string;
  trackCount?: number;
  mine?: boolean;
  saved?: boolean;
  fixed?: boolean;
  tracks?: Track[];
}

export interface ArtistPage {
  artist: Artist;
  tracks?: Track[];
  albums?: Album[];
}

export interface AlbumPage {
  album: Album;
  tracks?: Track[];
}

export interface Account {
  id: string;
  name: string;
  imageUrl?: string;
  page?: string;
}

export type SearchKind = "tracks" | "albums" | "artists" | "playlists" | "shows";

export interface SearchResult {
  tracks?: Track[];
  albums?: Album[];
  artists?: Artist[];
  playlists?: Playlist[];
  shows?: Show[];
  more?: boolean;
}

export interface Show {
  id: string;
  name: string;
  imageUrl?: string;
  description?: string;
  publisher?: string;
  publisherPage?: string;
  episodeCount?: number;
  subscribed?: boolean;
}

export interface ShowPage {
  show: Show;
  episodes?: Track[];
  more?: boolean;
}

export interface Station {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
}

export interface Comment {
  id: string;
  author: string;
  avatarUrl?: string;
  text: string;
  time?: number;
  likes?: number;
  liked?: boolean;
}

export interface CommentPage {
  comments?: Comment[];
  total?: number;
  more?: boolean;
}

export interface Link {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  page: string;
}

export interface Section {
  title?: string;
  kind?: string;
  items?: any[];
  tracks?: Track[];
  albums?: Album[];
  artists?: Artist[];
  playlists?: Playlist[];
  shows?: Show[];
  stations?: Station[];
  links?: Link[];
  morePage?: string;
  empty?: string;
  pageTitle?: string;
  subtitle?: string;
}

export interface Browse {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  description?: string;
  sections?: Section[];
}

export type StreamType = "mp3" | "flac" | "ogg" | "wav" | "m4a" | "aac";

export interface Stream {
  url: string;
  type: StreamType;
  quality?: "standard" | "high" | "lossless" | string;
  bitRate?: number;
  size?: number;
  peak?: number;
  gain?: number;
  headers?: Record<string, string>;
}

export interface Device {
  id: string;
  name: string;
  active?: boolean;
}

export interface RemoteState {
  playing: boolean;
  trackId?: string;
  position: number; // milliseconds
  duration: number; // milliseconds
  volume: number;   // 0..100
  device?: string;
}

export interface LyricWord {
  start: number; // ms
  end: number;   // ms
  text: string;
}

export interface LyricLine {
  start: number; // ms
  end?: number;  // ms
  text?: string;
  translation?: string;
  words?: LyricWord[];
}

export interface Lyrics {
  lrc?: string;
  translation?: string;
  lines?: LyricLine[];
}

// ============================================================================
// Standard Error Handling (internal/plugin/plugin.go)
// ============================================================================

export type ErrorCode = "signIn" | "setup" | "unavailable" | "unsupported";

export interface PluginError extends Error {
  code: ErrorCode;
}

export function fail(code: ErrorCode, message?: string): PluginError {
  const err = new Error(message || code) as PluginError;
  err.code = code;
  return err;
}

// ============================================================================
// Apple Music API Internal Models
// ============================================================================

export interface AppleArtwork {
  width?: number;
  height?: number;
  url: string;
  bgColor?: string;
  textColor1?: string;
}

export interface ApplePreview {
  url: string;
}

export interface AppleSongAttributes {
  name: string;
  artistName: string;
  albumName: string;
  durationInMillis: number;
  url?: string;
  trackNumber?: number;
  discNumber?: number;
  releaseDate?: string;
  artwork?: AppleArtwork;
  previews?: ApplePreview[];
  contentRating?: "explicit" | "clean";
  isrc?: string;
  playParams?: {
    id?: string;
    kind?: string;
    catalogId?: string;
    isLibrary?: boolean;
  };
}

export interface AppleAlbumAttributes {
  name: string;
  artistName: string;
  artwork?: AppleArtwork;
  trackCount: number;
  releaseDate?: string;
  editorialNotes?: { short?: string; standard?: string };
  url?: string;
}

export interface AppleArtistAttributes {
  name: string;
  artwork?: AppleArtwork;
  url?: string;
  genreNames?: string[];
}

export interface ApplePlaylistAttributes {
  name: string;
  curatorName?: string;
  description?: { short?: string; standard?: string };
  artwork?: AppleArtwork;
  trackCount?: number;
  url?: string;
  canEdit?: boolean;
}

export interface AppleResource<T = any> {
  id: string;
  type: string;
  href?: string;
  attributes?: T;
  relationships?: {
    tracks?: { data: AppleResource<AppleSongAttributes>[]; next?: string };
    albums?: { data: AppleResource<AppleAlbumAttributes>[] };
    artists?: { data: AppleResource<AppleArtistAttributes>[] };
    catalog?: { data: AppleResource<any>[] };
  };
  views?: {
    "top-songs"?: { data: AppleResource<AppleSongAttributes>[] };
    "full-albums"?: { data: AppleResource<AppleAlbumAttributes>[] };
  };
}
