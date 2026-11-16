import { Lyrics, LyricLine, LyricWord } from "./types.js";

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
