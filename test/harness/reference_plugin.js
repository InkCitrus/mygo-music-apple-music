/**
 * Reference Plugin Implementation (Contract Oracle)
 * Authoritative implementation of the MyGo Music Apple Music Plugin interface.
 * Used for oracle comparisons, test harness self-verification, and baseline assertions.
 */

const DEFAULT_DEV_TOKEN =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw";

const AMP_API_BASE = "https://amp-api.music.apple.com/v1";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function formatArtworkUrl(url, size = 600) {
  if (!url) return undefined;
  return url.replace("{w}x{h}", `${size}x${size}`);
}

export function mapTrack(item) {
  const attr = item.attributes || {};
  return {
    id: String(item.id),
    title: attr.name,
    artist: attr.artistName,
    artists: [attr.artistName],
    album: attr.albumName,
    artwork: formatArtworkUrl(attr.artwork?.url, 600),
    duration: Math.round((attr.durationInMillis || 0) / 1000),
    trackNumber: attr.trackNumber,
    discNumber: attr.discNumber,
    isrc: attr.isrc,
    explicit: attr.contentRating === "explicit",
  };
}

export function mapAlbum(item) {
  const attr = item.attributes || {};
  return {
    id: String(item.id),
    title: attr.name,
    artist: attr.artistName,
    artwork: formatArtworkUrl(attr.artwork?.url, 600),
    trackCount: attr.trackCount,
    year: attr.releaseDate ? parseInt(attr.releaseDate.split("-")[0], 10) : undefined,
    description: attr.editorialNotes?.short || attr.editorialNotes?.standard,
  };
}

export function mapArtist(item) {
  const attr = item.attributes || {};
  return {
    id: String(item.id),
    name: attr.name,
    artwork: formatArtworkUrl(attr.artwork?.url, 600),
    url: attr.url,
  };
}

export function mapPlaylist(item) {
  const attr = item.attributes || {};
  return {
    id: String(item.id),
    title: attr.name,
    artwork: formatArtworkUrl(attr.artwork?.url, 600),
    description:
      attr.description?.short ||
      attr.description?.standard ||
      attr.editorialNotes?.short ||
      attr.editorialNotes?.standard,
    curator: attr.curatorName,
  };
}

export async function getDeveloperToken() {
  if (typeof host !== "undefined" && host.storage) {
    const cached = await host.storage.get("developer_token");
    const cachedExp = await host.storage.get("developer_token_exp");
    if (cached && cachedExp && Date.now() < cachedExp - 86400000) {
      return cached;
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
      const scriptMatch = html.match(/src="(\/assets\/index~[a-zA-Z0-9]+\.js)"/);
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
            try {
              const payload = JSON.parse(
                Buffer.from(token.split(".")[1], "base64").toString("utf-8")
              );
              if (typeof host !== "undefined" && host.storage) {
                await host.storage.set("developer_token", token);
                await host.storage.set("developer_token_exp", payload.exp * 1000);
              }
            } catch (_) {}
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

export async function getStorefront() {
  if (typeof host !== "undefined") {
    // 1. User setting override
    const settingSf = host.setting ? host.setting("storefront") : "";
    if (settingSf) {
      return settingSf.toLowerCase().trim();
    }

    // 2. Auth state storefront
    if (host.storage) {
      const auth = await host.storage.get("auth");
      if (auth && auth.storefront) {
        return auth.storefront.toLowerCase();
      }
    }

    // 3. Fallback based on language
    if (host.language && host.language() === "zh-CN") {
      return "cn";
    }
  }
  return "us";
}

async function requestApi(endpoint, options = {}) {
  const devToken = await getDeveloperToken();
  const headers = {
    Authorization: `Bearer ${devToken}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    Accept: "application/json",
    ...options.headers,
  };

  if (typeof host !== "undefined" && host.storage) {
    const auth = await host.storage.get("auth");
    if (auth && auth.mediaUserToken) {
      headers["Music-User-Token"] = auth.mediaUserToken;
    }
  }

  const url = endpoint.startsWith("http") ? endpoint : `${AMP_API_BASE}${endpoint}`;
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    throw fail("signIn", host?.t ? host.t("Sign in to Apple Music first") : "Sign in to Apple Music first");
  }

  if (res.status === 403) {
    if (typeof host !== "undefined" && host.storage) {
      await host.storage.remove("auth");
    }
    throw fail("signIn", host?.t ? host.t("Sign in to Apple Music first") : "Sign in to Apple Music first");
  }

  if (res.status === 404) {
    throw fail("unavailable", host?.t ? host.t("This track is unavailable for streaming") : "Resource not found");
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const detail = errBody.errors?.[0]?.detail || res.statusText;
    throw fail("unavailable", detail);
  }

  return res.json();
}

// Exported Hooks
export async function search(options) {
  const { query, kind = "tracks", offset = 0 } = options || {};
  if (!query || !query.trim()) {
    return { [kind]: [], more: false };
  }

  const sf = await getStorefront();
  const typeMap = {
    tracks: "songs",
    albums: "albums",
    artists: "artists",
    playlists: "playlists",
  };
  const appleType = typeMap[kind] || "songs";
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const limit = 20;

  const url = `/catalog/${sf}/search?term=${encodeURIComponent(
    query
  )}&types=${appleType}&limit=${limit}&offset=${offset}&l=${lang}`;

  const json = await requestApi(url);
  const resultContainer = json.results?.[appleType];
  const items = resultContainer?.data || [];
  const hasMore = Boolean(resultContainer?.next);

  let mappedItems = [];
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

export async function suggest(options) {
  const { query } = options || {};
  if (!query || !query.trim()) {
    return [];
  }

  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const url = `/catalog/${sf}/search/hints?term=${encodeURIComponent(query)}&l=${lang}`;

  const json = await requestApi(url);
  return json.results?.terms || [];
}

export async function home() {
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const url = `/catalog/${sf}/charts?types=songs,albums,playlists&limit=20&l=${lang}`;

  const json = await requestApi(url);
  const charts = json.results || {};
  const sections = [];

  if (charts.songs?.[0]?.data?.length) {
    sections.push({
      title: host?.t ? host.t("Top Songs") : "Top Songs",
      kind: "tracks",
      items: charts.songs[0].data.map(mapTrack),
      morePage: "charts-songs",
    });
  }

  if (charts.playlists?.[0]?.data?.length) {
    sections.push({
      title: host?.t ? host.t("Top Playlists") : "Top Playlists",
      kind: "playlists",
      items: charts.playlists[0].data.map(mapPlaylist),
      morePage: "charts-playlists",
    });
  }

  if (charts.albums?.[0]?.data?.length) {
    sections.push({
      title: host?.t ? host.t("Top Albums") : "Top Albums",
      kind: "albums",
      items: charts.albums[0].data.map(mapAlbum),
      morePage: "charts-albums",
    });
  }

  return { sections };
}

export async function browse(options) {
  const page = options?.page || options?.id || "charts";
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";

  if (page === "charts" || page === "browse") {
    return home();
  }

  if (page === "charts-songs") {
    const json = await requestApi(`/catalog/${sf}/charts?types=songs&limit=50&l=${lang}`);
    const songs = json.results?.songs?.[0]?.data || [];
    return {
      sections: [
        {
          title: host?.t ? host.t("Top Songs") : "Top Songs",
          kind: "tracks",
          items: songs.map(mapTrack),
        },
      ],
    };
  }

  if (page === "charts-albums") {
    const json = await requestApi(`/catalog/${sf}/charts?types=albums&limit=50&l=${lang}`);
    const albums = json.results?.albums?.[0]?.data || [];
    return {
      sections: [
        {
          title: host?.t ? host.t("Top Albums") : "Top Albums",
          kind: "albums",
          items: albums.map(mapAlbum),
        },
      ],
    };
  }

  if (page === "charts-playlists") {
    const json = await requestApi(`/catalog/${sf}/charts?types=playlists&limit=50&l=${lang}`);
    const playlists = json.results?.playlists?.[0]?.data || [];
    return {
      sections: [
        {
          title: host?.t ? host.t("Top Playlists") : "Top Playlists",
          kind: "playlists",
          items: playlists.map(mapPlaylist),
        },
      ],
    };
  }

  throw fail("unavailable", `Unknown browse page: ${page}`);
}

export async function album(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Album id required");
  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/albums/${id}`);
  const item = json.data?.[0];
  if (!item) throw fail("unavailable", "Album not found");

  const alb = mapAlbum(item);
  const trackItems = item.relationships?.tracks?.data || [];
  const tracks = trackItems.map(mapTrack);

  return {
    album: alb,
    tracks,
  };
}

export async function artist(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Artist id required");
  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/artists/${id}?views=top-songs,full-albums`);
  const item = json.data?.[0];
  if (!item) throw fail("unavailable", "Artist not found");

  const art = mapArtist(item);
  const topSongItems = item.views?.["top-songs"]?.data || [];
  const albumItems = item.views?.["full-albums"]?.data || [];

  return {
    artist: art,
    tracks: topSongItems.map(mapTrack),
    albums: albumItems.map(mapAlbum),
  };
}

export async function playlist(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Playlist id required");
  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/playlists/${id}`);
  const item = json.data?.[0];
  if (!item) throw fail("unavailable", "Playlist not found");

  const pl = mapPlaylist(item);
  const trackItems = item.relationships?.tracks?.data || [];
  pl.tracks = trackItems.map(mapTrack);

  return pl;
}

export async function stream(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Song id required");
  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/songs/${id}`);
  const song = json.data?.[0];
  if (!song) {
    throw fail("unavailable", host?.t ? host.t("This track is unavailable for streaming") : "Track not found");
  }

  const previewUrl = song.attributes?.previews?.[0]?.url;
  if (!previewUrl) {
    throw fail(
      "unavailable",
      host?.t
        ? host.t("This track is unavailable for streaming")
        : "This track is unavailable for streaming"
    );
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

export async function signIn() {
  if (typeof host === "undefined" || !host.webSignIn) {
    throw fail("unsupported", "webSignIn host API not supported in this environment");
  }

  const browserUA =
    host.platform === "darwin"
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

  const { cookie } = await host.webSignIn({
    url: "https://music.apple.com",
    cookiesOf: "https://music.apple.com",
    until: ["media-user-token"],
    userAgent: browserUA,
  });

  const match = cookie.match(/media-user-token=([^;]+)/);
  if (!match || !match[1]) {
    throw fail("signIn", "Failed to capture media-user-token from sign in");
  }
  const mediaUserToken = match[1].trim();

  // Validate subscriber storefront and account
  const devToken = await getDeveloperToken();
  const sfRes = await fetch("https://amp-api.music.apple.com/v1/me/storefront", {
    headers: {
      Authorization: `Bearer ${devToken}`,
      Origin: "https://music.apple.com",
      "Music-User-Token": mediaUserToken,
    },
  });

  if (!sfRes.ok) {
    throw fail("signIn", "Failed to validate storefront with media-user-token");
  }
  const sfData = await sfRes.json();
  const storefront = sfData.data?.[0]?.id || "us";

  const userAccount = {
    id: `apple-music-${storefront}`,
    name: sfData.data?.[0]?.attributes?.name
      ? `Apple Music (${sfData.data[0].attributes.name})`
      : "Apple Music Subscriber",
    imageUrl: "",
    page: "library",
  };

  await host.storage.set("auth", {
    mediaUserToken,
    storefront,
    account: userAccount,
    signedInAt: Date.now(),
  });

  return userAccount;
}

export async function signOut() {
  if (typeof host !== "undefined" && host.storage) {
    await host.storage.remove("auth");
  }
}

export async function account() {
  if (typeof host === "undefined" || !host.storage) return null;
  const auth = await host.storage.get("auth");
  if (!auth || !auth.mediaUserToken) return null;
  return auth.account || null;
}

export async function setSetting(options) {
  const { key, value } = options || {};
  if (typeof host !== "undefined" && host._setSetting) {
    host._setSetting(key, value);
  }
}
