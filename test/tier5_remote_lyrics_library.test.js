/**
 * Tier 5: Full-Track Remote Playback (macOS Music.app), TTML Word-by-Word Lyrics,
 * LRCLIB Fallback, Subscriber Library Hooks, and Real osacompile Dictionary Validation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
import { loadPlugin } from "./harness/plugin_loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../");

function loadZhTranslations() {
  return JSON.parse(
    fs.readFileSync(path.resolve(projectRoot, "locales/zh-CN.json"), "utf-8")
  );
}

describe("Tier 5.1: macOS AppleScript Real Dictionary Compilation (osacompile)", () => {
  test("5.1.1: all generated Music.app AppleScripts compile cleanly via /usr/bin/osacompile", async () => {
    const plugin = await loadPlugin();
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/osacompile")) {
      return;
    }

    const scripts = {
      playCatalog: plugin.buildPlayScript({
        name: '春日影 (MyGO!!!!! ver.) "Live" \\ Special',
        artistName: "MyGO!!!!!",
        musicUrl: "music://music.apple.com/cn/album/test/1783644603?i=1783644617",
        positionSec: 12.5,
      }),
      pause: plugin.buildPauseScript(),
      resume: plugin.buildResumeScript(),
      seek: plugin.buildSeekScript(45.25),
      volume: plugin.buildVolumeScript(75),
      state: plugin.buildStateScript(),
      devices: plugin.buildDevicesScript(),
      selectDevice: plugin.buildSelectDeviceScript("AA:BB:CC:DD:EE:FF"),
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mygo-am-osa-"));
    try {
      for (const [name, script] of Object.entries(scripts)) {
        const outScpt = path.join(tmpDir, `${name}.scpt`);
        execFileSync("/usr/bin/osacompile", ["-o", outScpt, "-"], {
          input: script,
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert(fs.existsSync(outScpt), `compiled ${name}.scpt must exist`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Tier 5.2: Full-Track Remote Playback Lifecycle (remote*)", () => {
  let host;
  let plugin;
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    host = createHost({ platform: "darwin" });
    host._setTranslations(loadZhTranslations());
    globalThis.host = host;
    plugin = await loadPlugin();
    plugin.resetRemoteSession();

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/songs/1783644617")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1783644617",
                type: "songs",
                attributes: {
                  name: "春日影 (MyGO!!!!! ver.)",
                  artistName: "MyGO!!!!!",
                  albumName: "迷跡波",
                  durationInMillis: 256613,
                  url: "https://music.apple.com/cn/album/haruhikage/1783644603?i=1783644617",
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ errors: [{ detail: "Not mocked" }] }), {
        status: 404,
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("5.2.1: remotePlay resolves song metadata and invokes osascript with music:// URL", async () => {
    host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));

    await plugin.remotePlay({ ids: ["1783644617", "1440935467"], start: 0, position: 15000 });

    const spawns = host._getSpawnHistory();
    assertEquals(spawns.length, 1);
    assertEquals(spawns[0].command, "/usr/bin/osascript");
    assertIncludes(
      spawns[0].stdin,
      "music://music.apple.com/us/album/haruhikage/1783644603?i=1783644617".replace("/us/", "/cn/")
        ? "music://music.apple.com/cn/album/haruhikage/1783644603?i=1783644617"
        : ""
    );
    assertIncludes(spawns[0].stdin, "set startPos to 15.000");
  });

  test("5.2.2: remoteState handles Music.app -1728 missing track metadata during catalog streaming", async () => {
    await plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 });

    // Simulate Music.app returning empty track name & 0 duration (as happens when -1728 is caught on catalog streams)
    host._setSpawnBehavior(() => ({
      stdout: "playing\t42350\t0\t80\tHomePod Mini\t\t",
      code: 0,
    }));

    const st = await plugin.remoteState();
    assertTruthy(st);
    assertEquals(st.playing, true);
    assertEquals(st.trackId, "1783644617");
    assertEquals(st.position, 42350);
    assertEquals(st.duration, 256613, "falls back cleanly to catalog durationMs");
    assertEquals(st.volume, 80);
    assertEquals(st.device, "HomePod Mini");
  });

  test("5.2.3: remotePause, remoteResume, remoteSeek, remoteVolume dispatch valid commands", async () => {
    await plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 });
    await plugin.remotePause();
    await plugin.remoteResume();
    await plugin.remoteSeek({ position: 90500 });
    await plugin.remoteVolume({ percent: 65 });

    const spawns = host._getSpawnHistory();
    assertEquals(spawns.length, 5);
    assertIncludes(spawns[1].stdin, "pause");
    assertIncludes(spawns[2].stdin, "play");
    assertIncludes(spawns[3].stdin, "90.500");
    assertIncludes(spawns[4].stdin, "set sound volume to 65");
  });

  test("5.2.4: remoteDevices & remoteUse enumerate and switch AirPlay speakers", async () => {
    host._setSpawnBehavior((rec) => {
      if (rec.stdin.includes("AirPlay device")) {
        return {
          stdout: "computer\tMacBook Pro Speakers\t1\nAA:BB:CC:11:22:33\tLiving Room HomePod\t0",
          code: 0,
        };
      }
      return { stdout: "OK", code: 0 };
    });

    const devices = await plugin.remoteDevices();
    assertEquals(devices.length, 2);
    assertEquals(devices[0].name, "MacBook Pro Speakers");
    assertEquals(devices[0].active, true);
    assertEquals(devices[1].id, "AA:BB:CC:11:22:33");
    assertEquals(devices[1].active, false);

    await plugin.remoteUse({ deviceId: "AA:BB:CC:11:22:33" });
    const lastSpawn = host._getSpawnHistory().at(-1);
    assertIncludes(lastSpawn.stdin, 'set targetId to "AA:BB:CC:11:22:33"');
  });

  test("5.2.5: ungranted process permission throws standard 'setup' error localized in zh-CN", async () => {
    host._setLanguage("zh-CN");
    host._setProcessGranted(false);

    let caught = null;
    try {
      await plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 });
    } catch (err) {
      caught = err;
    }
    assertTruthy(caught);
    assertEquals(caught.code, "setup");
    assertIncludes(caught.message, "允许此插件启动外部程序");
  });

  test("5.2.6: non-darwin platform throws standard 'unsupported' error", async () => {
    host.platform = "linux";
    await assertRejects(
      () => plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 }),
      "unsupported"
    );
  });
});

describe("Tier 5.3: Word-by-Word Karaoke TTML Lyrics & LRCLIB Fallback", () => {
  let host;
  let plugin;
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    host = createHost();
    globalThis.host = host;
    plugin = await loadPlugin();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("5.3.1: parseAppleTTML parses word-level syllable spans, inter-word spaces, and translations", () => {
    const sampleTtml = `
      <tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
        <head>
          <metadata>
            <itunes:translations>
              <translation type="subtitle" xml:lang="zh-Hans-CN">
                <text for="L1">残酷的夏天</text>
              </translation>
            </itunes:translations>
          </metadata>
        </head>
        <body>
          <div>
            <p begin="00:12.500" end="00:15.200" itunes:key="L1">
              <span begin="00:12.500" end="00:13.400">Cruel</span> <span begin="00:13.400" end="00:15.200">Summer</span>
            </p>
            <p begin="00:16.000" end="00:18.000">
              <span begin="00:16.000" end="00:17.000">春</span><span begin="00:17.000" end="00:18.000">日影</span>
              <span ttm:role="x-translation">Haruhikage</span>
            </p>
          </div>
        </body>
      </tt>
    `;

    const res = plugin.parseAppleTTML(sampleTtml);
    assertTruthy(res.lines);
    assertEquals(res.lines.length, 2);

    assertEquals(res.lines[0].start, 12500);
    assertEquals(res.lines[0].end, 15200);
    assertEquals(res.lines[0].translation, "残酷的夏天");
    assertEquals(res.lines[0].words.length, 2);
    assertEquals(res.lines[0].words[0].text, "Cruel ");
    assertEquals(res.lines[0].words[1].text, "Summer");

    assertEquals(res.lines[1].translation, "Haruhikage");
    assertEquals(res.lines[1].words.map((w) => w.text).join(""), "春日影");
  });

  test("5.3.2: lyrics() falls back cleanly to LRCLIB synced lyrics when signed out", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/songs/1585800430")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1585800430",
                attributes: {
                  name: "Cruel Summer",
                  artistName: "Taylor Swift",
                  albumName: "Lover",
                  durationInMillis: 178426,
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.startsWith("https://lrclib.net/api/get")) {
        return new Response(
          JSON.stringify({
            syncedLyrics: "[00:12.50] Fever dream high in the quiet of the night",
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const lyr = await plugin.lyrics({ id: "1585800430" });
    assertIncludes(lyr.lrc, "[00:12.50] Fever dream high");
  });
});

describe("Tier 5.4: Subscriber Library Integration (playlists, liked, savedAlbums, recent)", () => {
  let host;
  let plugin;
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    host = createHost();
    await host.storage.set("auth", {
      mediaUserToken: "sub_token_xyz",
      storefront: "cn",
      account: { id: "apple-music-cn", name: "Apple Music (China)" },
    });
    globalThis.host = host;
    plugin = await loadPlugin();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("5.4.1: playlists() & playlist({ id: 'p.xxx' }) fetch subscriber library playlists", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/me/library/playlists?limit=100")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "p.mygo01",
                type: "library-playlists",
                attributes: { name: "MyGO Favorites", canEdit: true },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/library/playlists/p.mygo01")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "p.mygo01",
                type: "library-playlists",
                attributes: { name: "MyGO Favorites", canEdit: true },
                relationships: {
                  tracks: {
                    data: [
                      {
                        id: "i.track01",
                        type: "library-songs",
                        attributes: {
                          name: "影色舞",
                          artistName: "MyGO!!!!!",
                          albumName: "迷跡波",
                          durationInMillis: 210000,
                          playParams: { id: "i.track01", isLibrary: true, catalogId: "1783644620" },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const list = await plugin.playlists();
    assertEquals(list.length, 1);
    assertEquals(list[0].id, "p.mygo01");
    assertEquals(list[0].mine, true);

    const detail = await plugin.playlist({ id: "p.mygo01" });
    assertEquals(detail.tracks.length, 1);
    assertEquals(detail.tracks[0].name, "影色舞");
    assertEquals(detail.tracks[0].duration, 210000);
  });

  test("5.4.2: liked() and savedAlbums() return subscriber library songs and albums", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/me/library/songs")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "i.s1",
                attributes: {
                  name: "碧天伴走",
                  artistName: "MyGO!!!!!",
                  albumName: "迷跡波",
                  durationInMillis: 225000,
                },
              },
            ],
            next: "/v1/me/library/songs?offset=100",
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/library/albums")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "l.a1",
                attributes: {
                  name: "迷跡波",
                  artistName: "MyGO!!!!!",
                  trackCount: 13,
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const likedPage = await plugin.liked({ offset: 0 });
    assertEquals(likedPage.tracks.length, 1);
    assertEquals(likedPage.more, true);

    const albumsPage = await plugin.savedAlbums({ offset: 0 });
    assertEquals(albumsPage.albums.length, 1);
    assertEquals(albumsPage.albums[0].name, "迷跡波");
  });
});
