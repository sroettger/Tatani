// Shared helpers for downloading and normalizing subtitle files.
// Handles zip archives, odd text encodings and SRT/ASS -> plain cue text.
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;

/** Decode bytes, falling back to windows-1252 when UTF-8 yields replacement chars. */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  // BOM sniffing for UTF-16
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length > 1 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad > 0 && bad > utf8.length / 2000) {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8.replace(/^\uFEFF/, "");
}

/** Score a candidate filename against the wanted season/episode. Higher is better. */
export function scoreFilename(name: string, season: number, episode: number): number {
  const n = name.toLowerCase();
  if (!SUB_EXT.test(n) && !/\.(zip)$/i.test(n)) return -1;
  let score = 0;
  const ep = String(episode);
  const pad = ep.padStart(2, "0");
  const se = `s${String(season).padStart(2, "0")}e${pad}`;
  if (n.includes(se)) score += 100;
  if (new RegExp(`(^|[^0-9])e?${pad}([^0-9]|$)`).test(n)) score += 50;
  if (new RegExp(`(^|[^0-9])${ep}([^0-9]|$)`).test(n)) score += 20;
  if (/\.srt$/i.test(n)) score += 5;
  if (/\.ass$|\.ssa$/i.test(n)) score += 3;
  return score;
}

/**
 * Turn a downloaded payload (raw subtitle or zip archive) into subtitle text.
 * Returns null when nothing usable is inside.
 */
export function extractSubtitleText(
  bytes: Uint8Array,
  filename: string,
  season: number,
  episode: number,
): { text: string; filename: string } | null {
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    const text = decodeSubtitleBytes(bytes);
    return text.trim() ? { text, filename } : null;
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return null;
  }
  const candidates = Object.keys(files).filter((k) => SUB_EXT.test(k));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => scoreFilename(b, season, episode) - scoreFilename(a, season, episode));
  const pick = candidates[0];
  const text = decodeSubtitleBytes(files[pick]);
  return text.trim() ? { text, filename: pick } : null;
}

/** Fetch a URL and extract subtitle text from it. */
export async function fetchSubtitleFile(
  url: string,
  season: number,
  episode: number,
  init?: RequestInit,
): Promise<{ text: string; filename: string } | null> {
  const res = await fetch(url, init);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const name = url.split("/").pop() ?? "subtitle";
  return extractSubtitleText(buf, name, season, episode);
}

/** Strip SRT/ASS markup down to plain dialogue lines (one cue per line). */
export function normalizeToCueText(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (/^\s*\[Script Info\]/i.test(text) || /^Dialogue:/m.test(text)) {
    const lines: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("Dialogue:")) continue;
      const parts = line.split(",");
      if (parts.length < 10) continue;
      const body = parts.slice(9).join(",")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N|\\n/gi, " ")
        .trim();
      if (body) lines.push(body);
    }
    return lines.join("\n");
  }
  // SRT / VTT
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n")
      .filter((l) => !/^\d+$/.test(l.trim()))
      .filter((l) => !/-->/.test(l))
      .filter((l) => !/^WEBVTT/i.test(l.trim()));
    const body = lines.join(" ").replace(/<[^>]+>/g, "").trim();
    if (body) out.push(body);
  }
  return out.join("\n");
}
