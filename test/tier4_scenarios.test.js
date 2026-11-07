/**
 * Tier 4: Real-World Workload Scenarios Test Suite
 * End-to-end realistic user workflows:
 * 1. Cold Start Discovery to Playback
 * 2. Subscriber Onboarding & Account Linking
 * 3. Multi-Region Roaming & Language Switching
 * 4. Playback Resilience with Missing Previews & Error Recovery
 * 5. Token Rotation & Automatic Session Recovery
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

describe("Tier 4: Real-World Workload Scenarios", () => {
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

  test("4.1: Cold Start Discovery to Playback Workflow", async () => {
    // 1. App starts up, verifies manifest
    const manifest = getManifest();
    assertEquals(manifest.id, "apple-music");

    // 2. User arrives at Home page
    const homeBrowse = await plugin.home();
    assert(homeBrowse.sections.length > 0, "home should have sections");
    const topSongs = homeBrowse.sections[0];
    assertEquals(topSongs.kind, "tracks");
    assert(topSongs.items.length > 0);

    // 3. User types in search query "tay" to see instant suggestions
    const suggestions = await plugin.suggest({ query: "tay" });
    assertIncludes(suggestions, "taylor swift");

    // 4. User selects "taylor swift" and runs full search
    const searchResult = await plugin.search({ query: "taylor swift", kind: "tracks" });
    assert(searchResult.tracks.length > 0);
    const selectedTrack = searchResult.tracks[0];

    // 5. User clicks Play -> stream URL resolved
    const streamInfo = await plugin.stream({ id: selectedTrack.id });
    assertTruthy(streamInfo.url);
    assertEquals(streamInfo.type, "m4a");
    assertEquals(streamInfo.quality, "high");
    assertIncludes(streamInfo.headers.Origin, "apple.com");
  });

  test("4.2: Subscriber Onboarding & Account Linking Workflow", async () => {
    // 1. Initial state: unauthenticated user
    let userAccount = await plugin.account();
    assertEquals(userAccount, null, "initial account should be null");

    // 2. User clicks Sign In -> host.webSignIn opens ephemeral webview
    let windowClosed = false;
    host._setWebSignInBehavior(async (opts) => {
      // Simulate user logging in on music.apple.com
      return {
        cookie: "media-user-token=authenticated_sub_token_2026; itua=us; itspod=1",
      };
    });

    const signedInAccount = await plugin.signIn();
    assertTruthy(signedInAccount);
    assertEquals(signedInAccount.id, "apple-music-us");

    // 3. Plugin persists credentials in host.storage
    const authState = await host.storage.get("auth");
    assertEquals(authState.mediaUserToken, "authenticated_sub_token_2026");
    assertEquals(authState.storefront, "us");

    // 4. Account is now active
    userAccount = await plugin.account();
    assertEquals(userAccount.id, "apple-music-us");

    // 5. Subsequent catalog requests attach subscriber credentials
    await plugin.home();
    const requests = network.getRequests();
    const chartReq = requests.find((r) => r.url.includes("/charts"));
    assertEquals(chartReq.headers["music-user-token"], "authenticated_sub_token_2026");
  });

  test("4.3: Multi-Region Roaming & Language Switching Workflow", async () => {
    // 1. User switches storefront to Japan in settings
    await plugin.setSetting({ key: "storefront", value: "jp" });
    let sf = await plugin.getStorefront();
    assertEquals(sf, "jp");

    // 2. User switches language to Simplified Chinese
    const zhLocale = getZhLocale();
    host._setLanguage("zh-CN");
    host._setTranslations(zhLocale);

    // 3. User browses Home -> catalog queries jp storefront with zh-CN localization
    const homeData = await plugin.home();
    assertTruthy(homeData.sections);

    const requests = network.getRequests();
    const chartReq = requests.find((r) => r.url.includes("/catalog/jp/charts"));
    assertTruthy(chartReq, "request must target /catalog/jp/charts");
    assertIncludes(chartReq.url, "l=zh-CN", "must include l=zh-CN");

    // 4. Home section title is localized into Chinese
    const songsSection = homeData.sections.find((s) => s.kind === "tracks");
    assertEquals(songsSection.title, "热门歌曲");
  });

  test("4.4: Playback Resilience with Missing Previews & Error Recovery Workflow", async () => {
    // Track 1: Normal track with preview
    const stream1 = await plugin.stream({ id: "1585800430" });
    assertTruthy(stream1.url);

    // Track 2: DRM restricted track without preview -> throws unavailable
    await assertRejects(
      () => plugin.stream({ id: "9999999999" }),
      (err) => {
        assertEquals(err.code, "unavailable");
      }
    );

    // Track 3: Next track in queue plays successfully without state contamination
    const stream3 = await plugin.stream({ id: "1585800430" });
    assertTruthy(stream3.url);
  });

  test("4.5: Token Rotation & Automatic Session Recovery Workflow", async () => {
    // 1. Stored session expires on Apple backend
    await host.storage.set("auth", {
      mediaUserToken: "expired_token",
      storefront: "us",
    });

    // 2. Request fails with 403, catches and throws signIn
    await assertRejects(
      () => plugin.search({ query: "taylor" }),
      (err) => {
        assertEquals(err.code, "signIn");
      }
    );

    // Stale session cleared
    const authAfterExpiry = await host.storage.get("auth");
    assertEquals(authAfterExpiry, undefined);

    // 3. Host triggers signIn re-login
    host._setWebSignInBehavior(async () => {
      return {
        cookie: "media-user-token=fresh_rotated_token_2026; itua=us",
      };
    });

    await plugin.signIn();

    // 4. Session recovered
    const authRecovered = await host.storage.get("auth");
    assertEquals(authRecovered.mediaUserToken, "fresh_rotated_token_2026");

    const searchRes = await plugin.search({ query: "taylor", kind: "tracks" });
    assert(searchRes.tracks.length > 0);
  });
});
