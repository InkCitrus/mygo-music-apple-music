/**
 * Tier 3: Cross-Feature Interactions Test Suite
 * Pairwise integration between modules:
 * 1. Search + Stream
 * 2. Auth + Browse
 * 3. Settings Storefront + Localized Search
 * 4. WebSignIn + Account + SignOut
 * 5. Session Expiry + Error SignIn + Re-Auth
 * 6. Album + Stream
 * 7. Artist + Album + Stream
 * 8. Playlist + Stream
 * 9. Localization + Error Message Translation
 * 10. Storage Persistence + Startup Hydration
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

function getZhLocale() {
  const rootZh = path.resolve(projectRoot, "locales/zh-CN.json");
  const target = fs.existsSync(rootZh)
    ? rootZh
    : path.resolve(fixturesDir, "zh-CN.json");
  return JSON.parse(fs.readFileSync(target, "utf-8"));
}

describe("Tier 3: Pairwise Interactions", () => {
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

  test("3.1: Search + Stream — search track and stream it", async () => {
    const searchRes = await plugin.search({ query: "taylor swift", kind: "tracks" });
    assert(searchRes.tracks.length > 0, "must find tracks");
    const track = searchRes.tracks[0];

    const streamRes = await plugin.stream({ id: track.id });
    assertTruthy(streamRes.url, "must resolve stream url");
    assertEquals(streamRes.type, "m4a");
    assertEquals(streamRes.quality, "high");
  });

  test("3.2: Auth + Browse — sign in and browse charts with session", async () => {
    const acct = await plugin.signIn();
    assertTruthy(acct, "sign-in must succeed");

    const homeData = await plugin.home();
    assertTruthy(homeData.sections, "home sections must load");

    const requests = network.getRequests();
    const chartReq = requests.find((r) => r.url.includes("/charts"));
    assertTruthy(chartReq, "chart request must be sent");
    assertTruthy(chartReq.headers["music-user-token"], "authenticated request must include user token");
  });

  test("3.3: Settings Storefront + Localized Search — storefront setting directs search region & language", async () => {
    host._setSetting("storefront", "cn");
    host._setLanguage("zh-CN");

    await plugin.search({ query: "周杰伦", kind: "tracks" });

    const requests = network.getRequests();
    const searchReq = requests.find((r) => r.url.includes("/search"));
    assertTruthy(searchReq, "search request must be sent");
    assertIncludes(searchReq.url, "/v1/catalog/cn/search", "must target cn storefront");
    assertIncludes(searchReq.url, "l=zh-CN", "must include zh-CN language parameter");
  });

  test("3.4: WebSignIn + Account + SignOut — lifecycle flow", async () => {
    // 1. Sign in
    await plugin.signIn();
    let currentAccount = await plugin.account();
    assertTruthy(currentAccount, "account must exist after sign in");

    // 2. Sign out
    await plugin.signOut();
    currentAccount = await plugin.account();
    assertEquals(currentAccount, null, "account must be null after sign out");
  });

  test("3.5: Session Expiry + Error SignIn + Re-Auth — recovers smoothly", async () => {
    // 1. Setup expired session
    await host.storage.set("auth", {
      mediaUserToken: "expired_token",
      storefront: "us",
    });

    // 2. Attempt call -> throws signIn
    await assertRejects(
      () => plugin.search({ query: "test" }),
      (err) => {
        assertEquals(err.code, "signIn");
      }
    );

    // 3. User re-authenticates via signIn
    await plugin.signIn();

    // 4. Next call succeeds
    const res = await plugin.search({ query: "taylor", kind: "tracks" });
    assert(res.tracks.length > 0);
  });

  test("3.6: Album + Stream — browse album tracklist and stream first track", async () => {
    const albumData = await plugin.album({ id: "1585800424" });
    assert(albumData.tracks.length > 0, "album must have tracks");
    const firstTrack = albumData.tracks[0];

    const streamData = await plugin.stream({ id: firstTrack.id });
    assertTruthy(streamData.url);
    assertEquals(streamData.type, "m4a");
  });

  test("3.7: Artist + Album + Stream — artist discography drill-down", async () => {
    const artistData = await plugin.artist({ id: "159260351" });
    assert(artistData.albums.length > 0, "artist must have albums");
    const topAlbum = artistData.albums[0];

    const albumData = await plugin.album({ id: topAlbum.id });
    assert(albumData.tracks.length > 0, "album must have tracks");

    const trackStream = await plugin.stream({ id: albumData.tracks[0].id });
    assertTruthy(trackStream.url);
  });

  test("3.8: Playlist + Stream — resolve stream for track inside playlist", async () => {
    const pl = await plugin.playlist({ id: "pl.u-2aoq8mNTGEeN5" });
    assert(pl.tracks.length > 0, "playlist must have tracks");

    const trackStream = await plugin.stream({ id: pl.tracks[0].id });
    assertTruthy(trackStream.url);
    assertEquals(trackStream.type, "m4a");
  });

  test("3.9: Localization + Error Message Translation — errors translated per host.language", async () => {
    const zhLocale = getZhLocale();
    host._setLanguage("zh-CN");
    host._setTranslations(zhLocale);

    await assertRejects(
      () => plugin.stream({ id: "9999999999" }),
      (err) => {
        assertEquals(err.code, "unavailable");
        assertEquals(err.message, "该歌曲不可播放");
      }
    );
  });

  test("3.10: Storage Persistence + Startup Hydration — loads user on startup", async () => {
    // 1. Session stored in host.storage
    await host.storage.set("auth", {
      mediaUserToken: "persisted_token",
      storefront: "us",
      account: {
        id: "apple-music-us",
        name: "Apple Music Subscriber",
        page: "library",
      },
    });

    // 2. Query account
    const acct = await plugin.account();
    assertTruthy(acct);
    assertEquals(acct.id, "apple-music-us");
    assertEquals(acct.name, "Apple Music Subscriber");
  });
});
