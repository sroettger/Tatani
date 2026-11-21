// Pure directory sanitization and episode filename scoring helpers for Ajatt-Tools/kitsunekko-mirror.

const WINDOWS_SUBSTITUTE: Array<[string, string]> = [
  ["??", "2"],
  ["||", "2"],
  ["'", "’"],
  ["\\", "⧵"],
  ["/", "∕"],
  [":", "."],
  ["?", "？"],
  ["|", "⏐"],
];

/** Exact directory name sanitizer used by Ajatt-Tools/kitsunekko-mirror. */
export function kitsuSanitizeDirName(raw: string): string {
  let s = raw;
  for (const [from, to] of WINDOWS_SUBSTITUTE) {
    s = s.split(from).join(to);
  }
  s = s.replace(/[ _\\\n\t\r#{}<>^*/:"`?'|]+/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim().replace(/^[ .]+|[ .]+$/g, "");
  return s;
}

/**
 * Episode-aware filename scorer that requires an actual episode number match
 * (unless `allowMovieFallback` is enabled for Episode 1 movies/specials).
 */
export function scoreEpisodeFilename(
  name: string,
  season: number,
  episode: number,
  allowMovieFallback = false,
): number {
  const n = name.toLowerCase();
  if (!/\.(srt|ass|ssa|vtt|zip)$/i.test(n)) return -1;

  const ep = String(episode);
  const pad = ep.padStart(2, "0");
  const pad3 = ep.padStart(3, "0");
  const se = `s${String(season).padStart(2, "0")}e${pad}`;

  let score = 0;
  let matched = false;

  if (n.includes(se)) {
    score += 120;
    matched = true;
  }
  if (new RegExp(`s\\d{1,2}e${pad}([^0-9]|$)`).test(n)) {
    score += 100;
    matched = true;
  }
  if (new RegExp(`(^|[^0-9a-z])(ep?|episode)\\s*${pad}([^0-9]|$)`).test(n)) {
    score += 90;
    matched = true;
  }
  if (new RegExp(`-\\s*${pad}(v\\d+)?(\\s*[\\[\\(.]|\\s*$)`).test(n)) {
    score += 85;
    matched = true;
  }
  if (new RegExp(`(^|[^0-9])${pad}([^0-9]|$)`).test(n)) {
    score += 50;
    matched = true;
  } else if (new RegExp(`(^|[^0-9])${pad3}([^0-9]|$)`).test(n)) {
    score += 45;
    matched = true;
  } else if (new RegExp(`(^|[^0-9])${ep}([^0-9]|$)`).test(n)) {
    score += 20;
    matched = true;
  }

  if (!matched) {
    if (!allowMovieFallback || episode !== 1) return -1;
    score += 5;
  }

  if (/\.srt$/i.test(n)) score += 6;
  else if (/\.(ass|ssa)$/i.test(n)) score += 4;
  return score;
}
