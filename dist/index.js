// src/types.ts
function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// src/native_remote.ts
var connection = null;
var nextId = 0;
var playGeneration = 0;
var mapping = null;
var loading = false;
function error(code, message) {
  return fail(code, typeof host !== "undefined" && typeof host.t === "function" ? host.t(message) : message);
}
function disconnect(c) {
  if (connection === c) {
    connection = null;
    mapping = null;
    loading = false;
    playGeneration++;
  }
  for (const item of c.pending.values()) {
    clearTimeout(item.timer);
    item.reject(error("unavailable", "Native playback connection closed"));
  }
  c.pending.clear();
  try {
    c.proc.closeStdin();
  } catch {
  }
  const timer = setTimeout(() => {
    try {
      c.proc.kill();
    } catch {
    }
  }, 3e3);
  void c.proc.wait().then(() => clearTimeout(timer), () => clearTimeout(timer));
}
function resetRemoteSession() {
  if (connection) disconnect(connection);
  mapping = null;
  loading = false;
  playGeneration++;
}
function send(c, method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = method === "auth" ? 15 * 6e4 : method === "setup" ? 10 * 6e4 : 65e3;
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(error("unavailable", "Native playback command timed out"));
      disconnect(c);
    }, timeout);
    c.pending.set(id, { resolve, reject, timer });
    try {
      c.proc.write(JSON.stringify({ id, method, params }) + "\n");
    } catch {
      clearTimeout(timer);
      c.pending.delete(id);
      reject(error("unavailable", "Native playback connection closed"));
      disconnect(c);
    }
  });
}
function connect() {
  if (typeof host === "undefined" || typeof host.spawn !== "function") throw error("setup", "Allow the Apple Music plugin to start the native playback core");
  if (connection?.owner === host) return connection;
  if (connection) disconnect(connection);
  if (!(host.platform === "darwin" && host.arch === "arm64") && !(["windows", "linux"].includes(host.platform) && host.arch === "amd64")) {
    throw error("unsupported", "Native playback supports macOS ARM64, Windows x64 and Linux x64");
  }
  const binary = `bin/apple-music-core-${host.platform}-${host.arch}${host.platform === "windows" ? ".exe" : ""}`;
  let proc;
  try {
    proc = host.spawn(binary, ["--data-dir", `${host.dataDir}/native-core`, "--language", host.language?.() || "en", "--app-name", "MyGo Music"]);
  } catch {
    throw error("setup", "Install the native playback bundle and allow this plugin to start programs");
  }
  const c = { proc, owner: host, pending: /* @__PURE__ */ new Map(), ready: Promise.resolve(), healthAt: 0 };
  connection = c;
  void (async () => {
    try {
      for (let line; (line = await proc.readLine()) !== null; ) {
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        const item = c.pending.get(reply.id);
        if (!item) continue;
        c.pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.ok !== true) {
          const code = ["signIn", "setup", "unsupported"].includes(reply.error?.code) ? reply.error.code : "unavailable";
          const message = code === "signIn" ? "Sign in using the native account window" : code === "setup" ? "Install or repair the native runtime" : code === "unsupported" ? "This track, quality or platform is not supported" : "Native operation failed";
          item.reject(error(code, message));
        } else item.resolve(reply.result ?? null);
      }
    } catch {
    } finally {
      disconnect(c);
    }
  })();
  c.ready = send(c, "hello", {}).then((value) => {
    if (value?.protocol !== 1) {
      disconnect(c);
      throw error("setup", "Update the native playback core to a compatible version");
    }
  });
  return c;
}
async function nativeCommand(method, params = {}) {
  const c = connect();
  await c.ready;
  return send(c, method, params);
}
function beginNativePlay() {
  if (connection && connection.owner !== host) disconnect(connection);
  loading = true;
  return ++playGeneration;
}
function isCurrentNativePlay(generation) {
  return generation === playGeneration;
}
function finishNativeLoading(generation) {
  if (isCurrentNativePlay(generation)) loading = false;
}
async function nativePlay(meta, position, generation) {
  const id = meta.catalogId || meta.id;
  if (!/^\d{1,24}$/.test(id)) throw error("unsupported", "Native playback currently supports catalog songs; radio and uploaded tracks are unavailable");
  const requestedQuality = String(host.setting("audioQuality") || "hires").toLowerCase();
  const quality = requestedQuality === "lossless" ? "lossless" : "hires";
  if (!isCurrentNativePlay(generation)) return;
  await nativeCommand("play", { trackId: id, position, quality });
  if (isCurrentNativePlay(generation)) mapping = { requested: meta.id, catalog: id };
}
async function nativeState() {
  if (!connection || loading) return null;
  const state = await nativeCommand("state");
  const current = connection;
  if (state?.outputStats && current && Date.now() >= current.healthAt) {
    current.healthAt = Date.now() + 1e4;
    try {
      if (await current.owner.storage.get("native_playback_health_enabled") === true) {
        const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
        await current.owner.storage.set("native_playback_health", {
          sampledAt: Date.now(),
          status: ["buffering", "playing", "paused", "ended", "error"].includes(state.status) ? state.status : "unknown",
          position: number(state.position),
          duration: number(state.duration),
          sampleRate: number(state.format?.sampleRate),
          bits: number(state.format?.bits),
          outputRate: number(state.outputRate),
          underruns: number(state.outputStats.underruns),
          queuedFrames: number(state.outputStats.queuedFrames),
          capacityFrames: number(state.outputStats.capacityFrames)
        });
      }
    } catch {
    }
  }
  if (!state || ["idle", "ended"].includes(state.status)) return null;
  if (state.status === "error") throw error(state.error === "signIn" ? "signIn" : "unavailable", "Native operation failed");
  return {
    playing: state.status !== "paused",
    trackId: mapping && state.trackId === mapping.catalog ? mapping.requested : state.trackId,
    position: Number(state.position) || 0,
    duration: Number(state.duration) || 0,
    volume: Number.isFinite(state.volume) ? state.volume : 100,
    device: "default"
  };
}
async function nativeDevices() {
  return [{ id: "default", name: typeof host !== "undefined" && typeof host.t === "function" ? host.t("System Audio Output") : "System Audio Output", active: true }];
}

// src/lyrics.ts
function parseTtmlTimestamp(raw) {
  if (!raw) return void 0;
  const s = raw.trim();
  if (!s) return void 0;
  if (s.endsWith("ms")) {
    const ms = parseFloat(s.slice(0, -2));
    return Number.isFinite(ms) ? Math.round(ms) : void 0;
  }
  if (s.endsWith("s")) {
    const sec = parseFloat(s.slice(0, -1));
    return Number.isFinite(sec) ? Math.round(sec * 1e3) : void 0;
  }
  const parts = s.split(":");
  if (parts.length === 3) {
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const sec = parseFloat(parts[2]);
    if ([h, m, sec].every(Number.isFinite)) {
      return Math.round((h * 3600 + m * 60 + sec) * 1e3);
    }
  } else if (parts.length === 2) {
    const m = parseFloat(parts[0]);
    const sec = parseFloat(parts[1]);
    if ([m, sec].every(Number.isFinite)) {
      return Math.round((m * 60 + sec) * 1e3);
    }
  } else {
    const sec = parseFloat(s);
    if (Number.isFinite(sec)) {
      return Math.round(sec * 1e3);
    }
  }
  return void 0;
}
function decodeXmlEntities(str) {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}
function stripXmlTags(str) {
  return decodeXmlEntities(str.replace(/<[^>]+>/g, ""));
}
function parseAppleTTML(ttml) {
  if (!ttml || typeof ttml !== "string") return {};
  const keyTranslations = /* @__PURE__ */ new Map();
  const transBlockRegex = /<translation\b[^>]*>([\s\S]*?)<\/translation>/gi;
  let tbMatch;
  while ((tbMatch = transBlockRegex.exec(ttml)) !== null) {
    const block = tbMatch[1];
    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let tm;
    while ((tm = textRegex.exec(block)) !== null) {
      const attrs = tm[1];
      const body = stripXmlTags(tm[2]).trim();
      const forMatch = attrs.match(/(?:itunes:)?for="([^"]+)"/i);
      if (forMatch && body) {
        keyTranslations.set(forMatch[1], body);
      }
    }
  }
  const lines = [];
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(ttml)) !== null) {
    const pAttrs = pMatch[1];
    let pInner = pMatch[2];
    const beginMatch = pAttrs.match(/\bbegin="([^"]+)"/i);
    const endMatch = pAttrs.match(/\bend="([^"]+)"/i);
    const keyMatch = pAttrs.match(/\bitunes:key="([^"]+)"/i);
    const pStart = parseTtmlTimestamp(beginMatch?.[1]);
    if (pStart === void 0) continue;
    const pEnd = parseTtmlTimestamp(endMatch?.[1]);
    let inlineTranslation = "";
    pInner = pInner.replace(
      /<span\b[^>]*ttm:role="x-translation"[^>]*>([\s\S]*?)<\/span>/gi,
      (_, transText) => {
        const clean = stripXmlTags(transText).trim();
        if (clean) inlineTranslation = clean;
        return "";
      }
    );
    const translation = inlineTranslation || (keyMatch ? keyTranslations.get(keyMatch[1]) : void 0);
    const words = [];
    const spanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>(\s*)/gi;
    let sMatch;
    while ((sMatch = spanRegex.exec(pInner)) !== null) {
      const sAttrs = sMatch[1];
      const sBody = sMatch[2];
      const trailingSpace = sMatch[3] ? " " : "";
      if (/ttm:role="x-bg"/i.test(sAttrs)) {
        let innerMatch;
        const innerSpanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>(\s*)/gi;
        while ((innerMatch = innerSpanRegex.exec(sBody)) !== null) {
          const wStart2 = parseTtmlTimestamp(innerMatch[1].match(/\bbegin="([^"]+)"/i)?.[1]);
          const wEnd2 = parseTtmlTimestamp(innerMatch[1].match(/\bend="([^"]+)"/i)?.[1]);
          const wText2 = stripXmlTags(innerMatch[2]) + (innerMatch[3] ? " " : "");
          if (wStart2 !== void 0 && wEnd2 !== void 0 && wText2) {
            words.push({ start: wStart2, end: wEnd2, text: wText2 });
          }
        }
        continue;
      }
      const wStart = parseTtmlTimestamp(sAttrs.match(/\bbegin="([^"]+)"/i)?.[1]);
      const wEnd = parseTtmlTimestamp(sAttrs.match(/\bend="([^"]+)"/i)?.[1]);
      const wText = stripXmlTags(sBody) + trailingSpace;
      if (wStart !== void 0 && wEnd !== void 0 && wText) {
        words.push({ start: wStart, end: wEnd, text: wText });
      }
    }
    if (words.length > 0) {
      words[words.length - 1].text = words[words.length - 1].text.trimEnd();
    }
    const plainText = stripXmlTags(pInner).replace(/\s+/g, " ").trim();
    if (!plainText && words.length === 0) continue;
    const line = {
      start: pStart,
      ...pEnd !== void 0 ? { end: pEnd } : {},
      ...plainText ? { text: plainText } : {},
      ...translation ? { translation } : {},
      ...words.length > 0 ? { words } : {}
    };
    lines.push(line);
  }
  if (lines.length === 0) return {};
  lines.sort((a, b) => a.start - b.start);
  return { lines };
}

// src/index.ts
var DEFAULT_DEV_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw";
var AMP_API_BASE = "https://amp-api.music.apple.com/v1";
var TRACK_CACHE_LIMIT = 2e3;
var trackMetaCache = /* @__PURE__ */ new Map();
var PLUGIN_ERROR_CODES = /* @__PURE__ */ new Set(["signIn", "setup", "unavailable", "unsupported"]);
function isPluginError(err) {
  return Boolean(err && typeof err.code === "string" && PLUGIN_ERROR_CODES.has(err.code));
}
function rememberTrackMeta(meta) {
  if (!meta.id) return;
  if (trackMetaCache.size >= TRACK_CACHE_LIMIT && !trackMetaCache.has(meta.id)) {
    const oldest = trackMetaCache.keys().next().value;
    if (oldest !== void 0) trackMetaCache.delete(oldest);
  }
  trackMetaCache.set(meta.id, meta);
  if (meta.catalogId && meta.catalogId !== meta.id) {
    trackMetaCache.set(meta.catalogId, meta);
  }
}
function tr(text) {
  return typeof host !== "undefined" && typeof host.t === "function" ? host.t(text) : text;
}
function parseJwtExp(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const jsonStr = typeof atob === "function" ? atob(b64) : typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("utf-8") : "";
    if (!jsonStr) return null;
    const payload = JSON.parse(jsonStr);
    return typeof payload.exp === "number" ? payload.exp * 1e3 : null;
  } catch {
    return null;
  }
}
function extractCookieMediaUserToken(cookie) {
  if (!cookie || typeof cookie !== "string") return "";
  const match = cookie.match(/(?:^|;\s*)media-user-token=([^;]+)/);
  if (!match || !match[1]) return "";
  return match[1].trim().replace(/^"|"$/g, "").trim();
}
function cleanMediaUserToken(raw) {
  if (!raw || typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";
  if (s.includes("media-user-token=") || s.includes(";")) {
    return extractCookieMediaUserToken(s);
  }
  return s.replace(/^"|"$/g, "").trim();
}
async function getStoredMediaUserToken() {
  if (typeof host !== "undefined") {
    if (host.storage) {
      try {
        const auth = await host.storage.get("auth");
        const fromStorage = cleanMediaUserToken(auth?.mediaUserToken);
        if (fromStorage) return fromStorage;
      } catch {
      }
    }
  }
  return "";
}
function formatArtworkUrl(url, size = 600, crop = "bb") {
  if (!url) return void 0;
  return url.replace("{w}x{h}", `${size}x${size}`).replace("{w}", String(size)).replace("{h}", String(size)).replace("{c}", crop).replace("-{q}", "").replace("{q}", "80").replace("{f}", "jpg");
}
function extractAlbumIdFromUrl(url) {
  if (!url || typeof url !== "string") return void 0;
  const m = url.match(/\/album\/[^/?#]+\/(\d+)/);
  return m?.[1];
}
function mapTrack(item) {
  const attr = item?.attributes || {};
  const id = String(item?.id ?? "");
  const catalogId = attr.playParams?.catalogId || item?.relationships?.catalog?.data?.[0]?.id || (/^\d+$/.test(id) ? id : void 0);
  const albumId = item?.relationships?.albums?.data?.[0]?.id || extractAlbumIdFromUrl(attr.url) || attr.albumName || "";
  const artistId = item?.relationships?.artists?.data?.[0]?.id || attr.artistName || "";
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
      isrc: attr.isrc
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
      imageUrl
    },
    artwork: imageUrl,
    imageUrl,
    duration: durationMs,
    durationInMillis: durationMs,
    trackNumber: attr.trackNumber,
    discNumber: attr.discNumber,
    isrc: attr.isrc,
    explicit: attr.contentRating === "explicit",
    url: attr.url || void 0
  };
}
function mapAlbum(item) {
  const attr = item?.attributes || {};
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  const artistId = item?.relationships?.artists?.data?.[0]?.id || attr.artistName || "";
  return {
    id: String(item?.id ?? ""),
    name: attr.name,
    title: attr.name,
    artist: attr.artistName,
    artists: attr.artistName ? [{ id: String(artistId), name: attr.artistName }] : [],
    artwork: imageUrl,
    imageUrl,
    trackCount: attr.trackCount,
    year: attr.releaseDate ? parseInt(attr.releaseDate.split("-")[0], 10) : void 0,
    released: attr.releaseDate,
    description: attr.editorialNotes?.short || attr.editorialNotes?.standard,
    url: attr.url
  };
}
function mapArtist(item) {
  const attr = item?.attributes || {};
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  return {
    id: String(item?.id ?? ""),
    name: attr.name,
    artwork: imageUrl,
    imageUrl,
    url: attr.url
  };
}
function mapPlaylist(item) {
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
    description: attr.description?.short || attr.description?.standard || attr.editorialNotes?.short || attr.editorialNotes?.standard,
    owner: attr.curatorName,
    curator: attr.curatorName,
    trackCount: attr.trackCount,
    mine: isLibrary ? Boolean(attr.canEdit ?? true) : false,
    saved: isLibrary ? !Boolean(attr.canEdit ?? true) : void 0,
    url: attr.url
  };
}
async function getDeveloperToken() {
  if (typeof host !== "undefined" && host.storage) {
    try {
      const native = await host.storage.get("native_developer_token");
      if (native && (parseJwtExp(native) || 0) > Date.now() + 6e4) return native;
      const cached = await host.storage.get("developer_token");
      const cachedExp = await host.storage.get("developer_token_exp");
      if (cached && cachedExp && Date.now() < cachedExp - 864e5) {
        return cached;
      }
    } catch (_) {
    }
  }
  try {
    const htmlRes = await fetch("https://music.apple.com/us/browse", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
      }
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
              }
            }
            return token;
          }
        }
      }
    }
  } catch (_) {
  }
  return DEFAULT_DEV_TOKEN;
}
async function getStorefront() {
  if (typeof host !== "undefined") {
    if (host.setting) {
      const rawSetting = host.setting("storefront");
      const settingSf = typeof rawSetting === "string" ? rawSetting.trim().toLowerCase() : "";
      if (settingSf) {
        return settingSf;
      }
    }
    if (host.storage) {
      try {
        const auth = await host.storage.get("auth");
        if (auth && typeof auth.storefront === "string") {
          const authSf = auth.storefront.trim().toLowerCase();
          if (authSf) {
            return authSf;
          }
        }
      } catch (_) {
      }
    }
    if (host.language && host.language() === "zh-CN") {
      return "cn";
    }
  }
  return "us";
}
async function requestApi(endpoint, options = {}) {
  const { requireAuth = false, ...fetchOpts } = options;
  const mediaUserToken = await getStoredMediaUserToken();
  if (requireAuth && !mediaUserToken) {
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }
  const devToken = await getDeveloperToken();
  const headers = {
    Authorization: `Bearer ${devToken}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    Accept: "application/json",
    ...fetchOpts.headers || {}
  };
  if (mediaUserToken) {
    headers["Music-User-Token"] = mediaUserToken;
  }
  const url = endpoint.startsWith("http") ? endpoint : `${AMP_API_BASE}${endpoint}`;
  let res;
  try {
    res = await fetch(url, { ...fetchOpts, headers });
  } catch (err) {
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
      } catch (_) {
      }
    }
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }
  if (res.status === 403) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        await host.storage.remove("auth");
      } catch (_) {
      }
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
async function resolveTrackMeta(id) {
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
  if (cleanId.startsWith("ra.") || APPLE_MUSIC_LIVE_STATIONS.some((s) => s.id === cleanId)) {
    const liveMatch = APPLE_MUSIC_LIVE_STATIONS.find((s) => s.id === cleanId);
    let name = liveMatch?.name || "Apple Music Radio";
    let artistName = "Apple Music Radio";
    let imageUrl = liveMatch?.imageUrl;
    let stationUrl = `https://music.apple.com/${sf}/station/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/${encodeURIComponent(cleanId)}`;
    try {
      const stJson = await requestApi(`/catalog/${sf}/stations/${encodeURIComponent(cleanId)}?l=${lang}`);
      const st = stJson?.data?.[0];
      if (st?.attributes) {
        if (st.attributes.name) name = st.attributes.name;
        if (st.attributes.url) stationUrl = st.attributes.url;
        if (st.attributes.artwork?.url) {
          imageUrl = formatArtworkUrl(st.attributes.artwork.url, 600);
        }
      }
    } catch {
    }
    const meta = {
      id: cleanId,
      name,
      artistName,
      albumName: "",
      durationMs: 0,
      url: stationUrl,
      imageUrl
    };
    trackMetaCache.set(cleanId, meta);
    return meta;
  }
  if (cleanId.startsWith("i.")) {
    const json2 = await requestApi(`/me/library/songs/${encodeURIComponent(cleanId)}?l=${lang}`, {
      requireAuth: true
    });
    const song2 = json2.data?.[0];
    if (!song2) {
      throw fail("unavailable", tr("This track is unavailable for streaming"));
    }
    mapTrack(song2);
    const resolved2 = trackMetaCache.get(cleanId);
    if (resolved2) return resolved2;
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
async function search(options) {
  const {
    query: rawQuery,
    kind = "tracks",
    offset = 0,
    limit: rawLimit
  } = options || {};
  const query = typeof rawQuery === "string" ? rawQuery.trim() : rawQuery != null ? String(rawQuery).trim() : "";
  if (!query) {
    return { [kind]: [], more: false };
  }
  const sf = await getStorefront();
  const typeMap = {
    tracks: "songs",
    albums: "albums",
    artists: "artists",
    playlists: "playlists"
  };
  const appleType = typeMap[kind] || "songs";
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  let limit = 20;
  if (rawLimit !== void 0 && rawLimit !== null) {
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
  let mappedItems = [];
  if (kind === "albums") {
    mappedItems = items.map(mapAlbum);
  } else if (kind === "artists") {
    mappedItems = items.map(mapArtist);
  } else if (kind === "playlists") {
    mappedItems = items.map(mapPlaylist);
  } else {
    mappedItems = items.map(mapTrack);
    registerNaturalTrackOrder(mappedItems);
  }
  return {
    [kind]: mappedItems,
    more: hasMore
  };
}
async function suggest(options) {
  const { query: rawQuery } = options || {};
  const query = typeof rawQuery === "string" ? rawQuery.trim() : rawQuery != null ? String(rawQuery).trim() : "";
  if (!query) {
    return [];
  }
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (text) => {
    if (!text) return;
    const clean = text.trim();
    if (!clean) return;
    if (clean.toLowerCase() === query.toLowerCase()) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
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
  } catch {
  }
  if (out.length === 0) {
    try {
      const hintUrl = `/catalog/${sf}/search/hints?term=${encodeURIComponent(query)}&l=${lang}`;
      const hintJson = await requestApi(hintUrl);
      for (const t of hintJson.results?.terms || []) {
        add(t);
      }
    } catch {
    }
  }
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
    } catch {
    }
  }
  return out.slice(0, 8);
}
function getLocalTimezoneOffset(date = /* @__PURE__ */ new Date()) {
  const offset = date.getTimezoneOffset();
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const sign = offset > 0 ? "-" : "+";
  return `${sign}${hh}:${mm}`;
}
function extractBestArtworkUrl(item, size = 600) {
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
    "brandLogo"
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
  return void 0;
}
function resolveResourceRef(ref, resourcesMap) {
  if (!ref) return null;
  if (resourcesMap && ref.type && ref.id != null) {
    const found = resourcesMap[ref.type]?.[String(ref.id)];
    if (found) {
      return ref.meta ? { ...found, meta: { ...found.meta || {}, ...ref.meta } } : found;
    }
  }
  return ref;
}
function parseEditorialLinkToPage(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  const fcMatch = urlStr.match(/[?&]fcId=(\d+)/i) || urlStr.match(/\/room\/[^/?#]+\/(\d+)/i);
  if (fcMatch?.[1]) return `room:${fcMatch[1]}`;
  const grpMatch = urlStr.match(/viewGrouping\?[^#]*\bid=(\d+)/i) || urlStr.match(/\/grouping\/(?:[^/?#]+\/)?(?:id)?(\d+)/i);
  if (grpMatch?.[1]) return `grouping:${grpMatch[1]}`;
  const curMatch = urlStr.match(/\/curator\/[^/?#]+\/(\d+)/i);
  if (curMatch?.[1]) return `apple-curator:${curMatch[1]}`;
  return null;
}
function createSectionBuckets() {
  return {
    tracks: [],
    albums: [],
    artists: [],
    playlists: [],
    stations: [],
    links: [],
    seen: /* @__PURE__ */ new Set()
  };
}
function collectResourceIntoBuckets(rawRef, buckets, resourcesMap, depth = 0) {
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
        subtitle: attr.subtitle || attr.designBadge || void 0,
        imageUrl: extractBestArtworkUrl(item, 600),
        page: linkPage
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
    const catalogId = item.meta?.catalogIds?.[0] || item.attributes?.playParams?.catalogId || item.relationships?.catalog?.data?.[0]?.id;
    const catAlbum = catalogId && resourcesMap?.["albums"]?.[String(catalogId)] ? resourcesMap["albums"][String(catalogId)] : null;
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
    const catalogId = item.meta?.catalogIds?.[0] || item.attributes?.playParams?.catalogId || item.relationships?.catalog?.data?.[0]?.id;
    const catPl = catalogId && resourcesMap?.["playlists"]?.[String(catalogId)] ? resourcesMap["playlists"][String(catalogId)] : null;
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
      description: attr.editorialNotes?.short || attr.plainEditorialNotes?.short || attr.editorialNotes?.tagline || void 0,
      imageUrl: extractBestArtworkUrl(item, 600)
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
      subtitle: attr.plainEditorialNotes?.short || attr.editorialNotes?.short || void 0,
      imageUrl: extractBestArtworkUrl(item, 600),
      page: pageTarget
    });
    return;
  }
  if (type === "editorial-items" || type === "activities") {
    const attr = item.attributes || {};
    const name = attr.name || attr.plainEditorialNotes?.name || attr.plainEditorialNotes?.badge || attr.editorialNotes?.name;
    const linkPage = parseEditorialLinkToPage(attr.url || attr.link?.url);
    if (name && linkPage && !buckets.seen.has(`link:${linkPage}`)) {
      buckets.seen.add(`link:${linkPage}`);
      buckets.links.push({
        title: String(name),
        subtitle: attr.plainEditorialNotes?.short || attr.editorialNotes?.short || void 0,
        imageUrl: extractBestArtworkUrl(item, 600),
        page: linkPage
      });
    }
  }
}
function bucketsToSplitEntries(title, buckets, morePage, subtitle) {
  const groups = [];
  if (buckets.tracks.length > 0) {
    groups.push({
      kind: "tracks",
      label: tr("Songs"),
      count: buckets.tracks.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "tracks",
        tracks: buckets.tracks,
        items: buckets.tracks
      })
    });
  }
  if (buckets.albums.length > 0) {
    groups.push({
      kind: "albums",
      label: tr("Albums"),
      count: buckets.albums.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "albums",
        albums: buckets.albums,
        items: buckets.albums
      })
    });
  }
  if (buckets.artists.length > 0) {
    groups.push({
      kind: "artists",
      label: tr("Artists"),
      count: buckets.artists.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "artists",
        artists: buckets.artists,
        items: buckets.artists
      })
    });
  }
  if (buckets.playlists.length > 0) {
    groups.push({
      kind: "playlists",
      label: tr("Playlists"),
      count: buckets.playlists.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "playlists",
        playlists: buckets.playlists,
        items: buckets.playlists
      })
    });
  }
  if (buckets.stations.length > 0) {
    groups.push({
      kind: "stations",
      label: tr("Stations"),
      count: buckets.stations.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        stations: buckets.stations
      })
    });
  }
  if (buckets.links.length > 0) {
    groups.push({
      kind: "links",
      label: tr("Browse"),
      count: buckets.links.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        links: buckets.links
      })
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
        count: g.count
      }
    ];
  }
  groups.sort((a, b) => b.count - a.count);
  return groups.map((g, idx) => {
    const isPrimary = idx === 0;
    const secTitle = isPrimary ? title : title ? `${title} \xB7 ${g.label}` : g.label;
    return {
      section: g.build(secTitle, isPrimary ? morePage : void 0, isPrimary ? subtitle : void 0),
      isOverflow: !isPrimary,
      itemKind: g.kind,
      count: g.count
    };
  });
}
function consolidateSplitEntries(entries) {
  const getArrayForKind = (sec, kind) => {
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
  const setArrayForKind = (sec, kind, arr) => {
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
  const preferredKeywords = {
    playlists: /made for you|为你推荐|playlist|歌单/i,
    stations: /station|radio|广播|电台/i,
    albums: /new release|新发行|album|专辑/i,
    tracks: /song|track|歌曲/i,
    artists: /artist|艺人/i,
    links: /mood|genre|browse|浏览/i
  };
  const absorbed = /* @__PURE__ */ new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.isOverflow || e.count !== 1) continue;
    const srcItems = getArrayForKind(e.section, e.itemKind);
    if (!srcItems || srcItems.length === 0) continue;
    const candidates = entries.filter(
      (cand, idx) => idx !== i && !absorbed.has(idx) && !cand.isOverflow && cand.itemKind === e.itemKind
    );
    if (candidates.length === 0) continue;
    const target = candidates.find((c) => preferredKeywords[e.itemKind].test(c.section.title || "")) || candidates[0];
    const dstItems = getArrayForKind(target.section, e.itemKind) || [];
    const keyOf = (obj) => String(obj?.id || obj?.page || "");
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
function bucketsToSections(title, buckets, morePage, subtitle) {
  return bucketsToSplitEntries(title, buckets, morePage, subtitle).map((e) => e.section);
}
function resolveRecommendationTitle(rec, resourcesMap) {
  const attr = rec?.attributes || {};
  const directTitle = typeof attr.title === "string" ? attr.title.trim() : String(attr.title?.stringForDisplay || "").trim();
  const reasonText = String(attr.reason?.stringForDisplay || "").trim();
  if (directTitle) {
    return { title: directTitle, subtitle: reasonText || void 0 };
  }
  const prefix = String(attr.titleWithoutName?.stringForDisplay || "").trim();
  const primaryRef = rec?.relationships?.["primary-content"]?.data?.[0];
  const primaryRes = resolveResourceRef(primaryRef, resourcesMap);
  const primaryName = String(primaryRes?.attributes?.name || "").trim();
  if (prefix && primaryName) {
    return { title: `${prefix} ${primaryName}`, subtitle: reasonText || void 0 };
  }
  if (primaryName) {
    return { title: primaryName, subtitle: reasonText || void 0 };
  }
  if (reasonText) {
    return { title: reasonText };
  }
  return { title: tr("Recommended For You") };
}
function parseRecommendationsToSections(json, allowMorePage = true) {
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const resourcesMap = json?.resources;
  const entries = [];
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
    const morePage = allowMorePage && rec.id && rec.attributes?.hasSeeAll === true ? `reco:${rec.id}` : void 0;
    entries.push(...bucketsToSplitEntries(title, buckets, morePage, subtitle));
  }
  return consolidateSplitEntries(entries);
}
async function fetchPersonalizedHome(sf, lang) {
  const tz = encodeURIComponent(getLocalTimezoneOffset());
  const listenNowQuery = `/me/recommendations?name=listen-now&platform=web&format[resources]=map&with=library,social,friendsMix&types=activities,albums,apple-curators,artists,curators,editorial-items,library-albums,library-playlists,playlists,songs,stations&include[albums]=artists&include[library-playlists]=catalog&include[library-albums]=catalog&include[personal-recommendation]=contents,primary-content&extend=plainEditorialNotes,plainEditorialCard,editorialArtwork&extend[playlists]=artistNames&fields[artists]=name,artwork,url&omit[resource]=autos&displayFilter[kind]=MusicCardShelf,MusicCircleCoverShelf,MusicCoverGrid,MusicCoverShelf,MusicHorizontalLockupGrid,MusicNotesHeroShelf,MusicSuperHeroShelf&timezone=${tz}&l=${encodeURIComponent(lang)}`;
  try {
    const json = await requestApi(listenNowQuery, { requireAuth: true });
    const sections = parseRecommendationsToSections(json, true);
    if (sections.length > 0) {
      return {
        title: tr("Home"),
        sections
      };
    }
  } catch (err) {
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
        sections
      };
    }
  } catch (err) {
    if (err?.code === "signIn") throw err;
  }
  return null;
}
async function buildChartsBrowse(sf, lang, pageTitle = tr("Charts")) {
  const url = `/catalog/${sf}/charts?types=songs,albums,playlists&limit=20&l=${lang}`;
  const json = await requestApi(url);
  const charts = json.results || {};
  const sections = [];
  if (charts.songs?.[0]?.data?.length) {
    const mapped = charts.songs[0].data.map(mapTrack);
    sections.push({
      title: tr("Top Songs"),
      kind: "tracks",
      tracks: mapped,
      items: mapped,
      morePage: "charts-songs"
    });
  }
  if (charts.playlists?.[0]?.data?.length) {
    const mapped = charts.playlists[0].data.map(mapPlaylist);
    sections.push({
      title: tr("Top Playlists"),
      kind: "playlists",
      playlists: mapped,
      items: mapped,
      morePage: "charts-playlists"
    });
  }
  if (charts.albums?.[0]?.data?.length) {
    const mapped = charts.albums[0].data.map(mapAlbum);
    sections.push({
      title: tr("Top Albums"),
      kind: "albums",
      albums: mapped,
      items: mapped,
      morePage: "charts-albums"
    });
  }
  return {
    title: pageTitle,
    sections
  };
}
function parseEditorialGroupingBrowse(json, fallbackTitle) {
  const resourcesMap = json?.resources;
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const rootGrouping = resolveResourceRef(dataRefs[0], resourcesMap) || (resourcesMap?.groupings ? Object.values(resourcesMap.groupings)[0] : null);
  const pageTitle = String(rootGrouping?.attributes?.name || fallbackTitle);
  const sections = [];
  const tabRefs = rootGrouping?.relationships?.tabs?.data || [];
  const shelfRefs = [];
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
            page: linkPage
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
    const morePage = roomRef?.id ? `room:${roomRef.id}` : void 0;
    const shelfTitle = attr.title || attr.name || (kind === "316" ? tr("Featured") : "");
    if (!shelfTitle && buckets.links.length === 0 && buckets.albums.length === 0 && buckets.playlists.length === 0) {
      continue;
    }
    sections.push(...bucketsToSections(shelfTitle || tr("Featured"), buckets, morePage));
  }
  return {
    title: pageTitle,
    sections
  };
}
async function buildRecommendationSeeAllBrowse(recId, lang) {
  const tz = encodeURIComponent(getLocalTimezoneOffset());
  const seeAllUrl = `/me/recommendations/${encodeURIComponent(recId)}/view/see-all?action=refresh&name=listen-now&platform=web&format[resources]=map&include[personal-recommendation]=contents&include[library-playlists]=catalog&include[library-albums]=catalog&limit[contents]=100&omit[resource]=autos&with=library,social,friendsMix&types=artists,albums,apple-curators,curators,editorial-items,library-albums,library-playlists,playlists,songs,stations&timezone=${tz}&l=${encodeURIComponent(lang)}`;
  let json = null;
  try {
    json = await requestApi(seeAllUrl, { requireAuth: true });
  } catch (err) {
    if (err?.code === "signIn") throw err;
    json = await requestApi(
      `/me/recommendations/${encodeURIComponent(recId)}?l=${encodeURIComponent(lang)}`,
      { requireAuth: true }
    );
  }
  const rootRec = resolveResourceRef(json?.data?.[0], json?.resources);
  const resolvedTitle = rootRec ? resolveRecommendationTitle(rootRec, json?.resources).title : "";
  const sections = parseRecommendationsToSections(json, false);
  const title = resolvedTitle || sections[0]?.title || tr("Recommended For You");
  if (sections.length === 1) {
    sections[0] = { ...sections[0], title: "" };
  }
  return {
    title,
    sections
  };
}
async function buildCuratorBrowse(sf, curatorId, isAppleCurator, lang) {
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
  const desc = attr.editorialNotes?.short || attr.editorialNotes?.standard || void 0;
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
          sections: grpBrowse.sections
        };
      }
    } catch {
    }
  }
  const playlistItems = item.relationships?.playlists?.data || [];
  const mappedPlaylists = playlistItems.map(mapPlaylist);
  return {
    title,
    description: desc,
    sections: mappedPlaylists.length > 0 ? [
      {
        title: tr("Playlists"),
        kind: "playlists",
        playlists: mappedPlaylists,
        items: mappedPlaylists
      }
    ] : []
  };
}
async function buildRoomBrowse(sf, roomId, lang) {
  const json = await requestApi(
    `/editorial/${sf}/rooms/${encodeURIComponent(roomId)}?platform=web&format[resources]=map&omit[resource:artists]=autos&l=${encodeURIComponent(lang)}`
  );
  const resourcesMap = json?.resources;
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const room = resolveResourceRef(dataRefs[0], resourcesMap) || (resourcesMap?.rooms ? Object.values(resourcesMap.rooms)[0] : null);
  if (!room) {
    throw fail("unavailable", `Room not found: ${roomId}`);
  }
  const attr = room.attributes || {};
  const title = String(attr.title || attr.name || tr("Browse"));
  const desc = attr.editorialNotes?.short || attr.plainEditorialNotes?.short || void 0;
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
    sections: roomSections
  };
}
async function home() {
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
function dedupeLibraryAlbums(rawItems, lang = "en") {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];
  const groups = /* @__PURE__ */ new Map();
  for (const item of rawItems) {
    if (item?.type && !String(item.type).includes("album")) {
      continue;
    }
    const catalogId = item.relationships?.catalog?.data?.[0]?.id || item.attributes?.playParams?.catalogId;
    const artworkUrl = item.attributes?.artwork?.url || "";
    const artKeyMatch = artworkUrl.match(/\/thumb\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/([^/]+)\/([^/]+)/);
    const artKey = artKeyMatch ? artKeyMatch[2] : artworkUrl ? artworkUrl.slice(-40) : "";
    const key = catalogId ? `cat:${catalogId}` : artKey ? `art:${artKey}` : `id:${item.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  const deduped = [];
  for (const [, items] of groups.entries()) {
    if (items.length === 1) {
      deduped.push(items[0]);
    } else {
      const withTracks = items.find((it) => (it.attributes?.trackCount ?? 0) > 0) || items[0];
      const merged = { ...withTracks, attributes: { ...withTracks.attributes } };
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
async function buildMyPageBrowse(sf, lang) {
  const token = await getStoredMediaUserToken();
  if (!token) {
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }
  const [acc, allPlaylists] = await Promise.all([
    account().catch(() => null),
    playlists().catch(() => [])
  ]);
  const sections = [];
  const myPlaylists = allPlaylists.filter((p) => p.mine);
  const displayPlaylists = myPlaylists.length > 0 ? myPlaylists : allPlaylists;
  if (displayPlaylists.length > 0) {
    sections.push({
      title: myPlaylists.length > 0 ? tr("My Playlists") : tr("Playlists"),
      kind: "playlists",
      playlists: displayPlaylists,
      items: displayPlaylists
    });
  }
  const hasHandle = Boolean(acc?.id && !acc.id.startsWith("apple-music-"));
  const subtitle = hasHandle ? `@${acc.id}` : void 0;
  const desc = `Apple Music (${sf.toUpperCase()})`;
  return {
    title: acc?.name || tr("Library"),
    subtitle,
    description: desc,
    imageUrl: acc?.imageUrl || void 0,
    sections
  };
}
var APPLE_MUSIC_LIVE_STATIONS = [
  {
    id: "ra.978194965",
    name: "Apple Music 1",
    description: "Live 24/7 \u2022 The new music that matters.",
    imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/f2/52/f6/f252f662-44e1-8860-73e8-5dab557d3e52/35d45158-76c3-4b9a-9a77-9a44317c1d79.png/600x600sr.jpg"
  },
  {
    id: "ra.1498155548",
    name: "Apple Music Hits",
    description: "The songs you know and love from the '80s, '90s, and 2000s.",
    imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/40/0f/72/400f7213-1311-a1d6-dd9d-f88d10b0c80f/51c24bce-b22a-4fea-aa1e-68e3d2b1163e.png/600x600sr.jpg"
  },
  {
    id: "ra.1498157166",
    name: "Apple Music Country",
    description: "Where country music lives.",
    imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/0e/eb/97/0eeb9759-323e-2aae-86e9-163feabb65c2/66506341-7a2f-4856-b736-644f62be6db1.png/600x600sr.jpg"
  },
  {
    id: "ra.1740613864",
    name: "Apple M\xFAsica Uno",
    description: "Lo mejor de los ritmos latinos.",
    imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/b0/dc/ef/b0dcefce-8977-2d47-282e-d79f045faf86/0f602447-188e-4d25-adcd-bd0446a11fae.png/600x600sr.jpg"
  },
  {
    id: "ra.1740614260",
    name: "Apple Music Chill",
    description: "Laid-back beats, acoustic vibes, and ambient sounds.",
    imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/0f/84/79/0f84796e-235a-eaec-f05a-97dee282de94/660c1ef8-7f4e-4f8f-8577-3dbdfeac0231.png/600x600sr.jpg"
  },
  {
    id: "ra.1740613859",
    name: "Apple Music Club",
    description: "The biggest dance and electronic tracks worldwide.",
    imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/17/34/71/1734717d-a753-062a-237c-65308b49135e/ba52d55d-5e41-4cce-bdc5-07ea61dc6c9b.png/600x600sr.jpg"
  }
];
async function buildAppleBrowse(sf, lang, pageTitle = tr("Browse")) {
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
  } catch {
  }
  try {
    const url = `https://music.apple.com/${sf}/browse?l=${encodeURIComponent(lang)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
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
        const sections = [];
        for (const rawSec of rawSections) {
          let title = rawSec.header?.item?.titleLink?.title || rawSec.header?.title?.text || "";
          if (!title && sections.length === 0) {
            title = tr("Featured");
          }
          if (!title) continue;
          const moreUrl = rawSec.header?.item?.titleLink?.url;
          const roomMatch = typeof moreUrl === "string" ? moreUrl.match(/\/room\/([a-zA-Z0-9._-]+)/) : null;
          const morePage = roomMatch ? `room:${roomMatch[1]}` : void 0;
          const albums = [];
          const playlists2 = [];
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
              albums.push({
                id,
                name: `${name} - ${artistName}`,
                artists: [{ id: "", name: artistName }],
                imageUrl
              });
            } else if (kind === "playlist") {
              playlists2.push({
                id,
                name,
                owner: artistName,
                imageUrl
              });
            } else {
              albums.push({
                id,
                name,
                artists: [{ id: "", name: artistName }],
                imageUrl
              });
            }
          }
          if (playlists2.length > 0 && albums.length === 0) {
            sections.push({ title, kind: "playlists", playlists: playlists2, items: playlists2, morePage });
          } else if (albums.length > 0) {
            sections.push({ title, kind: "albums", albums, items: albums, morePage });
          }
        }
        if (sections.length > 0) {
          return { title: pageTitle, sections };
        }
      }
    }
  } catch {
  }
  return buildChartsBrowse(sf, lang, pageTitle);
}
async function browse(options) {
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
          items: recentTracks
        }
      ]
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
          items: mapped
        }
      ]
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
          items: mapped
        }
      ]
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
          items: mapped
        }
      ]
    };
  }
  throw fail("unavailable", `Unknown browse page: ${page}`);
}
async function album(options) {
  const { id: rawId } = options || {};
  let id = String(rawId || "").trim();
  if (!id) throw fail("unavailable", "Album id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  let item = null;
  const isLibrary = id.startsWith("l.");
  const endpoint = isLibrary ? `/me/library/albums/${encodeURIComponent(id)}?include=tracks,catalog&l=${lang}` : `/catalog/${sf}/albums/${encodeURIComponent(id)}?l=${lang}`;
  try {
    const json = await requestApi(endpoint, { requireAuth: isLibrary });
    item = json.data?.[0];
  } catch (err) {
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
      } catch {
      }
    }
    if (!item) throw err;
  }
  if (!item) {
    throw fail("unavailable", tr("Album not found"));
  }
  const alb = mapAlbum(item);
  let trackItems = item.relationships?.tracks?.data || [];
  if (trackItems.length === 0 && isLibrary) {
    const catId = item.relationships?.catalog?.data?.[0]?.id || item.attributes?.playParams?.catalogId;
    if (catId) {
      try {
        const catJson = await requestApi(
          `/catalog/${sf}/albums/${encodeURIComponent(catId)}?l=${lang}`
        );
        if (catJson.data?.[0]?.relationships?.tracks?.data?.length) {
          trackItems = catJson.data[0].relationships.tracks.data;
        }
      } catch {
      }
    }
  }
  const tracks = trackItems.map(mapTrack);
  registerNaturalTrackOrder(tracks);
  return {
    album: alb,
    tracks
  };
}
async function artist(options) {
  const { id: rawId } = options || {};
  let id = String(rawId || "").trim();
  if (!id) throw fail("unavailable", "Artist id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  let item = null;
  try {
    const json = await requestApi(
      `/catalog/${sf}/artists/${encodeURIComponent(id)}?views=top-songs,full-albums&l=${lang}`
    );
    item = json.data?.[0];
  } catch (err) {
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
      } catch {
      }
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
    albums: albumItems.map(mapAlbum)
  };
}
var favoritesPlaylistIdCache = null;
var favoritesLookupDone = false;
var favoritedIdsCache = /* @__PURE__ */ new Set();
var favoritesHydratedAt = 0;
var favoritesHydratePromise = null;
var FAVORITES_CACHE_TTL_MS = 2 * 60 * 1e3;
function resetFavoritesState() {
  favoritesPlaylistIdCache = null;
  favoritesLookupDone = false;
  favoritedIdsCache.clear();
  favoritesHydratedAt = 0;
  favoritesHydratePromise = null;
}
function isFavoritesPlaylistItem(item) {
  const attr = item?.attributes || {};
  if (Array.isArray(attr.tags) && attr.tags.includes("favorited")) {
    return true;
  }
  if (attr.isFavorites === true) {
    return true;
  }
  const name = String(attr.name || "").trim();
  if (attr.canEdit === false && !attr.curatorName && /^(Favorite Songs|Favourite Songs|喜爱歌曲|喜好歌曲|喜愛歌曲|お気に入りの曲|즐겨찾는 노래)$/i.test(
    name
  )) {
    return true;
  }
  return false;
}
function recordFavoritedTrackItem(item) {
  if (!item) return;
  const id = String(item.id || "").trim();
  if (id) favoritedIdsCache.add(id);
  const catalogId = item.attributes?.playParams?.catalogId || item.relationships?.catalog?.data?.[0]?.id;
  if (catalogId) {
    favoritedIdsCache.add(String(catalogId));
  }
}
async function getFavoritesPlaylistId(lang) {
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
  }
  return null;
}
async function fetchFavoritesPlaylistTracks(favId, lang, offset = 0, maxPages = 5) {
  const rawItems = [];
  let nextPath = `/me/library/playlists/${encodeURIComponent(favId)}/tracks?limit=100&offset=${offset}&l=${lang}`;
  let pages = 0;
  while (nextPath && pages < maxPages) {
    pages++;
    const cleanPath = nextPath.replace(/^\/v1/, "");
    const pageJson = await requestApi(cleanPath, { requireAuth: true }).catch(() => null);
    if (!pageJson || !Array.isArray(pageJson.data)) {
      nextPath = void 0;
      break;
    }
    for (const item of pageJson.data) {
      recordFavoritedTrackItem(item);
      rawItems.push(item);
    }
    nextPath = typeof pageJson.next === "string" && pageJson.next ? pageJson.next : void 0;
  }
  if (offset === 0 && rawItems.length > 0) {
    favoritesHydratedAt = Date.now();
  }
  return {
    rawItems,
    hasMore: Boolean(nextPath)
  };
}
async function ensureFavoritesHydrated(lang) {
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
    } finally {
      favoritesHydratePromise = null;
    }
  })();
  return favoritesHydratePromise;
}
async function playlists() {
  const token = await getStoredMediaUserToken();
  if (!token) return [];
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/library/playlists?limit=100&extend[library-playlists]=tags&l=${lang}`,
    { requireAuth: true }
  );
  const items = Array.isArray(json.data) ? json.data : [];
  const fav = items.find(isFavoritesPlaylistItem);
  if (fav?.id) {
    favoritesPlaylistIdCache = String(fav.id);
    favoritesLookupDone = true;
  }
  return items.filter((item) => !isFavoritesPlaylistItem(item)).map(mapPlaylist);
}
async function playlist(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Playlist id required");
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  if (id.startsWith("p.")) {
    const json2 = await requestApi(
      `/me/library/playlists/${encodeURIComponent(id)}?include=tracks&l=${lang}`,
      { requireAuth: true }
    );
    const item2 = json2.data?.[0];
    if (!item2) {
      throw fail("unavailable", tr("Playlist not found"));
    }
    const pl2 = mapPlaylist(item2);
    const trackItems2 = [...item2.relationships?.tracks?.data || []];
    let nextUrl = item2.relationships?.tracks?.next;
    let pages = 0;
    while (nextUrl && pages < 5) {
      pages++;
      const cleanNext = nextUrl.replace(/^\/v1/, "");
      const moreJson = await requestApi(cleanNext, { requireAuth: true }).catch(() => null);
      if (!moreJson?.data?.length) break;
      trackItems2.push(...moreJson.data);
      nextUrl = moreJson.next;
    }
    pl2.tracks = trackItems2.map(mapTrack);
    pl2.trackCount = pl2.tracks.length;
    registerNaturalTrackOrder(pl2.tracks);
    return pl2;
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
  registerNaturalTrackOrder(pl.tracks);
  return pl;
}
async function createPlaylist(options) {
  const name = String(options?.name || "").trim();
  if (!name) throw fail("unavailable", "Playlist name required");
  const json = await requestApi("/me/library/playlists", {
    method: "POST",
    requireAuth: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attributes: { name } })
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
async function addToPlaylist(options) {
  const { id, trackIds } = options || {};
  if (!id || !Array.isArray(trackIds) || trackIds.length === 0) return;
  const data = trackIds.map((tid) => ({
    id: String(tid),
    type: String(tid).startsWith("i.") ? "library-songs" : "songs"
  }));
  await requestApi(`/me/library/playlists/${encodeURIComponent(id)}/tracks`, {
    method: "POST",
    requireAuth: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  });
}
var naturalSequences = /* @__PURE__ */ new Map();
function registerNaturalTrackOrder(tracks) {
  if (!Array.isArray(tracks) || tracks.length < 2) return;
  const ids = tracks.map((t) => String(t?.id ?? "")).filter(Boolean);
  if (ids.length >= 2) {
    naturalSequences.set(ids[0], ids);
    if (naturalSequences.size > 100) {
      const oldestKey = naturalSequences.keys().next().value;
      if (oldestKey) naturalSequences.delete(oldestKey);
    }
  }
}
async function liked(options) {
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
    const mappedTracks2 = rawItems.map(mapTrack);
    registerNaturalTrackOrder(mappedTracks2);
    return {
      tracks: mappedTracks2,
      more: hasMore
    };
  }
  const json = await requestApi(
    `/me/library/songs?limit=100&offset=${offset}&l=${lang}`,
    { requireAuth: true }
  );
  const items = json.data || [];
  const mappedTracks = items.map(mapTrack);
  registerNaturalTrackOrder(mappedTracks);
  return {
    tracks: mappedTracks,
    more: Boolean(json.next)
  };
}
async function savedAlbums(options) {
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
    more: Boolean(json.next)
  };
}
async function like(options) {
  const id = String(options?.id || "").trim();
  if (!id) return;
  const on = Boolean(options?.on);
  const isLibId = id.startsWith("i.");
  const resType = isLibId ? "library-songs" : "songs";
  const meta = trackMetaCache.get(id);
  let updatedFavorites = false;
  try {
    await requestApi(
      `/me/favorites?ids[${resType}]=${encodeURIComponent(id)}&platform=web`,
      {
        method: on ? "POST" : "DELETE",
        requireAuth: true
      }
    );
    updatedFavorites = true;
  } catch (err) {
    if (err?.code === "signIn") throw err;
  }
  const ratingPath = isLibId ? `/me/ratings/library-songs/${encodeURIComponent(id)}` : `/me/ratings/songs/${encodeURIComponent(id)}`;
  if (on) {
    if (!updatedFavorites) {
      if (!isLibId) {
        await requestApi(`/me/library?ids[songs]=${encodeURIComponent(id)}`, {
          method: "POST",
          requireAuth: true
        }).catch(() => {
        });
      }
      await requestApi(ratingPath, {
        method: "PUT",
        requireAuth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "rating", attributes: { value: 1 } })
      });
    } else {
      requestApi(ratingPath, {
        method: "PUT",
        requireAuth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "rating", attributes: { value: 1 } })
      }).catch(() => {
      });
    }
    favoritedIdsCache.add(id);
    if (meta?.catalogId) favoritedIdsCache.add(meta.catalogId);
  } else {
    if (!updatedFavorites) {
      await requestApi(ratingPath, {
        method: "DELETE",
        requireAuth: true
      }).catch(() => {
      });
    } else {
      requestApi(ratingPath, {
        method: "DELETE",
        requireAuth: true
      }).catch(() => {
      });
    }
    favoritedIdsCache.delete(id);
    if (meta?.catalogId) favoritedIdsCache.delete(meta.catalogId);
  }
}
async function isLiked(options) {
  const ids = Array.isArray(options?.ids) ? options.ids.filter(Boolean) : [];
  const out = {};
  for (const id of ids) out[id] = false;
  if (ids.length === 0) return out;
  const token = await getStoredMediaUserToken();
  if (!token) return out;
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  await ensureFavoritesHydrated(lang);
  const unresolvedLibIds = [];
  const unresolvedCatalogIds = [];
  for (const id of ids) {
    const meta = trackMetaCache.get(id);
    if (favoritedIdsCache.has(id) || meta?.catalogId && favoritedIdsCache.has(meta.catalogId) || meta?.id && favoritedIdsCache.has(meta.id)) {
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
    }
  }
  return out;
}
async function saveAlbum(options) {
  const id = String(options?.id || "").trim();
  if (!id) return;
  if (options?.on) {
    await requestApi(`/me/library?ids[albums]=${encodeURIComponent(id)}`, {
      method: "POST",
      requireAuth: true
    });
  }
}
async function played(options) {
  const id = String(options?.id || "").trim();
  if (!id || typeof host === "undefined" || !host.storage) return;
  try {
    const meta = trackMetaCache.get(id);
    if (!meta) return;
    const prev = await host.storage.get("recent_tracks") || [];
    const trackObj = {
      id: meta.id,
      name: meta.name,
      artists: [{ id: meta.artistName, name: meta.artistName }],
      album: { id: meta.albumId || meta.albumName, name: meta.albumName },
      duration: meta.durationMs,
      url: meta.url
    };
    const filtered = prev.filter((t) => t?.id !== id);
    await host.storage.set("recent_tracks", [trackObj, ...filtered].slice(0, 50));
  } catch {
  }
}
async function recent() {
  const token = await getStoredMediaUserToken();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  if (token) {
    try {
      const json = await requestApi(`/me/recent/played/tracks?limit=30&l=${lang}`, {
        requireAuth: true
      });
      if (Array.isArray(json?.data) && json.data.length > 0) {
        const mapped = json.data.map(mapTrack);
        registerNaturalTrackOrder(mapped);
        return mapped;
      }
    } catch {
    }
  }
  if (typeof host !== "undefined" && host.storage) {
    try {
      return await host.storage.get("recent_tracks") || [];
    } catch {
      return [];
    }
  }
  return [];
}
async function stations() {
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const sf = await getStorefront().catch(() => "jp");
  const result = [];
  const seenIds = /* @__PURE__ */ new Set();
  const add = (st) => {
    if (!st.id || seenIds.has(st.id)) return;
    seenIds.add(st.id);
    result.push({
      ...st,
      description: [tr("Live radio and radio shows are not supported yet"), st.description].filter(Boolean).join(" \xB7 ")
    });
  };
  const liveStationIds = APPLE_MUSIC_LIVE_STATIONS.map((s) => s.id).join(",");
  try {
    const liveApiRes = await requestApi(
      `/catalog/${sf}/stations?ids=${encodeURIComponent(liveStationIds)}&l=${encodeURIComponent(lang)}`
    );
    const liveItems = Array.isArray(liveApiRes?.data) ? liveApiRes.data : [];
    if (liveItems.length > 0) {
      for (const it of liveItems) {
        const id = it.id;
        const attr = it.attributes || {};
        const staticFallback = APPLE_MUSIC_LIVE_STATIONS.find((s) => s.id === id);
        add({
          id,
          name: attr.name || staticFallback?.name || "Apple Music Radio",
          description: attr.editorialNotes?.short || attr.editorialNotes?.tagline || attr.description?.short || staticFallback?.description,
          imageUrl: attr.artwork?.url ? formatArtworkUrl(attr.artwork.url, 600) : staticFallback?.imageUrl
        });
      }
    } else {
      for (const liveSt of APPLE_MUSIC_LIVE_STATIONS) {
        add(liveSt);
      }
    }
  } catch {
    for (const liveSt of APPLE_MUSIC_LIVE_STATIONS) {
      add(liveSt);
    }
  }
  try {
    const radioUrl = `https://music.apple.com/${sf}/radio?l=${encodeURIComponent(lang)}`;
    const res = await fetch(radioUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
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
              description: desc ? String(desc) : void 0,
              imageUrl: formatArtworkUrl(rawArt, 600)
            });
          }
        }
      }
    }
  } catch {
  }
  return result;
}
async function stationNext(options) {
  const id = String(options?.id || "").trim();
  if (!id) throw fail("unavailable", "Station id required");
  if (APPLE_MUSIC_LIVE_STATIONS.some((st) => st.id === id)) {
    throw fail("unsupported", tr("Live radio and radio shows are not supported yet"));
  }
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/stations/next-tracks/${encodeURIComponent(id)}?limit=10&l=${encodeURIComponent(lang)}`,
    { method: "POST", requireAuth: true }
  );
  const items = Array.isArray(json?.data) ? json.data : [];
  const tracks = items.filter((item) => {
    if (!["songs", "library-songs"].includes(item?.type)) return false;
    const catalogId = item?.attributes?.playParams?.catalogId || item?.relationships?.catalog?.data?.[0]?.id || item?.id;
    return /^\d{1,24}$/.test(String(catalogId || "")) && Boolean(item?.attributes?.name);
  }).map(mapTrack);
  if (tracks.length === 0) {
    throw fail("unsupported", tr("This station has no playable catalog songs"));
  }
  return tracks;
}
async function lyrics(options) {
  const id = String(options?.id || "").trim();
  if (!id) return {};
  let meta = null;
  try {
    meta = await resolveTrackMeta(id);
  } catch {
    meta = trackMetaCache.get(id) || null;
  }
  const catalogId = meta?.catalogId || (!id.startsWith("i.") ? id : "");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const mediaUserToken = await getStoredMediaUserToken();
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
      }
    }
  }
  if (meta && meta.name) {
    try {
      const params = new URLSearchParams({
        track_name: meta.name,
        artist_name: meta.artistName || "",
        album_name: meta.albumName || "",
        duration: String(Math.max(1, Math.round((meta.durationMs || 0) / 1e3)))
      });
      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers: { "User-Agent": "mygo-music-apple-music/0.1.0" }
      });
      if (res.ok) {
        const found = await res.json();
        if (found?.syncedLyrics) {
          return { lrc: String(found.syncedLyrics) };
        }
      }
    } catch {
    }
  }
  return {};
}
async function remotePlay(options) {
  const ids = Array.isArray(options?.ids) ? options.ids : [];
  const start = Math.max(0, Math.trunc(Number(options?.start) || 0));
  const position = Math.max(0, Number(options?.position) || 0);
  const targetId = ids[start];
  if (!targetId) throw fail("unavailable", tr("This track is unavailable for streaming"));
  if (String(targetId).trim().startsWith("ra.")) {
    throw fail("unsupported", tr("Live radio and radio shows are not supported yet"));
  }
  const generation = beginNativePlay();
  try {
    const meta = await resolveTrackMeta(String(targetId));
    if (isCurrentNativePlay(generation)) await nativePlay(meta, Math.round(position), generation);
  } finally {
    finishNativeLoading(generation);
  }
}
async function remotePause() {
  await nativeCommand("pause");
}
async function remoteResume() {
  await nativeCommand("resume");
}
async function remoteSeek(options) {
  const position = Number(options?.position);
  if (!Number.isFinite(position) || position < 0) throw fail("unavailable", "Invalid position");
  await nativeCommand("seek", { position: Math.round(position) });
}
async function remoteVolume(options) {
  const percent = Number(options?.percent);
  if (!Number.isFinite(percent)) throw fail("unavailable", "Invalid volume");
  await nativeCommand("volume", { percent: Math.max(0, Math.min(100, percent)) });
}
async function remoteState() {
  return nativeState();
}
async function remoteDevices() {
  return nativeDevices();
}
async function remoteUse(options) {
  if (options?.deviceId !== "default") throw fail("unsupported", tr("Select the output device in system audio settings"));
}
async function stream(options) {
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
      Referer: "https://music.apple.com/"
    }
  };
}
async function openInAppleMusic(options) {
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
    const sf = opts.storefront ? opts.storefront.trim().toLowerCase() : await getStorefront();
    const rawKind = (opts.kind || "song").toLowerCase();
    let kindPath = "song";
    if (rawKind === "album" || rawKind === "albums") {
      kindPath = "album";
    } else if (rawKind === "artist" || rawKind === "artists") {
      kindPath = "artist";
    } else if (rawKind === "playlist" || rawKind === "playlists") {
      kindPath = "playlist";
    }
    targetUrl = id ? `https://music.apple.com/${sf}/${kindPath}/${id}` : `https://music.apple.com/${sf}`;
  }
  if (typeof host !== "undefined" && typeof host.openURL === "function") {
    host.openURL(targetUrl);
  }
  return { url: targetUrl, opened: true };
}
var CURRENT_PROFILE_VERSION = 2;
function isPlaceholderAccountName(name) {
  if (!name || typeof name !== "string") return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (/^Apple Music\s*\(.+\)$/i.test(trimmed)) return true;
  if (trimmed === "Apple Music" || trimmed === "Apple Music Subscriber" || trimmed === "Apple Music \u8BA2\u9605\u7528\u6237") {
    return true;
  }
  return false;
}
function isLegacyStorefrontPlaceholder(name) {
  return Boolean(name && /^Apple Music\s*\(.+\)$/i.test(name.trim()));
}
function getCustomDisplayName() {
  if (typeof host !== "undefined" && typeof host.setting === "function") {
    const val = host.setting("displayName");
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}
function extractSocialProfileCandidate(json) {
  if (!json || typeof json !== "object") return {};
  const candidates = [];
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
  let id;
  let name;
  let handle;
  let imageUrl;
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
function extractMeAccountCandidate(json) {
  if (!json || typeof json !== "object") return {};
  const storefront = typeof json.meta?.subscription?.storefront === "string" ? json.meta.subscription.storefront.trim().toLowerCase() : void 0;
  const candidates = [];
  if (Array.isArray(json.data)) candidates.push(...json.data);
  if (json.resources?.accounts?.me) candidates.push(json.resources.accounts.me);
  let id;
  let name;
  let imageUrl;
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const attr = c.attributes || {};
    if (!id && typeof c.id === "string" && c.id.trim()) {
      id = c.id.trim();
    }
    const fullName = [attr.firstName, attr.lastName].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
    const rawName = fullName || (typeof attr.nickname === "string" ? attr.nickname.trim() : "") || (typeof attr.handle === "string" ? attr.handle.trim().replace(/^@+/, "") : "") || (typeof attr.name === "string" ? attr.name.trim() : "");
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
async function resolveSubscriberProfile(mediaUserToken, devToken, fallbackStorefront) {
  const authHeaders = {
    Authorization: `Bearer ${devToken}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    "Music-User-Token": mediaUserToken
  };
  const fetchJsonSafe = async (url) => {
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
    )
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
      imageUrl: social.imageUrl || altSocial.imageUrl
    };
  }
  const meAcc = extractMeAccountCandidate(meAccountJson);
  const storefront = meAcc.storefront || fallbackStorefront || "us";
  let resolvedName = social.name || social.handle || meAcc.name || "";
  if (!resolvedName) {
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
  const customName = getCustomDisplayName();
  const finalName = customName || resolvedName || tr("Apple Music Subscriber");
  const finalImage = social.imageUrl || meAcc.imageUrl || "";
  const finalId = social.handle || `apple-music-${storefront}`;
  return {
    account: {
      id: finalId,
      name: finalName,
      imageUrl: finalImage,
      page: "library"
    },
    storefront,
    foundRealProfile: foundRealProfile || Boolean(customName)
  };
}
async function verifyAndPersistToken(mediaUserToken) {
  let sfData;
  let devToken;
  try {
    devToken = await getDeveloperToken();
    const sfRes = await fetch("https://amp-api.music.apple.com/v1/me/storefront", {
      headers: {
        Authorization: `Bearer ${devToken}`,
        Origin: "https://music.apple.com",
        "Music-User-Token": mediaUserToken
      }
    });
    if (!sfRes.ok) {
      throw fail("signIn", tr("Failed to retrieve Apple Music storefront"));
    }
    sfData = await sfRes.json();
  } catch (err) {
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
        signedInAt: Date.now()
      });
    } catch (_) {
    }
  }
  return resolved.account;
}
async function signIn() {
  if (typeof host === "undefined") throw fail("unsupported", "Native sign-in requires a desktop plugin host");
  if (typeof host?.signInPrompt === "function") host.signInPrompt({ text: tr("Complete Apple Music sign-in in the native account dialogs") });
  await nativeCommand("auth");
  const session = await nativeCommand("session");
  const token = cleanMediaUserToken(session?.mediaUserToken);
  if (!token) throw fail("signIn", tr("Failed to capture Apple Music subscriber session"));
  if (session?.developerToken && host.storage) await host.storage.set("native_developer_token", session.developerToken);
  return verifyAndPersistToken(token);
}
async function signOut() {
  try {
    await nativeCommand("logout");
  } finally {
    resetRemoteSession();
    resetFavoritesState();
    if (typeof host !== "undefined" && host.storage) {
      await host.storage.remove("auth");
      await host.storage.remove("native_developer_token");
    }
  }
}
async function account() {
  if (typeof host === "undefined") return null;
  const customName = getCustomDisplayName();
  if (host.storage) {
    try {
      const auth = await host.storage.get("auth");
      const token = cleanMediaUserToken(auth?.mediaUserToken);
      if (auth && token) {
        const storedAcc = auth.account;
        const needsUpgrade = !storedAcc || auth.profileVersion !== CURRENT_PROFILE_VERSION || isLegacyStorefrontPlaceholder(storedAcc.name);
        if (needsUpgrade) {
          try {
            const devToken = await getDeveloperToken();
            const resolved = await resolveSubscriberProfile(
              token,
              devToken,
              auth.storefront || "us"
            );
            const nextAccount = resolved.foundRealProfile || !storedAcc || isLegacyStorefrontPlaceholder(storedAcc.name) ? resolved.account : {
              ...storedAcc,
              name: customName || storedAcc.name,
              imageUrl: resolved.account.imageUrl || storedAcc.imageUrl || ""
            };
            await host.storage.set("auth", {
              ...auth,
              storefront: resolved.storefront || auth.storefront || "us",
              account: nextAccount,
              profileVersion: CURRENT_PROFILE_VERSION
            });
            return nextAccount;
          } catch {
          }
        }
        if (storedAcc) {
          return customName ? { ...storedAcc, name: customName } : storedAcc;
        }
      }
    } catch (_) {
    }
  }
  return null;
}
async function setSetting(options) {
  const { key, value } = options || {};
  if (key === "audioQuality" && value !== "hires" && value !== "lossless") throw fail("unsupported", tr("The native core supports lossless and hires ALAC quality"));
  if (typeof host !== "undefined" && host._setSetting) {
    host._setSetting(key, value);
  }
  if (key === "displayName" && typeof host !== "undefined" && host.storage) {
    try {
      const auth = await host.storage.get("auth");
      if (auth && auth.mediaUserToken) {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed && auth.account) {
          await host.storage.set("auth", {
            ...auth,
            account: { ...auth.account, name: trimmed }
          });
        } else {
          await host.storage.set("auth", {
            ...auth,
            profileVersion: 0
          });
        }
      }
    } catch {
    }
    return;
  }
  if (key === "audioQuality") {
    await nativeCommand("quality", { quality: value });
  }
}
export {
  account,
  addToPlaylist,
  album,
  artist,
  browse,
  createPlaylist,
  dedupeLibraryAlbums,
  fail,
  formatArtworkUrl,
  getDeveloperToken,
  getStorefront,
  home,
  isLiked,
  like,
  liked,
  lyrics,
  mapAlbum,
  mapArtist,
  mapPlaylist,
  mapTrack,
  openInAppleMusic,
  parseAppleTTML,
  parseTtmlTimestamp,
  played,
  playlist,
  playlists,
  recent,
  registerNaturalTrackOrder,
  remoteDevices,
  remotePause,
  remotePlay,
  remoteResume,
  remoteSeek,
  remoteState,
  remoteUse,
  remoteVolume,
  resetRemoteSession,
  saveAlbum,
  savedAlbums,
  search,
  setSetting,
  signIn,
  signOut,
  stationNext,
  stations,
  stream,
  suggest
};
