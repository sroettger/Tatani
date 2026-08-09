// Which language the user is learning, and everything that varies by it.
export type LearningLangCode = "ja" | "es" | "fr" | "de";

export type LevelScale = "jlpt" | "cefr";

export type LearningLanguage = {
  code: LearningLangCode;
  /** English name */
  name: string;
  /** Endonym, shown in pickers */
  native: string;
  flag: string;
  scale: LevelScale;
  /** Japanese needs furigana / kanji-only preferences; latin scripts do not. */
  hasRuby: boolean;
};

export const LEARNING_LANGUAGES: LearningLanguage[] = [
  { code: "ja", name: "Japanese", native: "日本語", flag: "🇯🇵", scale: "jlpt", hasRuby: true },
  { code: "es", name: "Spanish", native: "Español", flag: "🇪🇸", scale: "cefr", hasRuby: false },
  { code: "fr", name: "French", native: "Français", flag: "🇫🇷", scale: "cefr", hasRuby: false },
  { code: "de", name: "German", native: "Deutsch", flag: "🇩🇪", scale: "cefr", hasRuby: false },
];

export const DEFAULT_LEARNING_LANGUAGE: LearningLangCode = "ja";

export const JLPT_LEVELS = ["N5", "N4", "N3", "N2", "N1"] as const;
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

export const isLearningLang = (v: unknown): v is LearningLangCode =>
  typeof v === "string" && LEARNING_LANGUAGES.some((l) => l.code === v);

export const getLearningLanguage = (code: string | null | undefined): LearningLanguage =>
  LEARNING_LANGUAGES.find((l) => l.code === code) ?? LEARNING_LANGUAGES[0];

/** Ordered level codes for a language, easiest first. */
export const levelsFor = (code: string | null | undefined): readonly string[] =>
  getLearningLanguage(code).scale === "jlpt" ? JLPT_LEVELS : CEFR_LEVELS;

/** 1-based difficulty rank of a level within its scale; 0 for "none"/unknown. */
export const levelRank = (langCode: string | null | undefined, level: string | null | undefined): number => {
  if (!level || level === "none") return 0;
  const idx = levelsFor(langCode).indexOf(level);
  return idx < 0 ? 0 : idx + 1;
};

export const levelFromRank = (langCode: string | null | undefined, rank: number): string => {
  const levels = levelsFor(langCode);
  return levels[Math.min(Math.max(rank, 1), levels.length) - 1];
};

/** Label for the level scale itself, e.g. "JLPT" or "CEFR". */
export const scaleLabel = (code: string | null | undefined): string =>
  getLearningLanguage(code).scale === "jlpt" ? "JLPT" : "CEFR";

/** Display a level, e.g. "N4" or "B1"; em dash when unset. */
export const formatLevel = (level: string | null | undefined): string =>
  !level || level === "none" ? "—" : level;
