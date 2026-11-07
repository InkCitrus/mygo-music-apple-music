import {
  Account,
  AlbumList,
  AlbumPage,
  ArtistPage,
  Browse,
  Device,
  fail,
  Lyrics,
  Page,
  Playlist,
  RemoteState,
  SearchKind,
  SearchResult,
  Stream,
  Track,
} from "./types.js";
import {
  CachedTrackMeta,
  executeRemoteDevices,
  executeRemotePause,
  executeRemotePlay,
  executeRemoteResume,
  executeRemoteSeek,
  executeRemoteState,
  executeRemoteUse,
  executeRemoteVolume,
  parseAppleTTML,
  resetRemoteSession,
} from "./apple_music_remote.js";

export * from "./types.js";
export {
  buildDevicesScript,
  buildPauseScript,
  buildPlayScript,
  buildResumeScript,
  buildSeekScript,
  buildSelectDeviceScript,
  buildStateScript,
  buildVolumeScript,
  escapeAppleScriptString,
  parseAppleTTML,
  parseTtmlTimestamp,
  resetRemoteSession,
  toMusicAppUrl,
} from "./apple_music_remote.js";

const DEFAULT_DEV_TOKEN =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw";

const AMP_API_BASE = "https://amp-api.music.apple.com/v1";
const TRACK_CACHE_LIMIT = 2000;
const trackMetaCache = new Map<string, CachedTrackMeta>();
const PLUGIN_ERROR_CODES = new Set(["signIn", "setup", "unavailable", "unsupported"]);

function isPluginError(err: any): boolean {
  return Boolean(err && typeof err.code === "string" && PLUGIN_ERROR_CODES.has(err.code));
}

function rememberTrackMeta(meta: CachedTrackMeta): void {
  if (!meta.id) return;
  if (trackMetaCache.size >= TRACK_CACHE_LIMIT && !trackMetaCache.has(meta.id)) {
    const oldest = trackMetaCache.keys().next().value;
    if (oldest !== undefined) trackMetaCache.delete(oldest);
  }
  trackMetaCache.set(meta.id, meta);
  if (meta.catalogId && meta.catalogId !== meta.id) {
    trackMetaCache.set(meta.catalogId, meta);
  }
}

function tr(text: string): string {
  return typeof host !== "undefined" && typeof host.t === "function" ? host.t(text) : text;
}

function parseJwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const jsonStr =
      typeof atob === "function"
        ? atob(b64)
        : typeof Buffer !== "undefined"
          ? Buffer.from(b64, "base64").toString("utf-8")
          : "";
    if (!jsonStr) return null;
    const payload = JSON.parse(jsonStr);
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function extractCookieMediaUserToken(cookie?: string | null): string {
  if (!cookie || typeof cookie !== "string") return "";
  const match = cookie.match(/(?:^|;\s*)media-user-token=([^;]+)/);
  if (!match || !match[1]) return "";
  return match[1].trim().replace(/^"|"$/g, "").trim();
}

function cleanMediaUserToken(raw?: string | null): string {
  if (!raw || typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";
  if (s.includes("media-user-token=") || s.includes(";")) {
    return extractCookieMediaUserToken(s);
  }
  return s.replace(/^"|"$/g, "").trim();
}

async function getStoredMediaUserToken(): Promise<string> {
  if (typeof host !== "undefined") {
    if (typeof host.setting === "function") {
      const fromSetting = cleanMediaUserToken(host.setting("mediaUserToken"));
      if (fromSetting) return fromSetting;
    }
    if (host.storage) {
      try {
        const auth = await host.storage.get<any>("auth");
        const fromStorage = cleanMediaUserToken(auth?.mediaUserToken);
        if (fromStorage) return fromStorage;
      } catch {
        // Ignore storage read errors
      }
    }
  }
  return "";
}

export function formatArtworkUrl(url?: string, size = 600): string | undefined {
  if (!url) return undefined;
  return url
    .replace("{w}x{h}", `${size}x${size}`)
    .replace("{w}", String(size))
    .replace("{h}", String(size));
}

function extractAlbumIdFromUrl(url?: string): string | undefined {
  if (!url || typeof url !== "string") return undefined;
  const m = url.match(/\/album\/[^/?#]+\/(\d+)/);
  return m?.[1];
}

export function mapTrack(item: any): any {
  const attr = item?.attributes || {};
  const id = String(item?.id ?? "");
  const catalogId: string | undefined =
    attr.playParams?.catalogId ||
    item?.relationships?.catalog?.data?.[0]?.id ||
    (/^\d+$/.test(id) ? id : undefined);
  const albumId =
    item?.relationships?.albums?.data?.[0]?.id ||
    extractAlbumIdFromUrl(attr.url) ||
    attr.albumName ||
    "";
  const artistId =
    item?.relationships?.artists?.data?.[0]?.id || attr.artistName || "";
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  const durationMs = Math.max(0, Math.round(Number(attr.durationInMillis) || 0));

  if (id && attr.name) {
    rememberTrackMeta({
      id,
      catalogId,
      name: String(attr.name),
      artistName: String(attr.artistName || ""),
      albumName: String(attr.albumName || ""),
      albumId: String(albumId || ""),
      durationMs,
      url: attr.url,
      isrc: attr.isrc,
    });
  }

  return {
    id,
    name: attr.name,
    title: attr.name,
    artist: attr.artistName,
    artists: [{ id: String(artistId), name: attr.artistName }],
    album: {
      id: String(albumId),
      name: attr.albumName,
      title: attr.albumName,
      imageUrl,
    },
    artwork: imageUrl,
    imageUrl,
    duration: durationMs,
    durationInMillis: durationMs,
    trackNumber: attr.trackNumber,
    discNumber: attr.discNumber,
    isrc: attr.isrc,
    explicit: attr.contentRating === "explicit",
    url: attr.url || undefined,
  };
}

export function mapAlbum(item: any): any {
  const attr = item?.attributes || {};
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  const artistId =
    item?.relationships?.artists?.data?.[0]?.id || attr.artistName || "";
  return {
    id: String(item?.id ?? ""),
    name: attr.name,
    title: attr.name,
    artist: attr.artistName,
    artists: attr.artistName ? [{ id: String(artistId), name: attr.artistName }] : [],
    artwork: imageUrl,
    imageUrl,
    trackCount: attr.trackCount,
    year: attr.releaseDate ? parseInt(attr.releaseDate.split("-")[0], 10) : undefined,
    released: attr.releaseDate,
    description: attr.editorialNotes?.short || attr.editorialNotes?.standard,
    url: attr.url,
  };
}

export function mapArtist(item: any): any {
  const attr = item?.attributes || {};
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  return {
    id: String(item?.id ?? ""),
    name: attr.name,
    artwork: imageUrl,
    imageUrl,
    url: attr.url,
  };
}

export function mapPlaylist(item: any): any {
  const attr = item?.attributes || {};
  const id = String(item?.id ?? "");
  const isLibrary = id.startsWith("p.") || item?.type === "library-playlists";
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  return {
    id,
    name: attr.name,
    title: attr.name,
    artwork: imageUrl,
    imageUrl,
    description:
      attr.description?.short ||
      attr.description?.standard ||
      attr.editorialNotes?.short ||
      attr.editorialNotes?.standard,
    owner: attr.curatorName,
    curator: attr.curatorName,
    trackCount: attr.trackCount,
    mine: isLibrary ? Boolean(attr.canEdit ?? true) : false,
    saved: isLibrary ? !Boolean(attr.canEdit ?? true) : undefined,
    url: attr.url,
  };
}

export async function getDeveloperToken(): Promise<string> {
  if (typeof host !== "undefined" && host.storage) {
    try {
      const cached = await host.storage.get<string>("developer_token");
      const cachedExp = await host.storage.get<number>("developer_token_exp");
      if (cached && cachedExp && Date.now() < cachedExp - 86400000) {
        return cached;
      }
    } catch (_) {
      // Storage read error fallback
    }
  }

  try {
    const htmlRes = await fetch("https://music.apple.com/us/browse", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
      },
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const scriptMatch = html.match(/src="(\/assets\/index[~-][a-zA-Z0-9_-]+\.js)"/);
      if (scriptMatch) {
        const jsUrl = `https://music.apple.com${scriptMatch[1]}`;
        const jsRes = await fetch(jsUrl);
        if (jsRes.ok) {
          const jsText = await jsRes.text();
          const tokenMatch = jsText.match(
            /eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/
          );
          if (tokenMatch) {
            const token = tokenMatch[0];
            const exp = parseJwtExp(token);
            if (typeof host !== "undefined" && host.storage) {
              try {
                await host.storage.set("developer_token", token);
                if (exp) {
                  await host.storage.set("developer_token_exp", exp);
                }
              } catch (_) {
                // Storage write error fallback
              }
            }
            return token;
          }
        }
      }
    }
  } catch (_) {
    // Dynamic harvesting failed, continue to fallback
  }

  return DEFAULT_DEV_TOKEN;
}

export async function getStorefront(): Promise<string> {
  if (typeof host !== "undefined") {
    if (host.setting) {
      const rawSetting = host.setting("storefront");
      const settingSf =
        typeof rawSetting === "string" ? rawSetting.trim().toLowerCase() : "";
      if (settingSf) {
        return settingSf;
      }
    }

    if (host.storage) {
      try {
        const auth = await host.storage.get<any>("auth");
        if (auth && typeof auth.storefront === "string") {
          const authSf = auth.storefront.trim().toLowerCase();
          if (authSf) {
            return authSf;
          }
        }
      } catch (_) {
        // Storage access error fallback
      }
    }

    if (host.language && host.language() === "zh-CN") {
      return "cn";
    }
  }
  return "us";
}

async function requestApi(
  endpoint: string,
  options: RequestInit & { requireAuth?: boolean } = {}
): Promise<any> {
  const { requireAuth = false, ...fetchOpts } = options;
  const mediaUserToken = await getStoredMediaUserToken();
  if (requireAuth && !mediaUserToken) {
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }

  const devToken = await getDeveloperToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${devToken}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    Accept: "application/json",
    ...((fetchOpts.headers as Record<string, string>) || {}),
  };

  if (mediaUserToken) {
    headers["Music-User-Token"] = mediaUserToken;
  }

  const url = endpoint.startsWith("http") ? endpoint : `${AMP_API_BASE}${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, { ...fetchOpts, headers });
  } catch (err: any) {
    if (isPluginError(err)) {
      throw err;
    }
    throw fail("unavailable", tr("Network request failed"));
  }

  if (res.status === 401) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        await host.storage.remove("developer_token");
        await host.storage.remove("developer_token_exp");
      } catch (_) {}
    }
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }

  if (res.status === 403) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        await host.storage.remove("auth");
      } catch (_) {}
    }
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }

  if (res.status === 404) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const detail = errBody.errors?.[0]?.detail || res.statusText;
    throw fail("unavailable", detail);
  }

  if (res.status === 204 || res.status === 202) {
    const text = await res.text().catch(() => "");
    return text ? JSON.parse(text) : {};
  }

  return res.json();
}

async function resolveTrackMeta(id: string): Promise<CachedTrackMeta> {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }

  const cached = trackMetaCache.get(cleanId);
  if (cached && cached.name) {
    return cached;
  }

  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";

  if (cleanId.startsWith("i.")) {
    const json = await requestApi(`/me/library/songs/${encodeURIComponent(cleanId)}?l=${lang}`, {
      requireAuth: true,
    });
    const song = json.data?.[0];
    if (!song) {
      throw fail("unavailable", tr("This track is unavailable for streaming"));
    }
    mapTrack(song);
    const resolved = trackMetaCache.get(cleanId);
    if (resolved) return resolved;
  }

  const json = await requestApi(`/catalog/${sf}/songs/${encodeURIComponent(cleanId)}?l=${lang}`);
  const song = json.data?.[0];
  if (!song) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  mapTrack(song);
  const resolved = trackMetaCache.get(cleanId);
  if (!resolved) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  return resolved;
}

// ============================================================================
// Catalog & Discovery Hooks
// ============================================================================

export async function search(options: {
  query: string;
  kind?: SearchKind;
  offset?: number;
  limit?: number;
}): Promise<SearchResult> {
  const {
    query: rawQuery,
    kind = "tracks",
    offset = 0,
    limit: rawLimit,
  } = options || ({} as any);
  const query =
    typeof rawQuery === "string"
      ? rawQuery.trim()
      : rawQuery != null
        ? String(rawQuery).trim()
        : "";
  if (!query) {
    return { [kind]: [], more: false };
  }

  const sf = await getStorefront();
  const typeMap: Record<string, string> = {
    tracks: "songs",
    albums: "albums",
    artists: "artists",
    playlists: "playlists",
  };
  const appleType = typeMap[kind] || "songs";
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  let limit = 20;
  if (rawLimit !== undefined && rawLimit !== null) {
    const parsedLimit = Number(rawLimit);
    if (!Number.isNaN(parsedLimit)) {
      limit = Math.min(Math.max(Math.floor(parsedLimit), 1), 50);
    }
  }

  const url = `/catalog/${sf}/search?term=${encodeURIComponent(
    query
  )}&types=${appleType}&limit=${limit}&offset=${offset}&l=${lang}`;

  const json = await requestApi(url);
  const resultContainer = json.results?.[appleType];
  const items = resultContainer?.data || [];
  const hasMore = Boolean(resultContainer?.next);

  let mappedItems: any[] = [];
  if (kind === "albums") {
    mappedItems = items.map(mapAlbum);
  } else if (kind === "artists") {
    mappedItems = items.map(mapArtist);
  } else if (kind === "playlists") {
    mappedItems = items.map(mapPlaylist);
  } else {
    mappedItems = items.map(mapTrack);
  }

  return {
    [kind]: mappedItems,
    more: hasMore,
  };
}

export async function suggest(options: { query: string }): Promise<string[]> {
  const { query: rawQuery } = options || ({} as any);
  const query =
    typeof rawQuery === "string"
      ? rawQuery.trim()
      : rawQuery != null
        ? String(rawQuery).trim()
        : "";
  if (!query) {
    return [];
  }

  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const url = `/catalog/${sf}/search/hints?term=${encodeURIComponent(query)}&l=${lang}`;

  const json = await requestApi(url);
  return json.results?.terms || [];
}

export async function home(): Promise<Browse> {
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const url = `/catalog/${sf}/charts?types=songs,albums,playlists&limit=20&l=${lang}`;

  const json = await requestApi(url);
  const charts = json.results || {};
  const sections: any[] = [];

  if (charts.songs?.[0]?.data?.length) {
    const mapped = charts.songs[0].data.map(mapTrack);
    sections.push({
      title: tr("Top Songs"),
      kind: "tracks",
      tracks: mapped,
      items: mapped,
      morePage: "charts-songs",
    });
  }

  if (charts.playlists?.[0]?.data?.length) {
    const mapped = charts.playlists[0].data.map(mapPlaylist);
    sections.push({
      title: tr("Top Playlists"),
      kind: "playlists",
      playlists: mapped,
      items: mapped,
      morePage: "charts-playlists",
    });
  }

  if (charts.albums?.[0]?.data?.length) {
    const mapped = charts.albums[0].data.map(mapAlbum);
    sections.push({
      title: tr("Top Albums"),
      kind: "albums",
      albums: mapped,
      items: mapped,
      morePage: "charts-albums",
    });
  }

  return {
    title: tr("Home"),
    sections,
  };
}

export async function browse(options?: { page?: string; id?: string }): Promise<Browse> {
  const page = options?.page || options?.id || "charts";
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";

  if (page === "charts" || page === "browse" || page === "home") {
    return home();
  }

  if (page === "recent" || page === "library") {
    const recentTracks = await recent();
    return {
      title: tr("Recently Played"),
      sections: [
        {
          title: tr("Recently Played"),
          kind: "tracks",
          tracks: recentTracks,
          items: recentTracks,
        },
      ],
    };
  }

  if (page === "charts-songs") {
    const json = await requestApi(`/catalog/${sf}/charts?types=songs&limit=50&l=${lang}`);
    const songs = json.results?.songs?.[0]?.data || [];
    const mapped = songs.map(mapTrack);
    return {
      title: tr("Top Songs"),
      sections: [
        {
          title: tr("Top Songs"),
          kind: "tracks",
          tracks: mapped,
          items: mapped,
        },
      ],
    };
  }

  if (page === "charts-albums") {
    const json = await requestApi(`/catalog/${sf}/charts?types=albums&limit=50&l=${lang}`);
    const albums = json.results?.albums?.[0]?.data || [];
    const mapped = albums.map(mapAlbum);
    return {
      title: tr("Top Albums"),
      sections: [
        {
          title: tr("Top Albums"),
          kind: "albums",
          albums: mapped,
          items: mapped,
        },
      ],
    };
  }

  if (page === "charts-playlists") {
    const json = await requestApi(`/catalog/${sf}/charts?types=playlists&limit=50&l=${lang}`);
    const playlistsData = json.results?.playlists?.[0]?.data || [];
    const mapped = playlistsData.map(mapPlaylist);
    return {
      title: tr("Top Playlists"),
      sections: [
        {
          title: tr("Top Playlists"),
          kind: "playlists",
          playlists: mapped,
          items: mapped,
        },
      ],
    };
  }

  throw fail("unavailable", `Unknown browse page: ${page}`);
}

export async function album(options: { id: string }): Promise<AlbumPage> {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Album id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const endpoint = id.startsWith("l.")
    ? `/me/library/albums/${encodeURIComponent(id)}?include=tracks&l=${lang}`
    : `/catalog/${sf}/albums/${encodeURIComponent(id)}?l=${lang}`;
  const json = await requestApi(endpoint, { requireAuth: id.startsWith("l.") });
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Album not found"));
  }

  const alb = mapAlbum(item);
  const trackItems = item.relationships?.tracks?.data || [];
  const tracks = trackItems.map(mapTrack);

  return {
    album: alb,
    tracks,
  };
}

export async function artist(options: { id: string }): Promise<ArtistPage> {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Artist id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/catalog/${sf}/artists/${encodeURIComponent(id)}?views=top-songs,full-albums&l=${lang}`
  );
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Artist not found"));
  }

  const art = mapArtist(item);
  const topSongItems = item.views?.["top-songs"]?.data || [];
  const albumItems = item.views?.["full-albums"]?.data || [];

  return {
    artist: art,
    tracks: topSongItems.map(mapTrack),
    albums: albumItems.map(mapAlbum),
  };
}

// ============================================================================
// Subscriber Library & Playlists Hooks
// ============================================================================

export async function playlists(): Promise<Playlist[]> {
  const token = await getStoredMediaUserToken();
  if (!token) return [];
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(`/me/library/playlists?limit=100&l=${lang}`, {
    requireAuth: true,
  });
  const items = json.data || [];
  return items.map(mapPlaylist);
}

export async function playlist(options: { id: string }): Promise<Playlist> {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Playlist id required");
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";

  if (id.startsWith("p.")) {
    const json = await requestApi(
      `/me/library/playlists/${encodeURIComponent(id)}?include=tracks&l=${lang}`,
      { requireAuth: true }
    );
    const item = json.data?.[0];
    if (!item) {
      throw fail("unavailable", tr("Playlist not found"));
    }
    const pl = mapPlaylist(item);
    const trackItems = [...(item.relationships?.tracks?.data || [])];
    let nextUrl: string | undefined = item.relationships?.tracks?.next;
    let pages = 0;
    while (nextUrl && pages < 5) {
      pages++;
      const cleanNext = nextUrl.replace(/^\/v1/, "");
      const moreJson = await requestApi(cleanNext, { requireAuth: true }).catch(() => null);
      if (!moreJson?.data?.length) break;
      trackItems.push(...moreJson.data);
      nextUrl = moreJson.next;
    }
    pl.tracks = trackItems.map(mapTrack);
    pl.trackCount = pl.tracks.length;
    return pl;
  }

  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/playlists/${encodeURIComponent(id)}?l=${lang}`);
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Playlist not found"));
  }

  const pl = mapPlaylist(item);
  const trackItems = item.relationships?.tracks?.data || [];
  pl.tracks = trackItems.map(mapTrack);

  return pl;
}

export async function createPlaylist(options: { name: string }): Promise<Playlist> {
  const name = String(options?.name || "").trim();
  if (!name) throw fail("unavailable", "Playlist name required");
  const json = await requestApi("/me/library/playlists", {
    method: "POST",
    requireAuth: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attributes: { name } }),
  });
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Failed to load playlist"));
  }
  const pl = mapPlaylist(item);
  pl.tracks = [];
  pl.trackCount = 0;
  pl.mine = true;
  return pl;
}

export async function addToPlaylist(options: {
  id: string;
  trackIds: string[];
}): Promise<void> {
  const { id, trackIds } = options || ({} as any);
  if (!id || !Array.isArray(trackIds) || trackIds.length === 0) return;
  const data = trackIds.map((tid) => ({
    id: String(tid),
    type: String(tid).startsWith("i.") ? "library-songs" : "songs",
  }));
  await requestApi(`/me/library/playlists/${encodeURIComponent(id)}/tracks`, {
    method: "POST",
    requireAuth: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
}

export async function liked(options?: { offset?: number }): Promise<Page> {
  const offset = Math.max(0, Number(options?.offset) || 0);
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/library/songs?limit=100&offset=${offset}&l=${lang}`,
    { requireAuth: true }
  );
  const items = json.data || [];
  return {
    tracks: items.map(mapTrack),
    more: Boolean(json.next),
  };
}

export async function savedAlbums(options?: { offset?: number }): Promise<AlbumList> {
  const offset = Math.max(0, Number(options?.offset) || 0);
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/library/albums?limit=50&offset=${offset}&l=${lang}`,
    { requireAuth: true }
  );
  const items = json.data || [];
  return {
    albums: items.map(mapAlbum),
    more: Boolean(json.next),
  };
}

export async function like(options: { id: string; on: boolean }): Promise<void> {
  const id = String(options?.id || "").trim();
  if (!id) return;
  const on = Boolean(options?.on);
  if (on) {
    if (!id.startsWith("i.")) {
      await requestApi(`/me/library?ids[songs]=${encodeURIComponent(id)}`, {
        method: "POST",
        requireAuth: true,
      }).catch(() => {});
    }
    const ratingPath = id.startsWith("i.")
      ? `/me/ratings/library-songs/${encodeURIComponent(id)}`
      : `/me/ratings/songs/${encodeURIComponent(id)}`;
    await requestApi(ratingPath, {
      method: "PUT",
      requireAuth: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "rating", attributes: { value: 1 } }),
    });
  } else {
    const ratingPath = id.startsWith("i.")
      ? `/me/ratings/library-songs/${encodeURIComponent(id)}`
      : `/me/ratings/songs/${encodeURIComponent(id)}`;
    await requestApi(ratingPath, {
      method: "DELETE",
      requireAuth: true,
    }).catch(() => {});
  }
}

export async function isLiked(options: { ids: string[] }): Promise<Record<string, boolean>> {
  const ids = Array.isArray(options?.ids) ? options.ids.filter(Boolean) : [];
  const out: Record<string, boolean> = {};
  for (const id of ids) out[id] = false;
  if (ids.length === 0) return out;

  const token = await getStoredMediaUserToken();
  if (!token) return out;

  const catalogIds = ids.filter((x) => !x.startsWith("i."));
  if (catalogIds.length > 0) {
    try {
      const json = await requestApi(
        `/me/ratings/songs?ids=${catalogIds.map(encodeURIComponent).join(",")}`,
        { requireAuth: true }
      );
      for (const r of json.data || []) {
        if (r?.id && r?.attributes?.value === 1) {
          out[String(r.id)] = true;
        }
      }
    } catch {
      // Non-fatal
    }
  }
  return out;
}

export async function saveAlbum(options: { id: string; on: boolean }): Promise<void> {
  const id = String(options?.id || "").trim();
  if (!id) return;
  if (options?.on) {
    await requestApi(`/me/library?ids[albums]=${encodeURIComponent(id)}`, {
      method: "POST",
      requireAuth: true,
    });
  }
}

export async function played(options: { id: string }): Promise<void> {
  const id = String(options?.id || "").trim();
  if (!id || typeof host === "undefined" || !host.storage) return;
  try {
    const meta = trackMetaCache.get(id);
    if (!meta) return;
    const prev = (await host.storage.get<any[]>("recent_tracks")) || [];
    const trackObj: Track = {
      id: meta.id,
      name: meta.name,
      artists: [{ id: meta.artistName, name: meta.artistName }],
      album: { id: meta.albumId || meta.albumName, name: meta.albumName },
      duration: meta.durationMs,
      url: meta.url,
    };
    const filtered = prev.filter((t) => t?.id !== id);
    await host.storage.set("recent_tracks", [trackObj, ...filtered].slice(0, 50));
  } catch {
    // Non-fatal
  }
}

export async function recent(): Promise<Track[]> {
  const token = await getStoredMediaUserToken();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  if (token) {
    try {
      const json = await requestApi(`/me/recent/played/tracks?limit=30&l=${lang}`, {
        requireAuth: true,
      });
      if (Array.isArray(json?.data) && json.data.length > 0) {
        return json.data.map(mapTrack);
      }
    } catch {
      // Fall back to local recent list
    }
  }
  if (typeof host !== "undefined" && host.storage) {
    try {
      return (await host.storage.get<Track[]>("recent_tracks")) || [];
    } catch {
      return [];
    }
  }
  return [];
}

// ============================================================================
// Word-by-Word Syllable & Synced Lyrics Hook
// ============================================================================

export async function lyrics(options: { id: string }): Promise<Lyrics> {
  const id = String(options?.id || "").trim();
  if (!id) return {};

  let meta: CachedTrackMeta | null = null;
  try {
    meta = await resolveTrackMeta(id);
  } catch {
    meta = trackMetaCache.get(id) || null;
  }

  const catalogId = meta?.catalogId || (!id.startsWith("i.") ? id : "");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const mediaUserToken = await getStoredMediaUserToken();

  // Tier 1: Apple Music subscriber syllable-lyrics / TTML
  if (mediaUserToken && catalogId) {
    for (const subPath of ["syllable-lyrics", "lyrics"]) {
      try {
        const json = await requestApi(
          `/catalog/${sf}/songs/${encodeURIComponent(catalogId)}/${subPath}?l=${lang}`,
          { requireAuth: true }
        );
        const ttml = json?.data?.[0]?.attributes?.ttml;
        if (typeof ttml === "string" && ttml.includes("<p")) {
          const parsed = parseAppleTTML(ttml);
          if (parsed.lines && parsed.lines.length > 0) {
            return parsed;
          }
        }
      } catch {
        // Try next lyric source
      }
    }
  }

  // Tier 2: LRCLIB open synced lyrics fallback
  if (meta && meta.name) {
    try {
      const params = new URLSearchParams({
        track_name: meta.name,
        artist_name: meta.artistName || "",
        album_name: meta.albumName || "",
        duration: String(Math.max(1, Math.round((meta.durationMs || 0) / 1000))),
      });
      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers: { "User-Agent": "mygo-music-apple-music/0.1.0" },
      });
      if (res.ok) {
        const found = await res.json();
        if (found?.syncedLyrics) {
          return { lrc: String(found.syncedLyrics) };
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return {};
}

// ============================================================================
// Full-Track Remote Playback Hooks ("playback": "remote" via macOS Music.app)
// ============================================================================

export async function remotePlay(options: {
  ids: string[];
  start?: number;
  position?: number;
}): Promise<void> {
  const ids = Array.isArray(options?.ids) ? options.ids : [];
  const start = Math.max(0, Number(options?.start) || 0);
  const position = Math.max(0, Number(options?.position) || 0);
  const targetId = ids[start];
  if (!targetId) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }

  const sf = await getStorefront();
  const meta = await resolveTrackMeta(String(targetId));
  await executeRemotePlay({
    meta,
    storefront: sf,
    positionMs: position,
  });
}

export async function remotePause(): Promise<void> {
  await executeRemotePause();
}

export async function remoteResume(): Promise<void> {
  await executeRemoteResume();
}

export async function remoteSeek(options: { position: number }): Promise<void> {
  await executeRemoteSeek(Number(options?.position) || 0);
}

export async function remoteVolume(options: { percent: number }): Promise<void> {
  await executeRemoteVolume(Number(options?.percent) ?? 100);
}

export async function remoteState(): Promise<RemoteState | null> {
  return executeRemoteState();
}

export async function remoteDevices(): Promise<Device[]> {
  return executeRemoteDevices();
}

export async function remoteUse(options: { deviceId: string }): Promise<void> {
  await executeRemoteUse(String(options?.deviceId || ""));
}

// ============================================================================
// Direct Preview Stream & External Link Helpers (Backward-Compatible)
// ============================================================================

export async function stream(options: { id: string; quality?: string }): Promise<Stream> {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Song id required");
  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/songs/${encodeURIComponent(id)}`);
  const song = json.data?.[0];
  if (!song) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }

  const previewUrl = song.attributes?.previews?.[0]?.url;
  if (!previewUrl) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }

  return {
    url: previewUrl,
    type: "m4a",
    quality: "high",
    headers: {
      Origin: "https://music.apple.com",
      Referer: "https://music.apple.com/",
    },
  };
}

export async function openInAppleMusic(options: {
  id?: string;
  url?: string;
  kind?: string;
  storefront?: string;
}): Promise<{ url: string; opened: boolean }> {
  const opts = options || {};
  let targetUrl = opts.url ? String(opts.url).trim() : "";
  if (targetUrl) {
    if (/^music:\/\//i.test(targetUrl)) {
      targetUrl = targetUrl.replace(/^music:\/\//i, "https://");
    } else if (/^http:\/\//i.test(targetUrl)) {
      targetUrl = targetUrl.replace(/^http:\/\//i, "https://");
    } else if (/^https:\/\//i.test(targetUrl)) {
      targetUrl = targetUrl.replace(/^https:\/\//i, "https://");
    } else {
      targetUrl = `https://${targetUrl}`;
    }
  } else {
    const id = String(opts.id || "").trim();
    const sf = opts.storefront
      ? opts.storefront.trim().toLowerCase()
      : await getStorefront();
    const rawKind = (opts.kind || "song").toLowerCase();
    let kindPath = "song";
    if (rawKind === "album" || rawKind === "albums") {
      kindPath = "album";
    } else if (rawKind === "artist" || rawKind === "artists") {
      kindPath = "artist";
    } else if (rawKind === "playlist" || rawKind === "playlists") {
      kindPath = "playlist";
    }
    targetUrl = id
      ? `https://music.apple.com/${sf}/${kindPath}/${id}`
      : `https://music.apple.com/${sf}`;
  }

  if (typeof host !== "undefined" && typeof host.openURL === "function") {
    host.openURL(targetUrl);
  }

  return { url: targetUrl, opened: true };
}

// ============================================================================
// Authentication & Session Lifecycle (Zero Apple Developer Account Needed)
// ============================================================================

async function verifyAndPersistToken(mediaUserToken: string): Promise<Account> {
  let sfData: any;
  try {
    const devToken = await getDeveloperToken();
    const sfRes = await fetch("https://amp-api.music.apple.com/v1/me/storefront", {
      headers: {
        Authorization: `Bearer ${devToken}`,
        Origin: "https://music.apple.com",
        "Music-User-Token": mediaUserToken,
      },
    });

    if (!sfRes.ok) {
      throw fail("signIn", tr("Failed to retrieve Apple Music storefront"));
    }
    sfData = await sfRes.json();
  } catch (err: any) {
    if (isPluginError(err)) {
      throw err;
    }
    throw fail("signIn", tr("Failed to retrieve Apple Music storefront"));
  }

  const storefront = sfData?.data?.[0]?.id || "us";

  const userAccount: Account = {
    id: `apple-music-${storefront}`,
    name: sfData?.data?.[0]?.attributes?.name
      ? `Apple Music (${sfData.data[0].attributes.name})`
      : tr("Apple Music Subscriber"),
    imageUrl: "",
    page: "library",
  };

  if (typeof host !== "undefined" && host.storage) {
    try {
      await host.storage.set("auth", {
        mediaUserToken,
        storefront,
        account: userAccount,
        signedInAt: Date.now(),
      });
    } catch (_) {
      // Ignore storage errors on write
    }
  }

  return userAccount;
}

export async function signIn(): Promise<Account> {
  if (typeof host !== "undefined" && typeof host.setting === "function") {
    const pastedToken = cleanMediaUserToken(host.setting("mediaUserToken"));
    if (pastedToken) {
      return verifyAndPersistToken(pastedToken);
    }
  }

  if (typeof host === "undefined" || !host.webSignIn) {
    throw fail("unsupported", "webSignIn host API not supported in this environment");
  }

  const browserUA =
    host.platform === "darwin"
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

  let result: any;
  try {
    result = await host.webSignIn({
      url: "https://music.apple.com",
      cookiesOf: "https://music.apple.com",
      until: ["media-user-token"],
      userAgent: browserUA,
    });
  } catch (err: any) {
    if (isPluginError(err)) {
      throw err;
    }
    throw fail(
      "signIn",
      tr("The sign-in window was closed before you finished signing in")
    );
  }

  const cookie = result?.cookie;
  const mediaUserToken = extractCookieMediaUserToken(cookie);
  if (!mediaUserToken) {
    throw fail("signIn", tr("Failed to capture Apple Music subscriber session"));
  }

  return verifyAndPersistToken(mediaUserToken);
}

export async function signOut(): Promise<void> {
  resetRemoteSession();
  if (typeof host !== "undefined" && host.storage) {
    try {
      await host.storage.remove("auth");
    } catch (_) {
      // Safely ignore storage removal errors
    }
  }
}

export async function account(): Promise<Account | null> {
  if (typeof host === "undefined") return null;
  if (host.storage) {
    try {
      const auth = await host.storage.get<any>("auth");
      if (auth && auth.mediaUserToken && auth.account) {
        return auth.account;
      }
    } catch (_) {}
  }
  if (typeof host.setting === "function") {
    const pasted = cleanMediaUserToken(host.setting("mediaUserToken"));
    if (pasted) {
      return {
        id: "apple-music-subscriber",
        name: tr("Apple Music Subscriber"),
        imageUrl: "",
        page: "library",
      };
    }
  }
  return null;
}

export function setSetting(options: { key: string; value: string }): void {
  const { key, value } = options || {};
  if (key === "mediaUserToken" && !cleanMediaUserToken(value)) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        host.storage.remove("auth");
      } catch {}
    }
  }
  if (typeof host !== "undefined" && host._setSetting) {
    host._setSetting(key, value);
  }
}
