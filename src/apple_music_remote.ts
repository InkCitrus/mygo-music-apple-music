import { Device, fail, LyricLine, Lyrics, LyricWord, RemoteState } from "./types.js";

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
}

export type MusicAudioQualityMode = "high" | "lossless" | "hires";

interface ActivePlaybackSession {
  generation: number;
  isStarting: boolean;
  meta: CachedTrackMeta;
  storefront: string;
  trackId: string;
  catalogId?: string;
  name: string;
  artistName: string;
  durationMs: number;
  startedAt: number;
  lastCommandAt: number;
  maxPositionMs: number;
  hasObservedPlaying: boolean;
  initialReportedName?: string;
  deviceName?: string;
  lastKnownState: RemoteState | null;
}

let activeSession: ActivePlaybackSession | null = null;
let lastSyncedAudioQuality: MusicAudioQualityMode | null = null;
let playGeneration = 0;

export function resetRemoteSession(): void {
  activeSession = null;
  lastSyncedAudioQuality = null;
  playGeneration = 0;
}

export function parseAudioQualitySetting(raw?: string | null): MusicAudioQualityMode | null {
  if (!raw || typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (
    v === "hires" ||
    v === "hi-res" ||
    v === "hi-res lossless" ||
    v === "hires-lossless" ||
    v === "30" ||
    v === "192" ||
    v === "192khz" ||
    v === "高解析" ||
    v === "高解析度" ||
    v === "高解析度无损"
  ) {
    return "hires";
  }
  if (
    v === "lossless" ||
    v === "alac" ||
    v === "20" ||
    v === "48" ||
    v === "48khz" ||
    v === "无损" ||
    v === "无损音频"
  ) {
    return "lossless";
  }
  if (
    v === "high" ||
    v === "aac" ||
    v === "standard" ||
    v === "256" ||
    v === "256kbps" ||
    v === "10" ||
    v === "高质量" ||
    v === "标准"
  ) {
    return "high";
  }
  return null;
}

export function escapeAppleScriptString(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

export function toMusicAppUrl(rawUrl: string | undefined, sf: string, songId: string, albumId?: string): string {
  const cleanId = String(songId || "").trim();
  const cleanSf = (sf || "us").trim().toLowerCase();
  if (rawUrl && typeof rawUrl === "string") {
    const trimmed = rawUrl.trim();
    if (
      trimmed.startsWith("music://") ||
      trimmed.startsWith("musics://") ||
      trimmed.startsWith("itmss://") ||
      trimmed.startsWith("itsradio://")
    ) {
      return trimmed;
    }
    if (trimmed.startsWith("https://music.apple.com/") || trimmed.startsWith("http://music.apple.com/")) {
      return trimmed.replace(/^https?:\/\//i, "music://");
    }
  }
  if (!cleanId) return "";
  if (cleanId.startsWith("ra.")) {
    return `music://music.apple.com/${cleanSf}/station/_/${encodeURIComponent(cleanId)}`;
  }
  if (albumId && /^\d+$/.test(albumId)) {
    return `music://music.apple.com/${cleanSf}/album/_/${albumId}?i=${encodeURIComponent(cleanId)}`;
  }
  return `music://music.apple.com/${cleanSf}/song/_/${encodeURIComponent(cleanId)}`;
}

export function extractCatalogStoreId(catalogId?: string, musicUrl?: string): string {
  const direct = String(catalogId || "").trim();
  if (/^\d+$/.test(direct)) {
    return direct;
  }
  const url = String(musicUrl || "").trim();
  if (!url) return "";
  const itemMatch = url.match(/[?&]i=(\d+)/);
  if (itemMatch?.[1]) return itemMatch[1];
  const idMatch = url.match(/[?&]id=(\d+)/);
  if (idMatch?.[1]) return idMatch[1];
  const songMatch = url.match(/\/song\/(?:[^/?#]+\/)?(\d+)/);
  if (songMatch?.[1]) return songMatch[1];
  return "";
}

export function toPlayStoreIdUrl(storeId?: string): string {
  const cleanId = String(storeId || "").trim();
  if (!/^\d+$/.test(cleanId)) return "";
  return `music://music.apple.com/?cmd=playStoreID&id=${encodeURIComponent(cleanId)}`;
}

export function buildPlayScript(params: {
  name: string;
  artistName: string;
  musicUrl: string;
  catalogId?: string;
  positionSec: number;
}): string {
  const safeName = escapeAppleScriptString(params.name);
  const safeArtist = escapeAppleScriptString(params.artistName);
  const safeUrl = escapeAppleScriptString(params.musicUrl);
  const storeId = extractCatalogStoreId(params.catalogId, params.musicUrl);
  const safePlayStoreUrl = escapeAppleScriptString(toPlayStoreIdUrl(storeId));
  const posSec = Math.max(0, Number.isFinite(params.positionSec) ? params.positionSec : 0);

  return `
set targetName to "${safeName}"
set targetArtist to "${safeArtist}"
set targetURL to "${safeUrl}"
set playStoreURL to "${safePlayStoreUrl}"
set startPos to ${posSec.toFixed(3)}

set prevApp to ""
try
  tell application "System Events"
    set prevApp to name of first application process whose frontmost is true
  end tell
end try

tell application "Music"
  try
    set shuffle enabled to false
  end try
  try
    set song repeat to off
  end try

  set playedFromLib to false
  if targetName is not "" then
    try
      ignoring case
        if targetArtist is not "" then
          set matchedTracks to (every track of library playlist 1 whose name is targetName and artist contains targetArtist)
        else
          set matchedTracks to (every track of library playlist 1 whose name is targetName)
        end if
        if (count of matchedTracks) is 0 and playStoreURL is "" then
          set matchedTracks to (every track of library playlist 1 whose name is targetName)
        end if
      end ignoring
      if (count of matchedTracks) > 0 then
        play (item 1 of matchedTracks)
        set playedFromLib to true
      end if
    end try
  end if

  if playedFromLib is false then
    if playStoreURL is "" and targetURL is "" then
      error "MISSING_CATALOG_URL"
    end if
    try
      stop
    end try
    if playStoreURL is not "" and targetURL does not contain "/album/" and targetURL does not contain "/station/" then
      open location playStoreURL
    else
      open location targetURL
    end if
    repeat with waitIdx from 1 to 20
      delay 0.25
      try
        if player state is playing then exit repeat
        if waitIdx >= 8 and player state is paused then
          play
        end if
      end try
    end repeat
  end if

  if startPos > 0 then
    try
      if player state is playing or player state is paused then
        set player position to startPos
      end if
    end try
  end if
end tell

if playedFromLib is false and prevApp is not "" and prevApp is not "Music" then
  try
    tell application prevApp to activate
  end try
end if

if playedFromLib then
  return "OK|LIBRARY"
else
  return "OK|CATALOG"
end if
`.trim();
}

export function buildPauseScript(): string {
  return `
if application "Music" is running then
  tell application "Music"
    pause
  end tell
end if
return "OK"
`.trim();
}

export function buildResumeScript(): string {
  return `
tell application "Music"
  play
end tell
return "OK"
`.trim();
}

export function buildSeekScript(positionSec: number): string {
  const safeSec = Math.max(0, Number.isFinite(positionSec) ? positionSec : 0);
  return `
if application "Music" is running then
  tell application "Music"
    set player position to ${safeSec.toFixed(3)}
  end tell
end if
return "OK"
`.trim();
}

export function buildVolumeScript(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 100)));
  return `
tell application "Music"
  set sound volume to ${clamped}
end tell
return "OK"
`.trim();
}

export function buildStateScript(): string {
  return `
if application "Music" is not running then
  return "STOPPED"
end if

tell application "Music"
  set pState to "stopped"
  try
    set curState to player state
    if curState is playing then
      set pState to "playing"
    else if curState is paused then
      set pState to "paused"
    else if curState is fast forwarding or curState is rewinding then
      set pState to "playing"
    end if
  on error
    return "STOPPED"
  end try

  if pState is "stopped" then
    return "STOPPED"
  end if

  set posMs to 0
  try
    set rawPos to player position
    if rawPos is not missing value then
      set posMs to round (rawPos * 1000) rounding as taught in school
    end if
  end try

  set pVol to 100
  try
    set pVol to sound volume
  end try

  set tName to ""
  set tArtist to ""
  set durMs to 0
  try
    set tName to name of current track
    set tArtist to artist of current track
    set rawDur to duration of current track
    if rawDur is not missing value then
      set durMs to round (rawDur * 1000) rounding as taught in school
    end if
  end try

  return pState & tab & (posMs as string) & tab & (durMs as string) & tab & (pVol as string) & tab & "" & tab & tName & tab & tArtist
end tell
`.trim();
}

export function buildDevicesScript(): string {
  return `
if application "Music" is not running then
  return ""
end if

tell application "Music"
  set outLines to ""
  try
    set devs to (every AirPlay device whose available is true and supports audio is true)
    repeat with d in devs
      set dName to name of d
      set dSel to selected of d
      set dAddr to ""
      try
        set dAddr to network address of d
      end try
      if dAddr is "" or dAddr is missing value then
        set dId to dName
      else
        set dId to dAddr
      end if
      if outLines is not "" then
        set outLines to outLines & linefeed
      end if
      if dSel then
        set outLines to outLines & dId & tab & dName & tab & "1"
      else
        set outLines to outLines & dId & tab & dName & tab & "0"
      end if
    end repeat
  end try
  return outLines
end tell
`.trim();
}

export function buildSelectDeviceScript(deviceId: string): string {
  const safeId = escapeAppleScriptString(deviceId);
  return `
tell application "Music"
  set targetId to "${safeId}"
  set didMatch to false
  set devs to (every AirPlay device whose available is true and supports audio is true)
  repeat with d in devs
    set dName to name of d
    set dAddr to ""
    try
      set dAddr to network address of d
    end try
    if dAddr is targetId or dName is targetId then
      set selected of d to true
      set didMatch to true
    end if
  end repeat
  if didMatch then
    repeat with d in devs
      set dName to name of d
      set dAddr to ""
      try
        set dAddr to network address of d
      end try
      if dAddr is not targetId and dName is not targetId then
        try
          set selected of d to false
        end try
      end if
    end repeat
  end if
end tell
return "OK"
`.trim();
}

function translate(text: string): string {
  return typeof host !== "undefined" && typeof host.t === "function" ? host.t(text) : text;
}

export function formatAudioQualityLabel(mode: MusicAudioQualityMode): string {
  if (mode === "hires") {
    return translate("Hi-Res Lossless (24-bit/192 kHz)");
  }
  if (mode === "lossless") {
    return translate("Lossless (24-bit/48 kHz)");
  }
  return translate("High Quality (AAC 256 kbps)");
}

export function buildReadAudioQualityScript(): string {
  return `
set losslessVal to "0"
set qualVal to "10"
try
  set losslessVal to do shell script "/usr/bin/defaults read com.apple.Music losslessEnabled 2>/dev/null || echo 0"
end try
try
  set qualVal to do shell script "/usr/bin/defaults read com.apple.Music preferredStreamPlaybackAudioQuality 2>/dev/null || echo 10"
end try
return "QUALITY:" & losslessVal & ":" & qualVal
`.trim();
}

export function buildWriteAudioQualityScript(mode: MusicAudioQualityMode): string {
  const losslessBool = mode === "high" ? "false" : "true";
  const expectedLossless = mode === "high" ? "0" : "1";
  const qualInt = mode === "hires" ? 30 : mode === "lossless" ? 20 : 10;

  return `
set curLossless to ""
set curQual to ""
try
  set curLossless to do shell script "/usr/bin/defaults read com.apple.Music losslessEnabled 2>/dev/null || echo 0"
end try
try
  set curQual to do shell script "/usr/bin/defaults read com.apple.Music preferredStreamPlaybackAudioQuality 2>/dev/null || echo 10"
end try

if curLossless is "${expectedLossless}" and curQual is "${qualInt}" then
  return "UNCHANGED"
end if

set wasPlaying to "0"
set savedPosMs to 0

if application "Music" is running then
  try
    tell application "Music"
      if player state is playing then
        set wasPlaying to "1"
        set rawPos to player position
        if rawPos is not missing value then
          set savedPosMs to round (rawPos * 1000) rounding as taught in school
        end if
      end if
    end tell
  end try

  try
    tell application "Music" to quit
  end try

  repeat 12 times
    if application "Music" is not running then exit repeat
    delay 0.2
  end repeat
end if

do shell script "/usr/bin/defaults write com.apple.Music losslessEnabled -bool ${losslessBool} && /usr/bin/defaults write com.apple.Music preferredStreamPlaybackAudioQuality -int ${qualInt}"

return "UPDATED:" & wasPlaying & ":" & (savedPosMs as string)
`.trim();
}

export async function readMusicAppAudioQuality(): Promise<MusicAudioQualityMode | null> {
  if (typeof host === "undefined" || typeof host.spawn !== "function" || host.platform !== "darwin") {
    return null;
  }
  try {
    const out = await runAppleScript(buildReadAudioQualityScript());
    if (!out.startsWith("QUALITY:")) return null;
    const parts = out.slice("QUALITY:".length).trim().split(":");
    const lossless = parts[0]?.trim() === "1" || parts[0]?.trim().toLowerCase() === "true";
    const qual = parseInt(parts[1]?.trim() || "10", 10);
    if (!lossless || qual <= 10) return "high";
    if (qual >= 30) return "hires";
    return "lossless";
  } catch {
    return null;
  }
}

export async function syncMusicAppAudioQuality(
  mode: MusicAudioQualityMode,
  options?: { skipResume?: boolean }
): Promise<boolean> {
  if (typeof host === "undefined" || typeof host.spawn !== "function") {
    return false;
  }
  if (host.platform && host.platform !== "darwin") {
    return false;
  }

  const snapshot = activeSession ? { ...activeSession } : null;
  const out = await runAppleScript(buildWriteAudioQualityScript(mode));
  lastSyncedAudioQuality = mode;

  if (out.startsWith("UPDATED:1:") && !options?.skipResume && snapshot) {
    const posPart = parseInt(out.slice("UPDATED:1:".length).trim(), 10);
    const resumePosMs = Number.isFinite(posPart) && posPart > 0 ? posPart : snapshot.maxPositionMs;
    await executeRemotePlay({
      meta: snapshot.meta,
      storefront: snapshot.storefront,
      positionMs: resumePosMs,
    });
  }

  return out.startsWith("UPDATED:");
}

export async function runAppleScript(script: string): Promise<string> {
  if (typeof host === "undefined" || typeof host.spawn !== "function") {
    throw fail("unsupported", translate("Remote Apple Music playback requires macOS Music.app"));
  }
  if (host.platform && host.platform !== "darwin") {
    throw fail("unsupported", translate("Remote Apple Music playback requires macOS Music.app"));
  }

  let proc;
  const candidates = ["/usr/bin/osascript", "osascript"];
  let lastSpawnErr: any = null;

  for (const bin of candidates) {
    try {
      proc = host.spawn(bin, ["-"]);
      break;
    } catch (err: any) {
      lastSpawnErr = err;
      const msg = String(err?.message || err || "");
      if (
        msg.includes("hasn't allowed") ||
        msg.includes("process permission") ||
        msg.includes("start programs")
      ) {
        throw fail(
          "setup",
          translate("Allow Apple Music plugin to start programs in Settings > Plugins")
        );
      }
    }
  }

  if (!proc) {
    const msg = String(lastSpawnErr?.message || lastSpawnErr || "");
    if (
      msg.includes("hasn't allowed") ||
      msg.includes("process permission") ||
      msg.includes("start programs")
    ) {
      throw fail(
        "setup",
        translate("Allow Apple Music plugin to start programs in Settings > Plugins")
      );
    }
    throw fail("unavailable", translate("Failed to control macOS Music.app"));
  }

  try {
    proc.write(script);
    proc.closeStdin();
  } catch (err: any) {
    try {
      proc.kill();
    } catch {}
    throw fail("unavailable", translate("Failed to control macOS Music.app"));
  }

  const lines: string[] = [];
  while (true) {
    const line = await proc.readLine();
    if (line === null || line === undefined) break;
    lines.push(line);
  }

  const exitCode = await proc.wait();
  if (typeof exitCode === "number" && exitCode !== 0) {
    const stderr = typeof proc.errorOutput === "function" ? proc.errorOutput() : "";
    if (stderr.includes("MISSING_CATALOG_URL")) {
      throw fail("unavailable", translate("This track is unavailable for streaming"));
    }
    throw fail(
      "unavailable",
      stderr.trim() || translate("Failed to control macOS Music.app")
    );
  }

  return lines.join("\n").trim();
}

export async function executeRemotePlay(params: {
  meta: CachedTrackMeta;
  storefront: string;
  positionMs: number;
}): Promise<void> {
  const { meta, storefront, positionMs } = params;

  if (typeof host !== "undefined" && typeof host.setting === "function") {
    const desiredQuality = parseAudioQualitySetting(host.setting("audioQuality"));
    if (desiredQuality && lastSyncedAudioQuality !== desiredQuality) {
      try {
        await syncMusicAppAudioQuality(desiredQuality, { skipResume: true });
      } catch (err: any) {
        if (err?.code === "setup") throw err;
      }
    }
  }

  const songIdForUrl = meta.catalogId || meta.id;
  const catalogStoreId =
    meta.catalogId && /^\d+$/.test(meta.catalogId)
      ? meta.catalogId
      : /^\d+$/.test(meta.id)
        ? meta.id
        : undefined;
  const musicUrl = toMusicAppUrl(meta.url, storefront, songIdForUrl, meta.albumId);
  const posSec = Math.max(0, (positionMs || 0) / 1000);
  const gen = ++playGeneration;

  activeSession = {
    generation: gen,
    isStarting: true,
    meta,
    storefront,
    trackId: meta.id,
    catalogId: catalogStoreId,
    name: meta.name,
    artistName: meta.artistName,
    durationMs: meta.durationMs || 0,
    startedAt: Date.now(),
    lastCommandAt: Date.now(),
    maxPositionMs: Math.max(0, positionMs || 0),
    hasObservedPlaying: false,
    initialReportedName: undefined,
    lastKnownState: {
      playing: true,
      trackId: meta.id,
      position: Math.max(0, positionMs || 0),
      duration: meta.durationMs || 0,
      volume: 100,
      device: translate("Mac (Apple Music)"),
    },
  };

  const script = buildPlayScript({
    name: meta.name,
    artistName: meta.artistName,
    musicUrl,
    catalogId: catalogStoreId,
    positionSec: posSec,
  });

  try {
    await runAppleScript(script);
  } catch (err) {
    if (activeSession && activeSession.generation === gen) {
      activeSession = null;
    }
    throw err;
  }
  if (activeSession && activeSession.generation === gen) {
    activeSession.isStarting = false;
    activeSession.lastCommandAt = Date.now();
  }
}

export async function executeRemotePause(): Promise<void> {
  await runAppleScript(buildPauseScript());
  if (activeSession) {
    activeSession.lastCommandAt = Date.now();
    if (activeSession.lastKnownState) {
      activeSession.lastKnownState.playing = false;
    }
  }
}

export async function executeRemoteResume(): Promise<void> {
  await runAppleScript(buildResumeScript());
  if (activeSession) {
    activeSession.lastCommandAt = Date.now();
    if (activeSession.lastKnownState) {
      activeSession.lastKnownState.playing = true;
    }
  }
}

export async function executeRemoteSeek(positionMs: number): Promise<void> {
  const clampedMs = Math.max(0, Number(positionMs) || 0);
  await runAppleScript(buildSeekScript(clampedMs / 1000));
  if (activeSession) {
    activeSession.lastCommandAt = Date.now();
    activeSession.maxPositionMs = clampedMs;
    if (activeSession.lastKnownState) {
      activeSession.lastKnownState.position = clampedMs;
    }
  }
}

export async function executeRemoteVolume(percent: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  await runAppleScript(buildVolumeScript(clamped));
  if (activeSession?.lastKnownState) {
    activeSession.lastKnownState.volume = clamped;
  }
}

function parseLocalizedNumber(raw: string, fallback = 0): number {
  if (!raw) return fallback;
  const normalized = raw.trim().replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : fallback;
}

export async function executeRemoteState(): Promise<RemoteState | null> {
  if (activeSession?.isStarting) {
    return activeSession.lastKnownState;
  }

  const sessionAtStart = activeSession;
  const callStart = Date.now();
  const out = await runAppleScript(buildStateScript());
  const execMs = Date.now() - callStart;

  // Discard stale state snapshot if a new remotePlay superseded the session in flight
  if (activeSession !== sessionAtStart) {
    return activeSession?.lastKnownState ?? null;
  }

  if (!out || out === "STOPPED") {
    if (
      activeSession &&
      !activeSession.hasObservedPlaying &&
      Date.now() - activeSession.lastCommandAt < 4000
    ) {
      return activeSession.lastKnownState;
    }
    activeSession = null;
    return null;
  }

  const parts = out.split("\t");
  const rawState = (parts[0] || "").trim();
  const posMs = Math.max(0, Math.round(parseLocalizedNumber(parts[1], 0)));
  const reportedDurMs = Math.max(0, Math.round(parseLocalizedNumber(parts[2], 0)));
  const volume = Math.max(0, Math.min(100, Math.round(parseLocalizedNumber(parts[3], 100))));
  const devPart = (parts[4] || "").trim();
  const deviceName = devPart || activeSession?.deviceName || translate("Mac (Apple Music)");
  const reportedName = (parts[5] || "").trim();

  const durationMs = reportedDurMs > 0 ? reportedDurMs : activeSession?.durationMs || 0;
  const playing = rawState === "playing";

  // Compensate for osascript execution delay + CoreAudio buffer delay so lyrics sync on-beat
  const latencyLead = playing && posMs > 0 && execMs > 5 ? Math.min(300, Math.round(execMs * 0.8) + 120) : 0;
  const effectivePosMs = playing && posMs > 0
    ? (durationMs > 0 ? Math.min(posMs + latencyLead, durationMs) : posMs + latencyLead)
    : posMs;

  if (activeSession) {
    if (playing) {
      activeSession.hasObservedPlaying = true;
    }

    const settled = Date.now() - activeSession.lastCommandAt > 2000;

    if (
      reportedName &&
      activeSession.initialReportedName === undefined &&
      (!settled || posMs < 15000)
    ) {
      activeSession.initialReportedName = reportedName;
    }

    const isRadio = Boolean(activeSession.trackId && String(activeSession.trackId).startsWith("ra."));

    // Detect if Music.app finished our track and auto-advanced to a subsequent album/autoplay song:
    // Case 1: Reported track title changed after settling (when library metadata is readable)
    const matchesRequested =
      Boolean(activeSession.name) &&
      reportedName.toLowerCase() === activeSession.name.toLowerCase();
    const matchesInitial =
      Boolean(activeSession.initialReportedName) &&
      reportedName.toLowerCase() === activeSession.initialReportedName!.toLowerCase();

    if (
      !isRadio &&
      settled &&
      reportedName &&
      !matchesRequested &&
      !matchesInitial &&
      activeSession.maxPositionMs > 5000
    ) {
      try {
        await runAppleScript(buildPauseScript());
      } catch {}
      activeSession = null;
      return null;
    }

    // Case 2: Catalog stream (-1728 hides reportedName) reached end zone and position wrapped back near 0
    if (
      !isRadio &&
      settled &&
      durationMs > 10000 &&
      activeSession.maxPositionMs >= durationMs - 4000 &&
      posMs < 3000
    ) {
      try {
        await runAppleScript(buildPauseScript());
      } catch {}
      activeSession = null;
      return null;
    }

    if (posMs > activeSession.maxPositionMs) {
      activeSession.maxPositionMs = posMs;
    }

    const st: RemoteState = {
      playing,
      trackId: activeSession.trackId,
      position: effectivePosMs,
      duration: durationMs,
      volume,
      device: deviceName,
    };
    activeSession.lastKnownState = st;
    return st;
  }

  return {
    playing,
    trackId: "",
    position: effectivePosMs,
    duration: durationMs,
    volume,
    device: deviceName,
  };
}

export async function executeRemoteDevices(): Promise<Device[]> {
  const fallback: Device = {
    id: "computer",
    name: translate("Mac (Apple Music)"),
    active: true,
  };
  try {
    const out = await runAppleScript(buildDevicesScript());
    if (!out) return [fallback];
    const devices: Device[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [id, name, sel] = line.split("\t");
      if (!id || !name) continue;
      devices.push({
        id: id.trim(),
        name: name.trim(),
        active: sel?.trim() === "1",
      });
    }
    return devices.length > 0 ? devices : [fallback];
  } catch (err: any) {
    if (err && (err.code === "setup" || err.code === "unsupported")) {
      throw err;
    }
    return [fallback];
  }
}

export async function executeRemoteUse(deviceId: string): Promise<void> {
  if (!deviceId || deviceId === "computer") return;
  await runAppleScript(buildSelectDeviceScript(deviceId));
  if (activeSession) {
    activeSession.deviceName = deviceId;
    if (activeSession.lastKnownState) {
      activeSession.lastKnownState.device = deviceId;
    }
  }
}

// ============================================================================
// TTML Word-by-Word Syllable & Line Lyrics Parser
// ============================================================================

export function parseTtmlTimestamp(raw?: string): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;

  if (s.endsWith("ms")) {
    const ms = parseFloat(s.slice(0, -2));
    return Number.isFinite(ms) ? Math.round(ms) : undefined;
  }
  if (s.endsWith("s")) {
    const sec = parseFloat(s.slice(0, -1));
    return Number.isFinite(sec) ? Math.round(sec * 1000) : undefined;
  }

  const parts = s.split(":");
  if (parts.length === 3) {
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const sec = parseFloat(parts[2]);
    if ([h, m, sec].every(Number.isFinite)) {
      return Math.round((h * 3600 + m * 60 + sec) * 1000);
    }
  } else if (parts.length === 2) {
    const m = parseFloat(parts[0]);
    const sec = parseFloat(parts[1]);
    if ([m, sec].every(Number.isFinite)) {
      return Math.round((m * 60 + sec) * 1000);
    }
  } else {
    const sec = parseFloat(s);
    if (Number.isFinite(sec)) {
      return Math.round(sec * 1000);
    }
  }
  return undefined;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripXmlTags(str: string): string {
  return decodeXmlEntities(str.replace(/<[^>]+>/g, ""));
}

export function parseAppleTTML(ttml: string): Lyrics {
  if (!ttml || typeof ttml !== "string") return {};

  // Extract optional <itunes:translations> mapped by itunes:key="L1"
  const keyTranslations = new Map<string, string>();
  const transBlockRegex = /<translation\b[^>]*>([\s\S]*?)<\/translation>/gi;
  let tbMatch: RegExpExecArray | null;
  while ((tbMatch = transBlockRegex.exec(ttml)) !== null) {
    const block = tbMatch[1];
    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = textRegex.exec(block)) !== null) {
      const attrs = tm[1];
      const body = stripXmlTags(tm[2]).trim();
      const forMatch = attrs.match(/(?:itunes:)?for="([^"]+)"/i);
      if (forMatch && body) {
        keyTranslations.set(forMatch[1], body);
      }
    }
  }

  const lines: LyricLine[] = [];
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let pMatch: RegExpExecArray | null;

  while ((pMatch = pRegex.exec(ttml)) !== null) {
    const pAttrs = pMatch[1];
    let pInner = pMatch[2];

    const beginMatch = pAttrs.match(/\bbegin="([^"]+)"/i);
    const endMatch = pAttrs.match(/\bend="([^"]+)"/i);
    const keyMatch = pAttrs.match(/\bitunes:key="([^"]+)"/i);

    const pStart = parseTtmlTimestamp(beginMatch?.[1]);
    if (pStart === undefined) continue;
    const pEnd = parseTtmlTimestamp(endMatch?.[1]);

    // Extract inline translation spans (<span ttm:role="x-translation">...</span>) and remove from main lyric body
    let inlineTranslation = "";
    pInner = pInner.replace(
      /<span\b[^>]*ttm:role="x-translation"[^>]*>([\s\S]*?)<\/span>/gi,
      (_, transText) => {
        const clean = stripXmlTags(transText).trim();
        if (clean) inlineTranslation = clean;
        return "";
      }
    );

    const translation =
      inlineTranslation || (keyMatch ? keyTranslations.get(keyMatch[1]) : undefined);

    // Extract timed word spans (<span begin="..." end="...">word</span>) along with any trailing whitespace
    const words: LyricWord[] = [];
    const spanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>(\s*)/gi;
    let sMatch: RegExpExecArray | null;

    while ((sMatch = spanRegex.exec(pInner)) !== null) {
      const sAttrs = sMatch[1];
      const sBody = sMatch[2];
      const trailingSpace = sMatch[3] ? " " : "";
      if (/ttm:role="x-bg"/i.test(sAttrs)) {
        // Background vocal container: parse nested spans if timed, or include text
        let innerMatch: RegExpExecArray | null;
        const innerSpanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>(\s*)/gi;
        while ((innerMatch = innerSpanRegex.exec(sBody)) !== null) {
          const wStart = parseTtmlTimestamp(innerMatch[1].match(/\bbegin="([^"]+)"/i)?.[1]);
          const wEnd = parseTtmlTimestamp(innerMatch[1].match(/\bend="([^"]+)"/i)?.[1]);
          const wText = stripXmlTags(innerMatch[2]) + (innerMatch[3] ? " " : "");
          if (wStart !== undefined && wEnd !== undefined && wText) {
            words.push({ start: wStart, end: wEnd, text: wText });
          }
        }
        continue;
      }

      const wStart = parseTtmlTimestamp(sAttrs.match(/\bbegin="([^"]+)"/i)?.[1]);
      const wEnd = parseTtmlTimestamp(sAttrs.match(/\bend="([^"]+)"/i)?.[1]);
      const wText = stripXmlTags(sBody) + trailingSpace;
      if (wStart !== undefined && wEnd !== undefined && wText) {
        words.push({ start: wStart, end: wEnd, text: wText });
      }
    }

    if (words.length > 0) {
      words[words.length - 1].text = words[words.length - 1].text.trimEnd();
    }

    const plainText = stripXmlTags(pInner).replace(/\s+/g, " ").trim();
    if (!plainText && words.length === 0) continue;

    const line: LyricLine = {
      start: pStart,
      ...(pEnd !== undefined ? { end: pEnd } : {}),
      ...(plainText ? { text: plainText } : {}),
      ...(translation ? { translation } : {}),
      ...(words.length > 0 ? { words } : {}),
    };
    lines.push(line);
  }

  if (lines.length === 0) return {};
  lines.sort((a, b) => a.start - b.start);
  return { lines };
}
