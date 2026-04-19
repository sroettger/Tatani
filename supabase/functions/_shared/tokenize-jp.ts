// Japanese tokenizer using kuromoji (IPADIC).
// Dictionary files are fetched from jsDelivr on cold start and cached in module scope.
import * as kuromoji from "https://esm.sh/@patdx/kuromoji@1.0.4";

const DICT_BASE = "https://cdn.jsdelivr.net/npm/@patdx/kuromoji@1.0.4/dict";

// Custom loader: fetch .dat.gz from CDN, decompress with DecompressionStream.
const loader: kuromoji.LoaderConfig = {
  async loadArrayBuffer(url: string): Promise<ArrayBufferLike> {
    // url ends in `.dat.gz` — kuromoji passes just the filename relative to dicPath
    const filename = url.split("/").pop()!;
    const fullUrl = `${DICT_BASE}/${filename}`;
    const res = await fetch(fullUrl);
    if (!res.ok) throw new Error(`Failed to fetch dict ${filename}: ${res.status}`);
    const stream = res.body!.pipeThrough(new DecompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return buf;
  },
};

let tokenizerPromise: Promise<any> | null = null;

export function getTokenizer(): Promise<any> {
  if (!tokenizerPromise) {
    tokenizerPromise = new kuromoji.TokenizerBuilder({ loader }).build();
  }
  return tokenizerPromise;
}

export type Token = {
  surface_form: string;
  basic_form: string;
  reading?: string;
  pos: string;
  pos_detail_1?: string;
};

// POS classes worth surfacing as vocabulary. Filter out particles, aux verbs, symbols, etc.
const STUDY_POS = new Set(["名詞", "動詞", "形容詞", "副詞", "形容動詞", "連体詞"]);

// Skip these noun subtypes (numbers, pronouns, suffixes) — too noisy as vocab.
const SKIP_POS_DETAIL = new Set(["数", "代名詞", "非自立", "接尾", "接続助詞"]);

function katakanaToHiragana(s: string): string {
  return s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export type VocabEntry = {
  word: string;       // dictionary form (basic_form)
  reading: string;    // hiragana
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

  // word -> { count, reading, pos, exampleLineIdx (shortest line containing it) }
  const map = new Map<string, { count: number; reading: string; pos: string; exampleLineIdx: number; exampleLineLen: number }>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let tokens: Token[];
    try {
      tokens = tokenizer.tokenize(line) as Token[];
    } catch {
      continue;
    }
    for (const t of tokens) {
      if (!STUDY_POS.has(t.pos)) continue;
      if (t.pos_detail_1 && SKIP_POS_DETAIL.has(t.pos_detail_1)) continue;
      // Drop UNKNOWN tokens entirely — kuromoji tags every unrecognized symbol/emoji as 名詞.
      if ((t as any).word_type === "UNKNOWN") continue;
      const word = t.basic_form && t.basic_form !== "*" ? t.basic_form : t.surface_form;
      if (!word || word.length < 1) continue;
      // Must contain at least one Japanese character (kanji, hiragana, or katakana).
      if (!/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(word)) continue;
      // Skip pure-kana single chars and punctuation-y stuff.
      if (/^[、。！？…・「」『』（）()\s]+$/.test(word)) continue;
      // Drop short pure-hiragana/katakana "words" (1-2 chars) — these are almost always
      // tokenizer fragments from conjugations (ちゃ, しょ, ばー, やや) rather than real vocab.
      // Real short kana words (e.g. 目, 手) are kanji and pass this filter.
      const isAllKana = /^[\u3040-\u309F\u30A0-\u30FFー]+$/.test(word);
      if (isAllKana && word.length <= 2) continue;

      const reading = t.reading ? katakanaToHiragana(t.reading) : "";
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
