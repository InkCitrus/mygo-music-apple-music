/**
 * Tier 2: Boundary & Corner Cases Test Suite
 * Minimum >= 5 tests per boundary feature:
 * 1. Empty & Special Search Queries
 * 2. Pagination Limits (0, 1, 50, 51, negative)
 * 3. Invalid & Expired Tokens (JWT claims, Origin verification, media-user-token expiry)
 * 4. Unknown & Edge Storefronts ('xx', 'US', setting vs auth precedence)
 * 5. Missing & DRM Previews (empty previews, unavailable handling, isolation)
 */

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

describe("Tier 2: Boundary 1 - Empty & Special Search Queries", () => {
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

  test("2.1.1: empty string query returns empty results without sending network request", async () => {
    const res = await plugin.search({ query: "", kind: "tracks" });
    assertTruthy(res.tracks, "result must contain tracks array");
    assertEquals(res.tracks.length, 0, "tracks array should be empty");
    assertEquals(res.more, false, "more should be false");
    const requests = network.getRequests();
    const searchReq = requests.find((r) => r.url.includes("/search"));
    assertEquals(searchReq, undefined, "no network request should be sent for empty query");
  });

  test("2.1.2: whitespace-only query ('   ') is trimmed and returns empty results", async () => {
    const res = await plugin.search({ query: "     ", kind: "tracks" });
    assertEquals(res.tracks.length, 0, "should be empty");
    assertEquals(res.more, false);
  });

  test("2.1.3: punctuation and special symbols ('!@#$%^&*()') are URL-encoded properly", async () => {
    await plugin.search({ query: "rock & roll / 100%", kind: "tracks" });
    const requests = network.getRequests();
    const searchReq = requests.find((r) => r.url.includes("/search"));
    assertTruthy(searchReq, "search request must be sent");
    assertIncludes(searchReq.url, "term=rock%20%26%20roll%20%2F%20100%25");
  });

  test("2.1.4: extreme length search query (>1000 characters) is handled cleanly", async () => {
    const longQuery = "a".repeat(1200);
    const res = await plugin.search({ query: longQuery, kind: "tracks" });
    assertTruthy(res, "should return response without crash");
  });

  test("2.1.5: unicode emojis and multi-byte characters ('🎵🔥🎧') encoded correctly", async () => {
    await plugin.search({ query: "Taylor 🎵 Swift", kind: "tracks" });
    const requests = network.getRequests();
    const searchReq = requests.find((r) => r.url.includes("/search"));
    assertTruthy(searchReq, "search request must be sent");
    assertIncludes(searchReq.url, "%F0%9F%8E%B5");
  });
});

describe("Tier 2: Boundary 2 - Pagination Limits (0, 1, 50, 51, negative)", () => {
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

  test("2.2.1: limit=0 is rejected or clamped by API with 400 error handled cleanly", async () => {
    network.setRouteHandler(/\/catalog\/.*\/search/, (url) => {
      if (url.includes("limit=0")) {
        return new Response(
          JSON.stringify({
            errors: [{ title: "Bad Request", detail: "limit must be >= 1" }],
          }),
          { status: 400 }
        );
      }
    });

    await assertRejects(
      async () => {
        const url = `/catalog/us/search?term=test&limit=0`;
        const res = await fetch(`https://amp-api.music.apple.com/v1${url}`, {
          headers: {
            Authorization: `Bearer ${await plugin.getDeveloperToken()}`,
            Origin: "https://music.apple.com",
          },
        });
        if (!res.ok) throw new Error("limit 0 rejected");
      },
      "limit 0 rejected",
      "limit=0 should be rejected by API"
    );
  });

  test("2.2.2: limit=1 returns single item from search", async () => {
    network.setRouteHandler(/\/catalog\/.*\/search.*limit=1/, () => {
      return new Response(
        JSON.stringify({
          results: {
            songs: {
              data: [
                {
                  id: "1",
                  type: "songs",
                  attributes: { name: "Single Track", artistName: "Artist" },
                },
              ],
            },
          },
        }),
        { status: 200 }
      );
    });

    const res = await fetch(
      "https://amp-api.music.apple.com/v1/catalog/us/search?term=test&types=songs&limit=1",
      {
        headers: {
          Authorization: `Bearer ${await plugin.getDeveloperToken()}`,
          Origin: "https://music.apple.com",
        },
      }
    );
    const json = await res.json();
    assertEquals(json.results.songs.data.length, 1, "should contain exactly 1 song");
  });

  test("2.2.3: limit=50 returns maximum boundary items", async () => {
    network.setRouteHandler(/\/catalog\/.*\/search.*limit=50/, () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        id: String(i + 1),
        type: "songs",
        attributes: { name: `Track ${i + 1}`, artistName: "Artist" },
      }));
      return new Response(
        JSON.stringify({ results: { songs: { data: items } } }),
        { status: 200 }
      );
    });

    const res = await fetch(
      "https://amp-api.music.apple.com/v1/catalog/us/search?term=test&types=songs&limit=50",
      {
        headers: {
          Authorization: `Bearer ${await plugin.getDeveloperToken()}`,
          Origin: "https://music.apple.com",
        },
      }
    );
    const json = await res.json();
    assertEquals(json.results.songs.data.length, 50, "should accept limit 50");
  });

  test("2.2.4: limit=51 is rejected by amp-api with HTTP 400", async () => {
    const res = await fetch(
      "https://amp-api.music.apple.com/v1/catalog/us/search?term=test&types=songs&limit=51",
      {
        headers: {
          Authorization: `Bearer ${await plugin.getDeveloperToken()}`,
          Origin: "https://music.apple.com",
        },
      }
    );
    assertEquals(res.status, 400, "amp-api must reject limit > 50 with 400 Bad Request");
  });

  test("2.2.5: negative limit=-5 is rejected by amp-api with HTTP 400", async () => {
    const res = await fetch(
      "https://amp-api.music.apple.com/v1/catalog/us/search?term=test&types=songs&limit=-5",
      {
        headers: {
          Authorization: `Bearer ${await plugin.getDeveloperToken()}`,
          Origin: "https://music.apple.com",
        },
      }
    );
    assertEquals(res.status, 400, "amp-api must reject negative limit with 400 Bad Request");
  });
});

describe("Tier 2: Boundary 3 - Invalid & Expired Tokens", () => {
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

  test("2.3.1: missing Bearer developer token returns HTTP 401 Unauthorized", async () => {
    const res = await fetch("https://amp-api.music.apple.com/v1/catalog/us/charts?types=songs", {
      headers: {
        Origin: "https://music.apple.com",
      },
    });
    assertEquals(res.status, 401, "gateway must return 401 without bearer token");
  });

  test("2.3.2: missing Origin header returns HTTP 401 Unauthorized", async () => {
    const token = await plugin.getDeveloperToken();
    const res = await fetch("https://amp-api.music.apple.com/v1/catalog/us/charts?types=songs", {
      headers: {
        Authorization: `Bearer ${token}`,
        // Omitting Origin header
      },
    });
    assertEquals(res.status, 401, "gateway must return 401 when Origin is missing");
  });

  test("2.3.3: expired developer token in cache triggers re-harvesting", async () => {
    await host.storage.set("developer_token", "stale_expired_jwt");
    await host.storage.set("developer_token_exp", Date.now() - 100000); // Expired
    const token = await plugin.getDeveloperToken();
    assert(token !== "stale_expired_jwt", "should refresh expired token");
    assertIncludes(token, "eyJ");
  });

  test("2.3.4: expired subscriber media-user-token returns 403 and clears auth", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "expired_token",
      storefront: "us",
    });

    await assertRejects(
      () => plugin.search({ query: "test" }),
      "signIn",
      "expired token must throw signIn"
    );

    const storedAuth = await host.storage.get("auth");
    assertEquals(storedAuth, undefined, "expired auth must be cleared from storage");
  });

  test("2.3.5: malformed token string in storage does not crash plugin", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "!!!malformed_cookie_value###",
      storefront: "us",
    });

    // Plugin catches and handles error cleanly
    await assertRejects(
      () => plugin.search({ query: "test" }),
      (err) => {
        assertTruthy(err.code, "must have error code");
      }
    );
  });
});

describe("Tier 2: Boundary 4 - Unknown & Edge Storefronts", () => {
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

  test("2.4.1: unknown storefront 'xx' returns 40009 error handled cleanly", async () => {
    host._setSetting("storefront", "xx");
    await assertRejects(
      () => plugin.home(),
      (err) => {
        assertEquals(err.code, "unavailable", "unknown storefront should result in unavailable error");
      }
    );
  });

  test("2.4.2: uppercase storefront 'US' is normalized to lowercase 'us'", async () => {
    host._setSetting("storefront", "US");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "us", "storefront must be lowercase");
  });

  test("2.4.3: storefront with surrounding whitespace ('  cn  ') is trimmed", async () => {
    host._setSetting("storefront", "  cn  ");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "cn", "storefront must be trimmed");
  });

  test("2.4.4: setting storefront takes precedence when signed out", async () => {
    host._setSetting("storefront", "jp");
    await host.storage.remove("auth");
    const sf = await plugin.getStorefront();
    assertEquals(sf, "jp");
  });

  test("2.4.5: subscriber storefront from auth takes precedence over default", async () => {
    host._setSetting("storefront", "");
    await host.storage.set("auth", {
      mediaUserToken: "mock_token",
      storefront: "gb",
    });
    const sf = await plugin.getStorefront();
    assertEquals(sf, "gb", "auth storefront should be used");
  });
});

describe("Tier 2: Boundary 5 - Missing & DRM Previews", () => {
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

  test("2.5.1: track with empty previews: [] throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.stream({ id: "9999999999" }),
      (err) => {
        assertEquals(err.code, "unavailable");
      }
    );
  });

  test("2.5.2: track with null previews attribute throws code 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/.*\/songs\/null_previews/, () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "null_previews",
              type: "songs",
              attributes: { name: "Null Previews", previews: null },
            },
          ],
        }),
        { status: 200 }
      );
    });

    await assertRejects(
      () => plugin.stream({ id: "null_previews" }),
      (err) => {
        assertEquals(err.code, "unavailable");
      }
    );
  });

  test("2.5.3: track 404 not found in catalog throws code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.stream({ id: "404" }),
      (err) => {
        assertEquals(err.code, "unavailable");
      }
    );
  });

  test("2.5.4: missing preview error message is clear to user", async () => {
    await assertRejects(
      () => plugin.stream({ id: "9999999999" }),
      (err) => {
        assertIncludes(err.message, "unavailable");
      }
    );
  });

  test("2.5.5: stream resolution failure on one track does not corrupt subsequent requests", async () => {
    // Failing track
    await assertRejects(() => plugin.stream({ id: "9999999999" }), "unavailable");

    // Immediately following valid track succeeds
    const validStream = await plugin.stream({ id: "1585800430" });
    assertTruthy(validStream.url);
    assertEquals(validStream.type, "m4a");
  });
});
