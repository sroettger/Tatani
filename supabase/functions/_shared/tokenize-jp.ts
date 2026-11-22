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

export type Token = {
  surface_form: string;
  basic_form: string;
  reading?: string;
  pos: string;
  pos_detail_1?: string;
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

// POS classes worth surfacing as vocabulary. Filter out particles, aux verbs, symbols, etc.
const STUDY_POS = new Set(["名詞", "動詞", "形容詞", "副詞", "形容動詞", "連体詞"]);

// Skip these noun subtypes (numbers, pronouns, suffixes) — too noisy as vocab.
const SKIP_POS_DETAIL = new Set(["数", "代名詞", "非自立", "接尾", "接続助詞"]);

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

// 2-char Katakana loanwords (e.g. パン, ドア, バス, キー).
const TWO_CHAR_KATAKANA_RE = /^[ァ-ヴー]{2}$/;

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

/**
 * Tokenize subtitles, return frequency-ranked vocab with example sentences.
 * `text` should be one subtitle line per "\n".
 */
export async function extractVocabFromSubtitles(text: string): Promise<VocabEntry[]> {
  const tokenizer = await getTokenizer();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  // word -> { count, reading, pos, exampleLineIdx (shortest contextual line containing it) }
  const map = new Map<
    string,
    { count: number; reading: string; pos: string; exampleLineIdx: number; exampleLineLen: number }
  >();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let tokens: Token[];
    try {
      tokens = tokenizer.tokenize(line);
    } catch {
      continue;
    }
    for (const t of tokens) {
      if (!STUDY_POS.has(t.pos)) continue;
      if (t.pos_detail_1 && SKIP_POS_DETAIL.has(t.pos_detail_1)) continue;
      // Drop UNKNOWN tokens entirely — kuromoji tags every unrecognized symbol/emoji as 名詞.
      if (t.word_type === "UNKNOWN") continue;
      const word = t.basic_form && t.basic_form !== "*" ? t.basic_form : t.surface_form;
      if (!word || word.length < 1) continue;
      // Must contain at least one Japanese character (kanji, hiragana, or katakana).
      if (!/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(word)) continue;
      // Skip pure-kana single chars and punctuation-y stuff.
      if (/^[、。！？…・「」『』（）()\s]+$/.test(word)) continue;

      const isAllKana = /^[\u3040-\u309F\u30A0-\u30FFー]+$/.test(word);
      if (isAllKana && word.length <= 2) {
        const allowedKatakana = TWO_CHAR_KATAKANA_RE.test(word) && word !== "ーー";
        if (!allowedKatakana && !ALLOWED_SHORT_HIRAGANA.has(word)) continue;
      }

      const surfaceReading = t.reading ? katakanaToHiragana(t.reading) : "";
      const reading = dictionaryFormReading(t.surface_form, word, surfaceReading);
      const cur = map.get(word);
      if (cur) {
        cur.count++;
        // Prefer a slightly longer example line (more context) but cap at 80 chars.
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
      example_sentence_jp: lines[info.exampleLineIdx] ?? "",
    });
  }
  // Sort by frequency desc, stable.
  out.sort((a, b) => b.frequency - a.frequency);
  return out;
}
