/**
 * Adversarial Stress Test Suite for Milestone M2 (Authentication & Session Management)
 * Tests hostile cookie inputs, storefront resolution edge cases, and HTTP 401/403 token eviction.
 */

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

describe("Milestone M2 Adversarial Vector 1: Hostile Cookie Parsing", () => {
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

  // 1.1 Non-string and missing cookie results
  test("1.1.1: webSignIn returning null result throws signIn code", async () => {
    host._setWebSignInBehavior(async () => null);
    await assertRejects(() => plugin.signIn(), "signIn", "null result must throw signIn");
  });

  test("1.1.2: webSignIn returning empty object throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({}));
    await assertRejects(() => plugin.signIn(), "signIn", "empty object must throw signIn");
  });

  test("1.1.3: webSignIn returning cookie: null throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({ cookie: null }));
    await assertRejects(() => plugin.signIn(), "signIn", "null cookie must throw signIn");
  });

  test("1.1.4: webSignIn returning cookie: '' (empty string) throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({ cookie: "" }));
    await assertRejects(() => plugin.signIn(), "signIn", "empty cookie string must throw signIn");
  });

  test("1.1.5: webSignIn returning numeric cookie throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({ cookie: 12345 }));
    await assertRejects(() => plugin.signIn(), "signIn", "numeric cookie must throw signIn");
  });

  test("1.1.6: webSignIn returning object cookie throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({ cookie: { token: "abc" } }));
    await assertRejects(() => plugin.signIn(), "signIn", "object cookie must throw signIn");
  });

  // 1.2 Double-quoted tokens
  test("1.2.1: double-quoted token is unquoted and saved cleanly", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: 'media-user-token="valid_quoted_token_abc_123"',
    }));
    const acct = await plugin.signIn();
    assertTruthy(acct, "signIn should succeed with quoted token");
    const stored = await host.storage.get("auth");
    assertEquals(stored.mediaUserToken, "valid_quoted_token_abc_123", "quotes must be stripped");
  });

  test("1.2.2: double-quoted token with other cookies is extracted without quotes", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: 'itua=us; media-user-token="quoted_middle_token"; itspod=1',
    }));
    await plugin.signIn();
    const stored = await host.storage.get("auth");
    assertEquals(stored.mediaUserToken, "quoted_middle_token", "quotes must be stripped");
  });

  test("1.2.3: empty double-quoted token ('\"\"') throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: 'media-user-token=""',
    }));
    await assertRejects(() => plugin.signIn(), "signIn", "empty quotes must throw signIn");
  });

  test("1.2.4: whitespace-only inside double quotes ('\"   \"') throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: 'media-user-token="   "',
    }));
    await assertRejects(() => plugin.signIn(), "signIn", "whitespace inside quotes must throw signIn");
  });

  // 1.3 Empty & whitespace-only tokens
  test("1.3.1: empty token without semicolon ('media-user-token=') throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "media-user-token=",
    }));
    await assertRejects(() => plugin.signIn(), "signIn", "empty token must throw signIn");
  });

  test("1.3.2: empty token with trailing semicolon ('media-user-token=; itua=us') throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "media-user-token=; itua=us",
    }));
    await assertRejects(() => plugin.signIn(), "signIn", "empty token before semicolon must throw signIn");
  });

  test("1.3.3: spaces-only token ('media-user-token=   ; itua=us') throws signIn code", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "media-user-token=   ; itua=us",
    }));
    await assertRejects(() => plugin.signIn(), "signIn", "spaces token must throw signIn");
  });

  // 1.4 Collision tokens & prefix / suffix attacks
  test("1.4.1: prefix_media-user-token does NOT hijack media-user-token", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "fake_prefix_media-user-token=malicious_fake; media-user-token=authentic_token_123",
    }));
    await plugin.signIn();
    const stored = await host.storage.get("auth");
    assertEquals(stored.mediaUserToken, "authentic_token_123", "must extract authentic token, not prefix");
  });

  test("1.4.2: not-media-user-token at beginning does not match", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "not-media-user-token=malicious_fake; itua=us",
    }));
    await assertRejects(() => plugin.signIn(), "signIn", "not-media-user-token must not match");
  });

  test("1.4.3: media-user-token-backup does not match when real token is absent", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "media-user-token-backup=backup_token; itua=us",
    }));
    await assertRejects(() => plugin.signIn(), "signIn", "media-user-token-backup must not match");
  });

  test("1.4.4: media-user-token followed by media-user-token-backup extracts true token", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "media-user-token=true_token; media-user-token-backup=backup_token",
    }));
    await plugin.signIn();
    const stored = await host.storage.get("auth");
    assertEquals(stored.mediaUserToken, "true_token", "must match true token");
  });

  test("1.4.5: duplicate media-user-token extracts first valid token without corruption", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "media-user-token=primary_token; other=1; media-user-token=secondary_token",
    }));
    await plugin.signIn();
    const stored = await host.storage.get("auth");
    assertEquals(stored.mediaUserToken, "primary_token", "must extract first token");
  });

  // 1.5 Special characters and base64 padding
  test("1.5.1: base64 token with '=' padding is preserved intact", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "media-user-token=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig==; itua=us",
    }));
    await plugin.signIn();
    const stored = await host.storage.get("auth");
    assertEquals(
      stored.mediaUserToken,
      "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig==",
      "base64 '=' padding must be preserved"
    );
  });

  test("1.5.2: token surrounded by spaces inside cookie is trimmed properly", async () => {
    host._setWebSignInBehavior(async () => ({
      cookie: "itua=us; media-user-token=  trimmed_token_456  ; itspod=1",
    }));
    await plugin.signIn();
    const stored = await host.storage.get("auth");
    assertEquals(stored.mediaUserToken, "trimmed_token_456", "token must be trimmed");
  });
});

describe("Milestone M2 Adversarial Vector 2: Storefront Resolution Edge Cases", () => {
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

  // 2.1 Whitespace-only setting
  test("2.1.1: whitespace-only setting ('   ') falls through to default 'us'", async () => {
    host._setSetting("storefront", "   ");
    await host.storage.remove("auth");
    host._setLanguage("en");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "us", "whitespace-only setting must not be returned");
  });

  test("2.1.2: tab and newline whitespace setting falls through to auth storefront", async () => {
    host._setSetting("storefront", "\t \n ");
    await host.storage.set("auth", { mediaUserToken: "tok", storefront: "jp" });
    const sf = await plugin.getStorefront();
    assertEquals(sf, "jp", "whitespace setting must fall through to auth storefront");
  });

  // 2.2 Empty setting
  test("2.2.1: empty string setting falls through to zh-CN language fallback 'cn'", async () => {
    host._setSetting("storefront", "");
    await host.storage.remove("auth");
    host._setLanguage("zh-CN");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "cn", "empty setting with zh-CN must fallback to cn");
  });

  // 2.3 Case normalization
  test("2.3.1: uppercase setting 'US' is normalized to lowercase 'us'", async () => {
    host._setSetting("storefront", "US");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "us", "uppercase setting must be normalized to lowercase");
  });

  test("2.3.2: mixed case setting '  Jp  ' is trimmed and lowercased to 'jp'", async () => {
    host._setSetting("storefront", "  Jp  ");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "jp", "must trim and lowercase");
  });

  test("2.3.3: uppercase auth storefront 'GB' is normalized to lowercase 'gb'", async () => {
    host._setSetting("storefront", "");
    await host.storage.set("auth", { mediaUserToken: "tok", storefront: "GB" });
    const sf = await plugin.getStorefront();
    assertEquals(sf, "gb", "auth storefront must be lowercased");
  });

  // 2.4 Corrupted / empty stored storefront in auth
  test("2.4.1: whitespace-only stored storefront in auth falls through safely", async () => {
    host._setSetting("storefront", "");
    await host.storage.set("auth", { mediaUserToken: "tok", storefront: "   " });
    host._setLanguage("en");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "us", "whitespace auth storefront must fall through to default");
  });

  test("2.4.2: non-string stored storefront (number) falls through safely without crashing", async () => {
    host._setSetting("storefront", "");
    await host.storage.set("auth", { mediaUserToken: "tok", storefront: 12345 });
    host._setLanguage("en");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "us", "non-string storefront in auth must not crash plugin");
  });

  test("2.4.3: null stored storefront in auth falls through safely without crashing", async () => {
    host._setSetting("storefront", "");
    await host.storage.set("auth", { mediaUserToken: "tok", storefront: null });
    host._setLanguage("en");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "us", "null storefront in auth must not crash plugin");
  });

  // 2.5 Precedence ordering
  test("2.5.1: non-empty setting takes precedence over auth storefront", async () => {
    host._setSetting("storefront", "de");
    await host.storage.set("auth", { mediaUserToken: "tok", storefront: "fr" });
    const sf = await plugin.getStorefront();
    assertEquals(sf, "de", "explicit user setting must take precedence over auth storefront");
  });

  test("2.5.2: auth storefront takes precedence over language fallback", async () => {
    host._setSetting("storefront", "");
    host._setLanguage("zh-CN");
    await host.storage.set("auth", { mediaUserToken: "tok", storefront: "gb" });
    const sf = await plugin.getStorefront();
    assertEquals(sf, "gb", "auth storefront must take precedence over language fallback");
  });
});

describe("Milestone M2 Adversarial Vector 3: HTTP 401 & 403 Token Eviction", () => {
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

  // 3.1 HTTP 401 on Bearer Developer Token
  test("3.1.1: HTTP 401 evicts developer_token and developer_token_exp from storage", async () => {
    await host.storage.set("developer_token", "invalid_expired_dev_token");
    await host.storage.set("developer_token_exp", Date.now() + 500000);

    // Mock amp-api returning 401 Unauthorized
    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      () =>
        new Response(JSON.stringify({ errors: [{ status: "401", title: "Unauthorized" }] }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
    );

    await assertRejects(
      () => plugin.search({ query: "rock" }),
      "signIn",
      "HTTP 401 must throw error with code 'signIn'"
    );

    const devToken = await host.storage.get("developer_token");
    const devTokenExp = await host.storage.get("developer_token_exp");
    assertEquals(devToken, undefined, "developer_token must be evicted from storage on 401");
    assertEquals(devTokenExp, undefined, "developer_token_exp must be evicted from storage on 401");
  });

  test("3.1.2: HTTP 401 does NOT evict subscriber auth session", async () => {
    await host.storage.set("developer_token", "invalid_expired_dev_token");
    await host.storage.set("auth", {
      mediaUserToken: "valid_subscriber_token",
      storefront: "us",
      account: { id: "apple-music-us", name: "Subscriber" },
    });

    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      () =>
        new Response(JSON.stringify({ errors: [{ status: "401", title: "Unauthorized" }] }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
    );

    await assertRejects(() => plugin.search({ query: "rock" }), "signIn");

    const auth = await host.storage.get("auth");
    assertTruthy(auth, "subscriber auth session must NOT be evicted by developer token 401");
    assertEquals(auth.mediaUserToken, "valid_subscriber_token");
  });

  // 3.2 HTTP 403 on Subscriber Token
  test("3.2.1: HTTP 403 evicts auth from storage and invalidates account", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "revoked_user_token",
      storefront: "us",
      account: { id: "apple-music-us", name: "User" },
    });

    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      () =>
        new Response(JSON.stringify({ errors: [{ status: "403", title: "Forbidden" }] }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
    );

    await assertRejects(
      () => plugin.search({ query: "rock" }),
      "signIn",
      "HTTP 403 must throw error with code 'signIn'"
    );

    const storedAuth = await host.storage.get("auth");
    assertEquals(storedAuth, undefined, "auth must be evicted from storage on 403");

    const acct = await plugin.account();
    assertEquals(acct, null, "account() must return null after auth eviction");
  });

  test("3.2.2: HTTP 403 does NOT evict valid developer_token", async () => {
    await host.storage.set("developer_token", "healthy_developer_token");
    await host.storage.set("developer_token_exp", Date.now() + 86400000 * 10);
    await host.storage.set("auth", {
      mediaUserToken: "expired_token",
      storefront: "us",
    });

    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      () =>
        new Response(JSON.stringify({ errors: [{ status: "403", title: "Forbidden" }] }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
    );

    await assertRejects(() => plugin.search({ query: "rock" }), "signIn");

    const devToken = await host.storage.get("developer_token");
    assertEquals(devToken, "healthy_developer_token", "developer_token must remain untouched on 403");
  });

  test("3.2.3: subsequent API call after 403 does not include Music-User-Token header", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "bad_token",
      storefront: "us",
    });

    let firstCall = true;
    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      (url, init, record) => {
        if (firstCall) {
          firstCall = false;
          return new Response(JSON.stringify({ errors: [{ status: "403", title: "Forbidden" }] }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Second call should not have Music-User-Token
        return new Response(JSON.stringify({ results: { songs: { data: [] } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    // First call: 403 -> evicts auth
    await assertRejects(() => plugin.search({ query: "test1" }), "signIn");

    // Second call: unauthenticated request
    await plugin.search({ query: "test2" });

    const requests = network.getRequests();
    const secondReq = requests[requests.length - 1];
    assertFalsy(secondReq.headers["music-user-token"], "subsequent request must NOT send evicted token");
  });

  // 3.3 Storage failure during eviction resilience
  test("3.3.1: storage removal exception during 401 does not crash error handling", async () => {
    host.storage.remove = async () => {
      throw new Error("Disk I/O error during storage.remove");
    };

    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      () =>
        new Response(JSON.stringify({ errors: [{ status: "401", title: "Unauthorized" }] }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
    );

    await assertRejects(
      () => plugin.search({ query: "test" }),
      "signIn",
      "plugin must safely handle storage removal failure and throw signIn"
    );
  });

  test("3.3.2: storage removal exception during 403 does not crash error handling", async () => {
    host.storage.remove = async () => {
      throw new Error("Disk I/O error during storage.remove");
    };

    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      () =>
        new Response(JSON.stringify({ errors: [{ status: "403", title: "Forbidden" }] }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
    );

    await assertRejects(
      () => plugin.search({ query: "test" }),
      "signIn",
      "plugin must safely handle storage removal failure and throw signIn"
    );
  });

  // 3.4 Full 401 Recovery Cycle Simulation
  test("3.4.1: complete 401 eviction, token re-harvesting, and recovery cycle", async () => {
    // 1. Storage starts with stale dev token
    await host.storage.set("developer_token", "stale_token_prior_to_401");
    await host.storage.set("developer_token_exp", Date.now() + 86400000 * 5);

    let devTokenRevoked = true;
    network.setRouteHandler(
      (url) => url.includes("/v1/catalog/"),
      (url, init, record) => {
        if (devTokenRevoked) {
          return new Response(JSON.stringify({ errors: [{ status: "401", title: "Unauthorized" }] }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ results: { songs: { data: [] } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    // First request fails with 401
    await assertRejects(() => plugin.search({ query: "test" }), "signIn");

    // Token must be evicted
    assertEquals(await host.storage.get("developer_token"), undefined);

    // Host rotates/re-harvests token
    devTokenRevoked = false;
    const freshToken = await plugin.getDeveloperToken();
    assertTruthy(freshToken);
    assert(freshToken !== "stale_token_prior_to_401", "must harvest fresh token");

    // Subsequent search succeeds with fresh token
    const result = await plugin.search({ query: "test" });
    assertTruthy(result.tracks);
  });
});

describe("Milestone M2 Adversarial Vector 4: Developer Token Scraper Fallbacks", () => {
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

  test("4.1: network failure while fetching browse HTML falls back to DEFAULT_DEV_TOKEN", async () => {
    network.setRouteHandler(
      (url) => url.includes("music.apple.com/us/browse"),
      () => {
        throw new Error("DNS resolution failed");
      }
    );
    const token = await plugin.getDeveloperToken();
    assertTruthy(token);
    assertIncludes(token, "eyJ");
  });

  test("4.2: HTML containing no JS bundle script falls back to DEFAULT_DEV_TOKEN", async () => {
    network.setRouteHandler(
      (url) => url.includes("music.apple.com/us/browse"),
      () => new Response("<html><body>No scripts here</body></html>", { status: 200 })
    );
    const token = await plugin.getDeveloperToken();
    assertTruthy(token);
    assertIncludes(token, "eyJ");
  });

  test("4.3: JS bundle returning 500 server error falls back to DEFAULT_DEV_TOKEN", async () => {
    network.setRouteHandler(
      (url) => url.includes("/assets/index~"),
      () => new Response("Internal Server Error", { status: 500 })
    );
    const token = await plugin.getDeveloperToken();
    assertTruthy(token);
    assertIncludes(token, "eyJ");
  });

  test("4.4: JS bundle containing no JWT token string falls back to DEFAULT_DEV_TOKEN", async () => {
    network.setRouteHandler(
      (url) => url.includes("/assets/index~"),
      () => new Response("const a = 1; console.log(a);", { status: 200 })
    );
    const token = await plugin.getDeveloperToken();
    assertTruthy(token);
    assertIncludes(token, "eyJ");
  });
});

// Execute all test suites
const result = await runSuites();
if (!result.success) {
  process.exit(1);
} else {
  process.exit(0);
}
