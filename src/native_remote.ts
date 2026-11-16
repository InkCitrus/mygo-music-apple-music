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
type Connection = { proc: ProcessHandle; owner: typeof host; pending: Map<number, Pending>; ready: Promise<void> };
let connection: Connection | null = null;
let nextId = 0;
let playGeneration = 0;
let mapping: { requested: string; catalog: string } | null = null;
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

function send(c: Connection, method: string, params: Record<string, any>): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = method === "auth" ? 15 * 60_000 : method === "setup" ? 10 * 60_000 : 65_000;
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(error("unavailable", "Native playback command timed out"));
      disconnect(c);
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
  try { proc = host.spawn(binary, ["--data-dir", `${host.dataDir}/native-core`]); }
  catch { throw error("setup", "Install the native playback bundle and allow this plugin to start programs"); }
  const c: Connection = { proc, owner: host, pending: new Map(), ready: Promise.resolve() };
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
  c.ready = send(c, "hello", {}).then(value => {
    if (value?.protocol !== 1) { disconnect(c); throw error("setup", "Update the native playback core to a compatible version"); }
  });
  return c;
}

export async function nativeCommand(method: string, params: Record<string, any> = {}): Promise<any> {
  const c = connect(); await c.ready;
  return send(c, method, params);
}

export function beginNativePlay(): number { if (connection && connection.owner !== host) disconnect(connection); loading = true; return ++playGeneration; }
export function isCurrentNativePlay(generation: number): boolean { return generation === playGeneration; }
export function finishNativeLoading(generation: number): void { if (isCurrentNativePlay(generation)) loading = false; }

export async function nativePlay(meta: CachedTrackMeta, position: number, generation: number): Promise<void> {
  const id = meta.catalogId || meta.id;
  if (!/^\d{1,24}$/.test(id)) throw error("unsupported", "Native playback currently supports catalog songs; radio and uploaded tracks are unavailable");
  const requestedQuality = String(host.setting("audioQuality") || "hires").toLowerCase();
  const quality = requestedQuality === "lossless" ? "lossless" : "hires";
  if (!isCurrentNativePlay(generation)) return;
  await nativeCommand("play", { trackId: id, position, quality });
  if (isCurrentNativePlay(generation)) mapping = { requested: meta.id, catalog: id };
}

export async function nativeState(): Promise<RemoteState | null> {
  if (!connection || loading) return null;
  const state = await nativeCommand("state");
  if (!state || ["idle", "ended"].includes(state.status)) return null;
  if (state.status === "error") throw error(state.error === "signIn" ? "signIn" : "unavailable", "Native operation failed");
  return {
    playing: state.status !== "paused",
    trackId: mapping && state.trackId === mapping.catalog ? mapping.requested : state.trackId,
    position: Number(state.position) || 0,
    duration: Number(state.duration) || 0,
    volume: Number.isFinite(state.volume) ? state.volume : 100,
    device: "default",
  };
}

export async function nativeDevices(): Promise<Device[]> {
  return [{ id: "default", name: typeof host !== "undefined" && typeof host.t === "function" ? host.t("System Audio Output") : "System Audio Output", active: true }];
}
