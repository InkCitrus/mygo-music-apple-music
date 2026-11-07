/**
 * Mock Network Simulation for Apple Music APIs
 * Intercepts global fetch and returns authoritative fixture responses.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, "../fixtures");

function readFixture(name) {
  const filePath = path.join(fixturesDir, name);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export class MockNetwork {
  constructor() {
    this._requests = [];
    this._customRoutes = [];
    this._originalFetch = globalThis.fetch;
    this._fixtures = {
      chartsUs: readFixture("charts_us.json"),
      chartsCn: readFixture("charts_cn.json"),
      searchSongs: readFixture("search_songs.json"),
      searchAlbums: readFixture("search_albums.json"),
      searchArtists: readFixture("search_artists.json"),
      searchPlaylists: readFixture("search_playlists.json"),
      searchHints: readFixture("search_hints.json"),
      albumDetail: readFixture("album_detail.json"),
      artistDetail: readFixture("artist_detail.json"),
      playlistDetail: readFixture("playlist_detail.json"),
      songWithPreview: readFixture("song_detail_with_preview.json"),
      songNoPreview: readFixture("song_detail_no_preview.json"),
      meStorefront: readFixture("me_storefront.json"),
      meAccount: readFixture("me_account.json"),
      errStorefront: readFixture("error_40009_storefront.json"),
      errLimit: readFixture("error_400_limit.json"),
      errUnauthorized: readFixture("error_401_unauthorized.json"),
      errForbidden: readFixture("error_403_forbidden.json"),
    };
  }

  install() {
    globalThis.fetch = this.fetch.bind(this);
  }

  uninstall() {
    globalThis.fetch = this._originalFetch;
  }

  reset() {
    this._requests = [];
    this._customRoutes = [];
  }

  getRequests() {
    return [...this._requests];
  }

  setRouteHandler(regexOrPredicate, handler) {
    this._customRoutes.unshift({ matcher: regexOrPredicate, handler });
  }

  async fetch(input, init = {}) {
    const urlStr = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});

    const reqRecord = {
      url: urlStr,
      method,
      headers: Object.fromEntries(headers.entries()),
      body: init.body,
      timestamp: Date.now(),
    };
    this._requests.push(reqRecord);

    // Check custom routes
    for (const route of this._customRoutes) {
      const match =
        typeof route.matcher === "function"
          ? route.matcher(urlStr, init)
          : route.matcher.test(urlStr);
      if (match) {
        return route.handler(urlStr, init, reqRecord);
      }
    }

    const parsed = new URL(urlStr);

    // 1. Dynamic developer token scraper routes
    if (parsed.hostname === "music.apple.com") {
      if (parsed.pathname === "/us/browse" || parsed.pathname === "/") {
        const mockHtml = `
          <!DOCTYPE html>
          <html>
            <head>
              <script src="/assets/index~abc12345.js" type="module"></script>
            </head>
            <body>Apple Music Web</body>
          </html>
        `;
        return new Response(mockHtml, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (parsed.pathname.startsWith("/assets/index~")) {
        const mockJs = `
          const Do = "2644.9.0-external";
          const qa = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw";
        `;
        return new Response(mockJs, {
          status: 200,
          headers: { "Content-Type": "application/javascript" },
        });
      }
    }

    // 2. Audio Preview CDN routes
    if (parsed.hostname === "audio-ssl.itunes.apple.com") {
      return new Response(new Uint8Array(1024), {
        status: 200,
        headers: {
          "Content-Type": "audio/x-m4a",
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 3. Apple Music amp-api Gateway
    if (parsed.hostname === "amp-api.music.apple.com") {
      const authHeader = headers.get("authorization");
      const originHeader = headers.get("origin");

      // Check Bearer Token
      if (!authHeader || !authHeader.startsWith("Bearer ey")) {
        return new Response(JSON.stringify(this._fixtures.errUnauthorized), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Check Origin Header (must match *.apple.com per JWT root_https_origin)
      if (!originHeader || !originHeader.includes("apple.com")) {
        return new Response(JSON.stringify(this._fixtures.errUnauthorized), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Check User Token on amp-api if supplied
      const userToken =
        headers.get("music-user-token") ||
        headers.get("media-user-token") ||
        (headers.get("cookie") || "").match(/media-user-token=([^;]+)/)?.[1];

      if (userToken && (userToken === "expired_token" || userToken === "invalid_token" || userToken.startsWith("!"))) {
        return new Response(JSON.stringify(this._fixtures.errForbidden), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const pathname = parsed.pathname;

      // Handle /v1/me/* subscriber endpoints
      if (pathname.startsWith("/v1/me/")) {
        if (!userToken) {
          return new Response(JSON.stringify(this._fixtures.errForbidden), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }


        if (pathname === "/v1/me/storefront") {
          return new Response(JSON.stringify(this._fixtures.meStorefront), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (pathname === "/v1/me/account") {
          return new Response(JSON.stringify(this._fixtures.meAccount), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Handle Storefront Validation in Catalog
      const sfMatch = pathname.match(/^\/v1\/catalog\/([a-zA-Z0-9_-]+)/);
      if (sfMatch) {
        const storefront = sfMatch[1].toLowerCase();
        if (storefront === "xx") {
          return new Response(JSON.stringify(this._fixtures.errStorefront), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Limit parameter validation
        const limitParam = parsed.searchParams.get("limit");
        if (limitParam !== null) {
          const limitVal = parseInt(limitParam, 10);
          if (isNaN(limitVal) || limitVal < 1 || limitVal > 50) {
            return new Response(JSON.stringify(this._fixtures.errLimit), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Charts
        if (pathname.endsWith("/charts")) {
          const lang = parsed.searchParams.get("l");
          const fixture = (storefront === "cn" || lang === "zh-CN")
            ? this._fixtures.chartsCn
            : this._fixtures.chartsUs;
          return new Response(JSON.stringify(fixture), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Search Hints
        if (pathname.endsWith("/search/hints")) {
          const term = parsed.searchParams.get("term") || "";
          if (!term.trim()) {
            return new Response(JSON.stringify({ results: { terms: [] } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(this._fixtures.searchHints), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Catalog Search
        if (pathname.endsWith("/search")) {
          const term = parsed.searchParams.get("term") || "";
          const types = parsed.searchParams.get("types") || "songs";

          if (!term.trim()) {
            return new Response(JSON.stringify({ results: {} }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (types.includes("albums") && !types.includes("songs")) {
            return new Response(JSON.stringify(this._fixtures.searchAlbums), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (types.includes("artists") && !types.includes("songs")) {
            return new Response(JSON.stringify(this._fixtures.searchArtists), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (types.includes("playlists") && !types.includes("songs")) {
            return new Response(JSON.stringify(this._fixtures.searchPlaylists), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(JSON.stringify(this._fixtures.searchSongs), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Albums
        if (pathname.includes("/albums/")) {
          const id = pathname.split("/albums/")[1];
          if (id === "not_found" || id === "404") {
            return new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(this._fixtures.albumDetail), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Artists
        if (pathname.includes("/artists/")) {
          const id = pathname.split("/artists/")[1];
          if (id === "not_found" || id === "404") {
            return new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(this._fixtures.artistDetail), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Playlists
        if (pathname.includes("/playlists/")) {
          const id = pathname.split("/playlists/")[1];
          if (id === "not_found" || id === "404") {
            return new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (id === "empty_playlist") {
            const emptyPl = JSON.parse(JSON.stringify(this._fixtures.playlistDetail));
            emptyPl.data[0].relationships.tracks.data = [];
            return new Response(JSON.stringify(emptyPl), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(this._fixtures.playlistDetail), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Songs
        if (pathname.includes("/songs/")) {
          const id = pathname.split("/songs/")[1];
          if (id === "9999999999" || id === "no_preview") {
            return new Response(JSON.stringify(this._fixtures.songNoPreview), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (id === "404" || id === "not_found") {
            return new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(this._fixtures.songWithPreview), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // Default 404 fallback
    return new Response(JSON.stringify({ error: "Not Found", url: urlStr }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export function createNetwork() {
  return new MockNetwork();
}
