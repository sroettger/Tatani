// Japanese tokenizer using kuromoji (IPADIC).
// Dictionary files are fetched from jsDelivr on cold start and cached in module scope.
import * as kuromoji from "https://esm.sh/@patdx/kuromoji@1.0.4";

const DICT_BASE = "https://cdn.jsdelivr.net/npm/@patdx/kuromoji@1.0.4/dict";

// Custom loader: fetch .dat.gz from CDN (retrying once on transient failure), decompress with DecompressionStream.
const loader: kuromoji.LoaderConfig = {
  async loadArrayBuffer(url: string): Promise<ArrayBufferLike> {
    // url ends in `.dat.gz` — kuromoji passes just the filename relative to dicPath
    const filename = url.split("/").pop()!;
    const fullUrl = `${DICT_BASE}/${filename}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(fullUrl);
        if (!res.ok) throw new Error(`Failed to fetch dict ${filename}: ${res.status}`);
        if (!res.body) throw new Error(`Empty dict response body for ${filename}`);
        const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to fetch dict ${filename}`);
  },
};

import { getOfficialJlptLevel } from "./jlpt-lookup.ts";

export type Token = {
  surface_form: string;
  basic_form: string;
  reading?: string;
  pos: string;
  pos_detail_1?: string;
  pos_detail_2?: string;
  word_type?: string;
};

export interface JapaneseTokenizer {
  tokenize(text: string): Token[];
}

let tokenizerPromise: Promise<JapaneseTokenizer> | null = null;

export function getTokenizer(): Promise<JapaneseTokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (new kuromoji.TokenizerBuilder({ loader }).build() as Promise<JapaneseTokenizer>).catch(
      (err: unknown) => {
        tokenizerPromise = null;
        throw err;
      },
    );
  }
  return tokenizerPromise;
}

// POS classes worth surfacing as vocabulary. Filter out particles, aux verbs, interjections (感動詞), symbols, etc.
const STUDY_POS = new Set(["名詞", "動詞", "形容詞", "副詞", "形容動詞", "連体詞"]);

// Skip proper nouns (固有名詞: person names, surnames, places, orgs), numbers, pronouns, dependent forms, affixes, ASCII, etc.
const SKIP_POS_DETAIL = new Set([
  "固有名詞",
  "数",
  "代名詞",
  "非自立",
  "接尾",
  "接頭",
  "接続助詞",
  "アルファベット",
  "間投",
  "特殊",
]);

// Common 2-char hiragana adverbs/conjunctions that are genuine study words rather than conjugation fragments.
const ALLOWED_SHORT_HIRAGANA = new Set([
  "すぐ",
  "まだ",
  "もう",
  "なぜ",
  "よく",
  "ぜひ",
  "ただ",
  "まず",
  "ほぼ",
  "もし",
]);

// Everyday modern 2-char Katakana nouns not in older JLPT lists (all other valid 2-char Katakana like ドア/パン/バス are in JLPT).
// Restricting 2-char Katakana to JLPT + this set blocks 2-char prefixes (イン, アン, サブ, ノン) and 2-char foreign names (レオ, カイ, レン).
const EXTRA_VALID_TWO_CHAR_KATAKANA = new Set([
  "キー",
  "ログ",
  "バグ",
  "タグ",
  "ボス",
  "ギア",
  "ケア",
  "レア",
]);

// Vocalizations, fillers, and interjections that kuromoji sometimes tags as 副詞 or 名詞.
const NOISE_WORDS = new Set([
  "ああ",
  "ええ",
  "うん",
  "ううん",
  "えっと",
  "あのう",
  "うーん",
  "ふん",
  "はあ",
  "ふう",
  "へえ",
  "ふうん",
  "きゃあ",
  "わあ",
  "ぎゃあ",
  "うわ",
  "うわあ",
  "あっ",
  "えっ",
  "おっ",
  "くっ",
  "はっ",
  "ふっ",
  "ちっ",
  "ほら",
  "ねえ",
  "おい",
  "さあ",
]);

// Honorific suffixes that strongly indicate the preceding unlisted noun is a character's name.
const PERSON_HONORIFIC_RE = /^(さん|ちゃん|くん|君|様|さま|殿|氏|嬢)$/;
const KATAKANA_PERSON_HONORIFIC_RE = /^(サン|チャン|クン|サマ|ドノ)$/;
// Role/title endings that can take -さん/-様 without being personal names (e.g. 社長さん, お嬢様, 神様).
const ROLE_NOUN_RE = /(?:[長師士官員生姫王主神仏様客方人者屋店]|^(?:お|ご|御))/;

const TWO_CHAR_KATAKANA_RE = /^[ァ-ヴー]{2}$/;
const CONTIGUOUS_KATAKANA_SEGMENT_RE = /^[ァ-ヴー]+$/;
const PURE_KATAKANA_RE = /^[ァ-ヴー・＝]{2,}$/;

export function katakanaToHiragana(s: string): string {
  return s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const KANA_RE = /[\u3040-\u309F\u30A0-\u30FFー]/;

// Count trailing kana chars in a (possibly mixed kanji+kana) string.
function trailingKanaCount(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (KANA_RE.test(s[i])) n++;
    else break;
  }
  return n;
}

// Get the trailing kana portion of a string.
function trailingKana(s: string): string {
  return s.slice(s.length - trailingKanaCount(s));
}

/**
 * Convert a surface-form reading into the dictionary-form reading.
 * Kuromoji gives `reading` for the inflected `surface_form`, but we store
 * `basic_form` as the word — without this fix, 殴る shows as なぐっ, 助ける as たすけ,
 * and irregular verbs 来る / する would misread as きる / こる.
 */
export function dictionaryFormReading(surface: string, basic: string, surfaceReading: string): string {
  if (basic === "来る") return "くる";
  if (basic === "する") return "する";
  if (!surfaceReading) return "";
  if (surface === basic) return katakanaToHiragana(surfaceReading);
  const surfaceTailLen = trailingKanaCount(surface);
  const basicTail = katakanaToHiragana(trailingKana(basic));
  const stem = surfaceReading.slice(0, Math.max(0, surfaceReading.length - surfaceTailLen));
  return stem + basicTail;
}

export type VocabEntry = {
  word: string; // dictionary form (basic_form)
  reading: string; // hiragana
  part_of_speech: string;
  frequency: number;
  example_sentence_jp: string; // best subtitle line containing the word
};

function canonicalWord(t: Token): string {
  return t.basic_form && t.basic_form !== "*" ? t.basic_form : t.surface_form;
}

/**
 * Reunite contiguous Katakana runs that IPADIC's 2007 lexicon splits into bogus fragments
 * (e.g. インプラント -> イン + プラント, インターフェース -> インター + フェース, パーティー -> パー + ティー).
 * Preserves Katakana person-honorific suffixes (サン/チャン/クン/サマ) and Katakana particles in robot speech.
 */
export function mergeAdjacentKatakanaTokens(tokens: Token[]): Token[] {
  if (tokens.length <= 1) return tokens;

  const isMergeable = (t: Token, hasPrecedingKatakana: boolean): boolean => {
    if (!CONTIGUOUS_KATAKANA_SEGMENT_RE.test(t.surface_form)) return false;
    if (t.pos === "助詞" || t.pos === "助動詞") return false;
    if (hasPrecedingKatakana) {
      if (t.pos_detail_1 === "接尾" && t.pos_detail_2 === "人名") return false;
      if (KATAKANA_PERSON_HONORIFIC_RE.test(t.surface_form)) return false;
    }
    return true;
  };

  const merged: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isMergeable(tokens[i], false)) {
      merged.push(tokens[i]);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < tokens.length && isMergeable(tokens[j], true)) {
      j++;
    }

    if (j === i + 1) {
      merged.push(tokens[i]);
      i++;
      continue;
    }

    const run = tokens.slice(i, j);
    const combinedSurface = run.map((r) => r.surface_form).join("");
    const allProper = run.every(
      (r) =>
        r.pos_detail_1 === "固有名詞" ||
        r.pos_detail_2 === "人名" ||
        r.pos_detail_2 === "地域" ||
        r.pos_detail_2 === "組織",
    );

    merged.push({
      surface_form: combinedSurface,
      basic_form: combinedSurface,
      reading: combinedSurface,
      pos: "名詞",
      pos_detail_1: allProper ? "固有名詞" : "一般",
      pos_detail_2: allProper ? run[0].pos_detail_2 : undefined,
      word_type: "KNOWN",
    });
    i = j;
  }

  return merged;
}

function isEligibleBaseToken(t: Token, word: string): boolean {
  if (!STUDY_POS.has(t.pos)) return false;
  if (t.pos_detail_1 && SKIP_POS_DETAIL.has(t.pos_detail_1)) return false;
  if (
    t.pos_detail_2 === "人名" ||
    t.pos_detail_2 === "地域" ||
    t.pos_detail_2 === "組織" ||
    t.pos_detail_2 === "接頭" ||
    t.pos_detail_2 === "接尾"
  ) {
    return false;
  }
  if (t.word_type === "UNKNOWN") return false;
  if (!word || word.length < 1) return false;
  if (NOISE_WORDS.has(word)) return false;
  if (!/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(word)) return false;
  if (/^[、。！？…・「」『』（）()\sー]+$/.test(word)) return false;

  // Foreign multi-part names with nakaguro/equals (e.g. ロイド・フォージャー, ジャン＝ピエール).
  if (/[・＝]/.test(word) && !getOfficialJlptLevel(word)) return false;

  const isAllKana = /^[\u3040-\u309F\u30A0-\u30FFー]+$/.test(word);
  if (isAllKana && word.length <= 2) {
    const allowedKatakana =
      TWO_CHAR_KATAKANA_RE.test(word) &&
      word !== "ーー" &&
      (Boolean(getOfficialJlptLevel(word)) || EXTRA_VALID_TWO_CHAR_KATAKANA.has(word));
    if (!allowedKatakana && !ALLOWED_SHORT_HIRAGANA.has(word)) return false;
  }
  return true;
}

/**
 * Detect episode-specific coined character names (e.g. アーニャ, フォージャー, フリーレン, ルーシー)
 * that IPADIC hasn't cataloged under 固有名詞, using:
 *  1) Honorific suffix adjacency (-さん, -ちゃん, -くん, -様, etc.) on non-JLPT nouns,
 *  2) Nakaguro adjacency (ロイド + ・ + フォージャー),
 *  3) Standalone vocative katakana callouts ("ルーシー！", "アーニャ、行くぞ").
 */
export function detectCoinedCharacterNames(tokenizedLines: Token[][]): Set<string> {
  const names = new Set<string>();
  const katakanaStats = new Map<string, { total: number; vocative: number }>();

  for (const tokens of tokenizedLines) {
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.pos !== "名詞") continue;
      const word = canonicalWord(t);
      if (!word || getOfficialJlptLevel(word)) continue;

      const prev = k > 0 ? tokens[k - 1] : undefined;
      const next = k + 1 < tokens.length ? tokens[k + 1] : undefined;

      // 1. Honorific suffix immediately following a non-JLPT noun
      if (
        next &&
        ((next.pos_detail_1 === "接尾" && next.pos_detail_2 === "人名") ||
          PERSON_HONORIFIC_RE.test(next.surface_form) ||
          KATAKANA_PERSON_HONORIFIC_RE.test(next.surface_form))
      ) {
        if (PURE_KATAKANA_RE.test(word) || !ROLE_NOUN_RE.test(word)) {
          names.add(word);
          continue;
        }
      }

      // 2. Adjacent to nakaguro separator in foreign full names (ロイド・フォージャー)
      if (
        PURE_KATAKANA_RE.test(word) &&
        (prev?.surface_form === "・" || next?.surface_form === "・")
      ) {
        names.add(word);
        continue;
      }

      // 3. Track vocative callouts for unlisted pure-Katakana nouns
      if (PURE_KATAKANA_RE.test(word)) {
        const stat = katakanaStats.get(word) ?? { total: 0, vocative: 0 };
        stat.total++;
        const isLineInitial = k === 0 || (k === 1 && /^[\s「『（(]+$/.test(tokens[0].surface_form));
        const followedByPauseOrEnd =
          !next ||
          next.pos === "記号" ||
          /^[！？!?、,…ー〜」』）)]+$/.test(next.surface_form);
        if (isLineInitial && followedByPauseOrEnd) {
          stat.vocative++;
        }
        katakanaStats.set(word, stat);
      }
    }
  }

  for (const [word, stat] of katakanaStats) {
    if (stat.vocative >= 2 && stat.vocative / stat.total >= 0.3) {
      names.add(word);
    }
  }

  return names;
}

/**
 * Tokenize subtitles using an explicit tokenizer instance (testable without network) or shared IPADIC.
 */
export function extractVocabWithTokenizer(
  tokenizer: JapaneseTokenizer,
  text: string,
  extraExcludedWords?: ReadonlySet<string>,
): VocabEntry[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const tokenizedLines: Token[][] = [];
  const validLines: string[] = [];

  for (const line of lines) {
    try {
      tokenizedLines.push(mergeAdjacentKatakanaTokens(tokenizer.tokenize(line)));
      validLines.push(line);
    } catch {
      // Skip malformed line
    }
  }

  const coinedNames = detectCoinedCharacterNames(tokenizedLines);

  const map = new Map<
    string,
    { count: number; reading: string; pos: string; exampleLineIdx: number; exampleLineLen: number }
  >();

  for (let i = 0; i < tokenizedLines.length; i++) {
    const line = validLines[i];
    const tokens = tokenizedLines[i];
    for (const t of tokens) {
      const word = canonicalWord(t);
      if (!isEligibleBaseToken(t, word)) continue;
      if (coinedNames.has(word)) continue;
      if (extraExcludedWords?.has(word)) continue;

      const surfaceReading = t.reading ? katakanaToHiragana(t.reading) : "";
      const reading = dictionaryFormReading(t.surface_form, word, surfaceReading);
      const cur = map.get(word);
      if (cur) {
        cur.count++;
        if (line.length <= 80 && line.length > cur.exampleLineLen && cur.exampleLineLen < 30) {
          cur.exampleLineIdx = i;
          cur.exampleLineLen = line.length;
        }
      } else {
        map.set(word, { count: 1, reading, pos: t.pos, exampleLineIdx: i, exampleLineLen: line.length });
      }
    }
  }

  const out: VocabEntry[] = [];
  for (const [word, info] of map) {
    out.push({
      word,
      reading: info.reading,
      part_of_speech: info.pos,
      frequency: info.count,
      example_sentence_jp: validLines[info.exampleLineIdx] ?? "",
    });
  }
  out.sort((a, b) => b.frequency - a.frequency);
  return out;
}

/**
 * Tokenize subtitles, return frequency-ranked vocab with example sentences.
 * `text` should be one subtitle line per "\n".
 */
export async function extractVocabFromSubtitles(
  text: string,
  extraExcludedWords?: ReadonlySet<string>,
): Promise<VocabEntry[]> {
  const tokenizer = await getTokenizer();
  return extractVocabWithTokenizer(tokenizer, text, extraExcludedWords);
}

/**
 * Lightweight set extraction for sibling season episodes (used to compute cross-episode dispersion
 * in ~15ms CPU per episode without calling AI).
 */
export async function extractWordSetFromSubtitles(text: string): Promise<Set<string>> {
  const entries = await extractVocabFromSubtitles(text);
  return new Set(entries.map((e) => e.word));
}
