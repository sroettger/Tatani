// Official JLPT vocab lookup. Source: github.com/elzup/jlpt-word-list
// Returns the easiest JLPT level (e.g. N5 over N3) for a given word.
import jlptData from "./jlpt-vocab.json" with { type: "json" };

type JlptLevel = "N5" | "N4" | "N3" | "N2" | "N1";
type Data = { byPair: Record<string, JlptLevel>; byWord: Record<string, JlptLevel> };
const data = jlptData as Data;

/**
 * Look up the official JLPT level for a vocab item.
 * Priority: exact word+reading match → word-only match → null.
 */
export function getOfficialJlptLevel(word: string, reading?: string | null): JlptLevel | null {
  if (!word) return null;
  const w = word.trim();
  if (reading) {
    const hit = data.byPair[`${w}|${reading.trim()}`];
    if (hit) return hit;
  }
  return data.byWord[w] ?? null;
}
