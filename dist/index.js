// src/types.ts
function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// src/apple_music_remote.ts
var activeSession = null;
var lastSyncedAudioQuality = null;
function resetRemoteSession() {
  activeSession = null;
  lastSyncedAudioQuality = null;
}
function parseAudioQualitySetting(raw) {
  if (!raw || typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === "hires" || v === "hi-res" || v === "hi-res lossless" || v === "hires-lossless" || v === "30" || v === "192" || v === "192khz" || v === "\u9AD8\u89E3\u6790" || v === "\u9AD8\u89E3\u6790\u5EA6" || v === "\u9AD8\u89E3\u6790\u5EA6\u65E0\u635F") {
    return "hires";
  }
  if (v === "lossless" || v === "alac" || v === "20" || v === "48" || v === "48khz" || v === "\u65E0\u635F" || v === "\u65E0\u635F\u97F3\u9891") {
    return "lossless";
  }
  if (v === "high" || v === "aac" || v === "standard" || v === "256" || v === "256kbps" || v === "10" || v === "\u9AD8\u8D28\u91CF" || v === "\u6807\u51C6") {
    return "high";
  }
  return null;
}
function escapeAppleScriptString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]+/g, " ").trim();
}
function toMusicAppUrl(rawUrl, sf, songId, albumId) {
  const cleanId = String(songId || "").trim();
  const cleanSf = (sf || "us").trim().toLowerCase();
  if (rawUrl && typeof rawUrl === "string") {
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith("music://") || trimmed.startsWith("musics://") || trimmed.startsWith("itmss://")) {
      return trimmed;
    }
    if (trimmed.startsWith("https://music.apple.com/") || trimmed.startsWith("http://music.apple.com/")) {
      return trimmed.replace(/^https?:\/\//i, "music://");
    }
  }
  if (!cleanId) return "";
  if (albumId && /^\d+$/.test(albumId)) {
    return `music://music.apple.com/${cleanSf}/album/_/${albumId}?i=${encodeURIComponent(cleanId)}`;
  }
  return `music://music.apple.com/${cleanSf}/song/_/${encodeURIComponent(cleanId)}`;
}
function buildPlayScript(params) {
  const safeName = escapeAppleScriptString(params.name);
  const safeArtist = escapeAppleScriptString(params.artistName);
  const safeUrl = escapeAppleScriptString(params.musicUrl);
  const posSec = Math.max(0, Number.isFinite(params.positionSec) ? params.positionSec : 0);
  return `
set targetName to "${safeName}"
set targetArtist to "${safeArtist}"
set targetURL to "${safeUrl}"
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
      end ignoring
      if (count of matchedTracks) > 0 then
        play (item 1 of matchedTracks)
        set playedFromLib to true
      end if
    end try
  end if

  if playedFromLib is false then
    if targetURL is "" then
      error "MISSING_CATALOG_URL"
    end if
    open location targetURL
    repeat 10 times
      delay 0.35
      try
        if player state is playing then exit repeat
        play
        if player state is playing then exit repeat
      end try
    end repeat
    try
      if player state is not playing then play
    end try
  end if

  if startPos > 0 then
    try
      set player position to startPos
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
function buildPauseScript() {
  return `
if application "Music" is running then
  tell application "Music"
    pause
  end tell
end if
return "OK"
`.trim();
}
function buildResumeScript() {
  return `
tell application "Music"
  play
end tell
return "OK"
`.trim();
}
function buildSeekScript(positionSec) {
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
function buildVolumeScript(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 100)));
  return `
tell application "Music"
  set sound volume to ${clamped}
end tell
return "OK"
`.trim();
}
function buildStateScript() {
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

  set devName to ""
  try
    set selDevs to (every AirPlay device whose selected is true)
    if (count of selDevs) > 0 then
      set devName to name of item 1 of selDevs
    end if
  end try

  return pState & tab & (posMs as string) & tab & (durMs as string) & tab & (pVol as string) & tab & devName & tab & tName & tab & tArtist
end tell
`.trim();
}
function buildDevicesScript() {
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
function buildSelectDeviceScript(deviceId) {
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
function translate(text) {
  return typeof host !== "undefined" && typeof host.t === "function" ? host.t(text) : text;
}
function formatAudioQualityLabel(mode) {
  if (mode === "hires") {
    return translate("Hi-Res Lossless (24-bit/192 kHz)");
  }
  if (mode === "lossless") {
    return translate("Lossless (24-bit/48 kHz)");
  }
  return translate("High Quality (AAC 256 kbps)");
}
function buildReadAudioQualityScript() {
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
function buildWriteAudioQualityScript(mode) {
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
async function readMusicAppAudioQuality() {
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
async function syncMusicAppAudioQuality(mode, options) {
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
      positionMs: resumePosMs
    });
  }
  return out.startsWith("UPDATED:");
}
async function runAppleScript(script) {
  if (typeof host === "undefined" || typeof host.spawn !== "function") {
    throw fail("unsupported", translate("Remote Apple Music playback requires macOS Music.app"));
  }
  if (host.platform && host.platform !== "darwin") {
    throw fail("unsupported", translate("Remote Apple Music playback requires macOS Music.app"));
  }
  let proc;
  const candidates = ["/usr/bin/osascript", "osascript"];
  let lastSpawnErr = null;
  for (const bin of candidates) {
    try {
      proc = host.spawn(bin, ["-"]);
      break;
    } catch (err) {
      lastSpawnErr = err;
      const msg = String(err?.message || err || "");
      if (msg.includes("hasn't allowed") || msg.includes("process permission") || msg.includes("start programs")) {
        throw fail(
          "setup",
          translate("Allow Apple Music plugin to start programs in Settings > Plugins")
        );
      }
    }
  }
  if (!proc) {
    const msg = String(lastSpawnErr?.message || lastSpawnErr || "");
    if (msg.includes("hasn't allowed") || msg.includes("process permission") || msg.includes("start programs")) {
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
  } catch (err) {
    try {
      proc.kill();
    } catch {
    }
    throw fail("unavailable", translate("Failed to control macOS Music.app"));
  }
  const lines = [];
  while (true) {
    const line = await proc.readLine();
    if (line === null || line === void 0) break;
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
async function executeRemotePlay(params) {
  const { meta, storefront, positionMs } = params;
  if (typeof host !== "undefined" && typeof host.setting === "function") {
    const desiredQuality = parseAudioQualitySetting(host.setting("audioQuality"));
    if (desiredQuality && lastSyncedAudioQuality !== desiredQuality) {
      try {
        await syncMusicAppAudioQuality(desiredQuality, { skipResume: true });
      } catch (err) {
        if (err?.code === "setup") throw err;
      }
    }
  }
  const songIdForUrl = meta.catalogId || meta.id;
  const musicUrl = toMusicAppUrl(meta.url, storefront, songIdForUrl, meta.albumId);
  const posSec = Math.max(0, (positionMs || 0) / 1e3);
  activeSession = {
    meta,
    storefront,
    trackId: meta.id,
    catalogId: meta.catalogId,
    name: meta.name,
    artistName: meta.artistName,
    durationMs: meta.durationMs || 0,
    startedAt: Date.now(),
    lastCommandAt: Date.now(),
    maxPositionMs: Math.max(0, positionMs || 0),
    lastKnownState: {
      playing: true,
      trackId: meta.id,
      position: Math.max(0, positionMs || 0),
      duration: meta.durationMs || 0,
      volume: 100,
      device: translate("Mac (Apple Music)")
    }
  };
  const script = buildPlayScript({
    name: meta.name,
    artistName: meta.artistName,
    musicUrl,
    positionSec: posSec
  });
  await runAppleScript(script);
  if (activeSession && activeSession.trackId === meta.id) {
    activeSession.lastCommandAt = Date.now();
  }
}
async function executeRemotePause() {
  await runAppleScript(buildPauseScript());
  if (activeSession) {
    activeSession.lastCommandAt = Date.now();
    if (activeSession.lastKnownState) {
      activeSession.lastKnownState.playing = false;
    }
  }
}
async function executeRemoteResume() {
  await runAppleScript(buildResumeScript());
  if (activeSession) {
    activeSession.lastCommandAt = Date.now();
    if (activeSession.lastKnownState) {
      activeSession.lastKnownState.playing = true;
    }
  }
}
async function executeRemoteSeek(positionMs) {
  const clampedMs = Math.max(0, Number(positionMs) || 0);
  await runAppleScript(buildSeekScript(clampedMs / 1e3));
  if (activeSession) {
    activeSession.lastCommandAt = Date.now();
    activeSession.maxPositionMs = clampedMs;
    if (activeSession.lastKnownState) {
      activeSession.lastKnownState.position = clampedMs;
    }
  }
}
async function executeRemoteVolume(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  await runAppleScript(buildVolumeScript(clamped));
  if (activeSession?.lastKnownState) {
    activeSession.lastKnownState.volume = clamped;
  }
}
function parseLocalizedNumber(raw, fallback = 0) {
  if (!raw) return fallback;
  const normalized = raw.trim().replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : fallback;
}
async function executeRemoteState() {
  const out = await runAppleScript(buildStateScript());
  if (!out || out === "STOPPED") {
    activeSession = null;
    return null;
  }
  const parts = out.split("	");
  const rawState = (parts[0] || "").trim();
  const posMs = Math.max(0, Math.round(parseLocalizedNumber(parts[1], 0)));
  const reportedDurMs = Math.max(0, Math.round(parseLocalizedNumber(parts[2], 0)));
  const volume = Math.max(0, Math.min(100, Math.round(parseLocalizedNumber(parts[3], 100))));
  const deviceName = (parts[4] || "").trim() || translate("Mac (Apple Music)");
  const reportedName = (parts[5] || "").trim();
  const durationMs = reportedDurMs > 0 ? reportedDurMs : activeSession?.durationMs || 0;
  const playing = rawState === "playing";
  if (activeSession) {
    const settled = Date.now() - activeSession.lastCommandAt > 2e3;
    if (settled && reportedName && activeSession.name && reportedName.toLowerCase() !== activeSession.name.toLowerCase() && activeSession.maxPositionMs > 5e3) {
      try {
        await runAppleScript(buildPauseScript());
      } catch {
      }
      activeSession = null;
      return null;
    }
    if (settled && durationMs > 1e4 && activeSession.maxPositionMs >= durationMs - 4e3 && posMs < 3e3) {
      try {
        await runAppleScript(buildPauseScript());
      } catch {
      }
      activeSession = null;
      return null;
    }
    if (posMs > activeSession.maxPositionMs) {
      activeSession.maxPositionMs = posMs;
    }
    const st = {
      playing,
      trackId: activeSession.trackId,
      position: durationMs > 0 ? Math.min(posMs, durationMs) : posMs,
      duration: durationMs,
      volume,
      device: deviceName
    };
    activeSession.lastKnownState = st;
    return st;
  }
  return {
    playing,
    trackId: "",
    position: posMs,
    duration: durationMs,
    volume,
    device: deviceName
  };
}
async function executeRemoteDevices() {
  const fallback = {
    id: "computer",
    name: translate("Mac (Apple Music)"),
    active: true
  };
  try {
    const out = await runAppleScript(buildDevicesScript());
    if (!out) return [fallback];
    const devices = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [id, name, sel] = line.split("	");
      if (!id || !name) continue;
      devices.push({
        id: id.trim(),
        name: name.trim(),
        active: sel?.trim() === "1"
      });
    }
    return devices.length > 0 ? devices : [fallback];
  } catch (err) {
    if (err && (err.code === "setup" || err.code === "unsupported")) {
      throw err;
    }
    return [fallback];
  }
}
async function executeRemoteUse(deviceId) {
  if (!deviceId || deviceId === "computer") return;
  await runAppleScript(buildSelectDeviceScript(deviceId));
}
function parseTtmlTimestamp(raw) {
  if (!raw) return void 0;
  const s = raw.trim();
  if (!s) return void 0;
  if (s.endsWith("ms")) {
    const ms = parseFloat(s.slice(0, -2));
    return Number.isFinite(ms) ? Math.round(ms) : void 0;
  }
  if (s.endsWith("s")) {
    const sec = parseFloat(s.slice(0, -1));
    return Number.isFinite(sec) ? Math.round(sec * 1e3) : void 0;
  }
  const parts = s.split(":");
  if (parts.length === 3) {
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const sec = parseFloat(parts[2]);
    if ([h, m, sec].every(Number.isFinite)) {
      return Math.round((h * 3600 + m * 60 + sec) * 1e3);
    }
  } else if (parts.length === 2) {
    const m = parseFloat(parts[0]);
    const sec = parseFloat(parts[1]);
    if ([m, sec].every(Number.isFinite)) {
      return Math.round((m * 60 + sec) * 1e3);
    }
  } else {
    const sec = parseFloat(s);
    if (Number.isFinite(sec)) {
      return Math.round(sec * 1e3);
    }
  }
  return void 0;
}
function decodeXmlEntities(str) {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}
function stripXmlTags(str) {
  return decodeXmlEntities(str.replace(/<[^>]+>/g, ""));
}
function parseAppleTTML(ttml) {
  if (!ttml || typeof ttml !== "string") return {};
  const keyTranslations = /* @__PURE__ */ new Map();
  const transBlockRegex = /<translation\b[^>]*>([\s\S]*?)<\/translation>/gi;
  let tbMatch;
  while ((tbMatch = transBlockRegex.exec(ttml)) !== null) {
    const block = tbMatch[1];
    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let tm;
    while ((tm = textRegex.exec(block)) !== null) {
      const attrs = tm[1];
      const body = stripXmlTags(tm[2]).trim();
      const forMatch = attrs.match(/(?:itunes:)?for="([^"]+)"/i);
      if (forMatch && body) {
        keyTranslations.set(forMatch[1], body);
      }
    }
  }
  const lines = [];
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(ttml)) !== null) {
    const pAttrs = pMatch[1];
    let pInner = pMatch[2];
    const beginMatch = pAttrs.match(/\bbegin="([^"]+)"/i);
    const endMatch = pAttrs.match(/\bend="([^"]+)"/i);
    const keyMatch = pAttrs.match(/\bitunes:key="([^"]+)"/i);
    const pStart = parseTtmlTimestamp(beginMatch?.[1]);
    if (pStart === void 0) continue;
    const pEnd = parseTtmlTimestamp(endMatch?.[1]);
    let inlineTranslation = "";
    pInner = pInner.replace(
      /<span\b[^>]*ttm:role="x-translation"[^>]*>([\s\S]*?)<\/span>/gi,
      (_, transText) => {
        const clean = stripXmlTags(transText).trim();
        if (clean) inlineTranslation = clean;
        return "";
      }
    );
    const translation = inlineTranslation || (keyMatch ? keyTranslations.get(keyMatch[1]) : void 0);
    const words = [];
    const spanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>(\s*)/gi;
    let sMatch;
    while ((sMatch = spanRegex.exec(pInner)) !== null) {
      const sAttrs = sMatch[1];
      const sBody = sMatch[2];
      const trailingSpace = sMatch[3] ? " " : "";
      if (/ttm:role="x-bg"/i.test(sAttrs)) {
        let innerMatch;
        const innerSpanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>(\s*)/gi;
        while ((innerMatch = innerSpanRegex.exec(sBody)) !== null) {
          const wStart2 = parseTtmlTimestamp(innerMatch[1].match(/\bbegin="([^"]+)"/i)?.[1]);
          const wEnd2 = parseTtmlTimestamp(innerMatch[1].match(/\bend="([^"]+)"/i)?.[1]);
          const wText2 = stripXmlTags(innerMatch[2]) + (innerMatch[3] ? " " : "");
          if (wStart2 !== void 0 && wEnd2 !== void 0 && wText2) {
            words.push({ start: wStart2, end: wEnd2, text: wText2 });
          }
        }
        continue;
      }
      const wStart = parseTtmlTimestamp(sAttrs.match(/\bbegin="([^"]+)"/i)?.[1]);
      const wEnd = parseTtmlTimestamp(sAttrs.match(/\bend="([^"]+)"/i)?.[1]);
      const wText = stripXmlTags(sBody) + trailingSpace;
      if (wStart !== void 0 && wEnd !== void 0 && wText) {
        words.push({ start: wStart, end: wEnd, text: wText });
      }
    }
    if (words.length > 0) {
      words[words.length - 1].text = words[words.length - 1].text.trimEnd();
    }
    const plainText = stripXmlTags(pInner).replace(/\s+/g, " ").trim();
    if (!plainText && words.length === 0) continue;
    const line = {
      start: pStart,
      ...pEnd !== void 0 ? { end: pEnd } : {},
      ...plainText ? { text: plainText } : {},
      ...translation ? { translation } : {},
      ...words.length > 0 ? { words } : {}
    };
    lines.push(line);
  }
  if (lines.length === 0) return {};
  lines.sort((a, b) => a.start - b.start);
  return { lines };
}

// src/index.ts
var DEFAULT_DEV_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw";
var AMP_API_BASE = "https://amp-api.music.apple.com/v1";
var TRACK_CACHE_LIMIT = 2e3;
var trackMetaCache = /* @__PURE__ */ new Map();
var PLUGIN_ERROR_CODES = /* @__PURE__ */ new Set(["signIn", "setup", "unavailable", "unsupported"]);
function isPluginError(err) {
  return Boolean(err && typeof err.code === "string" && PLUGIN_ERROR_CODES.has(err.code));
}
function rememberTrackMeta(meta) {
  if (!meta.id) return;
  if (trackMetaCache.size >= TRACK_CACHE_LIMIT && !trackMetaCache.has(meta.id)) {
    const oldest = trackMetaCache.keys().next().value;
    if (oldest !== void 0) trackMetaCache.delete(oldest);
  }
  trackMetaCache.set(meta.id, meta);
  if (meta.catalogId && meta.catalogId !== meta.id) {
    trackMetaCache.set(meta.catalogId, meta);
  }
}
function tr(text) {
  return typeof host !== "undefined" && typeof host.t === "function" ? host.t(text) : text;
}
function parseJwtExp(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const jsonStr = typeof atob === "function" ? atob(b64) : typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("utf-8") : "";
    if (!jsonStr) return null;
    const payload = JSON.parse(jsonStr);
    return typeof payload.exp === "number" ? payload.exp * 1e3 : null;
  } catch {
    return null;
  }
}
function extractCookieMediaUserToken(cookie) {
  if (!cookie || typeof cookie !== "string") return "";
  const match = cookie.match(/(?:^|;\s*)media-user-token=([^;]+)/);
  if (!match || !match[1]) return "";
  return match[1].trim().replace(/^"|"$/g, "").trim();
}
function cleanMediaUserToken(raw) {
  if (!raw || typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";
  if (s.includes("media-user-token=") || s.includes(";")) {
    return extractCookieMediaUserToken(s);
  }
  return s.replace(/^"|"$/g, "").trim();
}
async function getStoredMediaUserToken() {
  if (typeof host !== "undefined") {
    if (typeof host.setting === "function") {
      const fromSetting = cleanMediaUserToken(host.setting("mediaUserToken"));
      if (fromSetting) return fromSetting;
    }
    if (host.storage) {
      try {
        const auth = await host.storage.get("auth");
        const fromStorage = cleanMediaUserToken(auth?.mediaUserToken);
        if (fromStorage) return fromStorage;
      } catch {
      }
    }
  }
  return "";
}
function formatArtworkUrl(url, size = 600, crop = "bb") {
  if (!url) return void 0;
  return url.replace("{w}x{h}", `${size}x${size}`).replace("{w}", String(size)).replace("{h}", String(size)).replace("{c}", crop).replace("-{q}", "").replace("{q}", "80").replace("{f}", "jpg");
}
function extractAlbumIdFromUrl(url) {
  if (!url || typeof url !== "string") return void 0;
  const m = url.match(/\/album\/[^/?#]+\/(\d+)/);
  return m?.[1];
}
function mapTrack(item) {
  const attr = item?.attributes || {};
  const id = String(item?.id ?? "");
  const catalogId = attr.playParams?.catalogId || item?.relationships?.catalog?.data?.[0]?.id || (/^\d+$/.test(id) ? id : void 0);
  const albumId = item?.relationships?.albums?.data?.[0]?.id || extractAlbumIdFromUrl(attr.url) || attr.albumName || "";
  const artistId = item?.relationships?.artists?.data?.[0]?.id || attr.artistName || "";
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  const durationMs = Math.max(0, Math.round(Number(attr.durationInMillis) || 0));
  if (id && attr.name) {
    rememberTrackMeta({
      id,
      catalogId,
      name: String(attr.name),
      artistName: String(attr.artistName || ""),
      albumName: String(attr.albumName || ""),
      albumId: String(albumId || ""),
      durationMs,
      url: attr.url,
      isrc: attr.isrc
    });
  }
  return {
    id,
    name: attr.name,
    title: attr.name,
    artist: attr.artistName,
    artists: [{ id: String(artistId), name: attr.artistName }],
    album: {
      id: String(albumId),
      name: attr.albumName,
      title: attr.albumName,
      imageUrl
    },
    artwork: imageUrl,
    imageUrl,
    duration: durationMs,
    durationInMillis: durationMs,
    trackNumber: attr.trackNumber,
    discNumber: attr.discNumber,
    isrc: attr.isrc,
    explicit: attr.contentRating === "explicit",
    url: attr.url || void 0
  };
}
function mapAlbum(item) {
  const attr = item?.attributes || {};
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  const artistId = item?.relationships?.artists?.data?.[0]?.id || attr.artistName || "";
  return {
    id: String(item?.id ?? ""),
    name: attr.name,
    title: attr.name,
    artist: attr.artistName,
    artists: attr.artistName ? [{ id: String(artistId), name: attr.artistName }] : [],
    artwork: imageUrl,
    imageUrl,
    trackCount: attr.trackCount,
    year: attr.releaseDate ? parseInt(attr.releaseDate.split("-")[0], 10) : void 0,
    released: attr.releaseDate,
    description: attr.editorialNotes?.short || attr.editorialNotes?.standard,
    url: attr.url
  };
}
function mapArtist(item) {
  const attr = item?.attributes || {};
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  return {
    id: String(item?.id ?? ""),
    name: attr.name,
    artwork: imageUrl,
    imageUrl,
    url: attr.url
  };
}
function mapPlaylist(item) {
  const attr = item?.attributes || {};
  const id = String(item?.id ?? "");
  const isLibrary = id.startsWith("p.") || item?.type === "library-playlists";
  const imageUrl = formatArtworkUrl(attr.artwork?.url, 600);
  return {
    id,
    name: attr.name,
    title: attr.name,
    artwork: imageUrl,
    imageUrl,
    description: attr.description?.short || attr.description?.standard || attr.editorialNotes?.short || attr.editorialNotes?.standard,
    owner: attr.curatorName,
    curator: attr.curatorName,
    trackCount: attr.trackCount,
    mine: isLibrary ? Boolean(attr.canEdit ?? true) : false,
    saved: isLibrary ? !Boolean(attr.canEdit ?? true) : void 0,
    url: attr.url
  };
}
async function getDeveloperToken() {
  if (typeof host !== "undefined" && host.storage) {
    try {
      const cached = await host.storage.get("developer_token");
      const cachedExp = await host.storage.get("developer_token_exp");
      if (cached && cachedExp && Date.now() < cachedExp - 864e5) {
        return cached;
      }
    } catch (_) {
    }
  }
  try {
    const htmlRes = await fetch("https://music.apple.com/us/browse", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
      }
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const scriptMatch = html.match(/src="(\/assets\/index[~-][a-zA-Z0-9_-]+\.js)"/);
      if (scriptMatch) {
        const jsUrl = `https://music.apple.com${scriptMatch[1]}`;
        const jsRes = await fetch(jsUrl);
        if (jsRes.ok) {
          const jsText = await jsRes.text();
          const tokenMatch = jsText.match(
            /eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/
          );
          if (tokenMatch) {
            const token = tokenMatch[0];
            const exp = parseJwtExp(token);
            if (typeof host !== "undefined" && host.storage) {
              try {
                await host.storage.set("developer_token", token);
                if (exp) {
                  await host.storage.set("developer_token_exp", exp);
                }
              } catch (_) {
              }
            }
            return token;
          }
        }
      }
    }
  } catch (_) {
  }
  return DEFAULT_DEV_TOKEN;
}
async function getStorefront() {
  if (typeof host !== "undefined") {
    if (host.setting) {
      const rawSetting = host.setting("storefront");
      const settingSf = typeof rawSetting === "string" ? rawSetting.trim().toLowerCase() : "";
      if (settingSf) {
        return settingSf;
      }
    }
    if (host.storage) {
      try {
        const auth = await host.storage.get("auth");
        if (auth && typeof auth.storefront === "string") {
          const authSf = auth.storefront.trim().toLowerCase();
          if (authSf) {
            return authSf;
          }
        }
      } catch (_) {
      }
    }
    if (host.language && host.language() === "zh-CN") {
      return "cn";
    }
  }
  return "us";
}
async function requestApi(endpoint, options = {}) {
  const { requireAuth = false, ...fetchOpts } = options;
  const mediaUserToken = await getStoredMediaUserToken();
  if (requireAuth && !mediaUserToken) {
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }
  const devToken = await getDeveloperToken();
  const headers = {
    Authorization: `Bearer ${devToken}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    Accept: "application/json",
    ...fetchOpts.headers || {}
  };
  if (mediaUserToken) {
    headers["Music-User-Token"] = mediaUserToken;
  }
  const url = endpoint.startsWith("http") ? endpoint : `${AMP_API_BASE}${endpoint}`;
  let res;
  try {
    res = await fetch(url, { ...fetchOpts, headers });
  } catch (err) {
    if (isPluginError(err)) {
      throw err;
    }
    throw fail("unavailable", tr("Network request failed"));
  }
  if (res.status === 401) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        await host.storage.remove("developer_token");
        await host.storage.remove("developer_token_exp");
      } catch (_) {
      }
    }
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }
  if (res.status === 403) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        await host.storage.remove("auth");
      } catch (_) {
      }
    }
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }
  if (res.status === 404) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const detail = errBody.errors?.[0]?.detail || res.statusText;
    throw fail("unavailable", detail);
  }
  if (res.status === 204 || res.status === 202) {
    const text = await res.text().catch(() => "");
    return text ? JSON.parse(text) : {};
  }
  return res.json();
}
async function resolveTrackMeta(id) {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  const cached = trackMetaCache.get(cleanId);
  if (cached && cached.name) {
    return cached;
  }
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  if (cleanId.startsWith("i.")) {
    const json2 = await requestApi(`/me/library/songs/${encodeURIComponent(cleanId)}?l=${lang}`, {
      requireAuth: true
    });
    const song2 = json2.data?.[0];
    if (!song2) {
      throw fail("unavailable", tr("This track is unavailable for streaming"));
    }
    mapTrack(song2);
    const resolved2 = trackMetaCache.get(cleanId);
    if (resolved2) return resolved2;
  }
  const json = await requestApi(`/catalog/${sf}/songs/${encodeURIComponent(cleanId)}?l=${lang}`);
  const song = json.data?.[0];
  if (!song) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  mapTrack(song);
  const resolved = trackMetaCache.get(cleanId);
  if (!resolved) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  return resolved;
}
async function search(options) {
  const {
    query: rawQuery,
    kind = "tracks",
    offset = 0,
    limit: rawLimit
  } = options || {};
  const query = typeof rawQuery === "string" ? rawQuery.trim() : rawQuery != null ? String(rawQuery).trim() : "";
  if (!query) {
    return { [kind]: [], more: false };
  }
  const sf = await getStorefront();
  const typeMap = {
    tracks: "songs",
    albums: "albums",
    artists: "artists",
    playlists: "playlists"
  };
  const appleType = typeMap[kind] || "songs";
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  let limit = 20;
  if (rawLimit !== void 0 && rawLimit !== null) {
    const parsedLimit = Number(rawLimit);
    if (!Number.isNaN(parsedLimit)) {
      limit = Math.min(Math.max(Math.floor(parsedLimit), 1), 50);
    }
  }
  const url = `/catalog/${sf}/search?term=${encodeURIComponent(
    query
  )}&types=${appleType}&limit=${limit}&offset=${offset}&l=${lang}`;
  const json = await requestApi(url);
  const resultContainer = json.results?.[appleType];
  const items = resultContainer?.data || [];
  const hasMore = Boolean(resultContainer?.next);
  let mappedItems = [];
  if (kind === "albums") {
    mappedItems = items.map(mapAlbum);
  } else if (kind === "artists") {
    mappedItems = items.map(mapArtist);
  } else if (kind === "playlists") {
    mappedItems = items.map(mapPlaylist);
  } else {
    mappedItems = items.map(mapTrack);
  }
  return {
    [kind]: mappedItems,
    more: hasMore
  };
}
async function suggest(options) {
  const { query: rawQuery } = options || {};
  const query = typeof rawQuery === "string" ? rawQuery.trim() : rawQuery != null ? String(rawQuery).trim() : "";
  if (!query) {
    return [];
  }
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const url = `/catalog/${sf}/search/hints?term=${encodeURIComponent(query)}&l=${lang}`;
  const json = await requestApi(url);
  return json.results?.terms || [];
}
function getLocalTimezoneOffset(date = /* @__PURE__ */ new Date()) {
  const offset = date.getTimezoneOffset();
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const sign = offset > 0 ? "-" : "+";
  return `${sign}${hh}:${mm}`;
}
function extractBestArtworkUrl(item, size = 600) {
  const attr = item?.attributes || {};
  if (attr.artwork?.url) {
    return formatArtworkUrl(attr.artwork.url, size);
  }
  const edArt = attr.editorialArtwork || {};
  for (const key of [
    "subscriptionHero",
    "superHeroWide",
    "superHeroTall",
    "storeFlowcase",
    "brandLogo"
  ]) {
    if (edArt[key]?.url) {
      return formatArtworkUrl(edArt[key].url, size);
    }
  }
  const cards = attr.plainEditorialCard;
  if (cards && typeof cards === "object") {
    const preferredKey = item?.meta?.editorialCard;
    const keys = preferredKey ? [preferredKey, ...Object.keys(cards)] : Object.keys(cards);
    for (const k of keys) {
      const cardArt = cards[k]?.editorialArtwork;
      if (cardArt?.superHeroTall?.url) {
        return formatArtworkUrl(cardArt.superHeroTall.url, size);
      }
      if (cardArt?.superHeroWide?.url) {
        return formatArtworkUrl(cardArt.superHeroWide.url, size);
      }
    }
  }
  return void 0;
}
function resolveResourceRef(ref, resourcesMap) {
  if (!ref) return null;
  if (resourcesMap && ref.type && ref.id != null) {
    const found = resourcesMap[ref.type]?.[String(ref.id)];
    if (found) {
      return ref.meta ? { ...found, meta: { ...found.meta || {}, ...ref.meta } } : found;
    }
  }
  return ref;
}
function parseEditorialLinkToPage(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  const fcMatch = urlStr.match(/[?&]fcId=(\d+)/i) || urlStr.match(/\/room\/[^/?#]+\/(\d+)/i);
  if (fcMatch?.[1]) return `room:${fcMatch[1]}`;
  const grpMatch = urlStr.match(/viewGrouping\?[^#]*\bid=(\d+)/i) || urlStr.match(/\/grouping\/(?:[^/?#]+\/)?(?:id)?(\d+)/i);
  if (grpMatch?.[1]) return `grouping:${grpMatch[1]}`;
  const curMatch = urlStr.match(/\/curator\/[^/?#]+\/(\d+)/i);
  if (curMatch?.[1]) return `apple-curator:${curMatch[1]}`;
  return null;
}
function createSectionBuckets() {
  return {
    tracks: [],
    albums: [],
    artists: [],
    playlists: [],
    stations: [],
    links: [],
    seen: /* @__PURE__ */ new Set()
  };
}
function collectResourceIntoBuckets(rawRef, buckets, resourcesMap, depth = 0) {
  if (!rawRef || depth > 3) return;
  const item = resolveResourceRef(rawRef, resourcesMap);
  if (!item) return;
  const type = String(item.type || rawRef.type || "");
  const id = String(item.id ?? rawRef.id ?? "");
  if (type === "personal-recommendation") {
    const children = item.relationships?.contents?.data || [];
    for (const child of children) {
      collectResourceIntoBuckets(child, buckets, resourcesMap, depth + 1);
    }
    return;
  }
  if (type === "editorial-elements") {
    const contents = item.relationships?.contents?.data || [];
    if (contents.length > 0) {
      for (const child of contents) {
        collectResourceIntoBuckets(child, buckets, resourcesMap, depth + 1);
      }
      return;
    }
    const attr = item.attributes || {};
    const linkPage = parseEditorialLinkToPage(attr.link?.url || attr.url);
    const title = attr.title || attr.name || attr.link?.label;
    if (linkPage && title && !buckets.seen.has(`link:${linkPage}`)) {
      buckets.seen.add(`link:${linkPage}`);
      buckets.links.push({
        title: String(title),
        subtitle: attr.subtitle || attr.designBadge || void 0,
        imageUrl: extractBestArtworkUrl(item, 600),
        page: linkPage
      });
    }
    return;
  }
  if (!id) return;
  const dedupeKey = `${type}:${id}`;
  if (buckets.seen.has(dedupeKey)) return;
  if (type === "albums") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const alb = mapAlbum(item);
    if (!alb.imageUrl) alb.imageUrl = extractBestArtworkUrl(item, 600);
    buckets.albums.push(alb);
    return;
  }
  if (type === "library-albums") {
    const catalogId = item.meta?.catalogIds?.[0] || item.attributes?.playParams?.catalogId || item.relationships?.catalog?.data?.[0]?.id;
    const catAlbum = catalogId && resourcesMap?.["albums"]?.[String(catalogId)] ? resourcesMap["albums"][String(catalogId)] : null;
    if (catAlbum?.attributes?.name) {
      const catKey = `albums:${catAlbum.id}`;
      if (buckets.seen.has(catKey)) return;
      buckets.seen.add(catKey);
      buckets.albums.push(mapAlbum(catAlbum));
      return;
    }
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const alb = mapAlbum(item);
    if (!alb.imageUrl && catAlbum) {
      alb.imageUrl = extractBestArtworkUrl(catAlbum, 600);
    }
    buckets.albums.push(alb);
    return;
  }
  if (type === "playlists") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const pl = mapPlaylist(item);
    if (!pl.imageUrl) pl.imageUrl = extractBestArtworkUrl(item, 600);
    buckets.playlists.push(pl);
    return;
  }
  if (type === "library-playlists") {
    const catalogId = item.meta?.catalogIds?.[0] || item.attributes?.playParams?.catalogId || item.relationships?.catalog?.data?.[0]?.id;
    const catPl = catalogId && resourcesMap?.["playlists"]?.[String(catalogId)] ? resourcesMap["playlists"][String(catalogId)] : null;
    if (!item.attributes?.name && catPl?.attributes?.name) {
      const catKey = `playlists:${catPl.id}`;
      if (buckets.seen.has(catKey)) return;
      buckets.seen.add(catKey);
      buckets.playlists.push(mapPlaylist(catPl));
      return;
    }
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const pl = mapPlaylist(item);
    if (!pl.imageUrl && catPl) {
      pl.imageUrl = extractBestArtworkUrl(catPl, 600);
    }
    if (!pl.owner && catPl?.attributes?.curatorName) {
      pl.owner = catPl.attributes.curatorName;
    }
    buckets.playlists.push(pl);
    return;
  }
  if (type === "artists") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    const art = mapArtist(item);
    if (!art.imageUrl) art.imageUrl = extractBestArtworkUrl(item, 600);
    buckets.artists.push(art);
    return;
  }
  if (type === "songs" || type === "library-songs") {
    if (!item.attributes?.name) return;
    buckets.seen.add(dedupeKey);
    buckets.tracks.push(mapTrack(item));
    return;
  }
  if (type === "stations") {
    const attr = item.attributes || {};
    if (!attr.name || attr.isLive === true) return;
    buckets.seen.add(dedupeKey);
    buckets.stations.push({
      id,
      name: String(attr.name),
      description: attr.editorialNotes?.short || attr.plainEditorialNotes?.short || attr.editorialNotes?.tagline || void 0,
      imageUrl: extractBestArtworkUrl(item, 600)
    });
    return;
  }
  if (type === "apple-curators" || type === "curators") {
    const attr = item.attributes || {};
    const name = attr.name || attr.plainEditorialNotes?.name;
    if (!name) return;
    const pageTarget = type === "apple-curators" ? `apple-curator:${id}` : `curator:${id}`;
    if (buckets.seen.has(`link:${pageTarget}`)) return;
    buckets.seen.add(`link:${pageTarget}`);
    buckets.links.push({
      title: String(name),
      subtitle: attr.plainEditorialNotes?.short || attr.editorialNotes?.short || void 0,
      imageUrl: extractBestArtworkUrl(item, 600),
      page: pageTarget
    });
    return;
  }
  if (type === "editorial-items" || type === "activities") {
    const attr = item.attributes || {};
    const name = attr.name || attr.plainEditorialNotes?.name || attr.plainEditorialNotes?.badge || attr.editorialNotes?.name;
    const linkPage = parseEditorialLinkToPage(attr.url || attr.link?.url);
    if (name && linkPage && !buckets.seen.has(`link:${linkPage}`)) {
      buckets.seen.add(`link:${linkPage}`);
      buckets.links.push({
        title: String(name),
        subtitle: attr.plainEditorialNotes?.short || attr.editorialNotes?.short || void 0,
        imageUrl: extractBestArtworkUrl(item, 600),
        page: linkPage
      });
    }
  }
}
function bucketsToSplitEntries(title, buckets, morePage, subtitle) {
  const groups = [];
  if (buckets.tracks.length > 0) {
    groups.push({
      kind: "tracks",
      label: tr("Songs"),
      count: buckets.tracks.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "tracks",
        tracks: buckets.tracks,
        items: buckets.tracks
      })
    });
  }
  if (buckets.albums.length > 0) {
    groups.push({
      kind: "albums",
      label: tr("Albums"),
      count: buckets.albums.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "albums",
        albums: buckets.albums,
        items: buckets.albums
      })
    });
  }
  if (buckets.artists.length > 0) {
    groups.push({
      kind: "artists",
      label: tr("Artists"),
      count: buckets.artists.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "artists",
        artists: buckets.artists,
        items: buckets.artists
      })
    });
  }
  if (buckets.playlists.length > 0) {
    groups.push({
      kind: "playlists",
      label: tr("Playlists"),
      count: buckets.playlists.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        kind: "playlists",
        playlists: buckets.playlists,
        items: buckets.playlists
      })
    });
  }
  if (buckets.stations.length > 0) {
    groups.push({
      kind: "stations",
      label: tr("Stations"),
      count: buckets.stations.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        stations: buckets.stations
      })
    });
  }
  if (buckets.links.length > 0) {
    groups.push({
      kind: "links",
      label: tr("Browse"),
      count: buckets.links.length,
      build: (secTitle, mp, sub) => ({
        title: secTitle,
        ...sub ? { subtitle: sub } : {},
        ...mp ? { morePage: mp } : {},
        links: buckets.links
      })
    });
  }
  if (groups.length === 0) return [];
  if (groups.length === 1) {
    const g = groups[0];
    return [
      {
        section: g.build(title, morePage, subtitle),
        isOverflow: false,
        itemKind: g.kind,
        count: g.count
      }
    ];
  }
  groups.sort((a, b) => b.count - a.count);
  return groups.map((g, idx) => {
    const isPrimary = idx === 0;
    const secTitle = isPrimary ? title : title ? `${title} \xB7 ${g.label}` : g.label;
    return {
      section: g.build(secTitle, isPrimary ? morePage : void 0, isPrimary ? subtitle : void 0),
      isOverflow: !isPrimary,
      itemKind: g.kind,
      count: g.count
    };
  });
}
function consolidateSplitEntries(entries) {
  const getArrayForKind = (sec, kind) => {
    switch (kind) {
      case "tracks":
        return sec.tracks;
      case "albums":
        return sec.albums;
      case "artists":
        return sec.artists;
      case "playlists":
        return sec.playlists;
      case "stations":
        return sec.stations;
      case "links":
        return sec.links;
    }
  };
  const setArrayForKind = (sec, kind, arr) => {
    switch (kind) {
      case "tracks":
        sec.tracks = arr;
        sec.items = arr;
        break;
      case "albums":
        sec.albums = arr;
        sec.items = arr;
        break;
      case "artists":
        sec.artists = arr;
        sec.items = arr;
        break;
      case "playlists":
        sec.playlists = arr;
        sec.items = arr;
        break;
      case "stations":
        sec.stations = arr;
        break;
      case "links":
        sec.links = arr;
        break;
    }
  };
  const preferredKeywords = {
    playlists: /made for you|为你推荐|playlist|歌单/i,
    stations: /station|radio|广播|电台/i,
    albums: /new release|新发行|album|专辑/i,
    tracks: /song|track|歌曲/i,
    artists: /artist|艺人/i,
    links: /mood|genre|browse|浏览/i
  };
  const absorbed = /* @__PURE__ */ new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.isOverflow || e.count !== 1) continue;
    const srcItems = getArrayForKind(e.section, e.itemKind);
    if (!srcItems || srcItems.length === 0) continue;
    const candidates = entries.filter(
      (cand, idx) => idx !== i && !absorbed.has(idx) && !cand.isOverflow && cand.itemKind === e.itemKind
    );
    if (candidates.length === 0) continue;
    const target = candidates.find((c) => preferredKeywords[e.itemKind].test(c.section.title || "")) || candidates[0];
    const dstItems = getArrayForKind(target.section, e.itemKind) || [];
    const keyOf = (obj) => String(obj?.id || obj?.page || "");
    const existingKeys = new Set(dstItems.map(keyOf));
    const toPrepend = srcItems.filter((item) => {
      const k = keyOf(item);
      return k && !existingKeys.has(k);
    });
    setArrayForKind(target.section, e.itemKind, [...toPrepend, ...dstItems]);
    target.count = dstItems.length + toPrepend.length;
    absorbed.add(i);
  }
  return entries.filter((_, idx) => !absorbed.has(idx)).map((e) => e.section);
}
function bucketsToSections(title, buckets, morePage, subtitle) {
  return bucketsToSplitEntries(title, buckets, morePage, subtitle).map((e) => e.section);
}
function resolveRecommendationTitle(rec, resourcesMap) {
  const attr = rec?.attributes || {};
  const directTitle = typeof attr.title === "string" ? attr.title.trim() : String(attr.title?.stringForDisplay || "").trim();
  const reasonText = String(attr.reason?.stringForDisplay || "").trim();
  if (directTitle) {
    return { title: directTitle, subtitle: reasonText || void 0 };
  }
  const prefix = String(attr.titleWithoutName?.stringForDisplay || "").trim();
  const primaryRef = rec?.relationships?.["primary-content"]?.data?.[0];
  const primaryRes = resolveResourceRef(primaryRef, resourcesMap);
  const primaryName = String(primaryRes?.attributes?.name || "").trim();
  if (prefix && primaryName) {
    return { title: `${prefix} ${primaryName}`, subtitle: reasonText || void 0 };
  }
  if (primaryName) {
    return { title: primaryName, subtitle: reasonText || void 0 };
  }
  if (reasonText) {
    return { title: reasonText };
  }
  return { title: tr("Recommended For You") };
}
function parseRecommendationsToSections(json, allowMorePage = true) {
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const resourcesMap = json?.resources;
  const entries = [];
  for (const rawRef of dataRefs) {
    const rec = resolveResourceRef(rawRef, resourcesMap);
    if (!rec) continue;
    const recType = String(rec.type || rawRef.type || "");
    if (recType !== "personal-recommendation") continue;
    const contents = rec.relationships?.contents?.data || [];
    if (!Array.isArray(contents) || contents.length === 0) continue;
    const buckets = createSectionBuckets();
    for (const childRef of contents) {
      collectResourceIntoBuckets(childRef, buckets, resourcesMap, 0);
    }
    const { title, subtitle } = resolveRecommendationTitle(rec, resourcesMap);
    const morePage = allowMorePage && rec.id && rec.attributes?.hasSeeAll === true ? `reco:${rec.id}` : void 0;
    entries.push(...bucketsToSplitEntries(title, buckets, morePage, subtitle));
  }
  return consolidateSplitEntries(entries);
}
async function fetchPersonalizedHome(sf, lang) {
  const tz = encodeURIComponent(getLocalTimezoneOffset());
  const listenNowQuery = `/me/recommendations?name=listen-now&platform=web&format[resources]=map&with=library,social,friendsMix&types=activities,albums,apple-curators,artists,curators,editorial-items,library-albums,library-playlists,playlists,songs,stations&include[albums]=artists&include[library-playlists]=catalog&include[library-albums]=catalog&include[personal-recommendation]=contents,primary-content&extend=plainEditorialNotes,plainEditorialCard,editorialArtwork&extend[playlists]=artistNames&fields[artists]=name,artwork,url&omit[resource]=autos&displayFilter[kind]=MusicCardShelf,MusicCircleCoverShelf,MusicCoverGrid,MusicCoverShelf,MusicHorizontalLockupGrid,MusicNotesHeroShelf,MusicSuperHeroShelf&timezone=${tz}&l=${encodeURIComponent(lang)}`;
  try {
    const json = await requestApi(listenNowQuery, { requireAuth: true });
    const sections = parseRecommendationsToSections(json, true);
    if (sections.length > 0) {
      return {
        title: tr("Home"),
        sections
      };
    }
  } catch (err) {
    if (err?.code === "signIn") throw err;
  }
  try {
    const fallbackJson = await requestApi(
      `/me/recommendations?limit=30&timezone=${tz}&l=${encodeURIComponent(lang)}`,
      { requireAuth: true }
    );
    const sections = parseRecommendationsToSections(fallbackJson, true);
    if (sections.length > 0) {
      return {
        title: tr("Home"),
        sections
      };
    }
  } catch (err) {
    if (err?.code === "signIn") throw err;
  }
  return null;
}
async function buildChartsBrowse(sf, lang, pageTitle = tr("Charts")) {
  const url = `/catalog/${sf}/charts?types=songs,albums,playlists&limit=20&l=${lang}`;
  const json = await requestApi(url);
  const charts = json.results || {};
  const sections = [];
  if (charts.songs?.[0]?.data?.length) {
    const mapped = charts.songs[0].data.map(mapTrack);
    sections.push({
      title: tr("Top Songs"),
      kind: "tracks",
      tracks: mapped,
      items: mapped,
      morePage: "charts-songs"
    });
  }
  if (charts.playlists?.[0]?.data?.length) {
    const mapped = charts.playlists[0].data.map(mapPlaylist);
    sections.push({
      title: tr("Top Playlists"),
      kind: "playlists",
      playlists: mapped,
      items: mapped,
      morePage: "charts-playlists"
    });
  }
  if (charts.albums?.[0]?.data?.length) {
    const mapped = charts.albums[0].data.map(mapAlbum);
    sections.push({
      title: tr("Top Albums"),
      kind: "albums",
      albums: mapped,
      items: mapped,
      morePage: "charts-albums"
    });
  }
  return {
    title: pageTitle,
    sections
  };
}
function parseEditorialGroupingBrowse(json, fallbackTitle) {
  const resourcesMap = json?.resources;
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const rootGrouping = resolveResourceRef(dataRefs[0], resourcesMap) || (resourcesMap?.groupings ? Object.values(resourcesMap.groupings)[0] : null);
  const pageTitle = String(rootGrouping?.attributes?.name || fallbackTitle);
  const sections = [];
  const tabRefs = rootGrouping?.relationships?.tabs?.data || [];
  const shelfRefs = [];
  if (tabRefs.length > 0) {
    for (const tabRef of tabRefs) {
      const tabEl = resolveResourceRef(tabRef, resourcesMap);
      const children = tabEl?.relationships?.children?.data || [];
      shelfRefs.push(...children);
    }
  } else if (rootGrouping?.relationships?.children?.data) {
    shelfRefs.push(...rootGrouping.relationships.children.data);
  }
  for (const shelfRef of shelfRefs) {
    const shelfEl = resolveResourceRef(shelfRef, resourcesMap);
    if (!shelfEl) continue;
    const attr = shelfEl.attributes || {};
    const kind = String(attr.editorialElementKind || "");
    const buckets = createSectionBuckets();
    if (Array.isArray(attr.links) && attr.links.length > 0) {
      for (const lnk of attr.links) {
        const linkPage = parseEditorialLinkToPage(lnk?.url);
        if (linkPage && lnk?.label && !buckets.seen.has(`link:${linkPage}`)) {
          buckets.seen.add(`link:${linkPage}`);
          buckets.links.push({
            title: String(lnk.label),
            page: linkPage
          });
        }
      }
    }
    const directContents = shelfEl.relationships?.contents?.data || [];
    for (const cRef of directContents) {
      collectResourceIntoBuckets(cRef, buckets, resourcesMap, 0);
    }
    const childElements = shelfEl.relationships?.children?.data || [];
    for (const chRef of childElements) {
      collectResourceIntoBuckets(chRef, buckets, resourcesMap, 0);
    }
    const roomRef = shelfEl.relationships?.room?.data?.[0];
    const morePage = roomRef?.id ? `room:${roomRef.id}` : void 0;
    const shelfTitle = attr.title || attr.name || (kind === "316" ? tr("Featured") : "");
    if (!shelfTitle && buckets.links.length === 0 && buckets.albums.length === 0 && buckets.playlists.length === 0) {
      continue;
    }
    sections.push(...bucketsToSections(shelfTitle || tr("Featured"), buckets, morePage));
  }
  return {
    title: pageTitle,
    sections
  };
}
async function buildRecommendationSeeAllBrowse(recId, lang) {
  const tz = encodeURIComponent(getLocalTimezoneOffset());
  const seeAllUrl = `/me/recommendations/${encodeURIComponent(recId)}/view/see-all?action=refresh&name=listen-now&platform=web&format[resources]=map&include[personal-recommendation]=contents&include[library-playlists]=catalog&include[library-albums]=catalog&limit[contents]=100&omit[resource]=autos&with=library,social,friendsMix&types=artists,albums,apple-curators,curators,editorial-items,library-albums,library-playlists,playlists,songs,stations&timezone=${tz}&l=${encodeURIComponent(lang)}`;
  let json = null;
  try {
    json = await requestApi(seeAllUrl, { requireAuth: true });
  } catch (err) {
    if (err?.code === "signIn") throw err;
    json = await requestApi(
      `/me/recommendations/${encodeURIComponent(recId)}?l=${encodeURIComponent(lang)}`,
      { requireAuth: true }
    );
  }
  const rootRec = resolveResourceRef(json?.data?.[0], json?.resources);
  const resolvedTitle = rootRec ? resolveRecommendationTitle(rootRec, json?.resources).title : "";
  const sections = parseRecommendationsToSections(json, false);
  const title = resolvedTitle || sections[0]?.title || tr("Recommended For You");
  if (sections.length === 1) {
    sections[0] = { ...sections[0], title: "" };
  }
  return {
    title,
    sections
  };
}
async function buildCuratorBrowse(sf, curatorId, isAppleCurator, lang) {
  const resourcePath = isAppleCurator ? "apple-curators" : "curators";
  const json = await requestApi(
    `/catalog/${sf}/${resourcePath}/${encodeURIComponent(curatorId)}?include=playlists&l=${encodeURIComponent(lang)}`
  );
  const item = json?.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Playlist not found"));
  }
  const attr = item.attributes || {};
  const title = String(attr.name || tr("Curator"));
  const desc = attr.editorialNotes?.short || attr.editorialNotes?.standard || void 0;
  const groupingId = item.relationships?.grouping?.data?.[0]?.id;
  if (groupingId) {
    try {
      const grpJson = await requestApi(
        `/editorial/${sf}/groupings/${encodeURIComponent(String(groupingId))}?platform=web&format[resources]=map&omit[resource:artists]=autos&l=${encodeURIComponent(lang)}`
      );
      const grpBrowse = parseEditorialGroupingBrowse(grpJson, title);
      if (grpBrowse.sections && grpBrowse.sections.length > 0) {
        return {
          title,
          description: desc,
          sections: grpBrowse.sections
        };
      }
    } catch {
    }
  }
  const playlistItems = item.relationships?.playlists?.data || [];
  const mappedPlaylists = playlistItems.map(mapPlaylist);
  return {
    title,
    description: desc,
    sections: mappedPlaylists.length > 0 ? [
      {
        title: tr("Playlists"),
        kind: "playlists",
        playlists: mappedPlaylists,
        items: mappedPlaylists
      }
    ] : []
  };
}
async function buildRoomBrowse(sf, roomId, lang) {
  const json = await requestApi(
    `/editorial/${sf}/rooms/${encodeURIComponent(roomId)}?platform=web&format[resources]=map&omit[resource:artists]=autos&l=${encodeURIComponent(lang)}`
  );
  const resourcesMap = json?.resources;
  const dataRefs = Array.isArray(json?.data) ? json.data : [];
  const room = resolveResourceRef(dataRefs[0], resourcesMap) || (resourcesMap?.rooms ? Object.values(resourcesMap.rooms)[0] : null);
  if (!room) {
    throw fail("unavailable", `Room not found: ${roomId}`);
  }
  const attr = room.attributes || {};
  const title = String(attr.title || attr.name || tr("Browse"));
  const desc = attr.editorialNotes?.short || attr.plainEditorialNotes?.short || void 0;
  const buckets = createSectionBuckets();
  const contents = room.relationships?.contents?.data || [];
  if (contents.length > 0) {
    for (const ref of contents) {
      collectResourceIntoBuckets(ref, buckets, resourcesMap, 0);
    }
  } else if (resourcesMap) {
    for (const [rType, group] of Object.entries(resourcesMap)) {
      if (rType === "rooms") continue;
      for (const obj of Object.values(group || {})) {
        collectResourceIntoBuckets(obj, buckets, resourcesMap, 0);
      }
    }
  }
  const roomSections = bucketsToSections("", buckets);
  if (roomSections.length === 1) {
    roomSections[0] = { ...roomSections[0], title: "" };
  }
  return {
    title,
    description: desc,
    sections: roomSections
  };
}
async function home() {
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const token = await getStoredMediaUserToken();
  if (token) {
    const personalized = await fetchPersonalizedHome(sf, lang);
    if (personalized && personalized.sections && personalized.sections.length > 0) {
      return personalized;
    }
  }
  return buildChartsBrowse(sf, lang, tr("Home"));
}
async function buildMyPageBrowse(sf, lang) {
  const token = await getStoredMediaUserToken();
  if (!token) {
    throw fail("signIn", tr("Sign in to Apple Music first"));
  }
  const [acc, heavyJson, recentAddedJson, allPlaylists, recentTracks, liveQuality] = await Promise.all([
    account().catch(() => null),
    requestApi(`/me/history/heavy-rotation?limit=12&l=${lang}`, { requireAuth: true }).catch(
      () => null
    ),
    requestApi(`/me/library/recently-added?limit=16&l=${lang}`, { requireAuth: true }).catch(
      () => null
    ),
    playlists().catch(() => []),
    recent().catch(() => []),
    readMusicAppAudioQuality().catch(() => null)
  ]);
  const sections = [];
  if (Array.isArray(heavyJson?.data) && heavyJson.data.length > 0) {
    const heavyBuckets = createSectionBuckets();
    heavyBuckets.albums = heavyJson.data.filter((x) => String(x?.type || "").includes("album")).map(mapAlbum);
    heavyBuckets.playlists = heavyJson.data.filter(
      (x) => String(x?.type || "").includes("playlist") && !isFavoritesPlaylistItem(x)
    ).map(mapPlaylist);
    sections.push(...bucketsToSections(tr("Heavy Rotation"), heavyBuckets));
  }
  if (Array.isArray(recentAddedJson?.data) && recentAddedJson.data.length > 0) {
    const addedBuckets = createSectionBuckets();
    addedBuckets.albums = recentAddedJson.data.filter((x) => String(x?.type || "").includes("album")).map(mapAlbum);
    addedBuckets.playlists = recentAddedJson.data.filter(
      (x) => String(x?.type || "").includes("playlist") && !isFavoritesPlaylistItem(x)
    ).map(mapPlaylist);
    sections.push(...bucketsToSections(tr("Recently Added"), addedBuckets));
  }
  const myPlaylists = allPlaylists.filter((p) => p.mine);
  const displayPlaylists = myPlaylists.length > 0 ? myPlaylists : allPlaylists;
  if (displayPlaylists.length > 0) {
    sections.push({
      title: myPlaylists.length > 0 ? tr("My Playlists") : tr("Playlists"),
      kind: "playlists",
      playlists: displayPlaylists,
      items: displayPlaylists
    });
  }
  if (recentTracks.length > 0) {
    const previewTracks = recentTracks.slice(0, 10);
    sections.push({
      title: tr("Recently Played"),
      kind: "tracks",
      tracks: previewTracks,
      items: previewTracks,
      morePage: "recent"
    });
  }
  const hasHandle = Boolean(acc?.id && !acc.id.startsWith("apple-music-"));
  const subtitle = hasHandle ? `@${acc.id}` : void 0;
  const qualSuffix = liveQuality ? ` \xB7 ${formatAudioQualityLabel(liveQuality)}` : "";
  const desc = `Apple Music (${sf.toUpperCase()})${qualSuffix}`;
  return {
    title: acc?.name || tr("Library"),
    subtitle,
    description: desc,
    imageUrl: acc?.imageUrl || void 0,
    sections
  };
}
async function browse(options) {
  const page = options?.page || options?.id || "charts";
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  if (page === "home") {
    return home();
  }
  if (page === "charts" || page === "browse") {
    return buildChartsBrowse(sf, lang, tr("Charts"));
  }
  if (page === "new") {
    try {
      const edJson = await requestApi(
        `/editorial/${sf}/groupings?name=music&platform=web&format[resources]=map&omit[resource]=autos&l=${encodeURIComponent(lang)}`
      );
      const parsed = parseEditorialGroupingBrowse(edJson, tr("New"));
      if (parsed.sections && parsed.sections.length > 0) {
        return { ...parsed, title: tr("New") };
      }
    } catch (err) {
      if (err?.code === "signIn") throw err;
    }
    return buildChartsBrowse(sf, lang, tr("New"));
  }
  if (page === "library" || page === "profile") {
    return buildMyPageBrowse(sf, lang);
  }
  if (page === "recent") {
    const recentTracks = await recent();
    return {
      title: tr("Recently Played"),
      sections: [
        {
          title: tr("Recently Played"),
          kind: "tracks",
          tracks: recentTracks,
          items: recentTracks
        }
      ]
    };
  }
  if (page.startsWith("reco:")) {
    const recId = page.slice(5).trim();
    if (!recId) throw fail("unavailable", "Recommendation id required");
    return buildRecommendationSeeAllBrowse(recId, lang);
  }
  if (page.startsWith("apple-curator:")) {
    const curId = page.slice(14).trim();
    if (!curId) throw fail("unavailable", "Curator id required");
    return buildCuratorBrowse(sf, curId, true, lang);
  }
  if (page.startsWith("curator:")) {
    const curId = page.slice(8).trim();
    if (!curId) throw fail("unavailable", "Curator id required");
    return buildCuratorBrowse(sf, curId, false, lang);
  }
  if (page.startsWith("grouping:")) {
    const grpId = page.slice(9).trim();
    if (!grpId) throw fail("unavailable", "Grouping id required");
    const grpJson = await requestApi(
      `/editorial/${sf}/groupings/${encodeURIComponent(grpId)}?platform=web&format[resources]=map&omit[resource:artists]=autos&l=${encodeURIComponent(lang)}`
    );
    return parseEditorialGroupingBrowse(grpJson, tr("Browse"));
  }
  if (page.startsWith("room:")) {
    const roomId = page.slice(5).trim();
    if (!roomId) throw fail("unavailable", "Room id required");
    return buildRoomBrowse(sf, roomId, lang);
  }
  if (page === "charts-songs") {
    const json = await requestApi(`/catalog/${sf}/charts?types=songs&limit=50&l=${lang}`);
    const songs = json.results?.songs?.[0]?.data || [];
    const mapped = songs.map(mapTrack);
    return {
      title: tr("Top Songs"),
      sections: [
        {
          title: tr("Top Songs"),
          kind: "tracks",
          tracks: mapped,
          items: mapped
        }
      ]
    };
  }
  if (page === "charts-albums") {
    const json = await requestApi(`/catalog/${sf}/charts?types=albums&limit=50&l=${lang}`);
    const albums = json.results?.albums?.[0]?.data || [];
    const mapped = albums.map(mapAlbum);
    return {
      title: tr("Top Albums"),
      sections: [
        {
          title: tr("Top Albums"),
          kind: "albums",
          albums: mapped,
          items: mapped
        }
      ]
    };
  }
  if (page === "charts-playlists") {
    const json = await requestApi(`/catalog/${sf}/charts?types=playlists&limit=50&l=${lang}`);
    const playlistsData = json.results?.playlists?.[0]?.data || [];
    const mapped = playlistsData.map(mapPlaylist);
    return {
      title: tr("Top Playlists"),
      sections: [
        {
          title: tr("Top Playlists"),
          kind: "playlists",
          playlists: mapped,
          items: mapped
        }
      ]
    };
  }
  throw fail("unavailable", `Unknown browse page: ${page}`);
}
async function album(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Album id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const endpoint = id.startsWith("l.") ? `/me/library/albums/${encodeURIComponent(id)}?include=tracks&l=${lang}` : `/catalog/${sf}/albums/${encodeURIComponent(id)}?l=${lang}`;
  const json = await requestApi(endpoint, { requireAuth: id.startsWith("l.") });
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Album not found"));
  }
  const alb = mapAlbum(item);
  const trackItems = item.relationships?.tracks?.data || [];
  const tracks = trackItems.map(mapTrack);
  return {
    album: alb,
    tracks
  };
}
async function artist(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Artist id required");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/catalog/${sf}/artists/${encodeURIComponent(id)}?views=top-songs,full-albums&l=${lang}`
  );
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Artist not found"));
  }
  const art = mapArtist(item);
  const topSongItems = item.views?.["top-songs"]?.data || [];
  const albumItems = item.views?.["full-albums"]?.data || [];
  return {
    artist: art,
    tracks: topSongItems.map(mapTrack),
    albums: albumItems.map(mapAlbum)
  };
}
var favoritesPlaylistIdCache = null;
var favoritesLookupDone = false;
var favoritedIdsCache = /* @__PURE__ */ new Set();
var favoritesHydratedAt = 0;
var favoritesHydratePromise = null;
var FAVORITES_CACHE_TTL_MS = 2 * 60 * 1e3;
function resetFavoritesState() {
  favoritesPlaylistIdCache = null;
  favoritesLookupDone = false;
  favoritedIdsCache.clear();
  favoritesHydratedAt = 0;
  favoritesHydratePromise = null;
}
function isFavoritesPlaylistItem(item) {
  const attr = item?.attributes || {};
  if (Array.isArray(attr.tags) && attr.tags.includes("favorited")) {
    return true;
  }
  if (attr.isFavorites === true) {
    return true;
  }
  const name = String(attr.name || "").trim();
  if (attr.canEdit === false && !attr.curatorName && /^(Favorite Songs|Favourite Songs|喜爱歌曲|喜好歌曲|喜愛歌曲|お気に入りの曲|즐겨찾는 노래)$/i.test(
    name
  )) {
    return true;
  }
  return false;
}
function recordFavoritedTrackItem(item) {
  if (!item) return;
  const id = String(item.id || "").trim();
  if (id) favoritedIdsCache.add(id);
  const catalogId = item.attributes?.playParams?.catalogId || item.relationships?.catalog?.data?.[0]?.id;
  if (catalogId) {
    favoritedIdsCache.add(String(catalogId));
  }
}
async function getFavoritesPlaylistId(lang) {
  if (favoritesPlaylistIdCache) return favoritesPlaylistIdCache;
  if (favoritesLookupDone) return null;
  try {
    const json = await requestApi(
      `/me/library/playlists?limit=100&extend[library-playlists]=tags&l=${lang}`,
      { requireAuth: true }
    );
    const items = Array.isArray(json?.data) ? json.data : [];
    const fav = items.find(isFavoritesPlaylistItem);
    favoritesLookupDone = true;
    if (fav?.id) {
      favoritesPlaylistIdCache = String(fav.id);
      return favoritesPlaylistIdCache;
    }
  } catch {
  }
  return null;
}
async function fetchFavoritesPlaylistTracks(favId, lang, offset = 0, maxPages = 5) {
  const rawItems = [];
  let nextPath = `/me/library/playlists/${encodeURIComponent(favId)}/tracks?limit=100&offset=${offset}&l=${lang}`;
  let pages = 0;
  while (nextPath && pages < maxPages) {
    pages++;
    const cleanPath = nextPath.replace(/^\/v1/, "");
    const pageJson = await requestApi(cleanPath, { requireAuth: true }).catch(() => null);
    if (!pageJson || !Array.isArray(pageJson.data)) {
      nextPath = void 0;
      break;
    }
    for (const item of pageJson.data) {
      recordFavoritedTrackItem(item);
      rawItems.push(item);
    }
    nextPath = typeof pageJson.next === "string" && pageJson.next ? pageJson.next : void 0;
  }
  if (offset === 0 && rawItems.length > 0) {
    favoritesHydratedAt = Date.now();
  }
  return {
    rawItems,
    hasMore: Boolean(nextPath)
  };
}
async function ensureFavoritesHydrated(lang) {
  if (favoritesHydratedAt > 0 && Date.now() - favoritesHydratedAt < FAVORITES_CACHE_TTL_MS) {
    return;
  }
  if (favoritesHydratePromise) {
    return favoritesHydratePromise;
  }
  favoritesHydratePromise = (async () => {
    try {
      const favId = await getFavoritesPlaylistId(lang);
      if (favId) {
        await fetchFavoritesPlaylistTracks(favId, lang, 0, 5);
      }
      favoritesHydratedAt = Date.now();
    } catch {
    } finally {
      favoritesHydratePromise = null;
    }
  })();
  return favoritesHydratePromise;
}
async function playlists() {
  const token = await getStoredMediaUserToken();
  if (!token) return [];
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/library/playlists?limit=100&extend[library-playlists]=tags&l=${lang}`,
    { requireAuth: true }
  );
  const items = Array.isArray(json.data) ? json.data : [];
  const fav = items.find(isFavoritesPlaylistItem);
  if (fav?.id) {
    favoritesPlaylistIdCache = String(fav.id);
    favoritesLookupDone = true;
  }
  return items.filter((item) => !isFavoritesPlaylistItem(item)).map(mapPlaylist);
}
async function playlist(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Playlist id required");
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  if (id.startsWith("p.")) {
    const json2 = await requestApi(
      `/me/library/playlists/${encodeURIComponent(id)}?include=tracks&l=${lang}`,
      { requireAuth: true }
    );
    const item2 = json2.data?.[0];
    if (!item2) {
      throw fail("unavailable", tr("Playlist not found"));
    }
    const pl2 = mapPlaylist(item2);
    const trackItems2 = [...item2.relationships?.tracks?.data || []];
    let nextUrl = item2.relationships?.tracks?.next;
    let pages = 0;
    while (nextUrl && pages < 5) {
      pages++;
      const cleanNext = nextUrl.replace(/^\/v1/, "");
      const moreJson = await requestApi(cleanNext, { requireAuth: true }).catch(() => null);
      if (!moreJson?.data?.length) break;
      trackItems2.push(...moreJson.data);
      nextUrl = moreJson.next;
    }
    pl2.tracks = trackItems2.map(mapTrack);
    pl2.trackCount = pl2.tracks.length;
    return pl2;
  }
  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/playlists/${encodeURIComponent(id)}?l=${lang}`);
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Playlist not found"));
  }
  const pl = mapPlaylist(item);
  const trackItems = item.relationships?.tracks?.data || [];
  pl.tracks = trackItems.map(mapTrack);
  return pl;
}
async function createPlaylist(options) {
  const name = String(options?.name || "").trim();
  if (!name) throw fail("unavailable", "Playlist name required");
  const json = await requestApi("/me/library/playlists", {
    method: "POST",
    requireAuth: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attributes: { name } })
  });
  const item = json.data?.[0];
  if (!item) {
    throw fail("unavailable", tr("Failed to load playlist"));
  }
  const pl = mapPlaylist(item);
  pl.tracks = [];
  pl.trackCount = 0;
  pl.mine = true;
  return pl;
}
async function addToPlaylist(options) {
  const { id, trackIds } = options || {};
  if (!id || !Array.isArray(trackIds) || trackIds.length === 0) return;
  const data = trackIds.map((tid) => ({
    id: String(tid),
    type: String(tid).startsWith("i.") ? "library-songs" : "songs"
  }));
  await requestApi(`/me/library/playlists/${encodeURIComponent(id)}/tracks`, {
    method: "POST",
    requireAuth: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  });
}
async function liked(options) {
  const offset = Math.max(0, Number(options?.offset) || 0);
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const favId = await getFavoritesPlaylistId(lang);
  if (favId) {
    if (offset === 0) {
      favoritedIdsCache.clear();
    }
    const maxPages = offset === 0 ? 5 : 1;
    const { rawItems, hasMore } = await fetchFavoritesPlaylistTracks(
      favId,
      lang,
      offset,
      maxPages
    );
    return {
      tracks: rawItems.map(mapTrack),
      more: hasMore
    };
  }
  const json = await requestApi(
    `/me/library/songs?limit=100&offset=${offset}&l=${lang}`,
    { requireAuth: true }
  );
  const items = json.data || [];
  return {
    tracks: items.map(mapTrack),
    more: Boolean(json.next)
  };
}
async function savedAlbums(options) {
  const offset = Math.max(0, Number(options?.offset) || 0);
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/library/albums?limit=50&offset=${offset}&l=${lang}`,
    { requireAuth: true }
  );
  const items = json.data || [];
  return {
    albums: items.map(mapAlbum),
    more: Boolean(json.next)
  };
}
async function like(options) {
  const id = String(options?.id || "").trim();
  if (!id) return;
  const on = Boolean(options?.on);
  const isLibId = id.startsWith("i.");
  const resType = isLibId ? "library-songs" : "songs";
  const meta = trackMetaCache.get(id);
  let updatedFavorites = false;
  try {
    await requestApi(
      `/me/favorites?ids[${resType}]=${encodeURIComponent(id)}&platform=web`,
      {
        method: on ? "POST" : "DELETE",
        requireAuth: true
      }
    );
    updatedFavorites = true;
  } catch (err) {
    if (err?.code === "signIn") throw err;
  }
  const ratingPath = isLibId ? `/me/ratings/library-songs/${encodeURIComponent(id)}` : `/me/ratings/songs/${encodeURIComponent(id)}`;
  if (on) {
    if (!updatedFavorites) {
      if (!isLibId) {
        await requestApi(`/me/library?ids[songs]=${encodeURIComponent(id)}`, {
          method: "POST",
          requireAuth: true
        }).catch(() => {
        });
      }
      await requestApi(ratingPath, {
        method: "PUT",
        requireAuth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "rating", attributes: { value: 1 } })
      });
    } else {
      requestApi(ratingPath, {
        method: "PUT",
        requireAuth: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "rating", attributes: { value: 1 } })
      }).catch(() => {
      });
    }
    favoritedIdsCache.add(id);
    if (meta?.catalogId) favoritedIdsCache.add(meta.catalogId);
  } else {
    if (!updatedFavorites) {
      await requestApi(ratingPath, {
        method: "DELETE",
        requireAuth: true
      }).catch(() => {
      });
    } else {
      requestApi(ratingPath, {
        method: "DELETE",
        requireAuth: true
      }).catch(() => {
      });
    }
    favoritedIdsCache.delete(id);
    if (meta?.catalogId) favoritedIdsCache.delete(meta.catalogId);
  }
}
async function isLiked(options) {
  const ids = Array.isArray(options?.ids) ? options.ids.filter(Boolean) : [];
  const out = {};
  for (const id of ids) out[id] = false;
  if (ids.length === 0) return out;
  const token = await getStoredMediaUserToken();
  if (!token) return out;
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  await ensureFavoritesHydrated(lang);
  const unresolvedLibIds = [];
  const unresolvedCatalogIds = [];
  for (const id of ids) {
    const meta = trackMetaCache.get(id);
    if (favoritedIdsCache.has(id) || meta?.catalogId && favoritedIdsCache.has(meta.catalogId) || meta?.id && favoritedIdsCache.has(meta.id)) {
      out[id] = true;
    } else if (id.startsWith("i.")) {
      unresolvedLibIds.push(id);
    } else {
      unresolvedCatalogIds.push(id);
    }
  }
  if (unresolvedLibIds.length > 0) {
    try {
      const json = await requestApi(
        `/me/ratings/library-songs?ids=${unresolvedLibIds.map(encodeURIComponent).join(",")}`,
        { requireAuth: true }
      );
      for (const r of json.data || []) {
        if (r?.id && r?.attributes?.value === 1) {
          out[String(r.id)] = true;
          favoritedIdsCache.add(String(r.id));
        }
      }
    } catch {
    }
  }
  if (unresolvedCatalogIds.length > 0) {
    try {
      const json = await requestApi(
        `/me/ratings/songs?ids=${unresolvedCatalogIds.map(encodeURIComponent).join(",")}`,
        { requireAuth: true }
      );
      for (const r of json.data || []) {
        if (r?.id && r?.attributes?.value === 1) {
          out[String(r.id)] = true;
          favoritedIdsCache.add(String(r.id));
        }
      }
    } catch {
    }
  }
  return out;
}
async function saveAlbum(options) {
  const id = String(options?.id || "").trim();
  if (!id) return;
  if (options?.on) {
    await requestApi(`/me/library?ids[albums]=${encodeURIComponent(id)}`, {
      method: "POST",
      requireAuth: true
    });
  }
}
async function played(options) {
  const id = String(options?.id || "").trim();
  if (!id || typeof host === "undefined" || !host.storage) return;
  try {
    const meta = trackMetaCache.get(id);
    if (!meta) return;
    const prev = await host.storage.get("recent_tracks") || [];
    const trackObj = {
      id: meta.id,
      name: meta.name,
      artists: [{ id: meta.artistName, name: meta.artistName }],
      album: { id: meta.albumId || meta.albumName, name: meta.albumName },
      duration: meta.durationMs,
      url: meta.url
    };
    const filtered = prev.filter((t) => t?.id !== id);
    await host.storage.set("recent_tracks", [trackObj, ...filtered].slice(0, 50));
  } catch {
  }
}
async function recent() {
  const token = await getStoredMediaUserToken();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  if (token) {
    try {
      const json = await requestApi(`/me/recent/played/tracks?limit=30&l=${lang}`, {
        requireAuth: true
      });
      if (Array.isArray(json?.data) && json.data.length > 0) {
        return json.data.map(mapTrack);
      }
    } catch {
    }
  }
  if (typeof host !== "undefined" && host.storage) {
    try {
      return await host.storage.get("recent_tracks") || [];
    } catch {
      return [];
    }
  }
  return [];
}
async function stations() {
  const token = await getStoredMediaUserToken();
  if (!token) return [];
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  try {
    const json = await requestApi(
      `/me/recent/radio-stations?limit=20&l=${encodeURIComponent(lang)}`,
      { requireAuth: true }
    );
    const items = Array.isArray(json?.data) ? json.data : [];
    return items.filter((st) => st?.id && st?.attributes?.name && st?.attributes?.isLive !== true).map((st) => ({
      id: String(st.id),
      name: String(st.attributes.name),
      description: st.attributes.editorialNotes?.short || st.attributes.plainEditorialNotes?.short || void 0,
      imageUrl: extractBestArtworkUrl(st, 600)
    }));
  } catch (err) {
    if (err?.code === "signIn") throw err;
    return [];
  }
}
async function stationNext(options) {
  const id = String(options?.id || "").trim();
  if (!id) throw fail("unavailable", "Station id required");
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const json = await requestApi(
    `/me/stations/next-tracks/${encodeURIComponent(id)}?limit=10&l=${encodeURIComponent(lang)}`,
    {
      method: "POST",
      requireAuth: true
    }
  );
  const items = Array.isArray(json?.data) ? json.data : [];
  if (items.length === 0) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  return items.map(mapTrack);
}
async function lyrics(options) {
  const id = String(options?.id || "").trim();
  if (!id) return {};
  let meta = null;
  try {
    meta = await resolveTrackMeta(id);
  } catch {
    meta = trackMetaCache.get(id) || null;
  }
  const catalogId = meta?.catalogId || (!id.startsWith("i.") ? id : "");
  const sf = await getStorefront();
  const lang = typeof host !== "undefined" && host.language ? host.language() : "en";
  const mediaUserToken = await getStoredMediaUserToken();
  if (mediaUserToken && catalogId) {
    for (const subPath of ["syllable-lyrics", "lyrics"]) {
      try {
        const json = await requestApi(
          `/catalog/${sf}/songs/${encodeURIComponent(catalogId)}/${subPath}?l=${lang}`,
          { requireAuth: true }
        );
        const ttml = json?.data?.[0]?.attributes?.ttml;
        if (typeof ttml === "string" && ttml.includes("<p")) {
          const parsed = parseAppleTTML(ttml);
          if (parsed.lines && parsed.lines.length > 0) {
            return parsed;
          }
        }
      } catch {
      }
    }
  }
  if (meta && meta.name) {
    try {
      const params = new URLSearchParams({
        track_name: meta.name,
        artist_name: meta.artistName || "",
        album_name: meta.albumName || "",
        duration: String(Math.max(1, Math.round((meta.durationMs || 0) / 1e3)))
      });
      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers: { "User-Agent": "mygo-music-apple-music/0.1.0" }
      });
      if (res.ok) {
        const found = await res.json();
        if (found?.syncedLyrics) {
          return { lrc: String(found.syncedLyrics) };
        }
      }
    } catch {
    }
  }
  return {};
}
async function remotePlay(options) {
  const ids = Array.isArray(options?.ids) ? options.ids : [];
  const start = Math.max(0, Number(options?.start) || 0);
  const position = Math.max(0, Number(options?.position) || 0);
  const targetId = ids[start];
  if (!targetId) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  const sf = await getStorefront();
  const meta = await resolveTrackMeta(String(targetId));
  await executeRemotePlay({
    meta,
    storefront: sf,
    positionMs: position
  });
}
async function remotePause() {
  await executeRemotePause();
}
async function remoteResume() {
  await executeRemoteResume();
}
async function remoteSeek(options) {
  await executeRemoteSeek(Number(options?.position) || 0);
}
async function remoteVolume(options) {
  await executeRemoteVolume(Number(options?.percent) ?? 100);
}
async function remoteState() {
  return executeRemoteState();
}
async function remoteDevices() {
  return executeRemoteDevices();
}
async function remoteUse(options) {
  await executeRemoteUse(String(options?.deviceId || ""));
}
async function stream(options) {
  const { id } = options || {};
  if (!id) throw fail("unavailable", "Song id required");
  const sf = await getStorefront();
  const json = await requestApi(`/catalog/${sf}/songs/${encodeURIComponent(id)}`);
  const song = json.data?.[0];
  if (!song) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  const previewUrl = song.attributes?.previews?.[0]?.url;
  if (!previewUrl) {
    throw fail("unavailable", tr("This track is unavailable for streaming"));
  }
  return {
    url: previewUrl,
    type: "m4a",
    quality: "high",
    headers: {
      Origin: "https://music.apple.com",
      Referer: "https://music.apple.com/"
    }
  };
}
async function openInAppleMusic(options) {
  const opts = options || {};
  let targetUrl = opts.url ? String(opts.url).trim() : "";
  if (targetUrl) {
    if (/^music:\/\//i.test(targetUrl)) {
      targetUrl = targetUrl.replace(/^music:\/\//i, "https://");
    } else if (/^http:\/\//i.test(targetUrl)) {
      targetUrl = targetUrl.replace(/^http:\/\//i, "https://");
    } else if (/^https:\/\//i.test(targetUrl)) {
      targetUrl = targetUrl.replace(/^https:\/\//i, "https://");
    } else {
      targetUrl = `https://${targetUrl}`;
    }
  } else {
    const id = String(opts.id || "").trim();
    const sf = opts.storefront ? opts.storefront.trim().toLowerCase() : await getStorefront();
    const rawKind = (opts.kind || "song").toLowerCase();
    let kindPath = "song";
    if (rawKind === "album" || rawKind === "albums") {
      kindPath = "album";
    } else if (rawKind === "artist" || rawKind === "artists") {
      kindPath = "artist";
    } else if (rawKind === "playlist" || rawKind === "playlists") {
      kindPath = "playlist";
    }
    targetUrl = id ? `https://music.apple.com/${sf}/${kindPath}/${id}` : `https://music.apple.com/${sf}`;
  }
  if (typeof host !== "undefined" && typeof host.openURL === "function") {
    host.openURL(targetUrl);
  }
  return { url: targetUrl, opened: true };
}
var CURRENT_PROFILE_VERSION = 2;
function isPlaceholderAccountName(name) {
  if (!name || typeof name !== "string") return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (/^Apple Music\s*\(.+\)$/i.test(trimmed)) return true;
  if (trimmed === "Apple Music" || trimmed === "Apple Music Subscriber" || trimmed === "Apple Music \u8BA2\u9605\u7528\u6237") {
    return true;
  }
  return false;
}
function isLegacyStorefrontPlaceholder(name) {
  return Boolean(name && /^Apple Music\s*\(.+\)$/i.test(name.trim()));
}
function getCustomDisplayName() {
  if (typeof host !== "undefined" && typeof host.setting === "function") {
    const val = host.setting("displayName");
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}
function extractSocialProfileCandidate(json) {
  if (!json || typeof json !== "object") return {};
  const candidates = [];
  const personalMap = json.resources?.["personal-social-profiles"];
  if (personalMap && typeof personalMap === "object") {
    if (personalMap.me) candidates.push(personalMap.me);
    for (const v of Object.values(personalMap)) {
      if (v && typeof v === "object") candidates.push(v);
    }
  }
  const socialMap = json.resources?.["social-profiles"];
  if (socialMap && typeof socialMap === "object") {
    for (const v of Object.values(socialMap)) {
      if (v && typeof v === "object") candidates.push(v);
    }
  }
  if (Array.isArray(json.data)) {
    candidates.push(...json.data);
  }
  if (Array.isArray(json.included)) {
    candidates.push(...json.included);
  }
  let id;
  let name;
  let handle;
  let imageUrl;
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const attr = c.attributes || {};
    if (!id && typeof c.id === "string" && c.id.trim()) {
      id = c.id.trim();
    }
    if (!name && typeof attr.name === "string" && attr.name.trim() && !isPlaceholderAccountName(attr.name)) {
      name = attr.name.trim();
    }
    if (!handle && typeof attr.handle === "string" && attr.handle.trim()) {
      handle = attr.handle.trim().replace(/^@+/, "");
    }
    if (!imageUrl && typeof attr.artwork?.url === "string" && attr.artwork.url.trim()) {
      imageUrl = formatArtworkUrl(attr.artwork.url.trim(), 160, "cc");
    }
  }
  return { id, name, handle, imageUrl };
}
function extractMeAccountCandidate(json) {
  if (!json || typeof json !== "object") return {};
  const storefront = typeof json.meta?.subscription?.storefront === "string" ? json.meta.subscription.storefront.trim().toLowerCase() : void 0;
  const candidates = [];
  if (Array.isArray(json.data)) candidates.push(...json.data);
  if (json.resources?.accounts?.me) candidates.push(json.resources.accounts.me);
  let id;
  let name;
  let imageUrl;
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const attr = c.attributes || {};
    if (!id && typeof c.id === "string" && c.id.trim()) {
      id = c.id.trim();
    }
    const fullName = [attr.firstName, attr.lastName].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
    const rawName = fullName || (typeof attr.nickname === "string" ? attr.nickname.trim() : "") || (typeof attr.handle === "string" ? attr.handle.trim().replace(/^@+/, "") : "") || (typeof attr.name === "string" ? attr.name.trim() : "");
    if (!name && rawName && !isPlaceholderAccountName(rawName)) {
      name = rawName;
    }
    const rawArt = attr.avatarArtwork?.url || attr.artwork?.url;
    if (!imageUrl && typeof rawArt === "string" && rawArt.trim()) {
      imageUrl = formatArtworkUrl(rawArt.trim(), 160, "cc");
    }
  }
  return { id, name, imageUrl, storefront };
}
async function getMacSystemUserName() {
  if (typeof host === "undefined" || host.platform !== "darwin" || typeof host.spawn !== "function") {
    return "";
  }
  try {
    const proc = host.spawn("/usr/bin/osascript", ["-"]);
    proc.write(
      'try\n  set fn to long user name of (system info)\n  if fn is not "" then return "USER:" & fn\nend try\nreturn "USER:" & (short user name of (system info))\n'
    );
    proc.closeStdin();
    const lines = [];
    while (true) {
      const line = await proc.readLine();
      if (line === null || line === void 0) break;
      lines.push(line);
    }
    const exitCode = await proc.wait();
    if (exitCode === 0) {
      const out = lines.join("\n").trim();
      if (out.startsWith("USER:")) {
        const user = out.slice(5).trim();
        if (user && !user.includes("	") && !user.includes("\n")) {
          return user;
        }
      }
    }
  } catch {
  }
  return "";
}
async function resolveSubscriberProfile(mediaUserToken, devToken, fallbackStorefront) {
  const authHeaders = {
    Authorization: `Bearer ${devToken}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    "Music-User-Token": mediaUserToken
  };
  const fetchJsonSafe = async (url) => {
    try {
      const res = await fetch(url, { headers: authHeaders });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
  const [socialMapJson, meAccountJson] = await Promise.all([
    fetchJsonSafe(
      `${AMP_API_BASE}/me/social/profile?include=social-profile&with=nonOnboarded&platform=web&format%5Bresources%5D=map`
    ),
    fetchJsonSafe(
      `${AMP_API_BASE}/me/account?meta=subscription&challenge%5BsubscriptionCapabilities%5D=voice,premium&platform=web`
    )
  ]);
  let social = extractSocialProfileCandidate(socialMapJson);
  if (!social.name && !social.handle && !social.imageUrl) {
    const socialPlainJson = await fetchJsonSafe(
      `${AMP_API_BASE}/me/social/profile?include=social-profile&with=nonOnboarded`
    );
    const altSocial = extractSocialProfileCandidate(socialPlainJson);
    social = {
      id: social.id || altSocial.id,
      name: social.name || altSocial.name,
      handle: social.handle || altSocial.handle,
      imageUrl: social.imageUrl || altSocial.imageUrl
    };
  }
  const meAcc = extractMeAccountCandidate(meAccountJson);
  const storefront = meAcc.storefront || fallbackStorefront || "us";
  let resolvedName = social.name || social.handle || meAcc.name || "";
  if (!resolvedName) {
    const libPlJson = await fetchJsonSafe(`${AMP_API_BASE}/me/library/playlists?limit=10`);
    if (Array.isArray(libPlJson?.data)) {
      for (const pl of libPlJson.data) {
        if (pl?.attributes?.canEdit && typeof pl?.attributes?.curatorName === "string") {
          const curator = pl.attributes.curatorName.trim();
          if (curator && !isPlaceholderAccountName(curator)) {
            resolvedName = curator;
            break;
          }
        }
      }
    }
  }
  let foundRealProfile = Boolean(resolvedName || social.imageUrl || meAcc.imageUrl);
  if (!resolvedName) {
    const macUser = await getMacSystemUserName();
    if (macUser) {
      resolvedName = macUser;
      foundRealProfile = true;
    }
  }
  const customName = getCustomDisplayName();
  const finalName = customName || resolvedName || tr("Apple Music Subscriber");
  const finalImage = social.imageUrl || meAcc.imageUrl || "";
  const finalId = social.handle || `apple-music-${storefront}`;
  return {
    account: {
      id: finalId,
      name: finalName,
      imageUrl: finalImage,
      page: "library"
    },
    storefront,
    foundRealProfile: foundRealProfile || Boolean(customName)
  };
}
async function verifyAndPersistToken(mediaUserToken) {
  let sfData;
  let devToken;
  try {
    devToken = await getDeveloperToken();
    const sfRes = await fetch("https://amp-api.music.apple.com/v1/me/storefront", {
      headers: {
        Authorization: `Bearer ${devToken}`,
        Origin: "https://music.apple.com",
        "Music-User-Token": mediaUserToken
      }
    });
    if (!sfRes.ok) {
      throw fail("signIn", tr("Failed to retrieve Apple Music storefront"));
    }
    sfData = await sfRes.json();
  } catch (err) {
    if (isPluginError(err)) {
      throw err;
    }
    throw fail("signIn", tr("Failed to retrieve Apple Music storefront"));
  }
  const initialStorefront = sfData?.data?.[0]?.id || "us";
  const resolved = await resolveSubscriberProfile(
    mediaUserToken,
    devToken,
    initialStorefront
  );
  if (typeof host !== "undefined" && host.storage) {
    try {
      await host.storage.set("auth", {
        mediaUserToken,
        storefront: resolved.storefront,
        account: resolved.account,
        profileVersion: CURRENT_PROFILE_VERSION,
        signedInAt: Date.now()
      });
    } catch (_) {
    }
  }
  return resolved.account;
}
async function signIn() {
  if (typeof host !== "undefined" && typeof host.setting === "function") {
    const pastedToken = cleanMediaUserToken(host.setting("mediaUserToken"));
    if (pastedToken) {
      return verifyAndPersistToken(pastedToken);
    }
  }
  if (typeof host === "undefined" || !host.webSignIn) {
    throw fail("unsupported", "webSignIn host API not supported in this environment");
  }
  const browserUA = host.platform === "darwin" ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  let result;
  try {
    result = await host.webSignIn({
      url: "https://music.apple.com",
      cookiesOf: "https://music.apple.com",
      until: ["media-user-token"],
      userAgent: browserUA
    });
  } catch (err) {
    if (isPluginError(err)) {
      throw err;
    }
    throw fail(
      "signIn",
      tr("The sign-in window was closed before you finished signing in")
    );
  }
  const cookie = result?.cookie;
  const mediaUserToken = extractCookieMediaUserToken(cookie);
  if (!mediaUserToken) {
    throw fail("signIn", tr("Failed to capture Apple Music subscriber session"));
  }
  return verifyAndPersistToken(mediaUserToken);
}
async function signOut() {
  resetRemoteSession();
  resetFavoritesState();
  if (typeof host !== "undefined" && host.storage) {
    try {
      await host.storage.remove("auth");
    } catch (_) {
    }
  }
}
async function account() {
  if (typeof host === "undefined") return null;
  const customName = getCustomDisplayName();
  if (host.storage) {
    try {
      const auth = await host.storage.get("auth");
      const token = cleanMediaUserToken(auth?.mediaUserToken);
      if (auth && token) {
        const storedAcc = auth.account;
        const needsUpgrade = !storedAcc || auth.profileVersion !== CURRENT_PROFILE_VERSION || isLegacyStorefrontPlaceholder(storedAcc.name);
        if (needsUpgrade) {
          try {
            const devToken = await getDeveloperToken();
            const resolved = await resolveSubscriberProfile(
              token,
              devToken,
              auth.storefront || "us"
            );
            const nextAccount = resolved.foundRealProfile || !storedAcc || isLegacyStorefrontPlaceholder(storedAcc.name) ? resolved.account : {
              ...storedAcc,
              name: customName || storedAcc.name,
              imageUrl: resolved.account.imageUrl || storedAcc.imageUrl || ""
            };
            await host.storage.set("auth", {
              ...auth,
              storefront: resolved.storefront || auth.storefront || "us",
              account: nextAccount,
              profileVersion: CURRENT_PROFILE_VERSION
            });
            return nextAccount;
          } catch {
          }
        }
        if (storedAcc) {
          return customName ? { ...storedAcc, name: customName } : storedAcc;
        }
      }
    } catch (_) {
    }
  }
  if (typeof host.setting === "function") {
    const pasted = cleanMediaUserToken(host.setting("mediaUserToken"));
    if (pasted) {
      try {
        const devToken = await getDeveloperToken();
        const resolved = await resolveSubscriberProfile(pasted, devToken, "us");
        if (host.storage) {
          try {
            await host.storage.set("auth", {
              mediaUserToken: pasted,
              storefront: resolved.storefront,
              account: resolved.account,
              profileVersion: CURRENT_PROFILE_VERSION,
              signedInAt: Date.now()
            });
          } catch {
          }
        }
        return resolved.account;
      } catch {
        return {
          id: "apple-music-subscriber",
          name: customName || tr("Apple Music Subscriber"),
          imageUrl: "",
          page: "library"
        };
      }
    }
  }
  return null;
}
async function setSetting(options) {
  const { key, value } = options || {};
  if (typeof host !== "undefined" && host._setSetting) {
    host._setSetting(key, value);
  }
  if (key === "mediaUserToken" && !cleanMediaUserToken(value)) {
    if (typeof host !== "undefined" && host.storage) {
      try {
        await host.storage.remove("auth");
      } catch {
      }
    }
    return;
  }
  if (key === "displayName" && typeof host !== "undefined" && host.storage) {
    try {
      const auth = await host.storage.get("auth");
      if (auth && auth.mediaUserToken) {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed && auth.account) {
          await host.storage.set("auth", {
            ...auth,
            account: { ...auth.account, name: trimmed }
          });
        } else {
          await host.storage.set("auth", {
            ...auth,
            profileVersion: 0
          });
        }
      }
    } catch {
    }
    return;
  }
  if (key === "audioQuality") {
    const mode = parseAudioQualitySetting(value);
    if (mode) {
      await syncMusicAppAudioQuality(mode);
    }
  }
}
export {
  account,
  addToPlaylist,
  album,
  artist,
  browse,
  buildDevicesScript,
  buildPauseScript,
  buildPlayScript,
  buildReadAudioQualityScript,
  buildResumeScript,
  buildSeekScript,
  buildSelectDeviceScript,
  buildStateScript,
  buildVolumeScript,
  buildWriteAudioQualityScript,
  createPlaylist,
  escapeAppleScriptString,
  fail,
  formatArtworkUrl,
  formatAudioQualityLabel,
  getDeveloperToken,
  getStorefront,
  home,
  isLiked,
  like,
  liked,
  lyrics,
  mapAlbum,
  mapArtist,
  mapPlaylist,
  mapTrack,
  openInAppleMusic,
  parseAppleTTML,
  parseAudioQualitySetting,
  parseTtmlTimestamp,
  played,
  playlist,
  playlists,
  readMusicAppAudioQuality,
  recent,
  remoteDevices,
  remotePause,
  remotePlay,
  remoteResume,
  remoteSeek,
  remoteState,
  remoteUse,
  remoteVolume,
  resetRemoteSession,
  saveAlbum,
  savedAlbums,
  search,
  setSetting,
  signIn,
  signOut,
  stationNext,
  stations,
  stream,
  suggest,
  syncMusicAppAudioQuality,
  toMusicAppUrl
};
