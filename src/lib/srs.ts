export const SRS_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60, 120, 240, 480] as const;
export const LEARN_BATCH_SIZE = 6;
export const LEARN_GRADUATION_RECALLS = 2;
export const SPRINT_LAPSE_REINSERT_GAP = 4;

export type WordStateKind = "unknown" | "learning" | "known";
export type WordPreferenceKind = "study" | "kanji_only" | "skip";
export type KnownSourceKind = "prior" | "learned" | null;

export interface WordSrsRecord {
  word: string;
  reading: string | null;
  level: string | null;
  state: WordStateKind;
  preference: WordPreferenceKind;
  known_source: KnownSourceKind;
  correct_streak: number;
  srs_level: number;
  srs_due_at: string | null;
  last_reviewed_at: string | null;
  marked_known_at?: string | null;
}

export interface WordContextSentence {
  jp: string;
  en: string;
  animeTitle?: string;
  episodeNumber?: number;
  episodeId?: string;
}

export interface SrsDeckCard extends WordSrsRecord {
  meaning: string;
  part_of_speech: string;
  frequency: number;
  contexts: WordContextSentence[];
}

export function dueAtFromDays(days: number, nowMs = Date.now()): string {
  return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
}

export function nextIntervalDaysForGrade(prev: Pick<WordSrsRecord, "srs_level" | "srs_due_at"> | undefined, remembered: boolean): number {
  if (!remembered) return SRS_INTERVALS_DAYS[0];
  if (!prev || !prev.srs_due_at) return SRS_INTERVALS_DAYS[0];
  const nextIdx = Math.min((prev.srs_level ?? 0) + 1, SRS_INTERVALS_DAYS.length - 1);
  return SRS_INTERVALS_DAYS[nextIdx];
}

export function computeNextSrsState(
  prev: Partial<WordSrsRecord> | undefined,
  meta: { word: string; reading: string | null; level: string | null },
  remembered: boolean,
  nowMs = Date.now(),
): WordSrsRecord {
  const nowIso = new Date(nowMs).toISOString();
  const wasGraduated = Boolean(prev?.srs_due_at);
  const prevStreak = prev?.correct_streak ?? 0;
  const prevLevel = prev?.srs_level ?? 0;

  if (remembered) {
    const nextLevel = wasGraduated
      ? Math.min(prevLevel + 1, SRS_INTERVALS_DAYS.length - 1)
      : 0;
    const days = SRS_INTERVALS_DAYS[nextLevel];
    return {
      word: meta.word,
      reading: meta.reading ?? prev?.reading ?? null,
      level: meta.level ?? prev?.level ?? null,
      state: "known",
      preference: prev?.preference ?? "study",
      known_source: "learned",
      correct_streak: prevStreak + 1,
      srs_level: nextLevel,
      srs_due_at: dueAtFromDays(days, nowMs),
      last_reviewed_at: nowIso,
      marked_known_at: prev?.marked_known_at ?? nowIso,
    };
  }

  return {
    word: meta.word,
    reading: meta.reading ?? prev?.reading ?? null,
    level: meta.level ?? prev?.level ?? null,
    state: "learning",
    preference: prev?.preference ?? "study",
    known_source: "learned",
    correct_streak: 0,
    srs_level: 0,
    srs_due_at: dueAtFromDays(SRS_INTERVALS_DAYS[0], nowMs),
    last_reviewed_at: nowIso,
    marked_known_at: prev?.marked_known_at ?? null,
  };
}

export function computePriorKnownState(
  prev: Partial<WordSrsRecord> | undefined,
  meta: { word: string; reading: string | null; level: string | null },
  nowMs = Date.now(),
): WordSrsRecord {
  const nowIso = new Date(nowMs).toISOString();
  return {
    word: meta.word,
    reading: meta.reading ?? prev?.reading ?? null,
    level: meta.level ?? prev?.level ?? null,
    state: "known",
    preference: prev?.preference ?? "study",
    known_source: "prior",
    correct_streak: prev?.correct_streak ?? 0,
    srs_level: 0,
    srs_due_at: null,
    last_reviewed_at: prev?.last_reviewed_at ?? null,
    marked_known_at: nowIso,
  };
}

export function isGraduatedForSrs(
  row: Pick<WordSrsRecord, "preference" | "known_source" | "srs_due_at"> | undefined,
): boolean {
  if (!row) return false;
  if (row.preference === "skip") return false;
  if (row.known_source === "prior") return false;
  return Boolean(row.srs_due_at);
}

export function isDueForSprint(
  row: Pick<WordSrsRecord, "preference" | "known_source" | "srs_due_at"> | undefined,
  nowMs = Date.now(),
): boolean {
  if (!isGraduatedForSrs(row)) return false;
  return new Date(row!.srs_due_at!).getTime() <= nowMs;
}

export function isUnlearnedCandidate(
  row: Pick<WordSrsRecord, "state" | "preference" | "known_source" | "srs_due_at"> | undefined,
  isBelowUserLevel: boolean,
): boolean {
  if (row?.preference === "skip") return false;
  if (row?.known_source === "prior") return false;
  if (row?.srs_due_at) return false;
  if (row?.state === "known") return false;
  if (!row && isBelowUserLevel) return false;
  return true;
}

/**
 * Rotates across unlocked episode contexts so repeated reviews don't habituate
 * to a single static sentence (Bolger et al., 2008).
 */
export function pickContextualSentence(
  contexts: WordContextSentence[],
  seed = 0,
): WordContextSentence | null {
  const valid = contexts.filter(c => c.jp.trim().length > 0);
  if (valid.length === 0) return null;
  const index = Math.abs(seed) % valid.length;
  return valid[index];
}

export interface SentenceSegment {
  text: string;
  highlighted: boolean;
}

export function splitSentenceWithHighlight(sentence: string, targetWord: string): SentenceSegment[] {
  if (!sentence) return [];
  const trimmed = targetWord.trim();
  if (!trimmed) return [{ text: sentence, highlighted: false }];
  const idx = sentence.indexOf(trimmed);
  if (idx === -1) {
    // For conjugated Japanese verbs/adjectives, match kanji stem prefix if present
    const stemMatch = trimmed.match(/^[\u4e00-\u9faf\u3400-\u4dbf]+/);
    if (stemMatch && stemMatch[0].length >= 1) {
      const stemIdx = sentence.indexOf(stemMatch[0]);
      if (stemIdx !== -1) {
        let end = stemIdx + stemMatch[0].length;
        while (end < sentence.length && /[\u3040-\u309f]/.test(sentence[end]) && end - stemIdx < trimmed.length + 3) {
          end++;
        }
        const segments: SentenceSegment[] = [];
        if (stemIdx > 0) segments.push({ text: sentence.slice(0, stemIdx), highlighted: false });
        segments.push({ text: sentence.slice(stemIdx, end), highlighted: true });
        if (end < sentence.length) segments.push({ text: sentence.slice(end), highlighted: false });
        return segments;
      }
    }
    return [{ text: sentence, highlighted: false }];
  }

  const segments: SentenceSegment[] = [];
  let cursor = 0;
  while (cursor < sentence.length) {
    const found = sentence.indexOf(trimmed, cursor);
    if (found === -1) {
      segments.push({ text: sentence.slice(cursor), highlighted: false });
      break;
    }
    if (found > cursor) {
      segments.push({ text: sentence.slice(cursor, found), highlighted: false });
    }
    segments.push({ text: trimmed, highlighted: true });
    cursor = found + trimmed.length;
  }
  return segments;
}

export function extractKanjiCharacters(word: string): string[] {
  const chars = word.match(/[\u4e00-\u9faf\u3400-\u4dbf]/g) ?? [];
  return [...new Set(chars)];
}
