/**
 * Adversarial Stress Test Suite for Milestone M4 (Playback, Stream Resolution, & Fault Tolerance)
 * Probing stream resolution edge cases, deep-link URL normalization, network failure fault tolerance,
 * dialog cancellation handling, and bilingual localization parity.
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
  assertIncludes,
  assertRejects,
  runSuites,
} from "./harness/framework.js";
import { createHost } from "./harness/host.js";
import { createNetwork } from "./harness/network.js";
import { loadPlugin } from "./harness/plugin_loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../");

function getZhLocale() {
  const rootZh = path.resolve(projectRoot, "locales/zh-CN.json");
  return JSON.parse(fs.readFileSync(rootZh, "utf-8"));
}

// ============================================================================
// Vector 1: Stream Resolution & Catalog Song Boundaries
// ============================================================================
describe("Milestone M4 Adversarial Vector 1: Stream Resolution & Song Boundaries", () => {
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

  test("1.1.1: stream() with valid preview returns Stream object with high quality, m4a type, and audio URL", async () => {
    const res = await plugin.stream({ id: "1440857781" });
    assertTruthy(res);
    assertEquals(res.type, "m4a");
    assertEquals(res.quality, "high");
    assertTruthy(res.url);
    assertIncludes(res.url, "audio-ssl.itunes.apple.com");
  });

  test("1.1.2: stream() returns headers containing Origin: https://music.apple.com and Referer", async () => {
    const res = await plugin.stream({ id: "1440857781" });
    assertTruthy(res.headers);
    assertEquals(res.headers.Origin, "https://music.apple.com");
    assertEquals(res.headers.Referer, "https://music.apple.com/");
  });

  test("1.1.3: stream() without options throws fail with code 'unavailable'", async () => {
    await assertRejects(() => plugin.stream(), "unavailable", "missing options must throw unavailable");
  });

  test("1.1.4: stream({}) with empty options throws fail with code 'unavailable'", async () => {
    await assertRejects(() => plugin.stream({}), "unavailable", "empty options must throw unavailable");
  });

  test("1.1.5: stream({ id: '' }) with empty string id throws fail with code 'unavailable'", async () => {
    await assertRejects(() => plugin.stream({ id: "" }), "unavailable", "empty id must throw unavailable");
  });

  test("1.1.6: stream({ id: null }) throws fail with code 'unavailable'", async () => {
    await assertRejects(() => plugin.stream({ id: null }), "unavailable", "null id must throw unavailable");
  });

  test("1.1.7: stream() with track having no previews attribute throws fail with code 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/us\/songs\/no_previews_attr/, () =>
      new Response(JSON.stringify({ data: [{ id: "no_previews_attr", attributes: { name: "No Previews" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await assertRejects(() => plugin.stream({ id: "no_previews_attr" }), "unavailable");
  });

  test("1.1.8: stream() with track having previews: [] (empty array) throws fail with code 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/us\/songs\/empty_previews/, () =>
      new Response(JSON.stringify({ data: [{ id: "empty_previews", attributes: { name: "Empty", previews: [] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await assertRejects(() => plugin.stream({ id: "empty_previews" }), "unavailable");
  });

  test("1.1.9: stream() with track having preview url: '' throws fail with code 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/us\/songs\/empty_url/, () =>
      new Response(JSON.stringify({ data: [{ id: "empty_url", attributes: { name: "Empty URL", previews: [{ url: "" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await assertRejects(() => plugin.stream({ id: "empty_url" }), "unavailable");
  });

  test("1.1.10: stream() with track having null attributes throws fail with code 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/us\/songs\/null_attr/, () =>
      new Response(JSON.stringify({ data: [{ id: "null_attr", attributes: null }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await assertRejects(() => plugin.stream({ id: "null_attr" }), "unavailable");
  });

  test("1.1.11: stream() when unauthenticated succeeds using public developer token without Music-User-Token", async () => {
    const res = await plugin.stream({ id: "1440857781" });
    assertTruthy(res.url);
    const req = network.getRequests().find((r) => r.url.includes("/catalog/us/songs/1440857781"));
    assertTruthy(req);
    assertTruthy(req.headers.authorization);
    assertFalsy(req.headers["music-user-token"]);
  });

  test("1.1.12: stream() when authenticated attaches Music-User-Token to catalog request", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "mut_test_token_playback",
      storefront: "us",
      account: { id: "apple-music-us", name: "Subscriber" },
    });

    const res = await plugin.stream({ id: "1440857781" });
    assertTruthy(res.url);
    const req = network.getRequests().find((r) => r.url.includes("/catalog/us/songs/1440857781"));
    assertTruthy(req);
    assertEquals(req.headers["music-user-token"], "mut_test_token_playback");
  });

  test("1.1.13: stream() for non-existent track (404) throws fail with code 'unavailable'", async () => {
    await assertRejects(() => plugin.stream({ id: "not_found" }), "unavailable");
  });

  test("1.1.14: stream() respects active storefront from settings", async () => {
    host._setSetting("storefront", "jp");
    network.setRouteHandler(/\/catalog\/jp\/songs\/jp_song/, () =>
      new Response(
        JSON.stringify({
          data: [{ id: "jp_song", attributes: { name: "JP Song", previews: [{ url: "https://audio-ssl.itunes.apple.com/jp.m4a" }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const res = await plugin.stream({ id: "jp_song" });
    assertEquals(res.url, "https://audio-ssl.itunes.apple.com/jp.m4a");
  });

  test("1.1.15: stream() accepts quality options and preserves standard stream structure", async () => {
    const resLow = await plugin.stream({ id: "1440857781", quality: "low" });
    assertEquals(resLow.type, "m4a");
    const resLossless = await plugin.stream({ id: "1440857781", quality: "lossless" });
    assertEquals(resLossless.type, "m4a");
  });
});

// ============================================================================
// Vector 2: Deep-Link URL Normalization & Scheme Sanitization (openInAppleMusic)
// ============================================================================
describe("Milestone M4 Adversarial Vector 2: Deep-Link Normalization (openInAppleMusic)", () => {
  let host;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    plugin = await loadPlugin();
  });

  test("2.1.1: openInAppleMusic() without arguments defaults to https://music.apple.com/us", async () => {
    const res = await plugin.openInAppleMusic();
    assertEquals(res.url, "https://music.apple.com/us");
    assertEquals(res.opened, true);
    assertIncludes(host._getOpenedURLs(), "https://music.apple.com/us");
  });

  test("2.1.2: openInAppleMusic({}) with empty object defaults to https://music.apple.com/us", async () => {
    const res = await plugin.openInAppleMusic({});
    assertEquals(res.url, "https://music.apple.com/us");
    assertEquals(res.opened, true);
  });

  test("2.1.3: openInAppleMusic({ id: '123' }) generates https://music.apple.com/us/song/123", async () => {
    const res = await plugin.openInAppleMusic({ id: "123" });
    assertEquals(res.url, "https://music.apple.com/us/song/123");
  });

  test("2.1.4: openInAppleMusic({ id: '123', kind: 'album' }) generates https://music.apple.com/us/album/123", async () => {
    const res = await plugin.openInAppleMusic({ id: "123", kind: "album" });
    assertEquals(res.url, "https://music.apple.com/us/album/123");
  });

  test("2.1.5: openInAppleMusic({ id: '123', kind: 'artist' }) generates https://music.apple.com/us/artist/123", async () => {
    const res = await plugin.openInAppleMusic({ id: "123", kind: "artist" });
    assertEquals(res.url, "https://music.apple.com/us/artist/123");
  });

  test("2.1.6: openInAppleMusic({ id: '123', kind: 'playlist' }) generates https://music.apple.com/us/playlist/123", async () => {
    const res = await plugin.openInAppleMusic({ id: "123", kind: "playlist" });
    assertEquals(res.url, "https://music.apple.com/us/playlist/123");
  });

  test("2.1.7: openInAppleMusic({ id: '123', storefront: 'jp' }) generates https://music.apple.com/jp/song/123", async () => {
    const res = await plugin.openInAppleMusic({ id: "123", storefront: "jp" });
    assertEquals(res.url, "https://music.apple.com/jp/song/123");
  });

  test("2.1.8: openInAppleMusic({ id: '123', storefront: ' CN ' }) trims and lowercases storefront to 'cn'", async () => {
    const res = await plugin.openInAppleMusic({ id: "123", storefront: " CN " });
    assertEquals(res.url, "https://music.apple.com/cn/song/123");
  });

  test("2.1.9: openInAppleMusic normalizes music:// scheme to https://", async () => {
    const res = await plugin.openInAppleMusic({ url: "music://music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.10: openInAppleMusic normalizes http:// scheme to https://", async () => {
    const res = await plugin.openInAppleMusic({ url: "http://music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.11: openInAppleMusic leaves https:// scheme intact", async () => {
    const res = await plugin.openInAppleMusic({ url: "https://music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.12: openInAppleMusic prepends https:// to scheme-less URL", async () => {
    const res = await plugin.openInAppleMusic({ url: "music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.13: openInAppleMusic normalizes uppercase MUSIC:// scheme to https:// without prefix corruption", async () => {
    const res = await plugin.openInAppleMusic({ url: "MUSIC://music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.14: openInAppleMusic normalizes uppercase HTTP:// scheme to https:// without prefix corruption", async () => {
    const res = await plugin.openInAppleMusic({ url: "HTTP://music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.15: openInAppleMusic normalizes uppercase HTTPS:// scheme to https:// without prefix corruption", async () => {
    const res = await plugin.openInAppleMusic({ url: "HTTPS://music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.16: openInAppleMusic normalizes mixed-case Music:// scheme to https:// without prefix corruption", async () => {
    const res = await plugin.openInAppleMusic({ url: "Music://music.apple.com/us/album/1440857781" });
    assertEquals(res.url, "https://music.apple.com/us/album/1440857781");
  });

  test("2.1.17: host.openURL() only ever receives valid https:// URLs", async () => {
    host._openedURLs = [];
    await plugin.openInAppleMusic({ url: "music://music.apple.com/us/album/1" });
    await plugin.openInAppleMusic({ url: "http://music.apple.com/us/album/2" });
    await plugin.openInAppleMusic({ id: "3" });
    for (const url of host._getOpenedURLs()) {
      assertTruthy(url.startsWith("https://"), `URL ${url} must begin with https://`);
      assertFalsy(url.includes("://music.apple.com") && !url.startsWith("https://music.apple.com"));
    }
  });

  test("2.1.18: openInAppleMusic executes safely when host is undefined", async () => {
    delete globalThis.host;
    try {
      const res = await plugin.openInAppleMusic({ id: "123" });
      assertEquals(res.opened, true);
    } finally {
      globalThis.host = host;
    }
  });

  test("2.1.19: openInAppleMusic executes safely when host.openURL is undefined", async () => {
    const orig = host.openURL;
    delete host.openURL;
    try {
      const res = await plugin.openInAppleMusic({ id: "123" });
      assertEquals(res.opened, true);
    } finally {
      host.openURL = orig;
    }
  });
});

// ============================================================================
// Vector 3: Network Fault Tolerance & Error Mapping (requestApi)
// ============================================================================
describe("Milestone M4 Adversarial Vector 3: Network Fault Tolerance (requestApi)", () => {
  let host;
  let plugin;

  beforeEach(async () => {
    host = createHost();
    globalThis.host = host;
    plugin = await loadPlugin();
  });

  test("3.1.1: fetch throwing TypeError ('fetch failed') is caught and mapped to code 'unavailable'", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.2: fetch throwing DNS resolution error with err.code = 'ENOTFOUND' is mapped to code 'unavailable'", async () => {
    const dnsErr = new Error("getaddrinfo ENOTFOUND amp-api.music.apple.com");
    dnsErr.code = "ENOTFOUND";
    globalThis.fetch = async () => {
      throw dnsErr;
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.3: fetch throwing socket timeout error with err.code = 'ETIMEDOUT' is mapped to code 'unavailable'", async () => {
    const timeoutErr = new Error("connect ETIMEDOUT");
    timeoutErr.code = "ETIMEDOUT";
    globalThis.fetch = async () => {
      throw timeoutErr;
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.4: fetch throwing connection refused error with err.code = 'ECONNREFUSED' is mapped to code 'unavailable'", async () => {
    const connErr = new Error("connect ECONNREFUSED 127.0.0.1:443");
    connErr.code = "ECONNREFUSED";
    globalThis.fetch = async () => {
      throw connErr;
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.5: fetch throwing network down error with err.code = 'ENETDOWN' is mapped to code 'unavailable'", async () => {
    const netDownErr = new Error("Network is down");
    netDownErr.code = "ENETDOWN";
    globalThis.fetch = async () => {
      throw netDownErr;
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.6: fetch throwing connection reset error with err.code = 'ECONNRESET' is mapped to code 'unavailable'", async () => {
    const resetErr = new Error("read ECONNRESET");
    resetErr.code = "ECONNRESET";
    globalThis.fetch = async () => {
      throw resetErr;
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.7: fetch throwing generic Error without code is mapped to code 'unavailable'", async () => {
    globalThis.fetch = async () => {
      throw new Error("Socket abruptly closed");
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.8: fetch throwing AbortError is mapped to code 'unavailable'", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    globalThis.fetch = async () => {
      throw abortErr;
    };
    await assertRejects(() => plugin.album({ id: "1" }), "unavailable");
  });

  test("3.1.9: intentional plugin error with code 'signIn' is preserved and rethrown as 'signIn'", async () => {
    const net = createNetwork();
    net.install();
    try {
      // Simulate 401 response
      net.setRouteHandler(/\/catalog\/us\/albums\/auth_fail/, () =>
        new Response(JSON.stringify({ errors: [{ status: "401" }] }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );
      await assertRejects(() => plugin.album({ id: "auth_fail" }), "signIn");
    } finally {
      net.uninstall();
    }
  });

  test("3.1.10: intentional plugin error with code 'unsupported' is preserved", async () => {
    host.webSignIn = undefined;
    await assertRejects(() => plugin.signIn(), "unsupported");
  });

  test("3.1.11: intentional plugin error with code 'unavailable' is preserved", async () => {
    await assertRejects(() => plugin.browse({ page: "non-existent-page" }), "unavailable");
  });
});

// ============================================================================
// Vector 4: Dialog Cancellation & Sign-In Session Edge Cases (signIn)
// ============================================================================
describe("Milestone M4 Adversarial Vector 4: Dialog Cancellation (signIn)", () => {
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

  test("4.1.1: webSignIn rejecting with modal closed error throws code 'signIn'", async () => {
    host._setWebSignInBehavior(async () => {
      throw new Error("User closed sign-in window");
    });
    await assertRejects(() => plugin.signIn(), "signIn");
  });

  test("4.1.2: webSignIn rejecting with cancellation code ('CANCELLED') throws code 'signIn'", async () => {
    host._setWebSignInBehavior(async () => {
      const cancelErr = new Error("Dialog cancelled");
      cancelErr.code = "CANCELLED";
      throw cancelErr;
    });
    await assertRejects(() => plugin.signIn(), "signIn");
  });

  test("4.1.3: webSignIn resolving with null result throws code 'signIn'", async () => {
    host._setWebSignInBehavior(async () => null);
    await assertRejects(() => plugin.signIn(), "signIn");
  });

  test("4.1.4: webSignIn resolving with empty cookie string throws code 'signIn'", async () => {
    host._setWebSignInBehavior(async () => ({ cookie: "" }));
    await assertRejects(() => plugin.signIn(), "signIn");
  });

  test("4.1.5: webSignIn resolving with cookie missing media-user-token throws code 'signIn'", async () => {
    host._setWebSignInBehavior(async () => ({ cookie: "itua=us; itspod=1" }));
    await assertRejects(() => plugin.signIn(), "signIn");
  });

  test("4.1.6: webSignIn resolving with empty media-user-token value throws code 'signIn'", async () => {
    host._setWebSignInBehavior(async () => ({ cookie: "media-user-token=; itua=us" }));
    await assertRejects(() => plugin.signIn(), "signIn");
  });

  test("4.1.7: webSignIn when host.webSignIn is undefined throws code 'unsupported'", async () => {
    host.webSignIn = undefined;
    await assertRejects(() => plugin.signIn(), "unsupported");
  });

  test("4.1.8: webSignIn when host is undefined throws code 'unsupported'", async () => {
    delete globalThis.host;
    try {
      await assertRejects(() => plugin.signIn(), "unsupported");
    } finally {
      globalThis.host = host;
    }
  });

  test("4.1.9: subscriber storefront fetch failure during signIn throws code 'signIn'", async () => {
    network.setRouteHandler(/\/v1\/me\/storefront/, () => {
      throw new TypeError("Network failure during storefront retrieval");
    });
    await assertRejects(() => plugin.signIn(), "signIn");
  });

  test("4.1.10: subscriber storefront returning 401 during signIn throws code 'signIn'", async () => {
    network.setRouteHandler(/\/v1\/me\/storefront/, () =>
      new Response(JSON.stringify({ errors: [{ status: "401" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );
    await assertRejects(() => plugin.signIn(), "signIn");
  });
});

// ============================================================================
// Vector 5: Bilingual Localization Parity (zh-CN)
// ============================================================================
describe("Milestone M4 Adversarial Vector 5: Localization Parity (zh-CN)", () => {
  let host;
  let network;
  let plugin;

  beforeEach(async () => {
    const zh = getZhLocale();
    host = createHost({ language: "zh-CN", translations: zh });
    globalThis.host = host;
    network = createNetwork();
    network.install();
    plugin = await loadPlugin();
  });

  afterEach(() => {
    network.uninstall();
  });

  test("5.1.1: album() returning empty data array throws localized error '未找到该专辑' when host language is 'zh-CN'", async () => {
    network.setRouteHandler(/\/catalog\/cn\/albums\/empty_album/, () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    try {
      await plugin.album({ id: "empty_album" });
      assert(false, "Should have thrown");
    } catch (err) {
      assertEquals(err.code, "unavailable");
      assertEquals(err.message, "未找到该专辑");
    }
  });

  test("5.1.2: artist() returning empty data array throws localized error '未找到该艺人' when host language is 'zh-CN'", async () => {
    network.setRouteHandler(/\/catalog\/cn\/artists\/empty_artist/, () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    try {
      await plugin.artist({ id: "empty_artist" });
      assert(false, "Should have thrown");
    } catch (err) {
      assertEquals(err.code, "unavailable");
      assertEquals(err.message, "未找到该艺人");
    }
  });

  test("5.1.3: playlist() returning empty data array throws localized error '未找到该歌单' when host language is 'zh-CN'", async () => {
    network.setRouteHandler(/\/catalog\/cn\/playlists\/empty_playlist/, () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    try {
      await plugin.playlist({ id: "empty_playlist" });
      assert(false, "Should have thrown");
    } catch (err) {
      assertEquals(err.code, "unavailable");
      assertEquals(err.message, "未找到该歌单");
    }
  });

  test("5.1.4: stream() with unavailable preview throws localized error '该歌曲不可播放' when host language is 'zh-CN'", async () => {
    network.setRouteHandler(/\/catalog\/cn\/songs\/no_prev/, () =>
      new Response(JSON.stringify({ data: [{ id: "no_prev", attributes: { previews: [] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    try {
      await plugin.stream({ id: "no_prev" });
      assert(false, "Should have thrown");
    } catch (err) {
      assertEquals(err.code, "unavailable");
      assertEquals(err.message, "该歌曲不可播放");
    }
  });

  test("5.1.5: network failure throws localized error '网络请求失败' when host language is 'zh-CN'", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    try {
      await plugin.album({ id: "1" });
      assert(false, "Should have thrown");
    } catch (err) {
      assertEquals(err.code, "unavailable");
      assertEquals(err.message, "网络请求失败");
    }
  });

  test("5.1.6: webSignIn cancellation throws localized error '登录窗口在完成登录前被关闭' when host language is 'zh-CN'", async () => {
    host._setWebSignInBehavior(async () => {
      throw new Error("Window closed");
    });
    try {
      await plugin.signIn();
      assert(false, "Should have thrown");
    } catch (err) {
      assertEquals(err.code, "signIn");
      assertEquals(err.message, "登录窗口在完成登录前被关闭");
    }
  });

  test("5.1.7: album(), artist(), playlist(), stream() error codes are all 'unavailable' in zh-CN", async () => {
    await assertRejects(() => plugin.album({ id: "" }), "unavailable");
    await assertRejects(() => plugin.artist({ id: "" }), "unavailable");
    await assertRejects(() => plugin.playlist({ id: "" }), "unavailable");
    await assertRejects(() => plugin.stream({ id: "" }), "unavailable");
  });

  test("5.1.8: webSignIn error code is 'signIn' in zh-CN", async () => {
    host._setWebSignInBehavior(async () => null);
    await assertRejects(() => plugin.signIn(), "signIn");
  });
});

// Run all test suites
const result = await runSuites();
if (!result.success) {
  process.exit(1);
} else {
  process.exit(0);
}
