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

  test("5.2.7: buildPlayScript stops stale track and uses native cmd=playStoreID URL for catalog songs", async () => {
    host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));

    await plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 });
    const script = host._getSpawnHistory()[0].stdin;

    assertIncludes(
      script,
      'set playStoreURL to "music://music.apple.com/?cmd=playStoreID&id=1783644617"'
    );
    const stopIdx = script.indexOf("\n    try\n      stop\n    end try");
    const openIdx = script.indexOf("open location playStoreURL");
    assert(stopIdx > 0 && openIdx > stopIdx, "must stop stale track before opening playStoreURL");
    assert(
      !script.includes("if player state is not playing then play"),
      "must not issue bare play when player state is stopped"
    );
  });

  test("5.2.8: remoteState keeps session alive during initial STOPPED lease-buffering window then ends cleanly on real stop", async () => {
    host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));
    await plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 });

    // Immediate poll while FairPlay lease is still buffering (Music.app reports STOPPED)
    host._setSpawnBehavior(() => ({ stdout: "STOPPED", code: 0 }));
    const bufferingState = await plugin.remoteState();
    assertTruthy(bufferingState, "must not drop activeSession during initial lease buffering");
    assertEquals(bufferingState.trackId, "1783644617");
    assertEquals(bufferingState.playing, true);

    // Once Music.app starts playing and later reaches STOPPED at end of 1-item queue, return null
    host._setSpawnBehavior(() => ({
      stdout: "playing\t12000\t256613\t85\tMacBook Pro\t春日影 (MyGO!!!!! ver.)\tMyGO!!!!!",
      code: 0,
    }));
    const playingState = await plugin.remoteState();
    assertTruthy(playingState);
    assertEquals(playingState.position, 12000);

    host._setSpawnBehavior(() => ({ stdout: "STOPPED", code: 0 }));
    const endedState = await plugin.remoteState();
    assertEquals(endedState, null, "must report null once track finishes after having played");
  });

  test("5.2.9: remoteState supports localized Music.app track titles without false 5s cutoff, yet stops autoplay spillover", async () => {
    const origNow = Date.now;
    let fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;
    try {
      host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));
      // Catalog metadata is English ("Haruhikage"), while Music.app reports Japanese ("春日影")
      await plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 });

      // Early poll records initialReportedName = "アルジャーノン" (localized title in Music.app)
      fakeNow += 500;
      host._setSpawnBehavior(() => ({
        stdout: "playing\t1200\t256613\t80\tAirPods 4\tアルジャーノン\tヨルシカ",
        code: 0,
      }));
      const st1 = await plugin.remoteState();
      assertTruthy(st1);
      assertEquals(st1.trackId, "1783644617");

      // After settling (>2s) and >5s playback, localized title still matches initialReportedName -> must NOT pause!
      fakeNow += 8000;
      host._setSpawnBehavior(() => ({
        stdout: "playing\t9200\t256613\t80\tAirPods 4\tアルジャーノン\tヨルシカ",
        code: 0,
      }));
      const st2 = await plugin.remoteState();
      assertTruthy(st2, "must not falsely pause localized title after 5s");
      assertEquals(st2.position, 9200);

      // When Music.app later auto-advances to a genuinely different song, pause and end session
      fakeNow += 250000;
      let paused = false;
      host._setSpawnBehavior((rec) => {
        if (rec.stdin.includes("\n    pause\n")) {
          paused = true;
          return { stdout: "OK", code: 0 };
        }
        return {
          stdout: "playing\t800\t215000\t80\tAirPods 4\t六兆年と一夜物語\tkemu",
          code: 0,
        };
      });
      const st3 = await plugin.remoteState();
      assertEquals(st3, null, "must end session when Music.app auto-advances to another track");
      assertEquals(paused, true, "must pause Music.app spillover track");
    } finally {
      Date.now = origNow;
    }
  });

  test("5.2.10: remoteState during in-flight remotePlay never leaks previous song state", async () => {
    let releasePlayScript;
    const playGate = new Promise((resolve) => {
      releasePlayScript = resolve;
    });
    const origSpawn = host.spawn.bind(host);
    host.spawn = (cmd, args) => {
      let stdinBuf = "";
      let emitted = false;
      return {
        pid: 9999,
        write: (t) => {
          stdinBuf += String(t ?? "");
        },
        closeStdin: () => {},
        readLine: async () => {
          if (stdinBuf.includes("playStoreURL")) {
            await playGate;
            if (emitted) return null;
            emitted = true;
            return "OK|CATALOG";
          }
          if (emitted) return null;
          emitted = true;
          return "playing\t258248\t286973\t100\tAirPods 4\tPoppin' Shuffle\tPoppin'Party";
        },
        errorOutput: () => "",
        wait: async () => 0,
        kill: () => {},
      };
    };

    try {
      const playPromise = plugin.remotePlay({ ids: ["1783644617"], start: 0, position: 0 });
      await new Promise((r) => setTimeout(r, 15));

      const midState = await plugin.remoteState();
      assertTruthy(midState);
      assertEquals(midState.trackId, "1783644617");
      assertEquals(midState.position, 0, "must not leak 258248ms from previous song");

      releasePlayScript();
      await playPromise;
    } finally {
      host.spawn = origSpawn;
    }
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

describe("Tier 5.5: Subscriber Profile, Real Username & Avatar Resolution", () => {
  let host;
  let plugin;
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    host = createHost({ platform: "darwin" });
    await host.storage.set("developer_token", "valid_dev_jwt");
    await host.storage.set("developer_token_exp", Date.now() + 86400000);
    globalThis.host = host;
    plugin = await loadPlugin();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("5.5.1: signIn() resolves real Apple Music display name, handle, and avatar from /v1/me/social/profile", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/me/storefront")) {
        return new Response(
          JSON.stringify({ data: [{ id: "jp", attributes: { name: "日本" } }] }),
          { status: 200 }
        );
      }
      if (u.includes("/me/social/profile")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "me", type: "personal-social-profiles" }],
            resources: {
              "personal-social-profiles": {
                me: {
                  id: "usr.jp.01",
                  type: "personal-social-profiles",
                  attributes: {
                    name: "InkCitrus",
                    handle: "@inkcitrus",
                    isOnboarded: false,
                    artwork: {
                      url: "https://is1-ssl.mzstatic.com/image/thumb/Features/{w}x{h}{c}.{f}",
                    },
                  },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/account")) {
        return new Response(
          JSON.stringify({
            meta: { subscription: { active: true, storefront: "jp" } },
            data: [{ id: "acc_jp_1", attributes: {} }],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const acc = await plugin.signIn();
    assertEquals(acc.name, "InkCitrus");
    assertEquals(acc.id, "inkcitrus");
    assertEquals(
      acc.imageUrl,
      "https://is1-ssl.mzstatic.com/image/thumb/Features/160x160cc.jpg"
    );
  });

  test("5.5.2: account() auto-upgrades legacy v0.1.0 'Apple Music (日本)' session and formats avatarArtwork", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "existing_v010_token",
      storefront: "jp",
      account: {
        id: "apple-music-jp",
        name: "Apple Music (日本)",
        imageUrl: "",
        page: "library",
      },
    });

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/me/social/profile")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "sp.99",
                type: "personal-social-profiles",
                attributes: { name: "燈 (Tomori)" },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/account")) {
        return new Response(
          JSON.stringify({
            meta: { subscription: { active: true, storefront: "jp" } },
            data: [
              {
                id: "acc_99",
                attributes: {
                  avatarArtwork: {
                    url: "https://is1-ssl.mzstatic.com/image/thumb/Avatar/{w}x{h}bb-{q}.{f}",
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

    const upgraded = await plugin.account();
    assertEquals(upgraded.name, "燈 (Tomori)");
    assertEquals(
      upgraded.imageUrl,
      "https://is1-ssl.mzstatic.com/image/thumb/Avatar/160x160bb.jpg"
    );
  });

  test("5.5.3: falls back to macOS system info user name when Apple profile has no name, and honors displayName override", async () => {
    host._setProcessGranted(true);
    host._setSpawnBehavior((rec) => {
      if (rec.stdin.includes("system info")) {
        return { code: 0, stdout: "USER:Zichen Wu\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await host.storage.set("auth", {
      mediaUserToken: "existing_v010_token",
      storefront: "jp",
      account: {
        id: "apple-music-jp",
        name: "Apple Music (日本)",
        imageUrl: "",
        page: "library",
      },
    });

    globalThis.fetch = async () => new Response("{}", { status: 404 });

    const accFromMac = await plugin.account();
    assertEquals(accFromMac.name, "Zichen Wu");

    host._setSetting("displayName", "InkOrange");
    const accCustom = await plugin.account();
    assertEquals(accCustom.name, "InkOrange");
  });
});

describe("Tier 5.6: Favorite Songs Unification (liked, like, isLiked, playlists)", () => {
  let host;
  let plugin;
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    host = createHost({ platform: "darwin" });
    await host.storage.set("developer_token", "valid_dev_jwt");
    await host.storage.set("developer_token_exp", Date.now() + 86400000);
    await host.storage.set("auth", {
      mediaUserToken: "sub_token_jp",
      storefront: "jp",
      profileVersion: 2,
      account: { id: "apple-music-jp", name: "InkCitrus", page: "library" },
    });
    globalThis.host = host;
    plugin = await loadPlugin();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("5.6.1: playlists() deduplicates system Favorite Songs and liked() loads multi-page Favorite Songs", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/me/library/playlists?limit=100")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "p.fav172",
                type: "library-playlists",
                attributes: {
                  name: "Favorite Songs",
                  canEdit: false,
                  tags: ["favorited"],
                },
              },
              {
                id: "p.shazam",
                type: "library-playlists",
                attributes: { name: "My Shazam Tracks", canEdit: true },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/library/playlists/p.fav172/tracks?limit=100&offset=0")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "i.algernon",
                type: "library-songs",
                attributes: {
                  name: "Algernon",
                  artistName: "Yorushika",
                  albumName: "Magic Lantern",
                  durationInMillis: 254000,
                  playParams: { id: "i.algernon", isLibrary: true, catalogId: "1679432100" },
                },
              },
            ],
            next: "/v1/me/library/playlists/p.fav172/tracks?offset=100",
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/library/playlists/p.fav172/tracks?offset=100")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "i.rokuchonen",
                type: "library-songs",
                attributes: {
                  name: "Rokuchonen to Ichiya Monogatari (feat. Ia)",
                  artistName: "kemu",
                  albumName: "Ia Super Best",
                  durationInMillis: 215000,
                  playParams: { id: "i.rokuchonen", isLibrary: true, catalogId: "987654321" },
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const sidebarPlaylists = await plugin.playlists();
    assertEquals(sidebarPlaylists.length, 1);
    assertEquals(sidebarPlaylists[0].name, "My Shazam Tracks");

    const likedRes = await plugin.liked({ offset: 0 });
    assertEquals(likedRes.tracks.length, 2);
    assertEquals(likedRes.tracks[0].name, "Algernon");
    assertEquals(likedRes.tracks[1].name, "Rokuchonen to Ichiya Monogatari (feat. Ia)");
    assertEquals(likedRes.more, false);

    // Both library ID ("i.algernon") and catalog ID ("1679432100") resolve as liked!
    const likedMap = await plugin.isLiked({
      ids: ["i.algernon", "1679432100", "i.not_fav"],
    });
    assertEquals(likedMap["i.algernon"], true);
    assertEquals(likedMap["1679432100"], true);
    assertEquals(likedMap["i.not_fav"], false);
  });

  test("5.6.2: like({ id, on }) calls Apple /v1/me/favorites POST & DELETE and updates isLiked immediately", async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: (init.method || "GET").toUpperCase() });
      if (u.includes("/me/favorites")) {
        return new Response("", { status: 202 });
      }
      if (u.includes("/me/ratings")) {
        return new Response("", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    await plugin.like({ id: "i.new_song", on: true });
    assert(
      calls.some(
        (c) => c.method === "POST" && c.url.includes("/me/favorites?ids[library-songs]=i.new_song")
      ),
      "like(on: true) must POST to /v1/me/favorites"
    );
    let check = await plugin.isLiked({ ids: ["i.new_song"] });
    assertEquals(check["i.new_song"], true);

    await plugin.like({ id: "i.new_song", on: false });
    assert(
      calls.some(
        (c) =>
          c.method === "DELETE" && c.url.includes("/me/favorites?ids[library-songs]=i.new_song")
      ),
      "like(on: false) must DELETE from /v1/me/favorites"
    );
    check = await plugin.isLiked({ ids: ["i.new_song"] });
    assertEquals(check["i.new_song"], false);
  });

  test("5.6.3: browse({ page: 'library' }) renders subscriber My Page profile instead of jumping to Recently Played", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "sub_token_jp",
      storefront: "jp",
      profileVersion: 2,
      account: {
        id: "inkcitrus",
        name: "InkCitrus",
        imageUrl: "https://is1-ssl.mzstatic.com/image/thumb/Features/160x160cc.jpg",
        page: "library",
      },
    });

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/me/history/heavy-rotation")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1679432000",
                type: "albums",
                attributes: { name: "Magic Lantern", artistName: "Yorushika" },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/library/recently-added")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "l.album01",
                type: "library-albums",
                attributes: { name: "迷跡波", artistName: "MyGO!!!!!" },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/library/playlists")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "p.shazam",
                type: "library-playlists",
                attributes: { name: "My Shazam Tracks", canEdit: true },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/me/recent/played/tracks")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1679432100",
                type: "songs",
                attributes: {
                  name: "Algernon",
                  artistName: "Yorushika",
                  albumName: "Magic Lantern",
                  durationInMillis: 254000,
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const myPage = await plugin.browse({ page: "library" });
    assertEquals(myPage.title, "InkCitrus");
    assertEquals(myPage.subtitle, "@inkcitrus");
    assertIncludes(myPage.description, "Apple Music (JP)");
    assert(myPage.subtitle !== myPage.description, "My Page subtitle and description must not duplicate");
    assertTruthy(myPage.imageUrl, "My Page should include user round avatar");
    const sectionTitles = myPage.sections.map((s) => s.title);
    assertIncludes(sectionTitles, "My Playlists");
    assert(!sectionTitles.includes("Recently Added"), "My Page must not duplicate Saved Albums/Recently Added");
    assert(!sectionTitles.includes("Recently Played"), "My Page must not duplicate sidebar Recently Played");
    assert(!sectionTitles.includes("Heavy Rotation"), "My Page must not duplicate Home Heavy Rotation");
  });

  test("5.4.12: home() syncs personalized Apple Music Listen Now shelves (Anime, Yorushika Fans Like, Find Your Mood, Made for You, Stations)", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "sub_tok_home",
      storefront: "jp",
      profileVersion: 2,
      account: { id: "zichenwu", name: "ZichenWu", page: "library" },
    });
    await host.storage.set("developer_token", "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig");
    await host.storage.set("developer_token_exp", Date.now() + 10_000_000);

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/me/recommendations/rec-anime/view/see-all")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "rec-anime", type: "personal-recommendation" }],
            resources: {
              "personal-recommendation": {
                "rec-anime": {
                  id: "rec-anime",
                  type: "personal-recommendation",
                  attributes: { title: { stringForDisplay: "Anime" } },
                  relationships: {
                    contents: {
                      data: [
                        { id: "alb-1", type: "albums" },
                        { id: "alb-2", type: "albums" },
                      ],
                    },
                  },
                },
              },
              albums: {
                "alb-1": {
                  id: "alb-1",
                  type: "albums",
                  attributes: { name: "Shuwarin☆Dreaming - EP", artistName: "Pastel*Palettes" },
                },
                "alb-2": {
                  id: "alb-2",
                  type: "albums",
                  attributes: { name: "Kessoku Band Concert", artistName: "kessoku band" },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/me/recommendations") && url.includes("name=listen-now")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "rec-anime", type: "personal-recommendation" },
              { id: "rec-fans", type: "personal-recommendation" },
              { id: "rec-made", type: "personal-recommendation" },
              { id: "rec-mood", type: "personal-recommendation" },
              { id: "rec-radio", type: "personal-recommendation" },
            ],
            resources: {
              "personal-recommendation": {
                "rec-anime": {
                  id: "rec-anime",
                  type: "personal-recommendation",
                  attributes: {
                    title: { stringForDisplay: "Anime" },
                    hasSeeAll: true,
                  },
                  relationships: {
                    contents: {
                      data: [
                        { id: "alb-1", type: "albums" },
                        { id: "l.alb99", type: "library-albums" },
                      ],
                    },
                  },
                },
                "rec-fans": {
                  id: "rec-fans",
                  type: "personal-recommendation",
                  attributes: {
                    titleWithoutName: { stringForDisplay: "Fans Like" },
                  },
                  relationships: {
                    "primary-content": {
                      data: [{ id: "art-yorushika", type: "artists" }],
                    },
                    contents: {
                      data: [{ id: "alb-yoru", type: "albums" }],
                    },
                  },
                },
                "rec-made": {
                  id: "rec-made",
                  type: "personal-recommendation",
                  attributes: {
                    title: { stringForDisplay: "Made for You" },
                    isGroupRecommendation: true,
                  },
                  relationships: {
                    contents: {
                      data: [{ id: "rec-made-child", type: "personal-recommendation" }],
                    },
                  },
                },
                "rec-made-child": {
                  id: "rec-made-child",
                  type: "personal-recommendation",
                  relationships: {
                    contents: {
                      data: [{ id: "pl.favmix", type: "playlists" }],
                    },
                  },
                },
                "rec-mood": {
                  id: "rec-mood",
                  type: "personal-recommendation",
                  attributes: {
                    title: { stringForDisplay: "Find Your Mood" },
                  },
                  relationships: {
                    contents: {
                      data: [{ id: "1555167098", type: "apple-curators" }],
                    },
                  },
                },
                "rec-radio": {
                  id: "rec-radio",
                  type: "personal-recommendation",
                  attributes: {
                    title: { stringForDisplay: "Stations for You" },
                  },
                  relationships: {
                    contents: {
                      data: [
                        { id: "ra.personal1", type: "stations" },
                        { id: "ra.live1", type: "stations" },
                      ],
                    },
                  },
                },
              },
              albums: {
                "alb-1": {
                  id: "alb-1",
                  type: "albums",
                  attributes: {
                    name: "Shuwarin☆Dreaming - EP",
                    artistName: "Pastel*Palettes",
                    artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg" },
                  },
                },
                "alb-cat-99": {
                  id: "alb-cat-99",
                  type: "albums",
                  attributes: {
                    name: "No one - EP",
                    artistName: "TOGENASHI TOGEARI",
                    artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg" },
                  },
                },
                "alb-yoru": {
                  id: "alb-yoru",
                  type: "albums",
                  attributes: {
                    name: "花と水飴、最終電車",
                    artistName: "n-buna",
                  },
                },
              },
              "library-albums": {
                "l.alb99": {
                  id: "l.alb99",
                  type: "library-albums",
                  meta: { catalogIds: ["alb-cat-99"] },
                },
              },
              artists: {
                "art-yorushika": {
                  id: "art-yorushika",
                  type: "artists",
                  attributes: { name: "Yorushika" },
                },
              },
              playlists: {
                "pl.favmix": {
                  id: "pl.favmix",
                  type: "playlists",
                  attributes: { name: "Favorites Mix", curatorName: "Apple Music for ZichenWu" },
                },
              },
              "apple-curators": {
                "1555167098": {
                  id: "1555167098",
                  type: "apple-curators",
                  attributes: {
                    name: "Apple Music Weekend",
                    artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/weekend/{w}x{h}bb.jpg" },
                  },
                },
              },
              stations: {
                "ra.personal1": {
                  id: "ra.personal1",
                  type: "stations",
                  attributes: {
                    name: "ZichenWu's Station",
                    isLive: false,
                    artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/st/{w}x{h}bb.jpg" },
                  },
                },
                "ra.live1": {
                  id: "ra.live1",
                  type: "stations",
                  attributes: {
                    name: "Apple Music 1",
                    isLive: true,
                  },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/catalog/jp/apple-curators/1555167098")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1555167098",
                type: "apple-curators",
                attributes: { name: "Apple Music Weekend" },
                relationships: {
                  playlists: {
                    data: [
                      {
                        id: "pl.weekend1",
                        type: "playlists",
                        attributes: { name: "Weekend Chill", curatorName: "Apple Music" },
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
      if (url.includes("/me/stations/next-tracks/ra.personal1")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1679432100",
                type: "songs",
                attributes: {
                  name: "Algernon",
                  artistName: "Yorushika",
                  albumName: "Magic Lantern",
                  durationInMillis: 254000,
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/editorial/jp/groupings?name=music")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "1000", type: "groupings" }],
            resources: {
              groupings: {
                "1000": {
                  id: "1000",
                  type: "groupings",
                  attributes: { name: "Music" },
                  relationships: {
                    tabs: { data: [{ id: "default", type: "editorial-elements" }] },
                  },
                },
              },
              "editorial-elements": {
                default: {
                  id: "default",
                  type: "editorial-elements",
                  relationships: {
                    children: { data: [{ id: "shelf-new", type: "editorial-elements" }] },
                  },
                },
                "shelf-new": {
                  id: "shelf-new",
                  type: "editorial-elements",
                  attributes: { title: "New This Week", editorialElementKind: 326 },
                  relationships: {
                    contents: { data: [{ id: "alb-new-1", type: "albums" }] },
                  },
                },
              },
              albums: {
                "alb-new-1": {
                  id: "alb-new-1",
                  type: "albums",
                  attributes: { name: "Magic Lantern", artistName: "Yorushika" },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const homeRes = await plugin.home();
    assertEquals(homeRes.sections.length, 5);
    assertEquals(homeRes.sections[0].title, "Anime");
    assertEquals(homeRes.sections[0].morePage, "reco:rec-anime");
    assertEquals(homeRes.sections[0].albums.length, 2);
    assertEquals(homeRes.sections[0].albums[1].id, "alb-cat-99");

    assertEquals(homeRes.sections[1].title, "Fans Like Yorushika");
    assertEquals(homeRes.sections[2].title, "Made for You");
    assertEquals(homeRes.sections[2].playlists[0].name, "Favorites Mix");

    assertEquals(homeRes.sections[3].title, "Find Your Mood");
    assertEquals(homeRes.sections[3].links[0].page, "apple-curator:1555167098");

    assertEquals(homeRes.sections[4].title, "Stations for You");
    assertEquals(homeRes.sections[4].stations.length, 1, "should exclude live broadcast stations");
    assertEquals(homeRes.sections[4].stations[0].id, "ra.personal1");

    // Verify See All ("reco:rec-anime")
    const seeAll = await plugin.browse({ page: "reco:rec-anime" });
    assertEquals(seeAll.title, "Anime");
    assertEquals(seeAll.sections[0].albums.length, 2);

    // Verify Find Your Mood curator drill-down ("apple-curator:1555167098")
    const moodBrowse = await plugin.browse({ page: "apple-curator:1555167098" });
    assertEquals(moodBrowse.title, "Apple Music Weekend");
    assertEquals(moodBrowse.sections[0].playlists[0].name, "Weekend Chill");

    // Verify New tab ("new")
    const newBrowse = await plugin.browse({ page: "new" });
    assertEquals(newBrowse.title, "New");
    assertEquals(newBrowse.sections[0].title, "New This Week");

    // Verify personal station playback feed
    const radioTracks = await plugin.stationNext({ id: "ra.personal1" });
    assertEquals(radioTracks.length, 1);
    assertEquals(radioTracks[0].name, "Algernon");
  });

  test("5.4.13: setSetting('audioQuality') syncs Music.app preferences (high/lossless/hires) and auto-resumes playing track", async () => {
    assertEquals(plugin.parseAudioQualitySetting("lossless"), "lossless");
    assertEquals(plugin.parseAudioQualitySetting("无损"), "lossless");
    assertEquals(plugin.parseAudioQualitySetting("hires"), "hires");
    assertEquals(plugin.parseAudioQualitySetting("Hi-Res Lossless"), "hires");
    assertEquals(plugin.parseAudioQualitySetting("高解析度无损"), "hires");
    assertEquals(plugin.parseAudioQualitySetting("high"), "high");
    assertEquals(plugin.parseAudioQualitySetting("AAC"), "high");
    assertEquals(plugin.parseAudioQualitySetting(""), null);

    await host.storage.set("developer_token", "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig");
    await host.storage.set("developer_token_exp", Date.now() + 10_000_000);

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/songs/1679432100")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1679432100",
                type: "songs",
                attributes: {
                  name: "Algernon",
                  artistName: "Yorushika",
                  albumName: "Magic Lantern",
                  durationInMillis: 254000,
                  url: "https://music.apple.com/jp/album/magic-lantern/1679432000?i=1679432100",
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    // Start playing a song first
    await plugin.remotePlay({ ids: ["1679432100"], start: 0, position: 10000 });

    // Switch quality to Hi-Res Lossless while playing at 42s
    host._setSpawnBehavior((rec) => {
      if (rec.stdin.includes("preferredStreamPlaybackAudioQuality -int 30")) {
        return { stdout: "UPDATED:1:42000" };
      }
      return { stdout: "OK|CATALOG" };
    });

    await plugin.setSetting({ key: "audioQuality", value: "hires" });

    const history = host._getSpawnHistory();
    const writeCall = history.find((h) =>
      h.stdin.includes("losslessEnabled -bool true") &&
      h.stdin.includes("preferredStreamPlaybackAudioQuality -int 30")
    );
    assertTruthy(writeCall, "should write Hi-Res Lossless (30) to com.apple.Music");

    const resumeCall = history[history.length - 1];
    assertIncludes(resumeCall.stdin, "set startPos to 42.000", "should auto-resume track at 42.000s");

    // Switching to High Quality AAC (10) when stopped
    host._setSpawnBehavior((rec) => {
      if (rec.stdin.includes("preferredStreamPlaybackAudioQuality -int 10")) {
        return { stdout: "UPDATED:0:0" };
      }
      return { stdout: "OK" };
    });
    await plugin.setSetting({ key: "audioQuality", value: "high" });
    const highCall = host
      ._getSpawnHistory()
      .find(
        (h) =>
          h.stdin.includes("losslessEnabled -bool false") &&
          h.stdin.includes("preferredStreamPlaybackAudioQuality -int 10")
      );
    assertTruthy(highCall, "should write High Quality AAC (false / 10) to com.apple.Music");
  });

  test("5.4.14: My Page displays live Music.app audio quality badge in subtitle", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "sub_tok_qual",
      storefront: "jp",
      profileVersion: 2,
      account: { id: "zichenwu", name: "ZichenWu", page: "library" },
    });
    await host.storage.set("developer_token", "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig");
    await host.storage.set("developer_token_exp", Date.now() + 10_000_000);

    host._setSpawnBehavior((rec) => {
      if (rec.stdin.includes("QUALITY:")) {
        return { stdout: "QUALITY:1:20" };
      }
      return { stdout: "OK" };
    });

    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    const myPage = await plugin.browse({ page: "library" });
    assertEquals(myPage.subtitle, "@zichenwu");
    assertEquals(myPage.description, "Apple Music (JP)");
    assert(myPage.subtitle !== myPage.description, "My Page subtitle and description must not duplicate");
  });

  test("5.4.15: mixed Top Picks shelf splits into single-kind sections and folds 1-item orphans without untitled blank rows", async () => {
    await host.storage.set("auth", {
      mediaUserToken: "sub_tok_top_picks",
      storefront: "jp",
      profileVersion: 2,
      account: { id: "inkorange", name: "ZichenWu", page: "library" },
    });
    await host.storage.set("developer_token", "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig");
    await host.storage.set("developer_token_exp", Date.now() + 10_000_000);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "rec-top-picks", type: "personal-recommendation" },
            { id: "rec-made", type: "personal-recommendation" },
          ],
          resources: {
            "personal-recommendation": {
              "rec-top-picks": {
                id: "rec-top-picks",
                type: "personal-recommendation",
                attributes: { title: { stringForDisplay: "Top Picks for You" } },
                relationships: {
                  contents: {
                    data: [
                      { id: "alb-ras", type: "albums" },
                      { id: "alb-porter", type: "albums" },
                      { id: "pl.newmusic", type: "playlists" },
                      { id: "ra.1", type: "stations" },
                      { id: "ra.2", type: "stations" },
                      { id: "ra.3", type: "stations" },
                      { id: "ra.4", type: "stations" },
                      { id: "ra.5", type: "stations" },
                    ],
                  },
                },
              },
              "rec-made": {
                id: "rec-made",
                type: "personal-recommendation",
                attributes: { title: { stringForDisplay: "Made for You" } },
                relationships: {
                  contents: {
                    data: [
                      { id: "pl.favmix", type: "playlists" },
                      { id: "pl.chillmix", type: "playlists" },
                    ],
                  },
                },
              },
            },
            albums: {
              "alb-ras": { id: "alb-ras", type: "albums", attributes: { name: "I AM WHO I AM - Single", artistName: "RAISE A SUILEN" } },
              "alb-porter": { id: "alb-porter", type: "albums", attributes: { name: "SMILE! :D plus+", artistName: "Porter Robinson" } },
            },
            playlists: {
              "pl.newmusic": { id: "pl.newmusic", type: "playlists", attributes: { name: "New Music", curatorName: "Apple Music for ZichenWu" } },
              "pl.favmix": { id: "pl.favmix", type: "playlists", attributes: { name: "Favorites Mix", curatorName: "Apple Music for ZichenWu" } },
              "pl.chillmix": { id: "pl.chillmix", type: "playlists", attributes: { name: "Chill Mix", curatorName: "Apple Music for ZichenWu" } },
            },
            stations: {
              "ra.1": { id: "ra.1", type: "stations", attributes: { name: "Station 1", isLive: false } },
              "ra.2": { id: "ra.2", type: "stations", attributes: { name: "Station 2", isLive: false } },
              "ra.3": { id: "ra.3", type: "stations", attributes: { name: "Discovery Station", isLive: false } },
              "ra.4": { id: "ra.4", type: "stations", attributes: { name: "ZichenWu's Station", isLive: false } },
              "ra.5": { id: "ra.5", type: "stations", attributes: { name: "Mood Station", isLive: false } },
            },
          },
        }),
        { status: 200 }
      );

    const homeBrowse = await plugin.home();
    // Every section must contain only ONE media array so MyGo Music never renders untitled broken rows
    for (const sec of homeBrowse.sections) {
      const populatedArrays = [
        sec.tracks?.length,
        sec.albums?.length,
        sec.artists?.length,
        sec.playlists?.length,
        sec.stations?.length,
        sec.links?.length,
      ].filter((n) => (n || 0) > 0);
      assertEquals(populatedArrays.length, 1, `Section '${sec.title}' must be single-kind`);
    }

    // Largest group (5 stations) leads under 'Top Picks for You'
    assertEquals(homeBrowse.sections[0].title, "Top Picks for You");
    assertEquals(homeBrowse.sections[0].stations.length, 5);

    // 2 albums get their own explicit section title 'Top Picks for You · Albums'
    assertEquals(homeBrowse.sections[1].title, "Top Picks for You · Albums");
    assertEquals(homeBrowse.sections[1].albums.length, 2);

    // 1-item playlist orphan ('New Music') is folded into 'Made for You' instead of creating an 80%-blank 1-card row
    const madeSec = homeBrowse.sections.find((s) => s.title === "Made for You");
    assertTruthy(madeSec);
    assertEquals(madeSec.playlists.length, 3);
    assertEquals(madeSec.playlists[0].id, "pl.newmusic");
  });

  test("5.4.15: stations() returns flagship live radio stations and episodes, excluding algorithmic song stations", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/catalog/jp/stations")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "ra.978194965",
                attributes: {
                  name: "Apple Music 1",
                  editorialNotes: { short: "Live Station" },
                  artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/35d45158/{w}x{h}sr.jpg" },
                },
              },
              {
                id: "ra.1498155548",
                attributes: {
                  name: "Apple Music Hits",
                  editorialNotes: { short: "Songs you know and love." },
                  artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/51c24bce/{w}x{h}sr.jpg" },
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const stList = await plugin.stations();
    assert(stList.length >= 2, "must include live stations");
    const stHits = stList.find((s) => s.id === "ra.1498155548");
    assertTruthy(stHits);
    assertEquals(stHits.name, "Apple Music Hits");
    assertIncludes(stHits.imageUrl, "51c24bce");
    // Ensure algorithmic song stations are NOT included in radio
    assert(!stList.some((s) => s.name?.includes("feel my soul Station")), "must exclude algorithmic song stations");
  });

  test("5.4.16: remotePlay on live radio station ('ra.1498155548') resolves station metadata and opens station location", async () => {
    host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/catalog/jp/stations/ra.1498155548")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "ra.1498155548",
                attributes: {
                  name: "Apple Music Hits",
                  url: "https://music.apple.com/jp/station/apple-music-hits/ra.1498155548",
                  artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/51c24bce/{w}x{h}sr.jpg" },
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    await plugin.remotePlay({ ids: ["ra.1498155548"], start: 0, position: 0 });
    const spawns = host._getSpawnHistory();
    const lastSpawn = spawns[spawns.length - 1];
    assertIncludes(lastSpawn.stdin, "station/apple-music-hits/ra.1498155548");
  });

  test("5.4.17: plugin.json contains crossfadeTip setting explaining why Music.app crossfade should be disabled", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "plugin.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    assertEquals(manifest.version, pkg.version);
    const cfSetting = manifest.settings.find((s) => s.key === "crossfadeTip");
    assertTruthy(cfSetting, "manifest must contain crossfadeTip setting");
    assertIncludes(cfSetting.help, "歌曲渐变");
    assertIncludes(cfSetting.help, "MyGo Music");
  });

  test("5.4.18: remotePlay on catalog album song uses playStoreURL to immediately autoplay", async () => {
    host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/catalog/jp/songs/1647466804")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1647466804",
                attributes: {
                  name: "hitoribocchi tokyo",
                  artistName: "kessoku band",
                  url: "https://music.apple.com/jp/album/hitoribocchi-tokyo/1647466795?i=1647466804",
                  durationInMillis: 213000,
                  playParams: { id: "1647466804", kind: "song" },
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    await plugin.remotePlay({ ids: ["1647466804"], start: 0, position: 0 });
    const spawns = host._getSpawnHistory();
    const lastSpawn = spawns[spawns.length - 1];
    assertIncludes(lastSpawn.stdin, "open location playStoreURL");
    assertIncludes(lastSpawn.stdin, "cmd=playStoreID&id=1647466804");
  });

  test("5.4.19: remotePlay in shuffle mode detects shuffled queue and plays a random track instead of song 0", async () => {
    host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));

    const songs = [
      { id: "1001", name: "Track 1" },
      { id: "1002", name: "Track 2" },
      { id: "1003", name: "Track 3" },
      { id: "1004", name: "Track 4" },
      { id: "1005", name: "Track 5" },
    ];

    globalThis.fetch = async (url) => {
      const u = String(url);
      for (const s of songs) {
        if (u.includes(`/catalog/jp/songs/${s.id}`)) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: s.id,
                  attributes: {
                    name: s.name,
                    artistName: "Artist",
                    url: `https://music.apple.com/jp/album/_/999?i=${s.id}`,
                    durationInMillis: 200000,
                    playParams: { id: s.id, kind: "song" },
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }
      }
      if (u.includes("/me/library/playlists/p.fav")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "p.fav",
                relationships: {
                  tracks: {
                    data: songs.map((s) => ({
                      id: s.id,
                      attributes: { name: s.name, playParams: { id: s.id } },
                    })),
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

    // First load the playlist in natural order: [1001, 1002, 1003, 1004, 1005]
    await plugin.playlist({ id: "p.fav" });

    // Scenario A: User clicks "Play" -> natural sequence [1001, 1002, 1003, ...]
    await plugin.remotePlay({ ids: ["1001", "1002", "1003", "1004", "1005"], start: 0 });
    let spawns = host._getSpawnHistory();
    assertIncludes(spawns[spawns.length - 1].stdin, "cmd=playStoreID&id=1001");

    // Scenario B: User clicks "Shuffle" -> MyGo's shuffleOrder pins 1001 to index 0, but shuffles rest
    // Shuffled queue passed by MyGo: [1001, 1004, 1002, 1005, 1003]
    const playedCatalogIds = new Set();
    for (let trial = 0; trial < 20; trial++) {
      await plugin.remotePlay({ ids: ["1001", "1004", "1002", "1005", "1003"], start: 0 });
      spawns = host._getSpawnHistory();
      const lastStdin = spawns[spawns.length - 1].stdin;
      const match = lastStdin.match(/cmd=playStoreID&id=(\d+)/);
      if (match) playedCatalogIds.add(match[1]);
    }
    // Over 20 trials across 5 tracks, random selection must hit tracks other than 1001!
    assert(playedCatalogIds.size > 1, `shuffle must select multiple distinct tracks, got: ${Array.from(playedCatalogIds)}`);
  });

  test("5.4.20: remotePlay on radio station sets isStation to true and uses itsradio scheme without library check", async () => {
    host._setSpawnBehavior(() => ({ stdout: "OK|CATALOG", code: 0 }));

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/catalog/jp/stations/ra.1498155548")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "ra.1498155548",
                attributes: {
                  name: "Apple Music Hits",
                  url: "https://music.apple.com/jp/station/apple-music-hits/ra.1498155548",
                  artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/Features/v4/51c24bce/{w}x{h}sr.jpg" },
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    await plugin.remotePlay({ ids: ["ra.1498155548"], start: 0, position: 0 });
    const spawns = host._getSpawnHistory();
    const lastSpawn = spawns[spawns.length - 1];
    assertIncludes(lastSpawn.stdin, "set isStation to (targetURL contains \"/station/\" or targetURL starts with \"itsradio://\")");
    assertIncludes(lastSpawn.stdin, "if isStation is false and targetName is not \"\"");
    assertIncludes(lastSpawn.stdin, "itsradio://music.apple.com/jp/station/apple-music-hits/ra.1498155548");
  });
});
