// Vocabulary extraction for space-separated languages (Spanish, French, German).
// No morphological analyzer: we tokenize on word boundaries, drop function words,
// and let the AI supply the dictionary form + meaning later in the pipeline.
import type { VocabEntry } from "./tokenize-jp.ts";

const STOPWORDS: Record<string, Set<string>> = {
  es: new Set("el la los las un una unos unas de del a al y o u que qué en con por para se su sus mi mis tu tus lo le les me te nos os es son era eran ser soy eres estoy está están este esta esto esos esas ese esa no sí ni pero si ya muy más menos como cuando donde quien porque he has ha hemos han hay fue fui era voy va van vamos".split(/\s+/)),
  fr: new Set("le la les un une des de du au aux à et ou que qui quoi en dans avec pour par sur se sa ses son mon mes ton tes ne pas plus moins très ce cet cette ces c'est je tu il elle nous vous ils elles on est sont était étaient suis es avoir être ai as a avons avez ont fait y d l qu s j n m t".split(/\s+/)),
  de: new Set("der die das den dem des ein eine einen einem einer eines und oder aber wenn dass weil als wie was wer wo ich du er sie es wir ihr mich dich sich uns euch mein dein sein ihre ihr nicht kein keine ist sind war waren bin bist sein haben hat habe hast hatte zu in an auf für mit von bei nach aus über unter noch nur schon auch doch mal so da hier".split(/\s+/)),
};

const WORD_RE = /[\p{L}][\p{L}'’-]*/gu;

/**
 * Tokenize latin-script subtitles into frequency-ranked vocabulary.
 * `text` is one subtitle line per "\n".
 */
export function extractVocabLatin(text: string, lang: string): VocabEntry[] {
  const stop = STOPWORDS[lang] ?? new Set<string>();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const map = new Map<string, { count: number; display: string; exampleIdx: number; exampleLen: number }>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = line.match(WORD_RE) ?? [];
    for (const raw of matches) {
      const token = raw.replace(/^['’-]+|['’-]+$/g, "");
      if (token.length < 2) continue;
      const key = token.toLocaleLowerCase(lang);
      if (stop.has(key)) continue;
      if (/^\d+$/.test(key)) continue;
      // German nouns are capitalised — keep the original casing for display there.
      const display = lang === "de" && /^\p{Lu}/u.test(token) ? token : key;
      const cur = map.get(key);
      if (cur) {
        cur.count++;
        if (line.length <= 120 && line.length > cur.exampleLen && cur.exampleLen < 40) {
          cur.exampleIdx = i;
          cur.exampleLen = line.length;
        }
      } else {
        map.set(key, { count: 1, display, exampleIdx: i, exampleLen: line.length });
      }
    }
  }

  const out: VocabEntry[] = [];
  for (const [, info] of map) {
    out.push({
      word: info.display,
      reading: "",
      part_of_speech: "",
      frequency: info.count,
      example_sentence_jp: lines[info.exampleIdx] ?? "",
    });
  }
  out.sort((a, b) => b.frequency - a.frequency);
  return out;
}
