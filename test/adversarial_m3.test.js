/**
 * Adversarial Stress Test Suite for Milestone M3 (Catalog Search, Suggestions, & Browsing)
 * Comprehensive empirical testing across hostile queries, pagination limits, browse/chart edge cases,
 * entity resolution boundaries, duration/artwork invariants, and localization parity.
 */

import {
  describe,
  test,
  beforeEach,
  afterEach,
  assert,
  assertEquals,
  assertDeepEquals,
  assertTruthy,
  assertFalsy,
  assertIncludes,
  assertRejects,
  runSuites,
} from "./harness/framework.js";
import { createHost } from "./harness/host.js";
import { createNetwork } from "./harness/network.js";
import { loadPlugin } from "./harness/plugin_loader.js";

// ============================================================================
// Vector 1: Hostile Search & Suggest Queries
// ============================================================================
describe("Milestone M3 Adversarial Vector 1: Hostile Search & Suggest Queries", () => {
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

  test("1.1.1: search with null options returns empty tracks without crash", async () => {
    const res = await plugin.search(null);
    assertTruthy(res);
    assertEquals(res.tracks.length, 0);
    assertEquals(res.more, false);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.1.2: search with undefined options returns empty tracks without crash", async () => {
    const res = await plugin.search(undefined);
    assertTruthy(res);
    assertEquals(res.tracks.length, 0);
    assertEquals(res.more, false);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.1.3: search with empty object returns empty tracks", async () => {
    const res = await plugin.search({});
    assertTruthy(res);
    assertEquals(res.tracks.length, 0);
    assertEquals(res.more, false);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.1.4: search with query: null returns empty tracks without network call", async () => {
    const res = await plugin.search({ query: null });
    assertEquals(res.tracks.length, 0);
    assertEquals(res.more, false);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.1.5: search with query: undefined returns empty tracks without network call", async () => {
    const res = await plugin.search({ query: undefined });
    assertEquals(res.tracks.length, 0);
    assertEquals(res.more, false);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.1.6: search with whitespace-only query (' \\t\\r\\n ') returns empty tracks without network call", async () => {
    const res = await plugin.search({ query: "   \t\r\n   " });
    assertEquals(res.tracks.length, 0);
    assertEquals(res.more, false);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.1.7: search with zero query (query: 0) coerces to '0' and executes search", async () => {
    const res = await plugin.search({ query: 0 });
    assertTruthy(res.tracks);
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "term=0");
  });

  test("1.1.8: search with numeric query (query: 12345) coerces to '12345' and executes search", async () => {
    const res = await plugin.search({ query: 12345 });
    assertTruthy(res.tracks);
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "term=12345");
  });

  test("1.1.9: search with boolean false query coerces to 'false' and executes search", async () => {
    const res = await plugin.search({ query: false });
    assertTruthy(res.tracks);
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "term=false");
  });

  test("1.1.10: search with SQL injection payload (' OR '1'='1) is properly URL-encoded", async () => {
    await plugin.search({ query: "' OR '1'='1; --" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "term='%20OR%20'1'%3D'1%3B%20--");
  });

  test("1.1.11: search with XSS HTML payload (<script>alert('xss')</script>) is properly URL-encoded", async () => {
    await plugin.search({ query: "<script>alert('xss')</script>" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "term=%3Cscript%3Ealert('xss')%3C%2Fscript%3E");
  });

  test("1.1.12: search with complex emojis and zero-width joiners encodes cleanly", async () => {
    await plugin.search({ query: "🎵 👨‍👩‍👧‍👦 🔥 🎸" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "%F0%9F%8E%B5");
  });

  test("1.1.13: search with multi-language CJK and Arabic characters encodes cleanly", async () => {
    await plugin.search({ query: "周杰伦 宇多田ヒカル موسيقى" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "%E5%91%A8%E6%9D%B0%E4%BC%A6");
  });

  test("1.1.14: search with massive query (5,000 characters) handles without crash or memory fault", async () => {
    const massiveTerm = "query_".repeat(1000);
    const res = await plugin.search({ query: massiveTerm });
    assertTruthy(res);
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
  });

  test("1.2.1: suggest with null options returns empty array", async () => {
    const res = await plugin.suggest(null);
    assertEquals(res.length, 0);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.2.2: suggest with undefined options returns empty array", async () => {
    const res = await plugin.suggest(undefined);
    assertEquals(res.length, 0);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.2.3: suggest with query: null returns empty array", async () => {
    const res = await plugin.suggest({ query: null });
    assertEquals(res.length, 0);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.2.4: suggest with query: undefined returns empty array", async () => {
    const res = await plugin.suggest({ query: undefined });
    assertEquals(res.length, 0);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.2.5: suggest with whitespace-only query returns empty array", async () => {
    const res = await plugin.suggest({ query: "   \t\n   " });
    assertEquals(res.length, 0);
    assertEquals(network.getRequests().length, 0);
  });

  test("1.2.6: suggest with numeric query (query: 42) coerces to '42' and requests hints", async () => {
    const res = await plugin.suggest({ query: 42 });
    assertTruthy(Array.isArray(res));
    const req = network.getRequests().find((r) => r.url.includes("/search/hints"));
    assertTruthy(req);
    assertIncludes(req.url, "term=42");
  });

  test("1.2.7: suggest with SQL injection payload is properly URL-encoded", async () => {
    await plugin.suggest({ query: "' UNION SELECT 1,2,3--" });
    const req = network.getRequests().find((r) => r.url.includes("/search/hints"));
    assertTruthy(req);
    assertIncludes(req.url, "term='%20UNION%20SELECT%201%2C2%2C3--");
  });

  test("1.2.8: suggest with emoji query encodes cleanly", async () => {
    await plugin.suggest({ query: "🎧 Beats" });
    const req = network.getRequests().find((r) => r.url.includes("/search/hints"));
    assertTruthy(req);
    assertIncludes(req.url, "%F0%9F%8E%A7");
  });
});

// ============================================================================
// Vector 2: Pagination Limit Boundaries & Type Coercion
// ============================================================================
describe("Milestone M3 Adversarial Vector 2: Pagination Limit Boundaries & Type Coercion", () => {
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

  test("2.1.1: default limit is 20 when limit is omitted", async () => {
    await plugin.search({ query: "pop" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=20");
  });

  test("2.1.2: limit: 0 is clamped to 1 (preventing Apple 400 Bad Request)", async () => {
    await plugin.search({ query: "pop", limit: 0 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=1");
  });

  test("2.1.3: limit: 1 is passed as 1 (minimum allowed boundary)", async () => {
    await plugin.search({ query: "pop", limit: 1 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=1");
  });

  test("2.1.4: limit: 50 is passed as 50 (maximum allowed boundary)", async () => {
    await plugin.search({ query: "pop", limit: 50 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=50");
  });

  test("2.1.5: limit: 51 is clamped to 50 (preventing Apple 400 Bad Request)", async () => {
    await plugin.search({ query: "pop", limit: 51 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=50");
  });

  test("2.1.6: limit: 500 is clamped to 50", async () => {
    await plugin.search({ query: "pop", limit: 500 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=50");
  });

  test("2.1.7: limit: -1 is clamped to 1", async () => {
    await plugin.search({ query: "pop", limit: -1 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=1");
  });

  test("2.1.8: limit: -9999 is clamped to 1", async () => {
    await plugin.search({ query: "pop", limit: -9999 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=1");
  });

  test("2.1.9: limit: NaN falls back safely to default 20", async () => {
    await plugin.search({ query: "pop", limit: NaN });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=20");
  });

  test("2.1.10: limit: Infinity is clamped safely to 50", async () => {
    await plugin.search({ query: "pop", limit: Infinity });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=50");
  });

  test("2.1.11: limit: -Infinity is clamped safely to 1", async () => {
    await plugin.search({ query: "pop", limit: -Infinity });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=1");
  });

  test("2.1.12: limit as numeric string '35' is coerced to 35", async () => {
    await plugin.search({ query: "pop", limit: "35" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=35");
  });

  test("2.1.13: limit as non-numeric string 'invalid' falls back to 20", async () => {
    await plugin.search({ query: "pop", limit: "invalid" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=20");
  });

  test("2.1.14: limit as floating point number 25.8 is floored to 25", async () => {
    await plugin.search({ query: "pop", limit: 25.8 });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=25");
  });

  test("2.1.15: limit: null falls back to default 20", async () => {
    await plugin.search({ query: "pop", limit: null });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "limit=20");
  });
});

// ============================================================================
// Vector 3: Browse & Chart Edge Cases
// ============================================================================
describe("Milestone M3 Adversarial Vector 3: Browse & Chart Edge Cases", () => {
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

  test("3.1.1: unknown browse page throws fail with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.browse({ page: "nonexistent_section" }),
      "unavailable",
      "unknown page must throw unavailable code"
    );
  });

  test("3.1.2: hostile/traversal browse page throws fail with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.browse({ page: "../../etc/passwd" }),
      "unavailable",
      "path traversal must throw unavailable code"
    );
  });

  test("3.1.3: unknown browse options.id throws fail with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.browse({ id: "unknown_id_123" }),
      "unavailable",
      "unknown id must throw unavailable code"
    );
  });

  test("3.1.4: browse() with no argument returns home Browse object", async () => {
    const res = await plugin.browse();
    assertTruthy(res.sections);
    assertTruthy(Array.isArray(res.sections));
  });

  test("3.1.5: browse({}) with empty object returns home Browse object", async () => {
    const res = await plugin.browse({});
    assertTruthy(res.sections);
    assertTruthy(Array.isArray(res.sections));
  });

  test("3.1.6: browse({ page: 'home' }) returns home Browse object", async () => {
    const res = await plugin.browse({ page: "home" });
    assertTruthy(res.sections);
  });

  test("3.1.7: browse({ page: 'charts' }) returns home Browse object", async () => {
    const res = await plugin.browse({ page: "charts" });
    assertTruthy(res.sections);
  });

  test("3.1.8: browse({ page: 'browse' }) returns home Browse object", async () => {
    const res = await plugin.browse({ page: "browse" });
    assertTruthy(res.sections);
  });

  test("3.2.1: home() handles API response with missing results object gracefully", async () => {
    network.setRouteHandler(/\/catalog\/.*\/charts/, () => {
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const res = await plugin.home();
    assertTruthy(res);
    assertEquals(res.sections.length, 0);
  });

  test("3.2.2: home() handles API response with empty results: {} gracefully", async () => {
    network.setRouteHandler(/\/catalog\/.*\/charts/, () => {
      return new Response(JSON.stringify({ results: {} }), { status: 200 });
    });
    const res = await plugin.home();
    assertTruthy(res);
    assertEquals(res.sections.length, 0);
  });

  test("3.2.3: home() handles charts containing songs with empty data: [] without crash", async () => {
    network.setRouteHandler(/\/catalog\/.*\/charts/, () => {
      return new Response(
        JSON.stringify({
          results: {
            songs: [{ data: [] }],
            albums: [],
            playlists: null,
          },
        }),
        { status: 200 }
      );
    });
    const res = await plugin.home();
    assertTruthy(res);
    assertEquals(res.sections.length, 0);
  });

  test("3.2.4: browse('charts-songs') handles empty API results gracefully", async () => {
    network.setRouteHandler(/\/catalog\/.*\/charts\?types=songs/, () => {
      return new Response(JSON.stringify({ results: { songs: [{ data: [] }] } }), {
        status: 200,
      });
    });
    const res = await plugin.browse({ page: "charts-songs" });
    assertTruthy(res);
    assertEquals(res.sections.length, 1);
    assertEquals(res.sections[0].tracks.length, 0);
  });

  test("3.2.5: browse('charts-albums') handles empty API results gracefully", async () => {
    network.setRouteHandler(/\/catalog\/.*\/charts\?types=albums/, () => {
      return new Response(JSON.stringify({ results: { albums: [{ data: [] }] } }), {
        status: 200,
      });
    });
    const res = await plugin.browse({ page: "charts-albums" });
    assertTruthy(res);
    assertEquals(res.sections.length, 1);
    assertEquals(res.sections[0].albums.length, 0);
  });

  test("3.2.6: browse('charts-playlists') handles empty API results gracefully", async () => {
    network.setRouteHandler(/\/catalog\/.*\/charts\?types=playlists/, () => {
      return new Response(JSON.stringify({ results: { playlists: [{ data: [] }] } }), {
        status: 200,
      });
    });
    const res = await plugin.browse({ page: "charts-playlists" });
    assertTruthy(res);
    assertEquals(res.sections.length, 1);
    assertEquals(res.sections[0].playlists.length, 0);
  });
});

// ============================================================================
// Vector 4: Entity Resolution Boundaries (Missing IDs, 404s, Corrupt Payloads)
// ============================================================================
describe("Milestone M3 Adversarial Vector 4: Entity Resolution Boundaries", () => {
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

  test("4.1.1: album with missing id throws unavailable code", async () => {
    await assertRejects(() => plugin.album({}), "unavailable", "missing id must throw");
    await assertRejects(() => plugin.album({ id: "" }), "unavailable", "empty id must throw");
    await assertRejects(() => plugin.album(null), "unavailable", "null options must throw");
    await assertRejects(() => plugin.album(undefined), "unavailable", "undefined options must throw");
  });

  test("4.1.2: artist with missing id throws unavailable code", async () => {
    await assertRejects(() => plugin.artist({}), "unavailable", "missing id must throw");
    await assertRejects(() => plugin.artist({ id: "" }), "unavailable", "empty id must throw");
    await assertRejects(() => plugin.artist(null), "unavailable", "null options must throw");
    await assertRejects(() => plugin.artist(undefined), "unavailable", "undefined options must throw");
  });

  test("4.1.3: playlist with missing id throws unavailable code", async () => {
    await assertRejects(() => plugin.playlist({}), "unavailable", "missing id must throw");
    await assertRejects(() => plugin.playlist({ id: "" }), "unavailable", "empty id must throw");
    await assertRejects(() => plugin.playlist(null), "unavailable", "null options must throw");
    await assertRejects(() => plugin.playlist(undefined), "unavailable", "undefined options must throw");
  });

  test("4.2.1: album returning HTTP 404 throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.album({ id: "404" }),
      "unavailable",
      "404 album must throw unavailable"
    );
  });

  test("4.2.2: artist returning HTTP 404 throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.artist({ id: "404" }),
      "unavailable",
      "404 artist must throw unavailable"
    );
  });

  test("4.2.3: playlist returning HTTP 404 throws error with code 'unavailable'", async () => {
    await assertRejects(
      () => plugin.playlist({ id: "404" }),
      "unavailable",
      "404 playlist must throw unavailable"
    );
  });

  test("4.3.1: album API returning 200 with empty data array throws 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/.*\/albums\/empty_alb/, () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await assertRejects(
      () => plugin.album({ id: "empty_alb" }),
      "unavailable",
      "empty data must throw unavailable"
    );
  });

  test("4.3.2: artist API returning 200 with empty data array throws 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/.*\/artists\/empty_art/, () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await assertRejects(
      () => plugin.artist({ id: "empty_art" }),
      "unavailable",
      "empty data must throw unavailable"
    );
  });

  test("4.3.3: playlist API returning 200 with empty data array throws 'unavailable'", async () => {
    network.setRouteHandler(/\/catalog\/.*\/playlists\/empty_pl/, () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await assertRejects(
      () => plugin.playlist({ id: "empty_pl" }),
      "unavailable",
      "empty data must throw unavailable"
    );
  });

  test("4.4.1: album with missing attributes and missing relationships maps safely", async () => {
    network.setRouteHandler(/\/catalog\/.*\/albums\/sparse_alb/, () => {
      return new Response(
        JSON.stringify({
          data: [{ id: "sparse_alb", type: "albums" }],
        }),
        { status: 200 }
      );
    });
    const res = await plugin.album({ id: "sparse_alb" });
    assertTruthy(res);
    assertEquals(res.album.id, "sparse_alb");
    assertEquals(res.tracks.length, 0);
  });

  test("4.4.2: artist with missing views maps safely with empty tracks and albums", async () => {
    network.setRouteHandler(/\/catalog\/.*\/artists\/sparse_art/, () => {
      return new Response(
        JSON.stringify({
          data: [{ id: "sparse_art", type: "artists", attributes: { name: "Sparse Artist" } }],
        }),
        { status: 200 }
      );
    });
    const res = await plugin.artist({ id: "sparse_art" });
    assertTruthy(res);
    assertEquals(res.artist.name, "Sparse Artist");
    assertEquals(res.tracks.length, 0);
    assertEquals(res.albums.length, 0);
  });

  test("4.4.3: playlist with missing relationships maps safely with empty tracks", async () => {
    network.setRouteHandler(/\/catalog\/.*\/playlists\/sparse_pl/, () => {
      return new Response(
        JSON.stringify({
          data: [{ id: "sparse_pl", type: "playlists", attributes: { name: "Sparse Playlist" } }],
        }),
        { status: 200 }
      );
    });
    const res = await plugin.playlist({ id: "sparse_pl" });
    assertTruthy(res);
    assertEquals(res.name, "Sparse Playlist");
    assertEquals(res.tracks.length, 0);
  });
});

// ============================================================================
// Vector 5: Duration and Artwork Format Invariants & Localization Parity
// ============================================================================
describe("Milestone M3 Adversarial Vector 5: Format Invariants & Localization Parity", () => {
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

  test("5.1.1: formatArtworkUrl handles undefined and null safely", () => {
    assertEquals(plugin.formatArtworkUrl(undefined), undefined);
    assertEquals(plugin.formatArtworkUrl(null), undefined);
    assertEquals(plugin.formatArtworkUrl(""), undefined);
  });

  test("5.1.2: formatArtworkUrl replaces {w}x{h} with 600x600 by default", () => {
    const raw = "https://is1-ssl.mzstatic.com/image/thumb/Music/{w}x{h}bb.jpg";
    const formatted = plugin.formatArtworkUrl(raw);
    assertEquals(formatted, "https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg");
    assertFalsy(formatted.includes("{w}"));
    assertFalsy(formatted.includes("{h}"));
  });

  test("5.1.3: formatArtworkUrl honors custom size argument", () => {
    const raw = "https://is1-ssl.mzstatic.com/image/thumb/Music/{w}x{h}bb.jpg";
    const formatted = plugin.formatArtworkUrl(raw, 300);
    assertEquals(formatted, "https://is1-ssl.mzstatic.com/image/thumb/Music/300x300bb.jpg");
  });

  test("5.1.4: formatArtworkUrl leaves URL without template unchanged", () => {
    const raw = "https://is1-ssl.mzstatic.com/image/thumb/Music/static_artwork.jpg";
    assertEquals(plugin.formatArtworkUrl(raw), raw);
  });

  test("5.2.1: mapTrack strictly preserves durationInMillis as integer milliseconds", () => {
    // 215432 ms -> 215432 ms
    const track1 = plugin.mapTrack({ attributes: { durationInMillis: 215432 } });
    assertEquals(track1.duration, 215432);
    assertEquals(track1.durationInMillis, 215432);
    assertTruthy(Number.isInteger(track1.duration));

    // 0 ms -> 0 ms
    const track2 = plugin.mapTrack({ attributes: { durationInMillis: 0 } });
    assertEquals(track2.duration, 0);
    assertTruthy(Number.isInteger(track2.duration));

    // null durationInMillis -> 0 ms
    const track3 = plugin.mapTrack({ attributes: { durationInMillis: null } });
    assertEquals(track3.duration, 0);
    assertTruthy(Number.isInteger(track3.duration));

    // undefined durationInMillis -> 0 ms
    const track4 = plugin.mapTrack({ attributes: {} });
    assertEquals(track4.duration, 0);
    assertTruthy(Number.isInteger(track4.duration));

    // 999 ms -> 999 ms
    const track5 = plugin.mapTrack({ attributes: { durationInMillis: 999 } });
    assertEquals(track5.duration, 999);
    assertTruthy(Number.isInteger(track5.duration));

    // negative -> clamped to 0 ms
    const track6 = plugin.mapTrack({ attributes: { durationInMillis: -400 } });
    assertEquals(track6.duration, 0);
    assertTruthy(Number.isInteger(track6.duration));
  });

  test("5.2.2: all track durations across album, playlist, artist, and search are integer milliseconds", async () => {
    const albumRes = await plugin.album({ id: "100" });
    for (const t of albumRes.tracks) {
      assertTruthy(Number.isInteger(t.duration), `track duration must be integer: ${t.duration}`);
      assertTruthy(t.duration > 0, "track duration should be > 0");
    }

    const playlistRes = await plugin.playlist({ id: "pl100" });
    for (const t of playlistRes.tracks) {
      assertTruthy(Number.isInteger(t.duration));
    }

    const artistRes = await plugin.artist({ id: "art100" });
    for (const t of artistRes.tracks) {
      assertTruthy(Number.isInteger(t.duration));
    }

    const searchRes = await plugin.search({ query: "rock" });
    for (const t of searchRes.tracks) {
      assertTruthy(Number.isInteger(t.duration));
    }
  });

  test("5.2.3: no artwork or imageUrl retains {w} or {h} placeholders across catalog objects", async () => {
    const albumRes = await plugin.album({ id: "100" });
    assertTruthy(albumRes.album.artwork);
    assertFalsy(albumRes.album.artwork.includes("{w}"));
    assertFalsy(albumRes.album.imageUrl.includes("{w}"));
    for (const t of albumRes.tracks) {
      if (t.artwork) assertFalsy(t.artwork.includes("{w}"));
      if (t.imageUrl) assertFalsy(t.imageUrl.includes("{w}"));
    }

    const artistRes = await plugin.artist({ id: "art100" });
    if (artistRes.artist.artwork) assertFalsy(artistRes.artist.artwork.includes("{w}"));

    const playlistRes = await plugin.playlist({ id: "pl100" });
    if (playlistRes.artwork) assertFalsy(playlistRes.artwork.includes("{w}"));
  });

  test("5.3.1: album() includes l=${lang} query parameter", async () => {
    host._setLanguage("zh-CN");
    await plugin.album({ id: "100" });
    const req = network.getRequests().find((r) => r.url.includes("/albums/100"));
    assertTruthy(req);
    assertIncludes(req.url, "l=zh-CN");
  });

  test("5.3.2: artist() includes l=${lang} query parameter", async () => {
    host._setLanguage("zh-CN");
    await plugin.artist({ id: "art100" });
    const req = network.getRequests().find((r) => r.url.includes("/artists/art100"));
    assertTruthy(req);
    assertIncludes(req.url, "l=zh-CN");
  });

  test("5.3.3: playlist() includes l=${lang} query parameter", async () => {
    host._setLanguage("zh-CN");
    await plugin.playlist({ id: "pl100" });
    const req = network.getRequests().find((r) => r.url.includes("/playlists/pl100"));
    assertTruthy(req);
    assertIncludes(req.url, "l=zh-CN");
  });

  test("5.3.4: search() includes l=${lang} query parameter", async () => {
    host._setLanguage("zh-CN");
    await plugin.search({ query: "piano" });
    const req = network.getRequests().find((r) => r.url.includes("/search"));
    assertTruthy(req);
    assertIncludes(req.url, "l=zh-CN");
  });

  test("5.3.5: suggest() includes l=${lang} query parameter", async () => {
    host._setLanguage("zh-CN");
    await plugin.suggest({ query: "pia" });
    const req = network.getRequests().find((r) => r.url.includes("/search/hints"));
    assertTruthy(req);
    assertIncludes(req.url, "l=zh-CN");
  });

  test("5.3.6: home() and browse() include l=${lang} query parameter", async () => {
    host._setLanguage("zh-CN");
    await plugin.home();
    const req = network.getRequests().find((r) => r.url.includes("/charts"));
    assertTruthy(req);
    assertIncludes(req.url, "l=zh-CN");
  });
});

// Run all test suites
const result = await runSuites();
if (!result.success) {
  process.exit(1);
} else {
  process.exit(0);
}
