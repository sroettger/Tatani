import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_LEARNING_LANGUAGE,
  LearningLangCode,
  getLearningLanguage,
  isLearningLang,
  type LearningLanguage,
} from "@/lib/languages";

type Profile = {
  id: string;
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  jlpt_level: "N5" | "N4" | "N3" | "N2" | "N1" | "none";
  placement_done: boolean;
  total_words_known: number;
  study_streak: number;
  country: string | null;
  ui_language: string;
  learning_language: string;
};

export type LanguageProgress = {
  id: string;
  user_id: string;
  learning_language: string;
  level: string;
  placement_done: boolean;
  total_words_known: number;
  study_streak: number;
};

type AuthCtx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  /** Language the user is currently learning. */
  learningLanguage: LearningLangCode;
  learningLanguageInfo: LearningLanguage;
  /** Progress row for the active learning language (level, placement, streak). */
  progress: LanguageProgress | null;
  setLearningLanguage: (code: LearningLangCode) => Promise<void>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [progress, setProgress] = useState<LanguageProgress | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProgress = async (uid: string, lang: string) => {
    const { data } = await supabase
      .from("user_language_progress")
      .select("*")
      .eq("user_id", uid)
      .eq("learning_language", lang)
      .maybeSingle();
    if (data) {
      setProgress(data as LanguageProgress);
      return;
    }
    // First time in this language — create an empty progress row.
    const { data: created } = await supabase
      .from("user_language_progress")
      .insert({ user_id: uid, learning_language: lang })
      .select()
      .maybeSingle();
    setProgress((created as LanguageProgress) ?? null);
  };

  const loadProfile = async (uid: string) => {
    const { data } = await supabase.from("profiles").select("*").eq("user_id", uid).maybeSingle();
    const p = (data as Profile) ?? null;
    setProfile(p);
    const lang = isLearningLang(p?.learning_language) ? p!.learning_language : DEFAULT_LEARNING_LANGUAGE;
    await loadProgress(uid, lang);
  };

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) {
        // defer to avoid deadlocks with Supabase auth callbacks
        setTimeout(() => loadProfile(sess.user.id), 0);
      } else {
        setProfile(null);
        setProgress(null);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) loadProfile(session.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshProfile = async () => {
    if (user) await loadProfile(user.id);
  };

  const learningLanguage: LearningLangCode = isLearningLang(profile?.learning_language)
    ? (profile!.learning_language as LearningLangCode)
    : DEFAULT_LEARNING_LANGUAGE;

  const setLearningLanguage = async (code: LearningLangCode) => {
    if (!user) return;
    const { error } = await supabase
      .from("profiles")
      .update({ learning_language: code })
      .eq("user_id", user.id);
    if (error) throw error;
    await loadProfile(user.id);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setProgress(null);
  };

  return (
    <Ctx.Provider
      value={{
        session,
        user,
        profile,
        loading,
        learningLanguage,
        learningLanguageInfo: getLearningLanguage(learningLanguage),
        progress,
        setLearningLanguage,
        refreshProfile,
        signOut,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
