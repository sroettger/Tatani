// Shared helpers for downloading and normalizing subtitle files.
// Handles zip archives, odd text encodings and SRT/ASS/VTT -> clean dialogue text.
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_UNZIP_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT_MS = 15_000; // 15s

const VIDEO_CODEC_TOKENS_RE =
  /(?<![a-z0-9])(?:2160p|1080p|720p|480p|x264|x265|h\.?264|h\.?265|hevc|10bit|hi10p|aac\d*(?:[._]\d+)?|flac)(?![a-z0-9])/gi;

/** Decode bytes, stripping leading UTF-8/UTF-16 BOM and falling back to windows-1252 when UTF-8 yields replacement chars. */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  // BOM sniffing for UTF-16
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "");
  }
  if (bytes.length > 1 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes).replace(/^\uFEFF/, "");
  }
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad > 0 && bad > utf8.length / 2000) {
    try {
      return new TextDecoder("windows-1252").decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      return utf8.replace(/^\uFEFF/, "");
    }
  }
  return utf8.replace(/^\uFEFF/, "");
}

/** Score a candidate filename against the wanted season/episode. Higher is better. */
export function scoreFilename(name: string, season: number, episode: number): number {
  const n = name.toLowerCase();
  if (!SUB_EXT.test(n) && !/\.(zip)$/i.test(n)) return -1;
  const stripped = n.replace(VIDEO_CODEC_TOKENS_RE, " ");
  let score = 0;
  const ep = String(episode);
  const pad = ep.padStart(2, "0");
  const se = `s${String(season).padStart(2, "0")}e${pad}`;
  if (stripped.includes(se)) score += 100;
  if (new RegExp(`(^|[^0-9])e?${pad}([^0-9]|$)`).test(stripped)) score += 50;
  if (new RegExp(`(^|[^0-9])${ep}([^0-9]|$)`).test(stripped)) score += 20;
  if (/\.srt$/i.test(n)) score += 5;
  if (/\.ass$|\.ssa$/i.test(n)) score += 3;
  return score;
}

/**
 * Turn a downloaded payload (raw subtitle or zip archive) into subtitle text.
 * Filters out embedded fonts and oversized archive entries before decompression.
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
    files = unzipSync(bytes, {
      filter: (file) => SUB_EXT.test(file.name) && file.originalSize <= MAX_UNZIP_FILE_BYTES,
    });
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

/** Fetch a URL (bounded to 15 MB and 15s timeout) and extract subtitle text from it. */
export async function fetchSubtitleFile(
  url: string,
  season: number,
  episode: number,
  init?: RequestInit,
): Promise<{ text: string; filename: string } | null> {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }

  let buf: Uint8Array;
  try {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    }
    buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch {
    return null;
  }

  const name = url.split("/").pop()?.split("?")[0] ?? "subtitle";
  return extractSubtitleText(buf, name, season, episode);
}

function decodeSubtitleHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&lrm;|&rlm;/gi, "")
    .replace(/&amp;/gi, "&");
}

function cleanSingleDialogueLine(rawLine: string): string {
  let line = rawLine;
  // Drop ASS vector drawing spans (`{\p1}...{\p0}` or `{\p1}...` to end of line) before stripping `{...}` tags.
  line = line.replace(/\{[^}]*\\p[1-9]\d*[^}]*\}[\s\S]*?(?:\{[^}]*\\p0[^}]*\}|$)/gi, "");
  // Strip remaining ASS override blocks and line-break / hard-space escapes.
  line = line.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]|\\h/g, " ");
  // Remove ruby `<rt>` and `<rp>` annotations BEFORE stripping general HTML/VTT tags.
  line = line
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "")
    .replace(/<[^>]+>/g, "");
  // Decode HTML entities after tag removal.
  line = decodeSubtitleHtmlEntities(line);
  // Strip inline Kanji furigana like 漢字（かんじ） or 漢字(かんじ).
  line = line.replace(/([\u3400-\u4DBF\u4E00-\u9FFF々]+)[（(][\u3040-\u309Fー]+[）)]/g, "$1");
  line = line.replace(/[ \t]+/g, " ").trim();
  if (!line) return "";

  // Strip leading speaker prefix ONLY when dialogue follows on the same line, preserving inner monologues like `（どうして…？）`.
  line = line.replace(/^[（(][^）)]{1,12}[）)]\s+(?=\S)/, "").trim();
  if (!line) return "";

  // Drop pure music-note lines.
  if (/^[♪♫〜～\s]+$/.test(line)) return "";

  // Drop pure stage/SFX cues ending in 音/息/声/音楽/拍手/笑 while keeping inner monologues.
  const stageMatch = /^[（([［【]([^）)\]］】]{1,20})[）)\]］】]$/.exec(line);
  if (stageMatch && /(?:音楽|拍手|音|息|声|笑)$/.test(stageMatch[1].trim())) {
    return "";
  }

  return line;
}

const ASS_META_RE =
  /^(Format|Style|Title|ScriptType|Collisions|PlayRes[XY]|Timer|WrapStyle|ScaledBorderAndShadow|YCbCr Matrix|Audio URI|Video URI|Original\s|Update\s|Synch Point|Script Updated By|Comment|PlayDepth):/i;

/**
 * Clean raw SRT/VTT/ASS/plain subtitle text into clean, deduplicated dialogue lines.
 */
export function cleanSubtitleDialogue(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rawLines = normalized.split("\n");
  const out: string[] = [];

  let skipUntilBlank = false;
  let atBlockStart = true;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      skipUntilBlank = false;
      atBlockStart = true;
      continue;
    }

    if (skipUntilBlank) {
      continue;
    }

    // Drop WebVTT header and NOTE / STYLE / REGION blocks.
    if (atBlockStart && /^(WEBVTT|NOTE|STYLE|REGION)(\s|$|:)/i.test(trimmed)) {
      skipUntilBlank = true;
      atBlockStart = false;
      continue;
    }

    // Drop SRT sequence numbers and VTT cue identifiers immediately preceding a timestamp line.
    if (/^\d+$/.test(trimmed)) {
      atBlockStart = false;
      continue;
    }
    if (atBlockStart && !trimmed.includes("-->") && i + 1 < rawLines.length && rawLines[i + 1].includes("-->")) {
      atBlockStart = false;
      continue;
    }
    if (trimmed.includes("-->")) {
      atBlockStart = false;
      continue;
    }

    atBlockStart = false;

    // Drop ASS section headers and metadata/comment lines.
    if (/^\[.*\]$/.test(trimmed)) continue;
    if (ASS_META_RE.test(trimmed)) continue;

    let candidate = line;
    if (/^Dialogue:/i.test(trimmed)) {
      const parts = line.split(",");
      if (parts.length < 10) continue;
      candidate = parts.slice(9).join(",");
    }

    const cleaned = cleanSingleDialogueLine(candidate);
    if (cleaned && cleaned !== out[out.length - 1]) {
      out.push(cleaned);
    }
  }

  return out.join("\n");
}

/** Strip SRT/ASS markup down to plain dialogue lines (one cue per line). */
export function normalizeToCueText(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^\s*\[Script Info\]/i.test(text) || /^Dialogue:/m.test(text)) {
    const lines: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("Dialogue:")) continue;
      const parts = line.split(",");
      if (parts.length < 10) continue;
      const body = cleanSingleDialogueLine(parts.slice(9).join(","));
      if (body) lines.push(body);
    }
    return lines.join("\n");
  }
  // SRT / VTT
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const firstTrimmed = block.trimStart();
    if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$|:)/i.test(firstTrimmed)) continue;
    const rawBlockLines = block.split("\n");
    const lines = rawBlockLines
      .filter((l, idx) => {
        const t = l.trim();
        if (!t) return false;
        if (/^\d+$/.test(t)) return false;
        if (idx === 0 && !t.includes("-->") && rawBlockLines[1]?.includes("-->")) return false;
        if (t.includes("-->")) return false;
        if (/^WEBVTT/i.test(t)) return false;
        return true;
      });
    const body = cleanSingleDialogueLine(lines.join(" "));
    if (body) out.push(body);
  }
  return out.join("\n");
}
