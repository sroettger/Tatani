// Language configuration shared by all edge functions.
export type LearningLangCode = "ja" | "es" | "fr" | "de";

type Info = {
  code: LearningLangCode;
  name: string;
  native: string;
  scale: "jlpt" | "cefr";
  levels: string[];
  /** Japanese needs a morphological tokenizer + JLPT list; latin scripts don't. */
  morphological: boolean;
  /** Subtitle language code used when searching subtitle providers. */
  subtitleLang: string;
};

export const LANGUAGES: Record<LearningLangCode, Info> = {
  ja: { code: "ja", name: "Japanese", native: "日本語", scale: "jlpt", levels: ["N5", "N4", "N3", "N2", "N1"], morphological: true, subtitleLang: "ja" },
  es: { code: "es", name: "Spanish", native: "Español", scale: "cefr", levels: ["A1", "A2", "B1", "B2", "C1", "C2"], morphological: false, subtitleLang: "es" },
  fr: { code: "fr", name: "French", native: "Français", scale: "cefr", levels: ["A1", "A2", "B1", "B2", "C1", "C2"], morphological: false, subtitleLang: "fr" },
  de: { code: "de", name: "German", native: "Deutsch", scale: "cefr", levels: ["A1", "A2", "B1", "B2", "C1", "C2"], morphological: false, subtitleLang: "de" },
};

export const DEFAULT_LEARNING_LANG: LearningLangCode = "ja";

export const langInfo = (code: string | null | undefined): Info =>
  LANGUAGES[(code ?? "") as LearningLangCode] ?? LANGUAGES[DEFAULT_LEARNING_LANG];

/** UI languages the learner may read explanations in. */
export const uiLanguageName = (code: string | null | undefined): string =>
  code === "ja" ? "Japanese (日本語)" : "English";

/** Fetch the learner's language settings. `supabase` must be a service-role client. */
export async function getUserLanguages(
  supabase: any,
  userId: string,
): Promise<{ learning: Info; uiLanguage: string; level: string }> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("ui_language, learning_language")
    .eq("user_id", userId)
    .maybeSingle();
  const learning = langInfo(profile?.learning_language);
  const { data: prog } = await supabase
    .from("user_language_progress")
    .select("level")
    .eq("user_id", userId)
    .eq("learning_language", learning.code)
    .maybeSingle();
  return {
    learning,
    uiLanguage: profile?.ui_language === "ja" ? "ja" : "en",
    level: prog?.level ?? "none",
  };
}
