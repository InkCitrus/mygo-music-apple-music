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

test("catalog queue starts without a metadata request and hints only the immediate next song", async () => {
  globalThis.host = createHost();
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Catalog fixture is offline"); };
  await plugin.remotePlay({ ids: ["901000", "901001", "901002", "901003"], start: 1 });
  await plugin.remotePlay({ ids: ["901002", "i.uncached-hint", "901003"] });
  await plugin.remotePlay({ ids: ["901003", "ra.978194965", "901004"] });
  assert.equal(requests, 0);
  const plays = commands(host).filter(c => c.method === "play");
  assert.deepEqual(plays.map(c => [c.params.trackId, c.params.nextTrackId]), [
    ["901001", "901002"], ["901002", undefined], ["901003", undefined],
  ]);
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

test("live radio prepares before returning a queue entry and waits for native output", async () => {
  const host = globalThis.host = createHost();
  const stationId = "ra.978194965";
  const playing = { status: "playing", trackId: stationId, live: true, duration: 0, position: 0, volume: 100 };
  let outputReady = false;
  host._setNativeBehavior(({ method, params }) => {
    switch (method) {
      case "hello": return { protocol: 1, liveRadio: true, formats: ["alac", "aac"] };
      case "prepareRadio": assert.equal(params.stationId, stationId); return true;
      case "playRadio": assert.deepEqual(params, { stationId }); return playing;
      case "state": return { ...playing, position: outputReady ? 42 : 0 };
      default: assert.fail(`unexpected method ${method}`);
    }
  });
  const [entry] = await plugin.stationNext({ id: stationId });
  assert.equal(entry.id, stationId);
  assert.equal(entry.name, "Apple Music 1");
  assert.equal(entry.duration, 0);
  assert.equal(entry.live, true);
  assert.deepEqual(commands(host).map(x => x.method), ["hello", "prepareRadio"]);
  let settled = false;
  const start = plugin.remotePlay({ ids: [entry.id] }).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(settled, false);
  assert.equal(await plugin.remoteState(), null);
  outputReady = true;
  await start;
  const state = await plugin.remoteState();
  assert.equal(state.trackId, stationId);
  assert.equal(state.position, 42);
  assert.equal(state.duration, 0);
  assert.equal(state.live, true);
  await plugin.remoteSeek({ position: 0 });
  assert.equal(commands(host).some(x => x.method === "seek"), false);
  assert.equal(host._getOpenedURLs().length, 0);
});

test("live stations never call song favorites endpoints", async () => {
  globalThis.host = createHost();
  await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  globalThis.fetch = async () => assert.fail("live stations should not query or change song favorites");
  const id = "ra.978194965";
  await plugin.like({ id, on: true });
  assert.deepEqual(await plugin.isLiked({ ids: [id] }), { [id]: false });
});

test("failed live segment preflight preserves playing song and sends no play command", async () => {
  const host = globalThis.host = createHost();
  const state = { status: "playing", trackId: "901210", position: 42001, duration: 256613, volume: 23 };
  host._setNativeBehavior(({ method }) => {
    switch (method) {
      case "hello": return { protocol: 1, liveRadio: true };
      case "play":
      case "state": return state;
      case "prepareRadio": throw plugin.fail("unavailable", "offline station");
      default: assert.fail(`unexpected method ${method}`);
    }
  });
  await plugin.remotePlay({ ids: [state.trackId], position: 42000 });
  const before = await plugin.remoteState();
  await assert.rejects(plugin.stationNext({ id: "ra.978194965" }), e => e.code === "unavailable");
  await assert.rejects(plugin.remotePlay({ ids: ["ra.978194965"] }), e => e.code === "unavailable");
  assert.deepEqual(await plugin.remoteState(), before);
  assert.deepEqual(commands(host).filter(x => x.method.startsWith("play")).map(x => x.method), ["play"]);
  assert.equal(host._getOpenedURLs().length, 0);
});

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

test("a rejected station does not cancel a library song whose metadata is still loading", async () => {
  globalThis.host = createHost();
  await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  let release, requested;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]).includes("/songs/i.radio-pending")) { requested(); await gate; }
    return fetch(...args);
  };
  const song = plugin.remotePlay({ ids: ["i.radio-pending"] });
  await started;
  try {
    await assert.rejects(plugin.remotePlay({ ids: ["ra.978194965"] }), e => e.code === "unsupported");
  } finally { release(); }
  await song;
  assert.deepEqual(commands(host).filter(c => c.method === "play").map(c => c.params.trackId), ["901001"]);
  assert.equal((await plugin.remoteState()).trackId, "i.radio-pending");
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
  await host.storage.set("auth", { mediaUserToken: "SYNTHETIC" });
  const pending = new Promise(resolve => { release = resolve; });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { if (String(args[0]).includes("/songs/i.stale-pending")) await pending; return fetch(...args); };
  const old = plugin.remotePlay({ ids: ["i.stale-pending"] });
  assert.equal(await plugin.remoteState(), null);
  await plugin.remotePlay({ ids: ["901124"] }); release(); await old;
  const plays = commands(host).filter(x => x.method === "play");
  assert.equal(plays.length, 1); assert.equal(plays[0].params.trackId, "901124");
});

test("keeps the host loading until the new track's output position advances", { timeout: 3000 }, async () => {
  globalThis.host = createHost();
  const trackId = "901039", start = 12500;
  let outputReady = false, acknowledged = false;
  let arrived;
  const stillAtStart = new Promise(resolve => { arrived = resolve; });
  host._setNativeBehavior(request => {
    const status = { trackId, position: start, duration: 200000, volume: 100 };
    if (request.method === "hello") return { protocol: 1 };
    if (request.method === "play") return { ...status, status: "buffering" };
    if (request.method === "state" && !outputReady) {
      arrived();
      return { ...status, status: "playing" };
    }
    return { ...status, status: "playing", position: start + 24 };
  });
  const pending = plugin.remotePlay({ ids: [trackId], position: start }).then(() => { acknowledged = true; });
  try {
    await Promise.race([stillAtStart, pending]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acknowledged, false);
    assert.equal(await plugin.remoteState(), null);
  } finally { outputReady = true; }
  await pending;
  assert.equal((await plugin.remoteState()).position, start + 24);
});

test("a native startup failure stays an error instead of starting the host clock", { timeout: 3000 }, async () => {
  globalThis.host = createHost();
  const trackId = "901043";
  host._setNativeBehavior(request => {
    if (request.method === "hello") return { protocol: 1 };
    if (request.method === "play") return { status: "buffering", trackId, position: 0 };
    return { status: "error", error: "signIn", trackId, position: 0 };
  });
  await assert.rejects(plugin.remotePlay({ ids: [trackId] }), e => e.code === "signIn");
});

test("rapid skips preserve command order and drop an intermediate selection", async () => {
  globalThis.host = createHost();
  let release, started;
  const first = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  host._setNativeBehavior(async request => {
    if (request.method === "hello") return { protocol: 1 };
    if (request.params.trackId === "901040") { started(); await wait; }
    return { status: "playing", trackId: request.params.trackId, position: request.params.position + 20 };
  });
  const original = plugin.remotePlay({ ids: ["901040"] });
  await first;
  const skipped = plugin.remotePlay({ ids: ["901041"] });
  const latest = plugin.remotePlay({ ids: ["901042"] });
  await new Promise(resolve => setImmediate(resolve));
  const played = () => commands(host).filter(c => c.method === "play").map(c => c.params.trackId);
  try {
    assert.deepEqual(played(), ["901040"]);
  } finally { release(); }
  await Promise.all([original, skipped, latest]);
  assert.deepEqual(played(), ["901040", "901042"]);
});

test("replacing a track does not wait for its buffered output to start", { timeout: 3000 }, async () => {
  globalThis.host = createHost();
  let arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  host._setNativeBehavior(request => {
    if (request.method === "hello") return { protocol: 1 };
    if (request.method === "state") arrived();
    const trackId = request.params?.trackId ?? "901044";
    return trackId === "901044" ? { status: "buffering", trackId, position: 0 }
      : { status: "playing", trackId, position: 20 };
  });
  const old = plugin.remotePlay({ ids: ["901044"] });
  await waiting;
  await Promise.all([old, plugin.remotePlay({ ids: ["901045"] })]);
  assert.deepEqual(commands(host).filter(c => ["play", "stop"].includes(c.method)).map(c => c.params.trackId), ["901044", "901045"]);
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
  assert.equal(host._getSpawnHistory().length, 0);
  await plugin.remotePlay({ ids: ["901001"] });
  await plugin.setSetting({ key: "audioQuality", value: "" });
  await plugin.remoteSeek({ position: 12000 });
  await plugin.remotePlay({ ids: ["901002"] });
  assert.deepEqual(commands(host).filter(c => ["play", "seek", "quality"].includes(c.method)).map(c => [c.method, c.params.quality]), [
    ["play", "lossless"], ["seek", "lossless"], ["play", "hires"],
  ]);
  assert.deepEqual((await plugin.remoteDevices()).map(d => d.id), ["default"]);
  await assert.rejects(plugin.remoteUse({ deviceId: "airplay-old-device" }), e => e.code === "unsupported");
  const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url)));
  const quality = manifest.settings.find(x => x.key === "audioQuality");
  assert.equal(quality.type, "select");
  const zh = JSON.parse(fs.readFileSync(new URL("../locales/zh-CN.json", import.meta.url)));
  for (const phrase of [quality.label, quality.help, ...quality.options.map(o => o.label)]) assert.ok(zh[phrase]);
  assert.deepEqual(manifest.permissions.process, ["bin/apple-music-core-*"]);
  assert.ok(!manifest.settings.some(x => x.key === "playbackBackend" || x.key === "crossfadeTip"));
});

test("AAC applies on a new song and stays selected when seeking it", async () => {
  globalThis.host = createHost();
  await plugin.remotePlay({ ids: ["901100"] });
  await plugin.setSetting({ key: "audioQuality", value: "aac" });
  await plugin.remoteSeek({ position: 4000 });
  await plugin.remotePlay({ ids: ["901101", "901102"] });
  await plugin.setSetting({ key: "audioQuality", value: "lossless" });
  await plugin.remoteSeek({ position: 3000 });
  await plugin.remotePlay({ ids: ["901102"] });
  assert.deepEqual(commands(host).filter(c => ["play", "seek"].includes(c.method)).map(c => c.params.quality), ["hires", "hires", "aac", "aac", "lossless"]);
});

test("selecting AAC with an ALAC-only core does not issue a play command", async () => {
  globalThis.host = createHost();
  host._setNativeBehavior(() => ({ protocol: 1, formats: ["alac"] }));
  await plugin.setSetting({ key: "audioQuality", value: "aac" });
  await assert.rejects(plugin.remotePlay({ ids: ["901100"] }), e => e.code === "setup");
  assert.deepEqual(commands(host).map(c => c.method), ["hello"]);
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
