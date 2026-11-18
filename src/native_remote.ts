import { Device, fail, ProcessHandle, RemoteState } from "./types.js";

export interface CachedTrackMeta {
  id: string;
  catalogId?: string;
  name: string;
  artistName: string;
  albumName: string;
  albumId?: string;
  durationMs: number;
  url?: string;
  isrc?: string;
  imageUrl?: string;
}

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Connection = { proc: ProcessHandle; owner: typeof host; pending: Map<number, Pending>; ready: Promise<void>; formats: string[]; liveRadio: boolean; play?: Promise<any>; healthAt: number };
type StartOptions = { nextId?: string; deadline: number };
type Quality = "hires" | "lossless" | "aac";
type PlaybackMapping = { requested: string; catalog: string; quality?: Quality; live?: boolean };
let connection: Connection | null = null;
let nextId = 0;
let playGeneration = 0;
let radioSelection = 0;
let mapping: PlaybackMapping | null = null;
let loading = false;

function error(code: "signIn" | "setup" | "unsupported" | "unavailable", message: string): Error {
  return fail(code, typeof host !== "undefined" && typeof host.t === "function" ? host.t(message) : message);
}

function disconnect(c: Connection): void {
  if (connection === c) { connection = null; mapping = null; loading = false; playGeneration++; }
  for (const item of c.pending.values()) { clearTimeout(item.timer); item.reject(error("unavailable", "Native playback connection closed")); }
  c.pending.clear();
  try { c.proc.closeStdin(); } catch {}
  const timer = setTimeout(() => { try { c.proc.kill(); } catch {} }, 3000);
  void c.proc.wait().then(() => clearTimeout(timer), () => clearTimeout(timer));
}

export function resetRemoteSession(): void { if (connection) disconnect(connection); mapping = null; loading = false; playGeneration++; }

function send(c: Connection, method: string, params: Record<string, any>, timeout = method === "auth" ? 15 * 60_000 : method === "setup" ? 10 * 60_000 : 65_000): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(error("unavailable", "Native playback command timed out"));
      if (method !== "prepareRadio") disconnect(c);
    }, timeout);
    c.pending.set(id, { resolve, reject, timer });
    try { c.proc.write(JSON.stringify({ id, method, params }) + "\n"); }
    catch { clearTimeout(timer); c.pending.delete(id); reject(error("unavailable", "Native playback connection closed")); disconnect(c); }
  });
}

function connect(): Connection {
  if (typeof host === "undefined" || typeof host.spawn !== "function") throw error("setup", "Allow the Apple Music plugin to start the native playback core");
  if (connection?.owner === host) return connection;
  if (connection) disconnect(connection);
  if (!(host.platform === "darwin" && host.arch === "arm64") && !(["windows", "linux"].includes(host.platform) && host.arch === "amd64")) {
    throw error("unsupported", "Native playback supports macOS ARM64, Windows x64 and Linux x64");
  }
  const binary = `bin/apple-music-core-${host.platform}-${host.arch}${host.platform === "windows" ? ".exe" : ""}`;
  let proc: ProcessHandle;
  try { proc = host.spawn(binary, ["--data-dir", `${host.dataDir}/native-core`, "--language", host.language?.() || "en", "--app-name", "MyGo Music"]); }
  catch { throw error("setup", "Install the native playback bundle and allow this plugin to start programs"); }
  const c: Connection = { proc, owner: host, pending: new Map(), ready: Promise.resolve(), formats: [], liveRadio: false, healthAt: 0 };
  connection = c;
  void (async () => {
    try {
      for (let line; (line = await proc.readLine()) !== null;) {
        let reply: any;
        try { reply = JSON.parse(line); } catch { continue; }
        const item = c.pending.get(reply.id);
        if (!item) continue;
        c.pending.delete(reply.id); clearTimeout(item.timer);
        if (reply.ok !== true) {
          const code = ["signIn", "setup", "unsupported"].includes(reply.error?.code) ? reply.error.code : "unavailable";
          const message = code === "signIn" ? "Sign in using the native account window" : code === "setup" ? "Install or repair the native runtime" : code === "unsupported" ? "This track, quality or platform is not supported" : "Native operation failed";
          item.reject(error(code, message));
        } else item.resolve(reply.result ?? null);
      }
    } catch {} finally { disconnect(c); }
  })();
  c.ready = send(c, "hello", {}, 5_000).then(value => {
    if (value?.protocol !== 1) { disconnect(c); throw error("setup", "Update the native playback core to a compatible version"); }
    c.formats = Array.isArray(value.formats) ? value.formats : [];
    c.liveRadio = value.liveRadio === true;
  });
  return c;
}

export async function nativeCommand(method: string, params: Record<string, any> = {}): Promise<any> {
  const c = connect(); await c.ready;
  return send(c, method, params);
}

export function beginNativePlay(): number { if (connection && connection.owner !== host) disconnect(connection); loading = true; return ++playGeneration; }
function isCurrentNativePlay(generation: number): boolean { return generation === playGeneration; }
export function finishNativeLoading(generation: number): void { if (isCurrentNativePlay(generation)) loading = false; }

function selectedQuality(): Quality {
  const value = String(host.setting("audioQuality")).toLowerCase();
  return value === "lossless" || value === "aac" ? value : "hires";
}

function playbackError(state: { error?: string }): Error {
  return error(state.error === "signIn" ? "signIn" : "unavailable", "Native operation failed");
}

async function waitForOutput(c: Connection, state: any, id: string, start: number, generation: number, deadline: number): Promise<void> {
  let delay = 40;
  for (;;) {
    if (connection !== c) throw error("unavailable", "Native playback connection closed");
    if (!isCurrentNativePlay(generation)) return;
    if (state?.trackId === id) {
      if (state.status === "error") throw playbackError(state);
      if (state.status === "paused" || ((state.status === "playing" || state.status === "ended") && state.position > start)) return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      disconnect(c);
      throw error("unavailable", "Apple Music took too long to start playing");
    }
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(delay, remaining)));
    if (connection !== c || !isCurrentNativePlay(generation) || Date.now() >= deadline) continue;
    state = await send(c, "state", {}, Math.max(1, deadline - Date.now()));
    delay = Math.min(120, delay * 2);
  }
}

async function startPlayback(c: Connection, method: "play" | "playRadio", params: Record<string, unknown>, current: PlaybackMapping, position: number, generation: number, deadline: number): Promise<void> {
  if (c.play) await c.play.catch(() => {});
  if (connection !== c) throw error("unavailable", "Native playback connection closed");
  if (!isCurrentNativePlay(generation)) return;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw error("unavailable", "Apple Music took too long to start playing");
  const play = c.play = send(c, method, params, remaining);
  let state;
  try {
    state = await play;
    if (connection === c) mapping = current;
  } finally {
    if (c.play === play) c.play = undefined;
  }
  await waitForOutput(c, state, current.catalog, position, generation, deadline);
}

export async function nativePlay(requested: string, id: string, position: number, generation: number, { nextId, deadline }: StartOptions): Promise<void> {
  if (!isCurrentNativePlay(generation)) return;
  if (!/^\d{1,24}$/.test(id)) throw error("unsupported", "Native playback requires a catalog song or supported live station");
  const c = connect(); await c.ready;
  const quality = selectedQuality();
  if (quality === "aac" && !c.formats.includes("aac")) throw error("setup", "Update the native playback core to a compatible version");
  await startPlayback(c, "play", { trackId: id, position, quality, nextTrackId: nextId === id ? undefined : nextId }, { requested, catalog: id, quality }, position, generation, deadline);
}

export async function prepareNativeRadio(id: string): Promise<void> {
  const c = connect(); await c.ready;
  if (!c.liveRadio) throw error("unsupported", "Update the native playback core to play live radio");
  try {
    await send(c, "prepareRadio", { stationId: id }, 18_000);
  } catch {
    throw error("unavailable", "This live station is temporarily unavailable");
  }
}

export async function nativePlayRadio(id: string, deadline: number): Promise<void> {
  const previous = playGeneration;
  const selection = ++radioSelection;
  const c = connect();
  await prepareNativeRadio(id);
  if (connection !== c || selection !== radioSelection || !isCurrentNativePlay(previous)) return;
  const generation = beginNativePlay();
  try {
    await startPlayback(c, "playRadio", { stationId: id }, { requested: id, catalog: id, live: true }, 0, generation, deadline);
  } finally { finishNativeLoading(generation); }
}

export async function nativeSeek(position: number): Promise<void> {
  // Older hosts show song controls for live stations and can still call this.
  if (mapping?.live && connection?.owner === host) return;
  await nativeCommand("seek", { position, quality: mapping?.quality ?? selectedQuality() });
}

export async function nativeState(): Promise<RemoteState | null> {
  if (!connection || loading) return null;
  const state = await nativeCommand("state");
  const current = connection;
  if (state?.outputStats && current && Date.now() >= current.healthAt) {
    current.healthAt = Date.now() + 10_000;
    try {
      if (await current.owner.storage.get("native_playback_health_enabled") === true) {
        const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
        await current.owner.storage.set("native_playback_health", {
          sampledAt: Date.now(), status: ["buffering", "playing", "paused", "ended", "error"].includes(state.status) ? state.status : "unknown",
          position: number(state.position), duration: number(state.duration),
          sampleRate: number(state.format?.sampleRate), bits: number(state.format?.bits), outputRate: number(state.outputRate),
          underruns: number(state.outputStats.underruns), queuedFrames: number(state.outputStats.queuedFrames), capacityFrames: number(state.outputStats.capacityFrames),
        });
      }
    } catch { /* Optional, local health checks must not interrupt playback. */ }
  }
  if (!state || ["idle", "ended"].includes(state.status)) return null;
  if (state.status === "error") throw playbackError(state);
  return {
    playing: state.status !== "paused",
    trackId: mapping && state.trackId === mapping.catalog ? mapping.requested : state.trackId,
    ...(state.live === true ? { live: true } : {}),
    position: Number(state.position) || 0,
    duration: Number(state.duration) || 0,
    volume: Number.isFinite(state.volume) ? state.volume : 100,
    device: "default",
  };
}

export async function nativeDevices(): Promise<Device[]> {
  return [{ id: "default", name: typeof host !== "undefined" && typeof host.t === "function" ? host.t("System Audio Output") : "System Audio Output", active: true }];
}
