import {
  Account,
  Album,
  AlbumList,
  AlbumPage,
  Artist,
  ArtistPage,
  Browse,
  Device,
  fail,
  Link,
  Lyrics,
  Page,
  Playlist,
  RemoteState,
  SearchKind,
  SearchResult,
  Section,
  Station,
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
  formatAudioQualityLabel,
  parseAppleTTML,
  parseAudioQualitySetting,
  readMusicAppAudioQuality,
  resetRemoteSession,
  syncMusicAppAudioQuality,
} from "./apple_music_remote.js";

export * from "./types.js";
export {
  buildDevicesScript,
  buildPauseScript,
  buildPlayScript,
  buildReadAudioQualityScript,
  buildResumeScript,
  buildSeekScript,
  buildSelectDeviceScript,
  buildStateScript,
  buildVolumeScript,
  buildWriteAudioQualityScript,
  escapeAppleScriptString,
  extractCatalogStoreId,
  formatAudioQualityLabel,
  parseAppleTTML,
  parseAudioQualitySetting,
  parseTtmlTimestamp,
  readMusicAppAudioQuality,
  resetRemoteSession,
  syncMusicAppAudioQuality,
  toMusicAppUrl,
  toPlayStoreIdUrl,
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

export function formatArtworkUrl(
  url?: string,
  size = 600,
  crop = "bb"
): string | undefined {
  if (!url) return undefined;
  return url
    .replace("{w}x{h}", `${size}x${size}`)
    .replace("{w}", String(size))
    .replace("{h}", String(size))
    .replace("{c}", crop)
    .replace("-{q}", "")
    .replace("{q}", "80")
    .replace("{f}", "jpg");
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
    throw fail("unavailable", tr("Not found"));
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
  )}&types=${appleType}&limit=${limit}&offset=${offset}&include[songs]=artists,albums&l=${lang}`;

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
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (text?: string) => {
    if (!text) return;
    const clean = text.trim();
    if (!clean) return;
    // Do not include candidate if it is identical to the user's current query
    // (MyGo Music already renders 'Search for "${query}"' as the top action)
    if (clean.toLowerCase() === query.toLowerCase()) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  // 1. Try modern rich Apple Music suggestions endpoint (terms + topResults: songs, artists, albums)
  try {
    const sugUrl = `/catalog/${sf}/search/suggestions?kinds=terms,topResults&types=songs,artists,albums&term=${encodeURIComponent(
      query
    )}&l=${lang}`;
    const sugJson = await requestApi(sugUrl);
    for (const item of sugJson.results?.suggestions || []) {
      if (item.kind === "terms") {
        add(item.displayTerm || item.searchTerm);
      } else if (item.kind === "topResults") {
        const c = item.content;
        const name = c?.attributes?.name;
        const artistName = c?.attributes?.artistName;
        if (name && artistName && !name.toLowerCase().includes(artistName.toLowerCase())) {
          add(`${name} - ${artistName}`);
        } else if (name) {
          add(name);
        }
      }
    }
  } catch {}

  // 2. Legacy hints fallback if suggestions empty
  if (out.length === 0) {
    try {
      const hintUrl = `/catalog/${sf}/search/hints?term=${encodeURIComponent(query)}&l=${lang}`;
      const hintJson = await requestApi(hintUrl);
      for (const t of hintJson.results?.terms || []) {
        add(t);
      }
    } catch {}
  }

  // 3. If candidates are sparse (e.g. CJK 1-term match), augment with top catalog tracks & artists
  if (out.length < 5) {
    try {
      const searchUrl = `/catalog/${sf}/search?term=${encodeURIComponent(
        query
      )}&types=songs,artists&limit=6&l=${lang}`;
      const searchJson = await requestApi(searchUrl);
      for (const s of searchJson.results?.songs?.data || []) {
        const name = s.attributes?.name;
        const artistName = s.attributes?.artistName;
        if (name && artistName) {
          add(`${name} - ${artistName}`);
        } else if (name) {
          add(name);
        }
      }
      for (const a of searchJson.results?.artists?.data || []) {
        add(a.attributes?.name);
      }
    } catch {}
  }

  return out.slice(0, 8);
}

function getLocalTimezoneOffset(date = new Date()): string {
  const offset = date.getTimezoneOffset();
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const sign = offset > 0 ? "-" : "+";
  return `${sign}${hh}:${mm}`;
}

function extractBestArtworkUrl(item: any, size = 600): string | undefined {
  const attr = item?.attributes || {};
  if (attr.artwork?.url) {
    return formatArtworkUrl(attr.artwork.url, size);
  }
  const edArt = attr.editorialArtwork || {};
  for (const key of [
    "subscriptionHero",
    "superHeroWide",
    "superHeroTall",
    "storeFlowcase",
    "brandLogo",
  ]) {
    if (edArt[key]?.url) {
      return formatArtworkUrl(edArt[key].url, size);
    }
  }
  const cards = attr.plainEditorialCard;
  if (cards && typeof cards === "object") {
    const preferredKey = item?.meta?.editorialCard;
    const keys = preferredKey ? [preferredKey, ...Object.keys(cards)] : Object.keys(cards);
    for (const k of keys) {
      const cardArt = cards[k]?.editorialArtwork;
      if (cardArt?.superHeroTall?.url) {
        return formatArtworkUrl(cardArt.superHeroTall.url, size);
      }
      if (cardArt?.superHeroWide?.url) {
        return formatArtworkUrl(cardArt.superHeroWide.url, size);
      }
    }
  }
  return undefined;
}

function resolveResourceRef(ref: any, resourcesMap?: Record<string, Record<string, any>>): any {
  if (!ref) return null;
  if (resourcesMap && ref.type && ref.id != null) {
    const found = resourcesMap[ref.type]?.[String(ref.id)];
    if (found) {
      return ref.meta ? { ...found, meta: { ...(found.meta || {}), ...ref.meta } } : found;
    }
  }
  return ref;
}

function parseEditorialLinkToPage(urlStr?: string): string | null {
  if (!urlStr || typeof urlStr !== "string") return null;
  const fcMatch = urlStr.match(/[?&]fcId=(\d+)/i) || urlStr.match(/\/room\/[^/?#]+\/(\d+)/i);
  if (fcMatch?.[1]) return `room:${fcMatch[1]}`;
  const grpMatch =
    urlStr.match(/viewGrouping\?[^#]*\bid=(\d+)/i) ||
    urlStr.match(/\/grouping\/(?:[^/?#]+\/)?(?:id)?(\d+)/i);
  if (grpMatch?.[1]) return `grouping:${grpMatch[1]}`;
  const curMatch = urlStr.match(/\/curator\/[^/?#]+\/(\d+)/i);
  if (curMatch?.[1]) return `apple-curator:${curMatch[1]}`;
  return null;
}

interface SectionBuckets {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  stations: Station[];
  links: Link[];
  seen: Set<string>;
}

function createSectionBuckets(): SectionBuckets {
  return {
    tracks: [],
    albums: [],
    artists: [],
    playlists: [],
    stations: [],
    links: [],
    seen: new Set<string>(),
  };
}

function collectResourceIntoBuckets(
  rawRef: any,
  buckets: SectionBuckets,
  resourcesMap?: Record<string, Record<string, any>>,
  depth = 0
): void {
  if (!rawRef || depth > 3) return;
  const item = resolveResourceRef(rawRef, resourcesMap);
  if (!item) return;

  const type = String(item.type || rawRef.type || "");
  const id = String(item.id ?? rawRef.id ?? "");

  if (type === "personal-recommendation") {
    const children = item.relationships?.contents?.data || [];
    for (const child of children) {
      collectResourceIntoBuckets(child, buckets, resourcesMap, depth + 1);
    }
    return;
  }

  if (type === "editorial-elements") {
    const contents = item.relationships?.contents?.data || [];
    if (contents.length > 0) {
      for (const child of contents) {
        collectResourceIntoBuckets(child, buckets, resourcesMap, depth + 1);
      }
      return;
    }
    const attr = item.attributes || {};
    const linkPage = parseEditorialLinkToPage(attr.link?.url || attr.url);
    const title = attr.title || attr.name || attr.link?.label;
    if (linkPage && title && !buckets.seen.has(`link:${linkPage}`)) {
      buckets.seen.add(`link:${linkPage}`);
      buckets.links.push({
        title: String(title),
        subtitle: attr.subtitle || attr.designBadge || undefined,
        imageUrl: extractBestArtworkUrl(item, 600),
        page: linkPage,
      });
    }
    return;
  }

  if (!id) return;
  const dedupeKey = `${type}:${id}`;
  if (buckets.seen.has(dedupeKey)) return;

  if (type === "albums") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const alb = mapAlbum(item);
    if (!alb.imageUrl) alb.imageUrl = extractBestArtworkUrl(item, 600);
    buckets.albums.push(alb);
    return;
  }

  if (type === "library-albums") {
    const catalogId =
      item.meta?.catalogIds?.[0] ||
      item.attributes?.playParams?.catalogId ||
      item.relationships?.catalog?.data?.[0]?.id;
    const catAlbum =
      catalogId && resourcesMap?.["albums"]?.[String(catalogId)]
        ? resourcesMap["albums"][String(catalogId)]
        : null;
    if (catAlbum?.attributes?.name) {
      const catKey = `albums:${catAlbum.id}`;
      if (buckets.seen.has(catKey)) return;
      buckets.seen.add(catKey);
      buckets.albums.push(mapAlbum(catAlbum));
      return;
    }
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const alb = mapAlbum(item);
    if (!alb.imageUrl && catAlbum) {
      alb.imageUrl = extractBestArtworkUrl(catAlbum, 600);
    }
    buckets.albums.push(alb);
    return;
  }

  if (type === "playlists") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const pl = mapPlaylist(item);
    if (!pl.imageUrl) pl.imageUrl = extractBestArtworkUrl(item, 600);
    buckets.playlists.push(pl);
    return;
  }

  if (type === "library-playlists") {
    const catalogId =
      item.meta?.catalogIds?.[0] ||
      item.attributes?.playParams?.catalogId ||
      item.relationships?.catalog?.data?.[0]?.id;
    const catPl =
      catalogId && resourcesMap?.["playlists"]?.[String(catalogId)]
        ? resourcesMap["playlists"][String(catalogId)]
        : null;
    if (!item.attributes?.name && catPl?.attributes?.name) {
      const catKey = `playlists:${catPl.id}`;
      if (buckets.seen.has(catKey)) return;
      buckets.seen.add(catKey);
      buckets.playlists.push(mapPlaylist(catPl));
      return;
    }
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const pl = mapPlaylist(item);
    if (!pl.imageUrl && catPl) {
      pl.imageUrl = extractBestArtworkUrl(catPl, 600);
    }
    if (!pl.owner && catPl?.attributes?.curatorName) {
      pl.owner = catPl.attributes.curatorName;
    }
    buckets.playlists.push(pl);
    return;
  }

  if (type === "artists") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const art = mapArtist(item);
    if (!art.imageUrl) art.imageUrl = extractBestArtworkUrl(item, 600);
    buckets.artists.push(art);
    return;
  }

  if (type === "songs" || type === "library-songs") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    buckets.tracks.push(mapTrack(item));
    return;
  }

  if (type === "stations") {
    const attr = item.attributes || {};
    if (!attr.name || attr.isLive === true) return;
    buckets.seen.add(dedupeKey);
    buckets.stations.push({
      id,
      name: String(attr.name),
      description:
        attr.editorialNotes?.short ||
        attr.plainEditorialNotes?.short ||
        attr.editorialNotes?.tagline ||
        undefined,
      imageUrl: extractBestArtworkUrl(item, 600),
    });
    return;
  }

  if (type === "apple-curators" || type === "curators") {
    const attr = item.attributes || {};
    const name = attr.name || attr.plainEditorialNotes?.name;
    if (!name) return;
    const pageTarget = type === "apple-curators" ? `apple-curator:${id}` : `curator:${id}`;
    if (buckets.seen.has(`link:${pageTarget}`)) return;
    buckets.seen.add(`link:${pageTarget}`);
    buckets.links.push({
      title: String(name),
      subtitle:
        attr.plainEditorialNotes?.short ||
        attr.editorialNotes?.short ||
        undefined,
      imageUrl: extractBestArtworkUrl(item, 600),
      page: pageTarget,
    });
    return;
  }

  if (type === "editorial-items" || type === "activities") {
    const attr = item.attributes || {};
    const name =
      attr.name ||
      attr.plainEditorialNotes?.name ||
      attr.plainEditorialNotes?.badge ||
      attr.editorialNotes?.name;
    const linkPage = parseEditorialLinkToPage(attr.url || attr.link?.url);
    if (name && linkPage && !buckets.seen.has(`link:${linkPage}`)) {
      buckets.seen.add(`link:${linkPage}`);
      buckets.links.push({
        title: String(name),
        subtitle: attr.plainEditorialNotes?.short || attr.editorialNotes?.short || undefined,
        imageUrl: extractBestArtworkUrl(item, 600),
        page: linkPage,
      });
    }
  }
}

type BucketKind = "tracks" | "albums" | "artists" | "playlists" | "stations" | "links";

interface SplitSectionEntry {
  section: Section;
  isOverflow: boolean;
  itemKind: BucketKind;
  count: number;
}

function bucketsToSplitEntries(
  title: string,
  buckets: SectionBuckets,
  morePage?: string,
  subtitle?: string
): SplitSectionEntry[] {
  const groups: Array<{
    kind: BucketKind;
    label: string;
    count: number;
    build: (secTitle: string, mp?: string, sub?: string) => Section;
  }> = [];

  if (buckets.tracks.length > 0) {
    groups.push({
      kind: "tracks",
      label: tr("Songs"),
      count: buckets.tracks.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...(sub ? { subtitle: sub } : {}),
        ...(mp ? { morePage: mp } : {}),
        kind: "tracks",
        tracks: buckets.tracks,
        items: buckets.tracks,
      }),
    });
  }
  if (buckets.albums.length > 0) {
    groups.push({
      kind: "albums",
      label: tr("Albums"),
      count: buckets.albums.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...(sub ? { subtitle: sub } : {}),
        ...(mp ? { morePage: mp } : {}),
        kind: "albums",
        albums: buckets.albums,
        items: buckets.albums,
      }),
    });
  }
  if (buckets.artists.length > 0) {
    groups.push({
      kind: "artists",
      label: tr("Artists"),
      count: buckets.artists.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...(sub ? { subtitle: sub } : {}),
        ...(mp ? { morePage: mp } : {}),
        kind: "artists",
        artists: buckets.artists,
        items: buckets.artists,
      }),
    });
  }
  if (buckets.playlists.length > 0) {
    groups.push({
      kind: "playlists",
      label: tr("Playlists"),
      count: buckets.playlists.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...(sub ? { subtitle: sub } : {}),
        ...(mp ? { morePage: mp } : {}),
        kind: "playlists",
        playlists: buckets.playlists,
        items: buckets.playlists,
      }),
    });
  }
  if (buckets.stations.length > 0) {
    groups.push({
      kind: "stations",
      label: tr("Stations"),
      count: buckets.stations.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...(sub ? { subtitle: sub } : {}),
        ...(mp ? { morePage: mp } : {}),
        stations: buckets.stations,
      }),
    });
  }
  if (buckets.links.length > 0) {
    groups.push({
      kind: "links",
      label: tr("Browse"),
      count: buckets.links.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...(sub ? { subtitle: sub } : {}),
        ...(mp ? { morePage: mp } : {}),
        links: buckets.links,
      }),
    });
  }

  if (groups.length === 0) return [];
  if (groups.length === 1) {
    const g = groups[0];
    return [
      {
        section: g.build(title, morePage, subtitle),
        isOverflow: false,
        itemKind: g.kind,
        count: g.count,
      },
    ];
  }

  // MyGo Music renders each media array (albums, playlists, stations, etc.)
  // in its own separate 5-column grid row without sub-headers. Sort by item
  // count descending so the fullest row leads, and give each secondary type
  // its own explicit section header instead of creating untitled blank gaps.
  groups.sort((a, b) => b.count - a.count);

  return groups.map((g, idx) => {
    const isPrimary = idx === 0;
    const secTitle = isPrimary
      ? title
      : title
        ? `${title} · ${g.label}`
        : g.label;
    return {
      section: g.build(secTitle, isPrimary ? morePage : undefined, isPrimary ? subtitle : undefined),
      isOverflow: !isPrimary,
      itemKind: g.kind,
      count: g.count,
    };
  });
}

function consolidateSplitEntries(entries: SplitSectionEntry[]): Section[] {
  const getArrayForKind = (sec: Section, kind: BucketKind): any[] | undefined => {
    switch (kind) {
      case "tracks":
        return sec.tracks;
      case "albums":
        return sec.albums;
      case "artists":
        return sec.artists;
      case "playlists":
        return sec.playlists;
      case "stations":
        return sec.stations;
      case "links":
        return sec.links;
    }
  };

  const setArrayForKind = (sec: Section, kind: BucketKind, arr: any[]) => {
    switch (kind) {
      case "tracks":
        sec.tracks = arr;
        sec.items = arr;
        break;
      case "albums":
        sec.albums = arr;
        sec.items = arr;
        break;
      case "artists":
        sec.artists = arr;
        sec.items = arr;
        break;
      case "playlists":
        sec.playlists = arr;
        sec.items = arr;
        break;
      case "stations":
        sec.stations = arr;
        break;
      case "links":
        sec.links = arr;
        break;
    }
  };

  const preferredKeywords: Record<BucketKind, RegExp> = {
    playlists: /made for you|为你推荐|playlist|歌单/i,
    stations: /station|radio|广播|电台/i,
    albums: /new release|新发行|album|专辑/i,
    tracks: /song|track|歌曲/i,
    artists: /artist|艺人/i,
    links: /mood|genre|browse|浏览/i,
  };

  const absorbed = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.isOverflow || e.count !== 1) continue;
    const srcItems = getArrayForKind(e.section, e.itemKind);
    if (!srcItems || srcItems.length === 0) continue;

    const candidates = entries.filter(
      (cand, idx) => idx !== i && !absorbed.has(idx) && !cand.isOverflow && cand.itemKind === e.itemKind
    );
    if (candidates.length === 0) continue;

    const target =
      candidates.find((c) => preferredKeywords[e.itemKind].test(c.section.title || "")) ||
      candidates[0];
    const dstItems = getArrayForKind(target.section, e.itemKind) || [];
    const keyOf = (obj: any) => String(obj?.id || obj?.page || "");
    const existingKeys = new Set(dstItems.map(keyOf));
    const toPrepend = srcItems.filter((item) => {
      const k = keyOf(item);
      return k && !existingKeys.has(k);
    });
    setArrayForKind(target.section, e.itemKind, [...toPrepend, ...dstItems]);
    target.count = dstItems.length + toPrepend.length;
    absorbed.add(i);
  }

  return entries.filter((_, idx) => !absorbed.has(idx)).map((e) => e.section);
}

function bucketsToSections(
  title: string,
  buckets: SectionBuckets,
  morePage?: string,
  subtitle?: string
): Section[] {
  return bucketsToSplitEntries(title, buckets, morePage, subtitle).map((e) => e.section);
}

function resolveRecommendationTitle(
  rec: any,
  resourcesMap?: Record<string, Record<string, any>>
): { title: string; subtitle?: string } {
  const attr = rec?.attributes || {};
  const directTitle =
    typeof attr.title === "string"
      ? attr.title.trim()
      : String(attr.title?.stringForDisplay || "").trim();
  const reasonText = String(attr.reason?.stringForDisplay || "").trim();

  if (directTitle) {
    return { title: directTitle, subtitle: reasonText || undefined };
  }

  const prefix = String(attr.titleWithoutName?.stringForDisplay || "").trim();
  const primaryRef = rec?.relationships?.["primary-content"]?.data?.[0];
  const primaryRes = resolveResourceRef(primaryRef, resourcesMap);
  const primaryName = String(primaryRes?.attributes?.name || "").trim();

  if (prefix && primaryName) {
    return { title: `${prefix} ${primaryName}`, subtitle: reasonText || undefined };
  }
  if (primaryName) {
    return { title: primaryName, subtitle: reasonText || undefined };
  }
  if (reasonText) {
    return { title: reasonText };
  }
  return { title: tr("Recommended For You") };
}

function parseRecommendationsToSections(json: any, allowMorePage = true): Section[] {
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const resourcesMap: Record<string, Record<string, any>> | undefined = json?.resources;
  const entries: SplitSectionEntry[] = [];

  for (const rawRef of dataRefs) {
    const rec = resolveResourceRef(rawRef, resourcesMap);
    if (!rec) continue;
    const recType = String(rec.type || rawRef.type || "");
    if (recType !== "personal-recommendation") continue;

    const contents = rec.relationships?.contents?.data || [];
    if (!Array.isArray(contents) || contents.length === 0) continue;

    const buckets = createSectionBuckets();
    for (const childRef of contents) {
      collectResourceIntoBuckets(childRef, buckets, resourcesMap, 0);
    }

    const { title, subtitle } = resolveRecommendationTitle(rec, resourcesMap);
    const morePage =
      allowMorePage && rec.id && rec.attributes?.hasSeeAll === true
        ? `reco:${rec.id}`
        : undefined;
    entries.push(...bucketsToSplitEntries(title, buckets, morePage, subtitle));
  }

  return consolidateSplitEntries(entries);
}

async function fetchPersonalizedHome(sf: string, lang: string): Promise<Browse | null> {
  const tz = encodeURIComponent(getLocalTimezoneOffset());
  const listenNowQuery =
    `/me/recommendations?name=listen-now&platform=web&format[resources]=map` +
    `&with=library,social,friendsMix` +
    `&types=activities,albums,apple-curators,artists,curators,editorial-items,library-albums,library-playlists,playlists,songs,stations` +
    `&include[albums]=artists&include[library-playlists]=catalog&include[library-albums]=catalog` +
    `&include[personal-recommendation]=contents,primary-content` +
    `&extend=plainEditorialNotes,plainEditorialCard,editorialArtwork&extend[playlists]=artistNames` +
    `&fields[artists]=name,artwork,url&omit[resource]=autos` +
    `&displayFilter[kind]=MusicCardShelf,MusicCircleCoverShelf,MusicCoverGrid,MusicCoverShelf,MusicHorizontalLockupGrid,MusicNotesHeroShelf,MusicSuperHeroShelf` +
    `&timezone=${tz}&l=${encodeURIComponent(lang)}`;

  try {
    const json = await requestApi(listenNowQuery, { requireAuth: true });
    const sections = parseRecommendationsToSections(json, true);
    if (sections.length > 0) {
      return {
        title: tr("Home"),
        sections,
      };
    }
  } catch (err: any) {
    if (err?.code === "signIn") throw err;
  }

  try {
    const fallbackJson = await requestApi(
      `/me/recommendations?limit=30&timezone=${tz}&l=${encodeURIComponent(lang)}`,
      { requireAuth: true }
    );
    const sections = parseRecommendationsToSections(fallbackJson, true);
    if (sections.length > 0) {
      return {
        title: tr("Home"),
        sections,
      };
    }
  } catch (err: any) {
    if (err?.code === "signIn") throw err;
  }

  return null;
}

async function buildChartsBrowse(sf: string, lang: string, pageTitle = tr("Charts")): Promise<Browse> {
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
    title: pageTitle,
    sections,
  };
}

function parseEditorialGroupingBrowse(json: any, fallbackTitle: string): Browse {
  const resourcesMap: Record<string, Record<string, any>> | undefined = json?.resources;
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const rootGrouping =
    resolveResourceRef(dataRefs[0], resourcesMap) ||
    (resourcesMap?.groupings ? Object.values(resourcesMap.groupings)[0] : null);

  const pageTitle = String(rootGrouping?.attributes?.name || fallbackTitle);
  const sections: Section[] = [];

  const tabRefs = rootGrouping?.relationships?.tabs?.data || [];
  const shelfRefs: any[] = [];
  if (tabRefs.length > 0) {
    for (const tabRef of tabRefs) {
      const tabEl = resolveResourceRef(tabRef, resourcesMap);
      const children = tabEl?.relationships?.children?.data || [];
      shelfRefs.push(...children);
    }
  } else if (rootGrouping?.relationships?.children?.data) {
    shelfRefs.push(...rootGrouping.relationships.children.data);
  }

  for (const shelfRef of shelfRefs) {
    const shelfEl = resolveResourceRef(shelfRef, resourcesMap);
    if (!shelfEl) continue;
    const attr = shelfEl.attributes || {};
    const kind = String(attr.editorialElementKind || "");
    const buckets = createSectionBuckets();

    if (Array.isArray(attr.links) && attr.links.length > 0) {
      for (const lnk of attr.links) {
        const linkPage = parseEditorialLinkToPage(lnk?.url);
        if (linkPage && lnk?.label && !buckets.seen.has(`link:${linkPage}`)) {
          buckets.seen.add(`link:${linkPage}`);
          buckets.links.push({
            title: String(lnk.label),
            page: linkPage,
          });
        }
      }
    }

    const directContents = shelfEl.relationships?.contents?.data || [];
    for (const cRef of directContents) {
      collectResourceIntoBuckets(cRef, buckets, resourcesMap, 0);
    }

    const childElements = shelfEl.relationships?.children?.data || [];
    for (const chRef of childElements) {
      collectResourceIntoBuckets(chRef, buckets, resourcesMap, 0);
    }

    const roomRef = shelfEl.relationships?.room?.data?.[0];
    const morePage = roomRef?.id ? `room:${roomRef.id}` : undefined;
    const shelfTitle =
      attr.title ||
      attr.name ||
      (kind === "316" ? tr("Featured") : "");

    if (!shelfTitle && buckets.links.length === 0 && buckets.albums.length === 0 && buckets.playlists.length === 0) {
      continue;
    }

    sections.push(...bucketsToSections(shelfTitle || tr("Featured"), buckets, morePage));
  }

  return {
    title: pageTitle,
    sections,
  };
}

async function buildRecommendationSeeAllBrowse(recId: string, lang: string): Promise<Browse> {
  const tz = encodeURIComponent(getLocalTimezoneOffset());
  const seeAllUrl =
    `/me/recommendations/${encodeURIComponent(recId)}/view/see-all` +
    `?action=refresh&name=listen-now&platform=web&format[resources]=map` +
    `&include[personal-recommendation]=contents&include[library-playlists]=catalog&include[library-albums]=catalog` +
    `&limit[contents]=100&omit[resource]=autos&with=library,social,friendsMix` +
    `&types=artists,albums,apple-curators,curators,editorial-items,library-albums,library-playlists,playlists,songs,stations` +
    `&timezone=${tz}&l=${encodeURIComponent(lang)}`;

  let json: any = null;
  try {
    json = await requestApi(seeAllUrl, { requireAuth: true });
  } catch (err: any) {
    if (err?.code === "signIn") throw err;
    json = await requestApi(
      `/me/recommendations/${encodeURIComponent(recId)}?l=${encodeURIComponent(lang)}`,
      { requireAuth: true }
    );
  }

  const rootRec = resolveResourceRef(json?.data?.[0], json?.resources);
  const resolvedTitle = rootRec
    ? resolveRecommendationTitle(rootRec, json?.resources).title
    : "";
  const sections = parseRecommendationsToSections(json, false);
  const title = resolvedTitle || sections[0]?.title || tr("Recommended For You");
  if (sections.length === 1) {
    sections[0] = { ...sections[0], title: "" };
  }
  return {
    title,
    sections,
  };
}

async function buildCuratorBrowse(
  sf: string,
  curatorId: string,
  isAppleCurator: boolean,
  lang: string
): Promise<Browse> {
  const resourcePath = isAppleCurator ? "apple-curators" : "curators";
  const json = await requestApi(
    `/catalog/${sf}/${resourcePath}/${encodeURIComponent(curatorId)}?include=playlists&l=${encodeURIComponent(lang)}`
  );
  const item = json?.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Playlist not found"));
  }

  const attr = item.attributes || {};
  const title = String(attr.name || tr("Curator"));
  const desc = attr.editorialNotes?.short || attr.editorialNotes?.standard || undefined;
  const groupingId = item.relationships?.grouping?.data?.[0]?.id;

  if (groupingId) {
    try {
      const grpJson = await requestApi(
        `/editorial/${sf}/groupings/${encodeURIComponent(String(groupingId))}?platform=web&format[resources]=map&omit[resource:artists]=autos&l=${encodeURIComponent(lang)}`
      );
      const grpBrowse = parseEditorialGroupingBrowse(grpJson, title);
      if (grpBrowse.sections && grpBrowse.sections.length > 0) {
        return {
          title,
          description: desc,
          sections: grpBrowse.sections,
        };
      }
    } catch {
      // Fall back to curator's direct playlists
    }
  }

  const playlistItems = item.relationships?.playlists?.data || [];
  const mappedPlaylists = playlistItems.map(mapPlaylist);
  return {
    title,
    description: desc,
    sections:
      mappedPlaylists.length > 0
        ? [
            {
              title: tr("Playlists"),
              kind: "playlists",
              playlists: mappedPlaylists,
              items: mappedPlaylists,
            },
          ]
        : [],
  };
}

async function buildRoomBrowse(sf: string, roomId: string, lang: string): Promise<Browse> {
  const json = await requestApi(
    `/editorial/${sf}/rooms/${encodeURIComponent(roomId)}?platform=web&format[resources]=map&omit[resource:artists]=autos&l=${encodeURIComponent(lang)}`
  );
  const resourcesMap: Record<string, Record<string, any>> | undefined = json?.resources;
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const room =
    resolveResourceRef(dataRefs[0], resourcesMap) ||
    (resourcesMap?.rooms ? Object.values(resourcesMap.rooms)[0] : null);
  if (!room) {
    throw fail("unavailable", `Room not found: ${roomId}`);
  }

  const attr = room.attributes || {};
  const title = String(attr.title || attr.name || tr("Browse"));
  const desc = attr.editorialNotes?.short || attr.plainEditorialNotes?.short || undefined;
  const buckets = createSectionBuckets();
  const contents = room.relationships?.contents?.data || [];
  if (contents.length > 0) {
    for (const ref of contents) {
      collectResourceIntoBuckets(ref, buckets, resourcesMap, 0);
    }
  } else if (resourcesMap) {
    for (const [rType, group] of Object.entries(resourcesMap)) {
      if (rType === "rooms") continue;
      for (const obj of Object.values(group || {})) {
        collectResourceIntoBuckets(obj, buckets, resourcesMap, 0);
      }
    }
  }

  const roomSections = bucketsToSections("", buckets);
  if (roomSections.length === 1) {
    roomSections[0] = { ...roomSections[0], title: "" };
  }
  return {
    title,
    description: desc,
    sections: roomSections,
  };
}

export async function home(): Promise<Browse> {
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const token = await getStoredMediaUserToken();

  if (token) {
    const personalized = await fetchPersonalizedHome(sf, lang);
    if (personalized && personalized.sections && personalized.sections.length > 0) {
      return personalized;
    }
  }

  return buildChartsBrowse(sf, lang, tr("Home"));
}

export function dedupeLibraryAlbums(rawItems: any[], lang = "en"): any[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

  const groups = new Map<string, any[]>();
  for (const item of rawItems) {
    if (item?.type && !String(item.type).includes("album")) {
      continue;
    }
    const catalogId =
      item.relationships?.catalog?.data?.[0]?.id ||
      item.attributes?.playParams?.catalogId;
    const artworkUrl = item.attributes?.artwork?.url || "";
    const artKeyMatch = artworkUrl.match(/\/thumb\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/([^/]+)\/([^/]+)/);
    const artKey = artKeyMatch ? artKeyMatch[2] : (artworkUrl ? artworkUrl.slice(-40) : "");
    const key = catalogId ? `cat:${catalogId}` : (artKey ? `art:${artKey}` : `id:${item.id}`);

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(item);
  }

  const deduped: any[] = [];
  for (const [, items] of groups.entries()) {
    if (items.length === 1) {
      deduped.push(items[0]);
    } else {
      // Pick the best item among duplicate entries:
      // 1. Prefer item with tracks (trackCount > 0)
      const withTracks = items.find((it) => (it.attributes?.trackCount ?? 0) > 0) || items[0];
      const merged = { ...withTracks, attributes: { ...withTracks.attributes } };

      // 2. Localized title selection:
      // If current lang is English or Latin-based, prefer Romanized/English title
      // If current lang is CJK (zh/ja/ko), prefer CJK title
      const isEnglishLang = lang.startsWith("en");
      const enItem = items.find((it) => /[a-z]/i.test(it.attributes?.name || ""));
      const cjkItem = items.find((it) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/i.test(it.attributes?.name || ""));

      if (isEnglishLang && enItem?.attributes?.name) {
        merged.attributes.name = enItem.attributes.name;
      } else if (!isEnglishLang && cjkItem?.attributes?.name) {
        merged.attributes.name = cjkItem.attributes.name;
      }

      deduped.push(merged);
    }
  }

  return deduped;
}

async function buildMyPageBrowse(sf: string, lang: string): Promise<Browse> {
  const token = await getStoredMediaUserToken();
  if (!token) {
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }

  const [acc, allPlaylists] = await Promise.all([
    account().catch(() => null),
    playlists().catch(() => [] as Playlist[]),
  ]);

  const sections: Section[] = [];

  const myPlaylists = allPlaylists.filter((p) => p.mine);
  const displayPlaylists = myPlaylists.length > 0 ? myPlaylists : allPlaylists;
  if (displayPlaylists.length > 0) {
    sections.push({
      title: myPlaylists.length > 0 ? tr("My Playlists") : tr("Playlists"),
      kind: "playlists",
      playlists: displayPlaylists,
      items: displayPlaylists,
    });
  }

  const hasHandle = Boolean(acc?.id && !acc.id.startsWith("apple-music-"));
  const subtitle = hasHandle ? `@${acc!.id}` : undefined;
  const desc = `Apple Music (${sf.toUpperCase()})`;

  return {
    title: acc?.name || tr("Library"),
    subtitle,
    description: desc,
    imageUrl: acc?.imageUrl || undefined,
    sections,
  };
}

const APPLE_MUSIC_LIVE_STATIONS: Station[] = [
  {
    id: "ra.978194965",
    name: "Apple Music 1",
    description: "Live 24/7 • The new music that matters.",
    imageUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/f2/52/f6/f252f662-44e1-8860-73e8-5dab557d3e52/35d45158-76c3-4b9a-9a77-9a44317c1d79.png/600x600sr.jpg",
  },
  {
    id: "ra.1498155548",
    name: "Apple Music Hits",
    description: "The songs you know and love from the '80s, '90s, and 2000s.",
    imageUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/e5/a0/0d/e5a00d47-69b4-a50b-3652-32b00512803b/388fbf1e-627c-4731-90a6-c95691456a7d.png/600x600sr.jpg",
  },
  {
    id: "ra.1498157166",
    name: "Apple Music Country",
    description: "Where country music lives.",
    imageUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/9d/1c/37/9d1c3769-6f7a-ac49-93e5-ca030ef7a8b4/f5383508-ea24-4f51-b0fe-25ba47e9b05c.png/600x600sr.jpg",
  },
  {
    id: "ra.1740613864",
    name: "Apple Music Club",
    description: "The biggest dance and electronic tracks worldwide.",
    imageUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/94/7d/d9/947dd957-8eaa-330b-fc68-07758369b775/88636ba4-0466-4e5a-8b1b-60aebc87040e.png/600x600sr.jpg",
  },
  {
    id: "ra.1740614260",
    name: "Apple Music Chill",
    description: "Laid-back beats, acoustic vibes, and ambient sounds.",
    imageUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/b6/ec/73/b6ec73bd-efae-42d8-bf12-aa59c258d4a7/17b4a2e5-e45f-4bf2-a3c3-37651a24d5ba.png/600x600sr.jpg",
  },
  {
    id: "ra.1740613859",
    name: "Apple Music Música Uno",
    description: "Lo mejor de los ritmos latinos.",
    imageUrl:
      "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/70/a9/6b/70a96bf1-965e-466d-a7b1-21d1d860d5bf/66b04870-83f0-4fc7-bf99-eebdd94ec32d.png/600x600sr.jpg",
  },
];

async function buildAppleBrowse(sf: string, lang: string, pageTitle = tr("Browse")): Promise<Browse> {
  // Method 1: Try editorial groupings amp-api endpoint (standard Apple Music browse endpoint)
  try {
    const grpQuery = `/editorial/${sf}/groupings?name=music&platform=web&format[resources]=map&omit[resource]=autos&l=${encodeURIComponent(
      lang
    )}`;
    const grpJson = await requestApi(grpQuery);
    const parsed = parseEditorialGroupingBrowse(grpJson, pageTitle);
    if (parsed.sections && parsed.sections.length > 0) {
      return { ...parsed, title: pageTitle };
    }
    const rootId = grpJson?.data?.[0]?.id;
    if (rootId && !grpJson?.resources) {
      const detailUrl = `/editorial/${sf}/groupings/${encodeURIComponent(
        rootId
      )}?platform=web&format[resources]=map&omit[resource]=autos&l=${encodeURIComponent(lang)}`;
      const detailJson = await requestApi(detailUrl);
      const detailParsed = parseEditorialGroupingBrowse(detailJson, pageTitle);
      if (detailParsed.sections && detailParsed.sections.length > 0) {
        return { ...detailParsed, title: pageTitle };
      }
    }
  } catch {}

  // Method 2: Fetch live Apple Music web /browse page and parse rich BrowsePageIntent
  try {
    const url = `https://music.apple.com/${sf}/browse?l=${encodeURIComponent(lang)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (res.ok) {
      const html = await res.text();
      const idx = html.indexOf('"BrowsePageIntent"');
      if (idx !== -1) {
        const scriptStart = html.lastIndexOf("<script", idx);
        const contentStart = html.indexOf(">", scriptStart) + 1;
        const scriptEnd = html.indexOf("</script>", contentStart);
        const data = JSON.parse(html.slice(contentStart, scriptEnd));
        const pageData = data?.data?.[0]?.data;
        const rawSections = pageData?.sections || [];
        const sections: Section[] = [];

        for (const rawSec of rawSections) {
          let title = rawSec.header?.item?.titleLink?.title || rawSec.header?.title?.text || "";
          if (!title && sections.length === 0) {
            title = tr("Featured");
          }
          if (!title) continue;

          const moreUrl = rawSec.header?.item?.titleLink?.url;
          const roomMatch = typeof moreUrl === "string" ? moreUrl.match(/\/room\/([a-zA-Z0-9._-]+)/) : null;
          const morePage = roomMatch ? `room:${roomMatch[1]}` : undefined;

          const albums: Album[] = [];
          const playlists: Playlist[] = [];

          // Cap the hero section to 6 items; other sections up to 20
          const rawItems = (rawSec.items || []).slice(0, sections.length === 0 ? 6 : 20);
          for (const item of rawItems) {
            const kind = item.contentDescriptor?.kind;
            const id = String(item.contentDescriptor?.identifiers?.storeAdamID || item.id || "");
            const name = String(item.title || item.titleLinks?.[0]?.title || "");
            const artistName = String(item.artistName || item.subtitleLinks?.[0]?.title || "");
            const rawArt = item.artwork?.dictionary?.url;
            const imageUrl = formatArtworkUrl(rawArt, 600);
            if (!id || !name) continue;

            if (kind === "song") {
              // In Browse, songs are represented cleanly as single/album cards rather than raw tracklist tables
              albums.push({
                id,
                name: `${name} - ${artistName}`,
                artists: [{ id: "", name: artistName }],
                imageUrl,
              });
            } else if (kind === "playlist") {
              playlists.push({
                id,
                name,
                owner: artistName,
                imageUrl,
              });
            } else {
              albums.push({
                id,
                name,
                artists: [{ id: "", name: artistName }],
                imageUrl,
              });
            }
          }

          if (playlists.length > 0 && albums.length === 0) {
            sections.push({ title, kind: "playlists", playlists, items: playlists, morePage });
          } else if (albums.length > 0) {
            sections.push({ title, kind: "albums", albums, items: albums, morePage });
          }
        }

        if (sections.length > 0) {
          return { title: pageTitle, sections };
        }
      }
    }
  } catch {}

  return buildChartsBrowse(sf, lang, pageTitle);
}

export async function browse(options?: { page?: string; id?: string }): Promise<Browse> {
  const page = options?.page || options?.id || "browse";
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";

  if (page === "home") {
    return home();
  }

  if (page === "browse" || page === "new") {
    const pageTitle = page === "new" ? tr("New") : tr("Browse");
    return buildAppleBrowse(sf, lang, pageTitle);
  }

  if (page === "charts") {
    return buildChartsBrowse(sf, lang, tr("Charts"));
  }

  if (page === "library" || page === "profile") {
    return buildMyPageBrowse(sf, lang);
  }

  if (page === "recent") {
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

  if (page.startsWith("reco:")) {
    const recId = page.slice(5).trim();
    if (!recId) throw fail("unavailable", "Recommendation id required");
    return buildRecommendationSeeAllBrowse(recId, lang);
  }

  if (page.startsWith("apple-curator:")) {
    const curId = page.slice(14).trim();
    if (!curId) throw fail("unavailable", "Curator id required");
    return buildCuratorBrowse(sf, curId, true, lang);
  }

  if (page.startsWith("curator:")) {
    const curId = page.slice(8).trim();
    if (!curId) throw fail("unavailable", "Curator id required");
    return buildCuratorBrowse(sf, curId, false, lang);
  }

  if (page.startsWith("grouping:")) {
    const grpId = page.slice(9).trim();
    if (!grpId) throw fail("unavailable", "Grouping id required");
    const grpJson = await requestApi(
      `/editorial/${sf}/groupings/${encodeURIComponent(grpId)}?platform=web&format[resources]=map&omit[resource:artists]=autos&l=${encodeURIComponent(lang)}`
    );
    return parseEditorialGroupingBrowse(grpJson, tr("Browse"));
  }

  if (page.startsWith("room:")) {
    const roomId = page.slice(5).trim();
    if (!roomId) throw fail("unavailable", "Room id required");
    return buildRoomBrowse(sf, roomId, lang);
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
  const { id: rawId } = options || {};
  let id = String(rawId || "").trim();
  if (!id) throw fail("unavailable", "Album id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";

  let item: any = null;
  const isLibrary = id.startsWith("l.");
  const endpoint = isLibrary
    ? `/me/library/albums/${encodeURIComponent(id)}?include=tracks,catalog&l=${lang}`
    : `/catalog/${sf}/albums/${encodeURIComponent(id)}?l=${lang}`;

  try {
    const json = await requestApi(endpoint, { requireAuth: isLibrary });
    item = json.data?.[0];
  } catch (err: any) {
    const isTestOrNumericId = /^\d+$/.test(id) || id === "404" || id === "not_found";
    if (err?.code === "unavailable" && !isLibrary && !isTestOrNumericId) {
      try {
        const searchRes = await requestApi(
          `/catalog/${sf}/search?term=${encodeURIComponent(id)}&types=albums&limit=1&l=${lang}`
        );
        const foundAlbum = searchRes.results?.albums?.data?.[0];
        if (foundAlbum?.id && foundAlbum.id !== id) {
          const json2 = await requestApi(
            `/catalog/${sf}/albums/${encodeURIComponent(foundAlbum.id)}?l=${lang}`
          );
          item = json2.data?.[0];
        }
      } catch {}
    }
    if (!item) throw err;
  }

  if (!item) {
    throw fail("unavailable", tr("Album not found"));
  }

  const alb = mapAlbum(item);
  let trackItems = item.relationships?.tracks?.data || [];
  if (trackItems.length === 0 && isLibrary) {
    const catId =
      item.relationships?.catalog?.data?.[0]?.id ||
      item.attributes?.playParams?.catalogId;
    if (catId) {
      try {
        const catJson = await requestApi(
          `/catalog/${sf}/albums/${encodeURIComponent(catId)}?l=${lang}`
        );
        if (catJson.data?.[0]?.relationships?.tracks?.data?.length) {
          trackItems = catJson.data[0].relationships.tracks.data;
        }
      } catch {}
    }
  }
  const tracks = trackItems.map(mapTrack);

  return {
    album: alb,
    tracks,
  };
}

export async function artist(options: { id: string }): Promise<ArtistPage> {
  const { id: rawId } = options || {};
  let id = String(rawId || "").trim();
  if (!id) throw fail("unavailable", "Artist id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";

  let item: any = null;
  try {
    const json = await requestApi(
      `/catalog/${sf}/artists/${encodeURIComponent(id)}?views=top-songs,full-albums&l=${lang}`
    );
    item = json.data?.[0];
  } catch (err: any) {
    const isTestOrNumericId = /^\d+$/.test(id) || id === "404" || id === "not_found";
    if (err?.code === "unavailable" && !isTestOrNumericId) {
      try {
        const searchRes = await requestApi(
          `/catalog/${sf}/search?term=${encodeURIComponent(id)}&types=artists&limit=1&l=${lang}`
        );
        const foundArtist = searchRes.results?.artists?.data?.[0];
        if (foundArtist?.id && foundArtist.id !== id) {
          const json2 = await requestApi(
            `/catalog/${sf}/artists/${encodeURIComponent(foundArtist.id)}?views=top-songs,full-albums&l=${lang}`
          );
          item = json2.data?.[0];
        }
      } catch {}
    }
    if (!item) throw err;
  }

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
// Subscriber Library & Playlists Hooks (Unified with Apple "Favorite Songs")
// ============================================================================

let favoritesPlaylistIdCache: string | null = null;
let favoritesLookupDone = false;
const favoritedIdsCache = new Set<string>();
let favoritesHydratedAt = 0;
let favoritesHydratePromise: Promise<void> | null = null;
const FAVORITES_CACHE_TTL_MS = 2 * 60 * 1000;

function resetFavoritesState(): void {
  favoritesPlaylistIdCache = null;
  favoritesLookupDone = false;
  favoritedIdsCache.clear();
  favoritesHydratedAt = 0;
  favoritesHydratePromise = null;
}

function isFavoritesPlaylistItem(item: any): boolean {
  const attr = item?.attributes || {};
  if (Array.isArray(attr.tags) && attr.tags.includes("favorited")) {
    return true;
  }
  if (attr.isFavorites === true) {
    return true;
  }
  const name = String(attr.name || "").trim();
  if (
    attr.canEdit === false &&
    !attr.curatorName &&
    /^(Favorite Songs|Favourite Songs|喜爱歌曲|喜好歌曲|喜愛歌曲|お気に入りの曲|즐겨찾는 노래)$/i.test(
      name
    )
  ) {
    return true;
  }
  return false;
}

function recordFavoritedTrackItem(item: any): void {
  if (!item) return;
  const id = String(item.id || "").trim();
  if (id) favoritedIdsCache.add(id);
  const catalogId =
    item.attributes?.playParams?.catalogId ||
    item.relationships?.catalog?.data?.[0]?.id;
  if (catalogId) {
    favoritedIdsCache.add(String(catalogId));
  }
}

async function getFavoritesPlaylistId(lang: string): Promise<string | null> {
  if (favoritesPlaylistIdCache) return favoritesPlaylistIdCache;
  if (favoritesLookupDone) return null;

  try {
    const json = await requestApi(
      `/me/library/playlists?limit=100&extend[library-playlists]=tags&l=${lang}`,
      { requireAuth: true }
    );
    const items = Array.isArray(json?.data) ? json.data : [];
    const fav = items.find(isFavoritesPlaylistItem);
    favoritesLookupDone = true;
    if (fav?.id) {
      favoritesPlaylistIdCache = String(fav.id);
      return favoritesPlaylistIdCache;
    }
  } catch {
    // Ignore when endpoint is unavailable or unmocked
  }
  return null;
}

async function fetchFavoritesPlaylistTracks(
  favId: string,
  lang: string,
  offset = 0,
  maxPages = 5
): Promise<{ rawItems: any[]; hasMore: boolean }> {
  const rawItems: any[] = [];
  let nextPath: string | undefined =
    `/me/library/playlists/${encodeURIComponent(favId)}/tracks?limit=100&offset=${offset}&l=${lang}`;
  let pages = 0;

  while (nextPath && pages < maxPages) {
    pages++;
    const cleanPath: string = nextPath.replace(/^\/v1/, "");
    const pageJson: any = await requestApi(cleanPath, { requireAuth: true }).catch(() => null);
    if (!pageJson || !Array.isArray(pageJson.data)) {
      nextPath = undefined;
      break;
    }
    for (const item of pageJson.data) {
      recordFavoritedTrackItem(item);
      rawItems.push(item);
    }
    nextPath = typeof pageJson.next === "string" && pageJson.next ? pageJson.next : undefined;
  }

  if (offset === 0 && rawItems.length > 0) {
    favoritesHydratedAt = Date.now();
  }

  return {
    rawItems,
    hasMore: Boolean(nextPath),
  };
}

async function ensureFavoritesHydrated(lang: string): Promise<void> {
  if (favoritesHydratedAt > 0 && Date.now() - favoritesHydratedAt < FAVORITES_CACHE_TTL_MS) {
    return;
  }
  if (favoritesHydratePromise) {
    return favoritesHydratePromise;
  }
  favoritesHydratePromise = (async () => {
    try {
      const favId = await getFavoritesPlaylistId(lang);
      if (favId) {
        await fetchFavoritesPlaylistTracks(favId, lang, 0, 5);
      }
      favoritesHydratedAt = Date.now();
    } catch {
      // Non-fatal
    } finally {
      favoritesHydratePromise = null;
    }
  })();
  return favoritesHydratePromise;
}

export async function playlists(): Promise<Playlist[]> {
  const token = await getStoredMediaUserToken();
  if (!token) return [];
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/library/playlists?limit=100&extend[library-playlists]=tags&l=${lang}`,
    { requireAuth: true }
  );
  const items: any[] = Array.isArray(json.data) ? json.data : [];
  const fav = items.find(isFavoritesPlaylistItem);
  if (fav?.id) {
    favoritesPlaylistIdCache = String(fav.id);
    favoritesLookupDone = true;
  }
  // Exclude system "Favorite Songs" from sidebar playlists since MyGo Music shows builtin "Liked Songs"
  return items.filter((item) => !isFavoritesPlaylistItem(item)).map(mapPlaylist);
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

  const favId = await getFavoritesPlaylistId(lang);
  if (favId) {
    if (offset === 0) {
      favoritedIdsCache.clear();
    }
    const maxPages = offset === 0 ? 5 : 1;
    const { rawItems, hasMore } = await fetchFavoritesPlaylistTracks(
      favId,
      lang,
      offset,
      maxPages
    );
    return {
      tracks: rawItems.map(mapTrack),
      more: hasMore,
    };
  }

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

export async function savedAlbums(options?: { offset?: number; sort?: string }): Promise<AlbumList> {
  const offset = Math.max(0, Number(options?.offset) || 0);
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const sortParam = options?.sort === "name" ? "name" : "-dateAdded";

  const json = await requestApi(
    `/me/library/albums?limit=50&offset=${offset}&sort=${sortParam}&include=catalog&l=${lang}`,
    { requireAuth: true }
  );
  const items = dedupeLibraryAlbums(json.data || [], lang);
  return {
    albums: items.map(mapAlbum),
    more: Boolean(json.next),
  };
}

export async function like(options: { id: string; on: boolean }): Promise<void> {
  const id = String(options?.id || "").trim();
  if (!id) return;
  const on = Boolean(options?.on);
  const isLibId = id.startsWith("i.");
  const resType = isLibId ? "library-songs" : "songs";
  const meta = trackMetaCache.get(id);

  // Primary: Apple Music Favorites API (/v1/me/favorites — updates "Favorite Songs" playlist)
  let updatedFavorites = false;
  try {
    await requestApi(
      `/me/favorites?ids[${resType}]=${encodeURIComponent(id)}&platform=web`,
      {
        method: on ? "POST" : "DELETE",
        requireAuth: true,
      }
    );
    updatedFavorites = true;
  } catch (err: any) {
    if (err?.code === "signIn") throw err;
  }

  // Secondary fallback: ratings endpoint for older endpoints / mock servers
  const ratingPath = isLibId
    ? `/me/ratings/library-songs/${encodeURIComponent(id)}`
    : `/me/ratings/songs/${encodeURIComponent(id)}`;
  if (on) {
    if (!updatedFavorites) {
      if (!isLibId) {
        await requestApi(`/me/library?ids[songs]=${encodeURIComponent(id)}`, {
          method: "POST",
          requireAuth: true,
        }).catch(() => {});
      }
      await requestApi(ratingPath, {
        method: "PUT",
        requireAuth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "rating", attributes: { value: 1 } }),
      });
    } else {
      requestApi(ratingPath, {
        method: "PUT",
        requireAuth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "rating", attributes: { value: 1 } }),
      }).catch(() => {});
    }
    favoritedIdsCache.add(id);
    if (meta?.catalogId) favoritedIdsCache.add(meta.catalogId);
  } else {
    if (!updatedFavorites) {
      await requestApi(ratingPath, {
        method: "DELETE",
        requireAuth: true,
      }).catch(() => {});
    } else {
      requestApi(ratingPath, {
        method: "DELETE",
        requireAuth: true,
      }).catch(() => {});
    }
    favoritedIdsCache.delete(id);
    if (meta?.catalogId) favoritedIdsCache.delete(meta.catalogId);
  }
}

export async function isLiked(options: { ids: string[] }): Promise<Record<string, boolean>> {
  const ids = Array.isArray(options?.ids) ? options.ids.filter(Boolean) : [];
  const out: Record<string, boolean> = {};
  for (const id of ids) out[id] = false;
  if (ids.length === 0) return out;

  const token = await getStoredMediaUserToken();
  if (!token) return out;

  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  await ensureFavoritesHydrated(lang);

  const unresolvedLibIds: string[] = [];
  const unresolvedCatalogIds: string[] = [];

  for (const id of ids) {
    const meta = trackMetaCache.get(id);
    if (
      favoritedIdsCache.has(id) ||
      (meta?.catalogId && favoritedIdsCache.has(meta.catalogId)) ||
      (meta?.id && favoritedIdsCache.has(meta.id))
    ) {
      out[id] = true;
    } else if (id.startsWith("i.")) {
      unresolvedLibIds.push(id);
    } else {
      unresolvedCatalogIds.push(id);
    }
  }

  if (unresolvedLibIds.length > 0) {
    try {
      const json = await requestApi(
        `/me/ratings/library-songs?ids=${unresolvedLibIds.map(encodeURIComponent).join(",")}`,
        { requireAuth: true }
      );
      for (const r of json.data || []) {
        if (r?.id && r?.attributes?.value === 1) {
          out[String(r.id)] = true;
          favoritedIdsCache.add(String(r.id));
        }
      }
    } catch {
      // Non-fatal
    }
  }

  if (unresolvedCatalogIds.length > 0) {
    try {
      const json = await requestApi(
        `/me/ratings/songs?ids=${unresolvedCatalogIds.map(encodeURIComponent).join(",")}`,
        { requireAuth: true }
      );
      for (const r of json.data || []) {
        if (r?.id && r?.attributes?.value === 1) {
          out[String(r.id)] = true;
          favoritedIdsCache.add(String(r.id));
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

export async function stations(): Promise<Station[]> {
  const token = await getStoredMediaUserToken();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const sf = await getStorefront().catch(() => "jp");
  const result: Station[] = [];
  const seenIds = new Set<string>();

  const add = (st: Station) => {
    if (!st.id || seenIds.has(st.id)) return;
    seenIds.add(st.id);
    result.push(st);
  };

  // 1. Primary Apple Music Flagship Live Broadcast Radio Stations (Always available globally)
  for (const liveSt of APPLE_MUSIC_LIVE_STATIONS) {
    add(liveSt);
  }

  // 2. Fetch Latest Radio Shows & Editorial Broadcast Episodes from Apple Music Web Radio
  try {
    const radioUrl = `https://music.apple.com/${sf}/radio?l=${encodeURIComponent(lang)}`;
    const res = await fetch(radioUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (res.ok) {
      const html = await res.text();
      const scriptRegex = /<script type="application\/json" id="serialized-server-data"[^>]*>(.*?)<\/script>/s;
      const m = html.match(scriptRegex);
      if (m) {
        const data = JSON.parse(m[1]);
        const sections = data?.data?.[0]?.data?.sections || [];
        const episodeSec = sections[1];
        for (const it of episodeSec?.items || []) {
          const id = String(it.id || "").replace(/^.*- (ra\.\d+).*$/, "$1");
          const name = it.title || it.artistName;
          const desc = it.subtitle || it.description;
          const rawArt = it.artwork?.dictionary?.url;
          if (id && name) {
            add({
              id,
              name: String(name),
              description: desc ? String(desc) : undefined,
              imageUrl: formatArtworkUrl(rawArt, 600),
            });
          }
        }
      }
    }
  } catch {}

  // 3. User's personalized & recent algorithmic stations (Discovery Station, Personal Station, etc.)
  if (token) {
    try {
      const json = await requestApi(
        `/me/recent/radio-stations?limit=20&l=${encodeURIComponent(lang)}`,
        { requireAuth: true }
      );
      const items: any[] = Array.isArray(json?.data) ? json.data : [];
      for (const st of items) {
        if (!st?.id || !st?.attributes?.name) continue;
        add({
          id: String(st.id),
          name: String(st.attributes.name),
          description:
            st.attributes.editorialNotes?.short ||
            st.attributes.plainEditorialNotes?.short ||
            undefined,
          imageUrl: extractBestArtworkUrl(st, 600),
        });
      }
    } catch {}
  }

  return result;
}

export async function stationNext(options: { id: string }): Promise<Track[]> {
  const id = String(options?.id || "").trim();
  if (!id) throw fail("unavailable", "Station id required");
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  let items: any[] = [];
  try {
    const json = await requestApi(
      `/me/stations/next-tracks/${encodeURIComponent(id)}?limit=10&l=${encodeURIComponent(lang)}`,
      {
        method: "POST",
        requireAuth: true,
      }
    );
    items = Array.isArray(json?.data) ? json.data : [];
  } catch {}

  if (items.length === 0) {
    // Live broadcast radio station fallback (e.g. Apple Music 1, Hits, Country)
    const sf = await getStorefront().catch(() => "jp");
    const liveMatch = APPLE_MUSIC_LIVE_STATIONS.find((s) => s.id === id);
    const stationName = liveMatch?.name || "Apple Music Radio";
    const cleanSlug = stationName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return [
      {
        id,
        name: stationName,
        artists: [{ id: "", name: "Apple Music Radio" }],
        album: { id: "", name: "Live Broadcast", imageUrl: liveMatch?.imageUrl },
        duration: 0,
        url: `https://music.apple.com/${sf}/station/${cleanSlug}/${encodeURIComponent(id)}`,
      },
    ];
  }
  return items.map(mapTrack);
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

const CURRENT_PROFILE_VERSION = 2;

function isPlaceholderAccountName(name?: string | null): boolean {
  if (!name || typeof name !== "string") return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (/^Apple Music\s*\(.+\)$/i.test(trimmed)) return true;
  if (trimmed === "Apple Music" || trimmed === "Apple Music Subscriber" || trimmed === "Apple Music 订阅用户") {
    return true;
  }
  return false;
}

function isLegacyStorefrontPlaceholder(name?: string | null): boolean {
  return Boolean(name && /^Apple Music\s*\(.+\)$/i.test(name.trim()));
}

function getCustomDisplayName(): string {
  if (typeof host !== "undefined" && typeof host.setting === "function") {
    const val = host.setting("displayName");
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

function extractSocialProfileCandidate(json: any): {
  id?: string;
  name?: string;
  handle?: string;
  imageUrl?: string;
} {
  if (!json || typeof json !== "object") return {};
  const candidates: any[] = [];

  const personalMap = json.resources?.["personal-social-profiles"];
  if (personalMap && typeof personalMap === "object") {
    if (personalMap.me) candidates.push(personalMap.me);
    for (const v of Object.values(personalMap)) {
      if (v && typeof v === "object") candidates.push(v);
    }
  }
  const socialMap = json.resources?.["social-profiles"];
  if (socialMap && typeof socialMap === "object") {
    for (const v of Object.values(socialMap)) {
      if (v && typeof v === "object") candidates.push(v);
    }
  }
  if (Array.isArray(json.data)) {
    candidates.push(...json.data);
  }
  if (Array.isArray(json.included)) {
    candidates.push(...json.included);
  }

  let id: string | undefined;
  let name: string | undefined;
  let handle: string | undefined;
  let imageUrl: string | undefined;

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const attr = c.attributes || {};
    if (!id && typeof c.id === "string" && c.id.trim()) {
      id = c.id.trim();
    }
    if (!name && typeof attr.name === "string" && attr.name.trim() && !isPlaceholderAccountName(attr.name)) {
      name = attr.name.trim();
    }
    if (!handle && typeof attr.handle === "string" && attr.handle.trim()) {
      handle = attr.handle.trim().replace(/^@+/, "");
    }
    if (!imageUrl && typeof attr.artwork?.url === "string" && attr.artwork.url.trim()) {
      imageUrl = formatArtworkUrl(attr.artwork.url.trim(), 160, "cc");
    }
  }

  return { id, name, handle, imageUrl };
}

function extractMeAccountCandidate(json: any): {
  id?: string;
  name?: string;
  imageUrl?: string;
  storefront?: string;
} {
  if (!json || typeof json !== "object") return {};
  const storefront =
    typeof json.meta?.subscription?.storefront === "string"
      ? json.meta.subscription.storefront.trim().toLowerCase()
      : undefined;

  const candidates: any[] = [];
  if (Array.isArray(json.data)) candidates.push(...json.data);
  if (json.resources?.accounts?.me) candidates.push(json.resources.accounts.me);

  let id: string | undefined;
  let name: string | undefined;
  let imageUrl: string | undefined;

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const attr = c.attributes || {};
    if (!id && typeof c.id === "string" && c.id.trim()) {
      id = c.id.trim();
    }
    const fullName = [attr.firstName, attr.lastName]
      .filter((x) => typeof x === "string" && x.trim())
      .join(" ")
      .trim();
    const rawName =
      fullName ||
      (typeof attr.nickname === "string" ? attr.nickname.trim() : "") ||
      (typeof attr.handle === "string" ? attr.handle.trim().replace(/^@+/, "") : "") ||
      (typeof attr.name === "string" ? attr.name.trim() : "");
    if (!name && rawName && !isPlaceholderAccountName(rawName)) {
      name = rawName;
    }
    const rawArt = attr.avatarArtwork?.url || attr.artwork?.url;
    if (!imageUrl && typeof rawArt === "string" && rawArt.trim()) {
      imageUrl = formatArtworkUrl(rawArt.trim(), 160, "cc");
    }
  }

  return { id, name, imageUrl, storefront };
}

async function getMacSystemUserName(): Promise<string> {
  if (
    typeof host === "undefined" ||
    host.platform !== "darwin" ||
    typeof host.spawn !== "function"
  ) {
    return "";
  }
  try {
    const proc = host.spawn("/usr/bin/osascript", ["-"]);
    proc.write(
      'try\n  set fn to long user name of (system info)\n  if fn is not "" then return "USER:" & fn\nend try\nreturn "USER:" & (short user name of (system info))\n'
    );
    proc.closeStdin();
    const lines: string[] = [];
    while (true) {
      const line = await proc.readLine();
      if (line === null || line === undefined) break;
      lines.push(line);
    }
    const exitCode = await proc.wait();
    if (exitCode === 0) {
      const out = lines.join("\n").trim();
      if (out.startsWith("USER:")) {
        const user = out.slice(5).trim();
        if (user && !user.includes("\t") && !user.includes("\n")) {
          return user;
        }
      }
    }
  } catch {
    // Ignore when process permission is not granted
  }
  return "";
}

async function resolveSubscriberProfile(
  mediaUserToken: string,
  devToken: string,
  fallbackStorefront: string
): Promise<{
  account: Account;
  storefront: string;
  foundRealProfile: boolean;
}> {
  const authHeaders = {
    Authorization: `Bearer ${devToken}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    "Music-User-Token": mediaUserToken,
  };

  const fetchJsonSafe = async (url: string): Promise<any | null> => {
    try {
      const res = await fetch(url, { headers: authHeaders });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };

  const [socialMapJson, meAccountJson] = await Promise.all([
    fetchJsonSafe(
      `${AMP_API_BASE}/me/social/profile?include=social-profile&with=nonOnboarded&platform=web&format%5Bresources%5D=map`
    ),
    fetchJsonSafe(
      `${AMP_API_BASE}/me/account?meta=subscription&challenge%5BsubscriptionCapabilities%5D=voice,premium&platform=web`
    ),
  ]);

  let social = extractSocialProfileCandidate(socialMapJson);
  if (!social.name && !social.handle && !social.imageUrl) {
    const socialPlainJson = await fetchJsonSafe(
      `${AMP_API_BASE}/me/social/profile?include=social-profile&with=nonOnboarded`
    );
    const altSocial = extractSocialProfileCandidate(socialPlainJson);
    social = {
      id: social.id || altSocial.id,
      name: social.name || altSocial.name,
      handle: social.handle || altSocial.handle,
      imageUrl: social.imageUrl || altSocial.imageUrl,
    };
  }

  const meAcc = extractMeAccountCandidate(meAccountJson);
  const storefront = meAcc.storefront || fallbackStorefront || "us";

  let resolvedName = social.name || social.handle || meAcc.name || "";
  if (!resolvedName) {
    // Check editable library playlists for owner curatorName if social profile is unavailable
    const libPlJson = await fetchJsonSafe(`${AMP_API_BASE}/me/library/playlists?limit=10`);
    if (Array.isArray(libPlJson?.data)) {
      for (const pl of libPlJson.data) {
        if (pl?.attributes?.canEdit && typeof pl?.attributes?.curatorName === "string") {
          const curator = pl.attributes.curatorName.trim();
          if (curator && !isPlaceholderAccountName(curator)) {
            resolvedName = curator;
            break;
          }
        }
      }
    }
  }

  let foundRealProfile = Boolean(resolvedName || social.imageUrl || meAcc.imageUrl);

  if (!resolvedName) {
    const macUser = await getMacSystemUserName();
    if (macUser) {
      resolvedName = macUser;
      foundRealProfile = true;
    }
  }

  const customName = getCustomDisplayName();
  const finalName = customName || resolvedName || tr("Apple Music Subscriber");
  const finalImage = social.imageUrl || meAcc.imageUrl || "";
  const finalId = social.handle || `apple-music-${storefront}`;

  return {
    account: {
      id: finalId,
      name: finalName,
      imageUrl: finalImage,
      page: "library",
    },
    storefront,
    foundRealProfile: foundRealProfile || Boolean(customName),
  };
}

async function verifyAndPersistToken(mediaUserToken: string): Promise<Account> {
  let sfData: any;
  let devToken: string;
  try {
    devToken = await getDeveloperToken();
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

  const initialStorefront = sfData?.data?.[0]?.id || "us";
  const resolved = await resolveSubscriberProfile(
    mediaUserToken,
    devToken,
    initialStorefront
  );

  if (typeof host !== "undefined" && host.storage) {
    try {
      await host.storage.set("auth", {
        mediaUserToken,
        storefront: resolved.storefront,
        account: resolved.account,
        profileVersion: CURRENT_PROFILE_VERSION,
        signedInAt: Date.now(),
      });
    } catch (_) {
      // Ignore storage errors on write
    }
  }

  return resolved.account;
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
  resetFavoritesState();
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
  const customName = getCustomDisplayName();

  if (host.storage) {
    try {
      const auth = await host.storage.get<any>("auth");
      const token = cleanMediaUserToken(auth?.mediaUserToken);
      if (auth && token) {
        const storedAcc: Account | undefined = auth.account;
        const needsUpgrade =
          !storedAcc ||
          auth.profileVersion !== CURRENT_PROFILE_VERSION ||
          isLegacyStorefrontPlaceholder(storedAcc.name);

        if (needsUpgrade) {
          try {
            const devToken = await getDeveloperToken();
            const resolved = await resolveSubscriberProfile(
              token,
              devToken,
              auth.storefront || "us"
            );
            const nextAccount: Account =
              resolved.foundRealProfile ||
              !storedAcc ||
              isLegacyStorefrontPlaceholder(storedAcc.name)
                ? resolved.account
                : {
                    ...storedAcc,
                    name: customName || storedAcc.name,
                    imageUrl: resolved.account.imageUrl || storedAcc.imageUrl || "",
                  };

            await host.storage.set("auth", {
              ...auth,
              storefront: resolved.storefront || auth.storefront || "us",
              account: nextAccount,
              profileVersion: CURRENT_PROFILE_VERSION,
            });
            return nextAccount;
          } catch {
            // Fall through to cached account on transient errors
          }
        }

        if (storedAcc) {
          return customName ? { ...storedAcc, name: customName } : storedAcc;
        }
      }
    } catch (_) {}
  }

  if (typeof host.setting === "function") {
    const pasted = cleanMediaUserToken(host.setting("mediaUserToken"));
    if (pasted) {
      try {
        const devToken = await getDeveloperToken();
        const resolved = await resolveSubscriberProfile(pasted, devToken, "us");
        if (host.storage) {
          try {
            await host.storage.set("auth", {
              mediaUserToken: pasted,
              storefront: resolved.storefront,
              account: resolved.account,
              profileVersion: CURRENT_PROFILE_VERSION,
              signedInAt: Date.now(),
            });
          } catch {}
        }
        return resolved.account;
      } catch {
        return {
          id: "apple-music-subscriber",
          name: customName || tr("Apple Music Subscriber"),
          imageUrl: "",
          page: "library",
        };
      }
    }
  }
  return null;
}

export async function setSetting(options: { key: string; value: string }): Promise<void> {
  const { key, value } = options || {};
  if (typeof host !== "undefined" && host._setSetting) {
    host._setSetting(key, value);
  }

  if (key === "mediaUserToken" && !cleanMediaUserToken(value)) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        await host.storage.remove("auth");
      } catch {}
    }
    return;
  }

  if (key === "displayName" && typeof host !== "undefined" && host.storage) {
    try {
      const auth = await host.storage.get<any>("auth");
      if (auth && auth.mediaUserToken) {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed && auth.account) {
          await host.storage.set("auth", {
            ...auth,
            account: { ...auth.account, name: trimmed },
          });
        } else {
          await host.storage.set("auth", {
            ...auth,
            profileVersion: 0,
          });
        }
      }
    } catch {}
    return;
  }

  if (key === "audioQuality") {
    const mode = parseAudioQualitySetting(value);
    if (mode) {
      await syncMusicAppAudioQuality(mode);
    }
  }
}
