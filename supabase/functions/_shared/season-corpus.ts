// Zero-AI season-wide vocabulary dispersion & importance ranking.
// Combines cross-episode Document Frequency (from cached sibling episodes + lightweight
// Kitsunekko subtitle sampling) with JLPT/CEFR core language utility weights — without
// running AI translation on the whole season.

import { cleanSubtitleDialogue, fetchSubtitleFile } from "./subtitles.ts";
import type { VocabEntry } from "./tokenize-jp.ts";

export type SeasonRankedVocab = VocabEntry & {
  level: string;
  episodeFrequency: number;
  seasonEpisodeHits: number;
  importanceScore: number;
};

const CORE_LEVEL_WEIGHT: Record<string, number> = {
  N5: 2.1,
  N4: 2.1,
  N3: 1.95,
  N2: 1.65,
  N1: 1.35,
  A1: 2.05,
  A2: 2.0,
  B1: 1.85,
  B2: 1.55,
  C1: 1.3,
  C2: 1.15,
};

export function computeLevelUtilityWeight(
  level: string,
  siblingEpisodeHits: number,
  sampledSiblingCount: number,
): number {
  const core = CORE_LEVEL_WEIGHT[level];
  if (core !== undefined) return core;

  // Unlisted ("none") words: reward words that recur across multiple episodes of the anime,
  // and dampen one-off scene-specific words when we have sibling episode coverage.
  if (siblingEpisodeHits >= 2) return 1.35;
  if (siblingEpisodeHits === 1) return 1.0;
  if (sampledSiblingCount >= 3) return 0.55;
  return 0.8;
}

/**
 * Rank single-episode vocabulary using cross-episode dispersion + core JLPT/CEFR utility,
 * and set `frequency` to a season-weighted priority integer so existing Web & Android
 * clients (`frequency * 10 + levelBonus`) surface recurring season words ahead of one-scene outliers.
 */
export function rankVocabBySeasonAndUtility(
  entries: VocabEntry[],
  levelResolver: (entry: VocabEntry) => string,
  siblingDocFreq: ReadonlyMap<string, number>,
  sampledSiblingCount: number,
): SeasonRankedVocab[] {
  const ranked: SeasonRankedVocab[] = entries.map((entry) => {
    const epFreq = Math.max(1, entry.frequency);
    const sibHits = siblingDocFreq.get(entry.word) ?? 0;
    const level = levelResolver(entry);
    const levelWeight = computeLevelUtilityWeight(level, sibHits, sampledSiblingCount);
    const seasonBoost = 1 + sibHits * 1.75;
    // Cap raw single-episode repetition at 12 + log1p so a gag word shouted 35x in one scene
    // does not crowd out recurring multi-episode vocabulary.
    const cappedEpTerm = Math.min(epFreq, 12) + Math.log1p(epFreq);
    const importanceScore = cappedEpTerm * seasonBoost * levelWeight;
    const effectiveFrequency = Math.max(epFreq, Math.round(epFreq + sibHits * 2));

    return {
      ...entry,
      frequency: effectiveFrequency,
      episodeFrequency: epFreq,
      seasonEpisodeHits: sibHits,
      level,
      importanceScore,
    };
  });

  ranked.sort((a, b) => b.importanceScore - a.importanceScore || b.episodeFrequency - a.episodeFrequency);
  return ranked;
}

/* ---------- Lightweight Kitsunekko Sibling Episode Sampling (0 AI) --------- */

const UA = "Tatani v2.0";

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

function sanitizeDirName(raw: string): string {
  let s = raw;
  for (const [from, to] of WINDOWS_SUBSTITUTE) {
    s = s.split(from).join(to);
  }
  s = s.replace(/[ _\\\n\t\r#{}<>^*/:"`?'|]+/g, " ");
  return s.replace(/\s{2,}/g, " ").trim().replace(/^[ .]+|[ .]+$/g, "");
}

function expandVariants(titles: string[]): string[] {
  const out = new Set<string>();
  for (const raw of titles) {
    const base = raw.trim();
    if (!base) continue;
    out.add(base);
    out.add(base.replace(/\s*x\s*/gi, "×"));
    out.add(base.replace(/×/g, " x "));
    const mSeason = /^(.*?)\s+Season\s+(\d+)$/i.exec(base);
    if (mSeason) {
      const n = Number(mSeason[2]);
      const ord = n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
      out.add(`${mSeason[1]} ${ord} Season`);
      out.add(`${mSeason[1]} ${n}`);
    }
  }
  return Array.from(out).filter((v) => v.length > 0);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const VIDEO_CODEC_RE =
  /(?<![a-z0-9])(?:2160p|1080p|720p|480p|x264|x265|h\.?264|h\.?265|hevc|10bit|hi10p|aac\d*(?:[._]\d+)?|flac)(?![a-z0-9])/gi;

function inferEpisodeNumber(filename: string): number | null {
  const n = filename.toLowerCase().replace(VIDEO_CODEC_RE, " ");
  if (!/\.(srt|ass|ssa|vtt)$/i.test(n)) return null;

  const patterns = [
    /s\d{1,2}e(\d{1,3})(?:[^0-9]|$)/,
    /(?:^|[^0-9a-z])(?:ep?|episode)\s*(\d{1,3})(?:[^0-9]|$)/,
    /-\s*(\d{2,3})(?:v\d+)?(?:\s*[[(.)]|\s*$)/,
    /(?:^|[^0-9])(\d{2})(?:[^0-9]|$)/,
  ];
  for (const re of patterns) {
    const m = re.exec(n);
    if (m) {
      const ep = Number(m[1]);
      if (ep >= 1 && ep <= 500) return ep;
    }
  }
  return null;
}

/**
 * Sample up to `maxSamples` sibling episodes' cleaned dialogue from `subtitles.ajatt.top`
 * within a strict `timeoutMs` wall-clock budget (zero AI calls).
 */
export async function sampleKitsunekkoSiblingDialogues(opts: {
  titles: string[];
  season: number;
  excludeEpisode: number;
  maxSamples?: number;
  timeoutMs?: number;
}): Promise<string[]> {
  const maxSamples = opts.maxSamples ?? 5;
  const timeoutMs = opts.timeoutMs ?? 3200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const variants = expandVariants(opts.titles);
    let html: string | null = null;

    for (const v of variants) {
      const sanitized = sanitizeDirName(v);
      if (!sanitized) continue;
      const slug = encodeURIComponent(sanitized.toLowerCase().replace(/[ _]/g, "-"));
      for (const cat of ["anime_tv", "unsorted"]) {
        const res = await fetch(`https://subtitles.ajatt.top/${cat}/${slug}.html`, {
          headers: { "User-Agent": UA },
          signal: controller.signal,
        });
        if (res.ok) {
          html = await res.text();
          break;
        }
      }
      if (html) break;
    }
    if (!html) return [];

    const byEpisode = new Map<number, { url: string; isSrt: boolean }>();
    const re = /data-download-url="([^"]+)"\s+data-filename="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const url = decodeEntities(m[1]);
      const fn = decodeEntities(m[2]);
      if (/\.zip$/i.test(fn)) continue; // Prefer direct text files for fast sampling
      const ep = inferEpisodeNumber(fn);
      if (!ep || ep === opts.excludeEpisode) continue;
      const isSrt = /\.srt$/i.test(fn);
      const prev = byEpisode.get(ep);
      if (!prev || (isSrt && !prev.isSrt)) {
        byEpisode.set(ep, { url, isSrt });
      }
    }

    const sortedEps = Array.from(byEpisode.entries()).sort((a, b) => a[0] - b[0]);
    if (sortedEps.length === 0) return [];

    // Spread samples evenly across the season so recurring show-wide words win over 2-episode mini-arcs.
    const chosen: Array<{ url: string; ep: number }> = [];
    if (sortedEps.length <= maxSamples) {
      for (const [ep, info] of sortedEps) chosen.push({ url: info.url, ep });
    } else {
      for (let i = 0; i < maxSamples; i++) {
        const idx = Math.floor((i * (sortedEps.length - 1)) / Math.max(1, maxSamples - 1));
        const [ep, info] = sortedEps[idx];
        chosen.push({ url: info.url, ep });
      }
    }

    const dialogues = await Promise.all(
      chosen.map(async ({ url, ep }) => {
        try {
          const file = await fetchSubtitleFile(url, opts.season, ep, {
            headers: { "User-Agent": UA },
            signal: controller.signal,
          });
          if (!file?.text) return null;
          const cleaned = cleanSubtitleDialogue(file.text);
          return cleaned.trim() ? cleaned : null;
        } catch {
          return null;
        }
      }),
    );

    return dialogues.filter((d): d is string => Boolean(d));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
