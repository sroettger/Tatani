import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { DICTS, LangCode, LANGUAGE_NAMES, StringKey, SUPPORTED_LANGUAGES } from "./strings";

const STORAGE_KEY = "ui.language";

type I18nCtx = {
  lang: LangCode;
  languageName: string;
  setLang: (l: LangCode) => Promise<void>;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
};

const Ctx = createContext<I18nCtx | undefined>(undefined);

const isLang = (v: unknown): v is LangCode =>
  typeof v === "string" && SUPPORTED_LANGUAGES.some((l) => l.code === v);

const readStored = (): LangCode => {
  if (typeof window === "undefined") return "en";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return isLang(raw) ? raw : "en";
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user, profile, refreshProfile } = useAuth();
  const [lang, setLangState] = useState<LangCode>(readStored);

  const profileUiLang = profile?.ui_language;

  // Profile is the source of truth once loaded.
  useEffect(() => {
    if (isLang(profileUiLang)) {
      setLangState((prev) => (prev === profileUiLang ? prev : profileUiLang));
      window.localStorage.setItem(STORAGE_KEY, profileUiLang);
    }
  }, [profileUiLang]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback(
    async (next: LangCode) => {
      setLangState(next);
      window.localStorage.setItem(STORAGE_KEY, next);
      if (user) {
        const { error } = await supabase.from("profiles").update({ ui_language: next }).eq("user_id", user.id);
        if (error) throw error;
        await refreshProfile();
      }
    },
    [user, refreshProfile],
  );

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => {
      const dict = DICTS[lang] ?? DICTS.en;
      let s = dict[key] ?? DICTS.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      }
      return s;
    },
    [lang],
  );

  const value = useMemo(
    () => ({ lang, languageName: LANGUAGE_NAMES[lang], setLang, t }),
    [lang, setLang, t],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}

export { SUPPORTED_LANGUAGES, LANGUAGE_NAMES, DICTS };
export type { LangCode };
