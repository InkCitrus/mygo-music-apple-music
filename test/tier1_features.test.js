/**
 * Tier 1: Feature Coverage Test Suite
 * Minimum >= 5 tests per feature across all core features:
 * 1. Manifest
 * 2. Search
 * 3. Suggest
 * 4. Home
 * 5. Browse
 * 6. Album
 * 7. Artist
 * 8. Playlist
 * 9. Stream
 * 10. WebSignIn
 * 11. Storage
 * 12. Auth Validation
 * 13. Localization zh-CN
 * 14. Error Codes (signIn, unavailable, unsupported, setup)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describe,
  test,
  beforeEach,
  afterEach,
  assert,
  assertEquals,
  assertTruthy,
  assertFalsy,
  assertRejects,
  assertIncludes,
} from "./harness/framework.js";
import { createHost } from "./harness/host.js";
import { createNetwork } from "./harness/network.js";
import { loadPlugin } from "./harness/plugin_loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../");
const fixturesDir = path.resolve(__dirname, "./fixtures");

// Manifest & Locales helper
function getManifest() {
  const rootManifest = path.resolve(projectRoot, "plugin.json");
  const target = fs.existsSync(rootManifest)
    ? rootManifest
    : path.resolve(fixturesDir, "plugin.json");
  return JSON.parse(fs.readFileSync(target, "utf-8"));
}

function getZhLocale() {
  const rootZh = path.resolve(projectRoot, "locales/zh-CN.json");
  const target = fs.existsSync(rootZh)
    ? rootZh
    : path.resolve(fixturesDir, "zh-CN.json");
  return JSON.parse(fs.readFileSync(target, "utf-8"));
}

describe("Tier 1: Feature 1 - Manifest (plugin.json)", () => {
  const manifest = getManifest();

  test("1.1: id is valid, non-empty, matches regex and is not 'local'", () => {
    assertTruthy(manifest.id, "manifest.id must exist");
    assertEquals(manifest.id, "apple-music", "id should be apple-music");
    assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(manifest.id), "id must match regex");
    assert(manifest.id !== "local", "id cannot be reserved name 'local'");
  });

  test("1.2: main entrypoint points to valid script file", () => {
    assertTruthy(manifest.main, "manifest.main must be specified");
    assert(
      manifest.main === "dist/index.js" || manifest.main === "index.js",
      `main should be dist/index.js or index.js, got ${manifest.main}`
    );
  });

  test("1.3: permissions.network includes required Apple Music endpoints", () => {
    assertTruthy(manifest.permissions, "permissions must exist");
    assertTruthy(manifest.permissions.network, "permissions.network must exist");
    const net = manifest.permissions.network;
    assertIncludes(net, "amp-api.music.apple.com");
    assertIncludes(net, "music.apple.com");
    assertIncludes(net, "*.mzstatic.com");
  });

  test("1.4: playback is remote with process permissions for macOS Music.app", () => {
    assertEquals(manifest.playback, "remote", "playback should be remote");
    assert(Array.isArray(manifest.permissions.process), "permissions.process must be an array");
    assertIncludes(manifest.permissions.process, "/usr/bin/osascript");
  });

  test("1.5: settings and navigation are defined with required properties", () => {
    assert(Array.isArray(manifest.settings), "settings must be an array");
    const storefrontSetting = manifest.settings.find((s) => s.key === "storefront");
    assertTruthy(storefrontSetting, "storefront setting must exist");
    assertTruthy(storefrontSetting.label, "setting label must exist");

    assert(Array.isArray(manifest.navigation), "navigation must be an array");
    const homeNav = manifest.navigation.find((n) => n.page === "home" || n.builtin === "home");
    assertTruthy(homeNav, "home navigation item must exist");
  });
});

describe("Tier 1: Feature 2 - Catalog Search", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("2.1: search tracks returns mapped Track objects with required fields", async () => {
    const res = await plugin.search({ query: "taylor swift", kind: "tracks" });
    assertTruthy(res.tracks, "result should contain tracks array");
    assert(res.tracks.length > 0, "should return tracks");
    const track = res.tracks[0];
    assertTruthy(track.id, "track.id must exist");
    assertTruthy(track.title, "track.title must exist");
    assertTruthy(track.artist, "track.artist must exist");
    assertTruthy(track.duration, "track.duration must exist");
    assert(track.duration > 0, "track.duration must be positive seconds");
    assertIncludes(track.artwork, "mzstatic.com", "artwork should be mzstatic URL");
  });

  test("2.2: search albums returns mapped Album objects", async () => {
    const res = await plugin.search({ query: "taylor swift", kind: "albums" });
    assertTruthy(res.albums, "result should contain albums array");
    assert(res.albums.length > 0, "should return albums");
    const album = res.albums[0];
    assertTruthy(album.id, "album.id must exist");
    assertTruthy(album.title, "album.title must exist");
    assertTruthy(album.artist, "album.artist must exist");
    assert(typeof album.trackCount === "number", "album.trackCount should be number");
  });

  test("2.3: search artists returns mapped Artist objects", async () => {
    const res = await plugin.search({ query: "taylor swift", kind: "artists" });
    assertTruthy(res.artists, "result should contain artists array");
    assert(res.artists.length > 0, "should return artists");
    const artist = res.artists[0];
    assertTruthy(artist.id, "artist.id must exist");
    assertEquals(artist.name, "Taylor Swift");
  });

  test("2.4: search playlists returns mapped Playlist objects", async () => {
    const res = await plugin.search({ query: "taylor swift", kind: "playlists" });
    assertTruthy(res.playlists, "result should contain playlists array");
    assert(res.playlists.length > 0, "should return playlists");
    const playlist = res.playlists[0];
    assertTruthy(playlist.id, "playlist.id must exist");
    assertTruthy(playlist.title, "playlist.title must exist");
    assertTruthy(playlist.curator, "playlist.curator must exist");
  });

  test("2.5: search pagination respects offset and returns more flag", async () => {
    const res = await plugin.search({ query: "taylor swift", kind: "tracks", offset: 0 });
    assert(typeof res.more === "boolean", "more must be a boolean");
    const requests = network.getRequests();
    const searchReq = requests.find((r) => r.url.includes("/search"));
    assertTruthy(searchReq, "search request must have been sent");
    assertIncludes(searchReq.url, "offset=0", "offset query param should be passed");
  });
});

describe("Tier 1: Feature 3 - Search Suggestions (suggest)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("3.1: suggest returns array of string hints for prefix", async () => {
    const hints = await plugin.suggest({ query: "tay" });
    assert(Array.isArray(hints), "hints should be an array");
    assert(hints.length > 0, "should return hints");
    assert(typeof hints[0] === "string", "hints should be strings");
    assertIncludes(hints, "taylor swift");
  });

  test("3.2: suggest returns empty array for empty query without error", async () => {
    const hints = await plugin.suggest({ query: "" });
    assert(Array.isArray(hints), "should return array");
    assertEquals(hints.length, 0, "should be empty for empty query");
  });

  test("3.3: suggest returns empty array for whitespace-only query", async () => {
    const hints = await plugin.suggest({ query: "    " });
    assert(Array.isArray(hints), "should return array");
    assertEquals(hints.length, 0, "should be empty for whitespace");
  });

  test("3.4: suggest handles single-character prefix", async () => {
    const hints = await plugin.suggest({ query: "t" });
    assert(Array.isArray(hints), "should return array");
  });

  test("3.5: suggest handles multi-word query", async () => {
    const hints = await plugin.suggest({ query: "taylor swift" });
    assert(Array.isArray(hints), "should return array");
  });
});

describe("Tier 1: Feature 4 - Home Page Charts (home)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("4.1: home returns Browse object with sections array", async () => {
    const res = await plugin.home();
    assertTruthy(res, "home result must exist");
    assert(Array.isArray(res.sections), "sections must be an array");
    assert(res.sections.length > 0, "sections should not be empty");
  });

  test("4.2: first section contains tracks and acts as hero section", async () => {
    const res = await plugin.home();
    const heroSection = res.sections[0];
    assertEquals(heroSection.kind, "tracks", "first section must be tracks");
    assert(heroSection.items.length > 0, "hero section must have items");
    assertTruthy(heroSection.items[0].title, "track item must have title");
  });

  test("4.3: sections include Top Playlists shelf", async () => {
    const res = await plugin.home();
    const playlistSec = res.sections.find((s) => s.kind === "playlists");
    assertTruthy(playlistSec, "Top Playlists section should exist");
    assert(playlistSec.items.length > 0, "playlist items must exist");
  });

  test("4.4: sections include Top Albums shelf", async () => {
    const res = await plugin.home();
    const albumSec = res.sections.find((s) => s.kind === "albums");
    assertTruthy(albumSec, "Top Albums section should exist");
    assert(albumSec.items.length > 0, "album items must exist");
  });

  test("4.5: sections include morePage identifiers for deep routing", async () => {
    const res = await plugin.home();
    const sectionsWithMore = res.sections.filter((s) => Boolean(s.morePage));
    assert(sectionsWithMore.length > 0, "at least one section must provide morePage");
    assertIncludes(sectionsWithMore[0].morePage, "charts", "morePage should reference charts");
  });
});

describe("Tier 1: Feature 5 - Catalog Browse (browse)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("5.1: browse without page returns general home charts", async () => {
    const res = await plugin.browse();
    assertTruthy(res.sections, "browse result must have sections");
    assert(res.sections.length > 0, "sections should not be empty");
  });

  test("5.2: browse with page='charts-songs' returns tracks section", async () => {
    const res = await plugin.browse({ page: "charts-songs" });
    assertTruthy(res.sections, "must have sections");
    assertEquals(res.sections[0].kind, "tracks", "section kind should be tracks");
    assert(res.sections[0].items.length > 0, "should have items");
  });

  test("5.3: browse with page='charts-albums' returns albums section", async () => {
    const res = await plugin.browse({ page: "charts-albums" });
    assertTruthy(res.sections, "must have sections");
    assertEquals(res.sections[0].kind, "albums", "section kind should be albums");
    assert(res.sections[0].items.length > 0, "should have items");
  });

  test("5.4: browse with page='charts-playlists' returns playlists section", async () => {
    const res = await plugin.browse({ page: "charts-playlists" });
    assertTruthy(res.sections, "must have sections");
    assertEquals(res.sections[0].kind, "playlists", "section kind should be playlists");
    assert(res.sections[0].items.length > 0, "should have items");
  });

  test("5.5: browse with invalid page throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.browse({ page: "non_existent_page_123" }),
      "unavailable",
      "unknown browse page must throw unavailable"
    );
  });
});

describe("Tier 1: Feature 6 - Album Resolution (album)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("6.1: album returns { album: Album, tracks: Track[] }", async () => {
    const res = await plugin.album({ id: "1585800424" });
    assertTruthy(res.album, "album must exist");
    assert(Array.isArray(res.tracks), "tracks must be an array");
    assertEquals(res.album.id, "1585800424");
    assertEquals(res.album.title, "Lover");
  });

  test("6.2: tracks inside album have trackNumber and discNumber", async () => {
    const res = await plugin.album({ id: "1585800424" });
    assert(res.tracks.length > 0, "must have tracks");
    const track = res.tracks[0];
    assertEquals(track.trackNumber, 1);
    assertEquals(track.discNumber, 1);
  });

  test("6.3: album artwork URL has {w}x{h} template replaced", async () => {
    const res = await plugin.album({ id: "1585800424" });
    assertTruthy(res.album.artwork);
    assert(!res.album.artwork.includes("{w}x{h}"), "template placeholders should be replaced");
    assertIncludes(res.album.artwork, "600x600bb.jpg");
  });

  test("6.4: album track duration is in milliseconds per MyGo Music Track.Duration spec", async () => {
    const res = await plugin.album({ id: "1585800424" });
    const track = res.tracks[0];
    assert(track.duration >= 1000, `duration should be milliseconds (>= 1000ms), got ${track.duration}`);
    assertEquals(track.duration, 170640);
  });

  test("6.5: missing album ID throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.album({ id: "404" }),
      "unavailable",
      "missing album must throw unavailable"
    );
  });
});

describe("Tier 1: Feature 7 - Artist Profile (artist)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("7.1: artist returns { artist: Artist, tracks: Track[], albums: Album[] }", async () => {
    const res = await plugin.artist({ id: "159260351" });
    assertTruthy(res.artist, "artist must exist");
    assert(Array.isArray(res.tracks), "tracks must be array");
    assert(Array.isArray(res.albums), "albums must be array");
    assertEquals(res.artist.id, "159260351");
    assertEquals(res.artist.name, "Taylor Swift");
  });

  test("7.2: artist top tracks are populated from views", async () => {
    const res = await plugin.artist({ id: "159260351" });
    assert(res.tracks.length > 0, "top tracks should not be empty");
    assertEquals(res.tracks[0].title, "Cruel Summer");
  });

  test("7.3: artist albums are populated from views", async () => {
    const res = await plugin.artist({ id: "159260351" });
    assert(res.albums.length > 0, "albums should not be empty");
    assertEquals(res.albums[0].title, "Lover");
  });

  test("7.4: artist artwork URL is formatted", async () => {
    const res = await plugin.artist({ id: "159260351" });
    assertTruthy(res.artist.artwork);
    assert(!res.artist.artwork.includes("{w}x{h}"), "template placeholders should be replaced");
  });

  test("7.5: missing artist ID throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.artist({ id: "404" }),
      "unavailable",
      "missing artist must throw unavailable"
    );
  });
});

describe("Tier 1: Feature 8 - Playlist Details (playlist)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("8.1: playlist returns Playlist object with child tracks array", async () => {
    const pl = await plugin.playlist({ id: "pl.u-2aoq8mNTGEeN5" });
    assertTruthy(pl.id, "playlist id must exist");
    assertEquals(pl.id, "pl.u-2aoq8mNTGEeN5");
    assert(Array.isArray(pl.tracks), "tracks must be array");
  });

  test("8.2: playlist tracks are mapped to standard Track schema", async () => {
    const pl = await plugin.playlist({ id: "pl.u-2aoq8mNTGEeN5" });
    assert(pl.tracks.length > 0, "tracks should exist");
    const track = pl.tracks[0];
    assertTruthy(track.id, "track id must exist");
    assertTruthy(track.title, "track title must exist");
    assertTruthy(track.artist, "track artist must exist");
  });

  test("8.3: playlist metadata includes curator and description", async () => {
    const pl = await plugin.playlist({ id: "pl.u-2aoq8mNTGEeN5" });
    assertEquals(pl.curator, "Apple Music");
    assertTruthy(pl.description, "description must exist");
  });

  test("8.4: handles empty playlist gracefully with empty tracks array", async () => {
    const pl = await plugin.playlist({ id: "empty_playlist" });
    assert(Array.isArray(pl.tracks), "tracks must be array");
    assertEquals(pl.tracks.length, 0, "tracks should be empty");
  });

  test("8.5: missing playlist ID throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.playlist({ id: "404" }),
      "unavailable",
      "missing playlist must throw unavailable"
    );
  });
});

describe("Tier 1: Feature 9 - Audio Stream Resolution (stream)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("9.1: stream returns Stream object with valid 30s preview URL", async () => {
    const st = await plugin.stream({ id: "1585800430" });
    assertTruthy(st.url, "stream url must exist");
    assertIncludes(st.url, "audio-ssl.itunes.apple.com");
  });

  test("9.2: stream audio type is 'm4a'", async () => {
    const st = await plugin.stream({ id: "1585800430" });
    assertEquals(st.type, "m4a", "type should be m4a");
  });

  test("9.3: stream quality is set to 'high'", async () => {
    const st = await plugin.stream({ id: "1585800430" });
    assertEquals(st.quality, "high", "quality should be high");
  });

  test("9.4: stream includes required Origin and Referer headers", async () => {
    const st = await plugin.stream({ id: "1585800430" });
    assertTruthy(st.headers, "stream headers should exist");
    assertEquals(st.headers.Origin, "https://music.apple.com");
    assertEquals(st.headers.Referer, "https://music.apple.com/");
  });

  test("9.5: track with no preview throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.stream({ id: "9999999999" }),
      "unavailable",
      "song without preview must throw unavailable"
    );
  });
});

describe("Tier 1: Feature 10 - Web Sign-In (webSignIn)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("10.1: signIn invokes host.webSignIn targeting music.apple.com", async () => {
    let capturedOptions = null;
    host._setWebSignInBehavior(async (opts) => {
      capturedOptions = opts;
      return { cookie: "media-user-token=test_token_123; itua=us" };
    });

    await plugin.signIn();
    assertTruthy(capturedOptions, "webSignIn must have been called");
    assertIncludes(capturedOptions.url, "music.apple.com");
  });

  test("10.2: specifies cookiesOf for https://music.apple.com", async () => {
    let capturedOptions = null;
    host._setWebSignInBehavior(async (opts) => {
      capturedOptions = opts;
      return { cookie: "media-user-token=test_token_123; itua=us" };
    });

    await plugin.signIn();
    assertEquals(capturedOptions.cookiesOf, "https://music.apple.com");
  });

  test("10.3: specifies until containing 'media-user-token'", async () => {
    let capturedOptions = null;
    host._setWebSignInBehavior(async (opts) => {
      capturedOptions = opts;
      return { cookie: "media-user-token=test_token_123; itua=us" };
    });

    await plugin.signIn();
    assertIncludes(capturedOptions.until, "media-user-token");
  });

  test("10.4: supplies platform-appropriate browser User-Agent", async () => {
    let capturedOptions = null;
    host._setWebSignInBehavior(async (opts) => {
      capturedOptions = opts;
      return { cookie: "media-user-token=test_token_123; itua=us" };
    });

    await plugin.signIn();
    assertTruthy(capturedOptions.userAgent, "userAgent should be provided");
    assertIncludes(capturedOptions.userAgent, "Mozilla/5.0");
  });

  test("10.5: handles user cancellation with clear rejection", async () => {
    host._setWebSignInBehavior(new Error("The sign-in window was closed before you finished signing in"));
    await assertRejects(
      () => plugin.signIn(),
      "closed",
      "window closed must reject sign-in"
    );
  });
});

describe("Tier 1: Feature 11 - Storage Persistence (host.storage)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("11.1: persists auth state containing mediaUserToken", async () => {
    await plugin.signIn();
    const stored = await host.storage.get("auth");
    assertTruthy(stored, "stored auth must exist");
    assertTruthy(stored.mediaUserToken, "stored token must exist");
  });

  test("11.2: retrieves stored auth state across plugin calls", async () => {
    await plugin.signIn();
    const acct = await plugin.account();
    assertTruthy(acct, "account should be hydrated from storage");
  });

  test("11.3: removes auth state from storage on signOut", async () => {
    await plugin.signIn();
    await plugin.signOut();
    const stored = await host.storage.get("auth");
    assertFalsy(stored, "stored auth should be removed after signOut");
    const acct = await plugin.account();
    assertEquals(acct, null, "account should return null when signed out");
  });

  test("11.4: caches scraped developer token in storage", async () => {
    await host.storage.set("developer_token", "cached_jwt_token");
    await host.storage.set("developer_token_exp", Date.now() + 100000000);
    const token = await plugin.getDeveloperToken();
    assertEquals(token, "cached_jwt_token");
  });

  test("11.5: overwriting stored token updates value atomically", async () => {
    await host.storage.set("test_key", "value1");
    await host.storage.set("test_key", "value2");
    const val = await host.storage.get("test_key");
    assertEquals(val, "value2");
  });
});

describe("Tier 1: Feature 12 - Auth Validation & Account", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("12.1: validates storefront via /v1/me/storefront during signIn", async () => {
    await plugin.signIn();
    const requests = network.getRequests();
    const sfReq = requests.find((r) => r.url.includes("/v1/me/storefront"));
    assertTruthy(sfReq, "must validate storefront via amp-api");
  });

  test("12.2: attaches Music-User-Token to subscriber requests", async () => {
    await plugin.signIn();
    const requests = network.getRequests();
    const sfReq = requests.find((r) => r.url.includes("/v1/me/storefront"));
    assertTruthy(sfReq.headers["music-user-token"], "Music-User-Token header must be present");
  });

  test("12.3: account() returns user profile when authenticated", async () => {
    await plugin.signIn();
    const acct = await plugin.account();
    assertTruthy(acct, "account must not be null");
    assertTruthy(acct.id, "account id must exist");
    assertTruthy(acct.name, "account name must exist");
  });

  test("12.4: account() returns null when signed out", async () => {
    await host.storage.remove("auth");
    const acct = await plugin.account();
    assertEquals(acct, null, "account() must return null when unauthenticated");
  });

  test("12.5: detects expired or revoked subscriber token on API call", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "expired_token",
      storefront: "us",
    });
    await assertRejects(
      () => plugin.search({ query: "test" }),
      "signIn",
      "expired token must throw signIn code"
    );
  });
});

describe("Tier 1: Feature 13 - Localization zh-CN", () => {
  let host;
  let network;
  let plugin;
  const zhLocale = getZhLocale();

  beforeEach(async () => {
    host = createHost({ language: "zh-CN", translations: zhLocale });
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("13.1: locales/zh-CN.json is valid and contains translation keys", () => {
    assertTruthy(zhLocale, "zh-CN locale must be valid JSON");
    assert(Object.keys(zhLocale).length >= 10, "should have sufficient translation keys");
  });

  test("13.2: contains translations for navigation titles", () => {
    assertTruthy(zhLocale["Home"], "Home translation must exist");
    assertEquals(zhLocale["Home"], "主页");
    assertTruthy(zhLocale["Browse"], "Browse translation must exist");
    assertEquals(zhLocale["Browse"], "浏览");
  });

  test("13.3: contains translations for settings labels and help text", () => {
    assertTruthy(zhLocale["Storefront Region"], "Setting label translation must exist");
    assertTruthy(zhLocale["Two-letter country code (e.g. us, cn, jp, gb)"]);
  });

  test("13.4: host.t() returns translated Chinese string when language is zh-CN", () => {
    host._setLanguage("zh-CN");
    const translated = host.t("Top Songs");
    assertEquals(translated, "热门歌曲");
  });

  test("13.5: host.t() falls back to English when language is en", () => {
    host._setLanguage("en");
    const original = host.t("Top Songs");
    assertEquals(original, "Top Songs");
  });
});

describe("Tier 1: Feature 14 - Error Code Standards", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("14.1: unauthenticated state or 401/403 throws error with code 'signIn'", async () => {
    network.setRouteHandler(/\/catalog\/.*\/search/, () => {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    });

    await assertRejects(
      () => plugin.search({ query: "test" }),
      (err) => {
        assertEquals(err.code, "signIn", "error.code must be 'signIn'");
      }
    );
  });

  test("14.2: unavailable resource throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.album({ id: "404" }),
      (err) => {
        assertEquals(err.code, "unavailable", "error.code must be 'unavailable'");
      }
    );
  });

  test("14.3: missing preview stream throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.stream({ id: "9999999999" }),
      (err) => {
        assertEquals(err.code, "unavailable", "error.code must be 'unavailable'");
      }
    );
  });

  test("14.4: unsupported host environment throws error with code 'unsupported'", async () => {
    host.webSignIn = undefined;
    await assertRejects(
      () => plugin.signIn(),
      (err) => {
        assertEquals(err.code, "unsupported", "error.code must be 'unsupported'");
      }
    );
  });

  test("14.5: thrown error message is user-friendly and translated via host.t", async () => {
    const zhLocale = getZhLocale();
    host._setLanguage("zh-CN");
    host._setTranslations(zhLocale);

    await assertRejects(
      () => plugin.stream({ id: "9999999999" }),
      (err) => {
        assertEquals(err.message, "该歌曲不可播放");
      }
    );
  });
});
