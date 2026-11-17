import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHost } from "./harness/host.js";
import * as plugin from "../dist/index.js";

let previousFetch;
beforeEach(() => {
  previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const id = String(url).match(/\/songs\/([^?]+)/)?.[1];
    if (id) return new Response(JSON.stringify({ data: [{ id, type: id.startsWith("i.") ? "library-songs" : "songs", attributes: { name: `Track ${id}`, durationInMillis: 256613, artistName: "Synthetic", playParams: id.startsWith("i.") ? { catalogId: "901001" } : undefined } }] }));
    return new Response("{}", { status: 404 });
  };
});
afterEach(() => { plugin.resetRemoteSession(); globalThis.fetch = previousFetch; });
const commands = host => host._getSpawnHistory().flatMap(p => p.stdin.trim().split("\n").filter(Boolean).map(JSON.parse));

for (const [platform, arch] of [["darwin", "arm64"], ["windows", "amd64"], ["linux", "amd64"]]) {
  test(`${platform}: native playback, units, zero volume, pause, seek and resume`, async () => {
    const host = createHost({ platform, arch }); globalThis.host = host;
    await plugin.remotePlay({ ids: ["901000", "901001"], start: 1, position: 12500 });
    assert.equal((await plugin.remoteState()).trackId, "901001");
    await plugin.remotePause(); assert.equal((await plugin.remoteState()).playing, false);
    await plugin.remoteSeek({ position: 90500 }); assert.equal((await plugin.remoteState()).position, 90500);
    await plugin.remoteVolume({ percent: 0 }); assert.equal((await plugin.remoteState()).volume, 0);
    await plugin.remoteResume(); assert.equal((await plugin.remoteState()).playing, true);
    const history = host._getSpawnHistory(); assert.equal(history.length, 1);
    assert.equal(history[0].command, `bin/apple-music-core-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`);
    assert.equal(commands(host).filter(x => x.method === "hello").length, 1);
    const play = commands(host).find(x => x.method === "play");
    assert.deepEqual(play.params, { trackId: "901001", position: 12500, quality: "hires" });
    assert.ok(!history[0].stdin.includes("password"));
  });
}

test("library identity survives the catalog mapping", async () => {
  globalThis.host = createHost(); await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  await plugin.remotePlay({ ids: ["i.native-test"] });
  assert.equal(commands(host).find(x => x.method === "play").params.trackId, "901001");
  assert.equal((await plugin.remoteState()).trackId, "i.native-test");
});

test("rejects unsupported architectures and unavailable track types without fallback", async () => {
  globalThis.host = createHost({ platform: "darwin", arch: "amd64" });
  await assert.rejects(plugin.remoteResume(), e => e.code === "unsupported");
  assert.equal(host._getSpawnHistory().length, 0);
  globalThis.host = createHost();
  await assert.rejects(plugin.remotePlay({ ids: ["ra.1498155548"] }), e => e.code === "unsupported");
  assert.equal(host._getOpenedURLs().length, 0);
});

for (const paused of [false, true]) {
  test(`unsupported live station preserves the ${paused ? "paused" : "playing"} song`, async () => {
    globalThis.host = createHost();
    await plugin.remotePlay({ ids: ["901210"], position: 42000 });
    await plugin.remoteVolume({ percent: 23 });
    if (paused) await plugin.remotePause();
    const before = await plugin.remoteState();
    const previousCommands = commands(host).filter(c => c.method !== "state");
    await assert.rejects(plugin.stationNext({ id: "ra.978194965" }), e => e.code === "unsupported");
    await assert.rejects(plugin.remotePlay({ ids: ["ra.978194965"] }), e => e.code === "unsupported");
    assert.deepEqual(await plugin.remoteState(), before);
    assert.deepEqual(commands(host).filter(c => c.method !== "state"), previousCommands);
    assert.equal(host._getOpenedURLs().length, 0);
  });
}

test("empty and non-song station feeds cannot replace current playback", async () => {
  globalThis.host = createHost();
  await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  await plugin.remotePlay({ ids: ["901211"], position: 61000 });
  const before = await plugin.remoteState();
  for (const data of [[], [
    { id: "ra.episode", type: "stations", attributes: { name: "Episode" } },
    { id: "901212", type: "music-videos", attributes: { name: "Video" } },
    { id: "i.unmapped-radio", type: "library-songs", attributes: { name: "Upload" } },
  ]]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ data }));
    await assert.rejects(plugin.stationNext({ id: "ra.empty-fixture" }), e => e.code === "unsupported");
    assert.deepEqual(await plugin.remoteState(), before);
  }
  assert.equal(commands(host).filter(c => c.method === "play").length, 1);
});

test("recommended stations return playable catalog songs and mapped library songs only", async () => {
  globalThis.host = createHost();
  await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: "901213", type: "songs", attributes: { name: "Song" } },
    { id: "i.radio-mapped", type: "library-songs", attributes: { name: "Library", playParams: { catalogId: "901214" } } },
    { id: "ra.nested", type: "stations", attributes: { name: "Station" } },
    { id: "901215", type: "music-videos", attributes: { name: "Video" } },
  ] }));
  const tracks = await plugin.stationNext({ id: "ra.recommended-fixture" });
  assert.deepEqual(tracks.map(t => t.id), ["901213", "i.radio-mapped"]);
  assert.equal(host._getSpawnHistory().length, 0);
  await plugin.remotePlay({ ids: tracks.map(t => t.id), start: 1 });
  assert.equal(commands(host).find(c => c.method === "play").params.trackId, "901214");
  assert.equal((await plugin.remoteState()).trackId, "i.radio-mapped");
});

test("a station API error is retained instead of becoming a fake track", async () => {
  globalThis.host = createHost();
  await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  await plugin.remotePlay({ ids: ["901216"], position: 38000 });
  const before = await plugin.remoteState();
  globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "Fixture unavailable" }] }), { status: 503 });
  await assert.rejects(plugin.stationNext({ id: "ra.failed-fixture" }), e => e.code === "unavailable" && e.message.includes("Fixture unavailable"));
  assert.deepEqual(await plugin.remoteState(), before);
});

test("a rejected station does not cancel a song whose metadata is still loading", async () => {
  globalThis.host = createHost();
  let release, requested;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]).includes("/songs/901217")) { requested(); await gate; }
    return fetch(...args);
  };
  const song = plugin.remotePlay({ ids: ["901217"] });
  await started;
  try {
    await assert.rejects(plugin.remotePlay({ ids: ["ra.978194965"] }), e => e.code === "unsupported");
  } finally { release(); }
  await song;
  assert.deepEqual(commands(host).filter(c => c.method === "play").map(c => c.params.trackId), ["901217"]);
  assert.equal((await plugin.remoteState()).trackId, "901217");
});

test("process permission failure is actionable", async () => {
  globalThis.host = createHost({ processGranted: false });
  await assert.rejects(plugin.remoteResume(), e => e.code === "setup");
});

test("account window receives the host language and client identity", async () => {
  globalThis.host = createHost({ language: "zh-CN" });
  await plugin.remoteResume();
  const args = host._getSpawnHistory()[0].args;
  assert.equal(args[args.indexOf("--language") + 1], "zh-CN");
  assert.equal(args[args.indexOf("--app-name") + 1], "MyGo Music");
});

test("ignores stale metadata after a newer play request", async () => {
  globalThis.host = createHost(); let release;
  const pending = new Promise(resolve => { release = resolve; });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { if (String(args[0]).includes("/songs/901123")) await pending; return fetch(...args); };
  const old = plugin.remotePlay({ ids: ["901123"] });
  assert.equal(await plugin.remoteState(), null);
  await plugin.remotePlay({ ids: ["901124"] }); release(); await old;
  const plays = commands(host).filter(x => x.method === "play");
  assert.equal(plays.length, 1); assert.equal(plays[0].params.trackId, "901124");
});

test("core failure and protocol mismatch do not expose diagnostic text", async () => {
  globalThis.host = createHost();
  host._setNativeBehavior(r => { if (r.method === "hello") return { protocol: 1 }; throw Object.assign(new Error("PRIVATE_TOKEN"), { code: "signIn" }); });
  await assert.rejects(plugin.remoteResume(), e => e.code === "signIn" && !e.message.includes("PRIVATE_TOKEN"));
  plugin.resetRemoteSession(); globalThis.host = createHost();
  host._setNativeBehavior(() => ({ protocol: 9 }));
  await assert.rejects(plugin.remoteResume(), e => e.code === "setup");
});

test("native quality, system output and manifest replace old control permissions", async () => {
  globalThis.host = createHost();
  await plugin.setSetting({ key: "audioQuality", value: "lossless" });
  await plugin.remotePlay({ ids: ["901001"] });
  assert.equal(commands(host).find(x => x.method === "play").params.quality, "lossless");
  assert.deepEqual((await plugin.remoteDevices()).map(d => d.id), ["default"]);
  await assert.rejects(plugin.remoteUse({ deviceId: "airplay-old-device" }), e => e.code === "unsupported");
  const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url)));
  assert.deepEqual(manifest.permissions.process, ["bin/apple-music-core-*"]);
  assert.ok(!manifest.settings.some(x => x.key === "playbackBackend" || x.key === "crossfadeTip"));
});

test("logout clears the native session and app catalog token", async () => {
  globalThis.host = createHost(); await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  host._setSetting("mediaUserToken", "OLD_WEB_TOKEN");
  await host.storage.set("native_developer_token", "SYNTHETIC");
  await plugin.signOut();
  assert.ok(commands(host).some(x => x.method === "logout"));
  assert.equal(await host.storage.get("auth"), undefined);
  assert.equal(await host.storage.get("native_developer_token"), undefined);
  assert.equal(await plugin.account(), null);
});

test("output health is opt-in and never copies arbitrary core fields", async () => {
  const state = { status: "playing", trackId: "901001", position: 20000, duration: 100000, volume: 12,
    format: { sampleRate: 96000, bits: 24 }, outputRate: 48000,
    outputStats: { underruns: 0, queuedFrames: 180000, capacityFrames: 192000, privateValue: "DO_NOT_COPY" },
    mediaUserToken: "DO_NOT_COPY", mediaURL: "DO_NOT_COPY" };
  for (const enabled of [false, true]) {
    plugin.resetRemoteSession(); globalThis.host = createHost();
    if (enabled) await host.storage.set("native_playback_health_enabled", true);
    host._setNativeBehavior(request => request.method === "hello" ? { protocol: 1 } : state);
    await plugin.remotePlay({ ids: ["901001"] }); await plugin.remoteState();
    const health = await host.storage.get("native_playback_health");
    if (!enabled) { assert.equal(health, undefined); continue; }
    assert.equal(health.underruns, 0); assert.equal(health.sampleRate, 96000);
    assert.ok(!JSON.stringify(health).includes("DO_NOT_COPY"));
    assert.ok(!("trackId" in health));
  }
});
