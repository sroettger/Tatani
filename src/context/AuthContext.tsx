import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_LEARNING_LANGUAGE,
  LearningLangCode,
  getLearningLanguage,
  isLearningLang,
  type LearningLanguage,
} from "@/lib/languages";

export type Profile = {
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

type CachedAuthPayload = {
  profile: Profile | null;
  progressByLang: Record<string, LanguageProgress>;
};

const AUTH_CACHE_PREFIX = "tatani-auth-cache-v1:";

function readAuthCache(uid: string): CachedAuthPayload | null {
  try {
    const raw = localStorage.getItem(`${AUTH_CACHE_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedAuthPayload>;
    return {
      profile: parsed.profile ?? null,
      progressByLang: parsed.progressByLang && typeof parsed.progressByLang === "object" ? parsed.progressByLang : {},
    };
  } catch {
    return null;
  }
}

function writeAuthCache(uid: string, profile: Profile | null, progress: LanguageProgress | null) {
  try {
    const existing = readAuthCache(uid);
    const progressByLang: Record<string, LanguageProgress> = { ...(existing?.progressByLang ?? {}) };
    if (progress?.learning_language) {
      progressByLang[progress.learning_language] = progress;
    }
    localStorage.setItem(
      `${AUTH_CACHE_PREFIX}${uid}`,
      JSON.stringify({ profile, progressByLang } satisfies CachedAuthPayload),
    );
  } catch {
    // Ignore storage quota errors cleanly
  }
}

function clearAuthCache(uid?: string | null) {
  if (!uid) return;
  try {
    localStorage.removeItem(`${AUTH_CACHE_PREFIX}${uid}`);
  } catch {
    // Ignore storage errors cleanly
  }
}

const Ctx = createContext<AuthCtx | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [progress, setProgress] = useState<LanguageProgress | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const inflightProfileRef = useRef<{ uid: string; promise: Promise<void> } | null>(null);
  const loadedUidRef = useRef<string | null>(null);

  const loadProgress = useCallback(async (uid: string, lang: string): Promise<LanguageProgress | null> => {
    const { data, error: selectError } = await supabase
      .from("user_language_progress")
      .select("*")
      .eq("user_id", uid)
      .eq("learning_language", lang)
      .maybeSingle();

    if (selectError) {
      return readAuthCache(uid)?.progressByLang[lang] ?? null;
    }

    if (data) {
      return data as LanguageProgress;
    }

    // First time in this language — idempotently upsert an empty progress row.
    const { data: created } = await supabase
      .from("user_language_progress")
      .upsert({ user_id: uid, learning_language: lang }, { onConflict: "user_id,learning_language" })
      .select()
      .maybeSingle();

    return (created as LanguageProgress) ?? null;
  }, []);

  const loadProfile = useCallback(
    (uid: string): Promise<void> => {
      if (inflightProfileRef.current?.uid === uid) {
        return inflightProfileRef.current.promise;
      }

      const promise = (async () => {
        try {
          const { data, error: profileError } = await supabase
            .from("profiles")
            .select("*")
            .eq("user_id", uid)
            .maybeSingle();

          if (profileError) {
            const cached = readAuthCache(uid);
            if (cached) {
              setProfile(cached.profile);
              const cachedLang = isLearningLang(cached.profile?.learning_language)
                ? cached.profile!.learning_language
                : DEFAULT_LEARNING_LANGUAGE;
              setProgress(cached.progressByLang[cachedLang] ?? null);
              loadedUidRef.current = uid;
            }
            return;
          }

          const p = (data as Profile) ?? null;
          const lang = isLearningLang(p?.learning_language)
            ? p!.learning_language
            : DEFAULT_LEARNING_LANGUAGE;
          const prog = await loadProgress(uid, lang);

          setProfile(p);
          setProgress(prog);
          writeAuthCache(uid, p, prog);
          loadedUidRef.current = uid;
        } catch {
          const cached = readAuthCache(uid);
          if (cached) {
            setProfile(cached.profile);
            const cachedLang = isLearningLang(cached.profile?.learning_language)
              ? cached.profile!.learning_language
              : DEFAULT_LEARNING_LANGUAGE;
            setProgress(cached.progressByLang[cachedLang] ?? null);
            loadedUidRef.current = uid;
          }
        } finally {
          if (inflightProfileRef.current?.uid === uid) {
            inflightProfileRef.current = null;
          }
        }
      })();

      inflightProfileRef.current = { uid, promise };
      return promise;
    },
    [loadProgress],
  );

  useEffect(() => {
    const hydrateFromCache = (uid: string): boolean => {
      const cached = readAuthCache(uid);
      if (!cached?.profile) return false;
      const cachedLang = isLearningLang(cached.profile.learning_language)
        ? cached.profile.learning_language
        : DEFAULT_LEARNING_LANGUAGE;
      const cachedProg = cached.progressByLang[cachedLang] ?? null;
      if (!cachedProg) return false;
      setProfile(cached.profile);
      setProgress(cachedProg);
      loadedUidRef.current = uid;
      return true;
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) {
        const uid = sess.user.id;
        const hydrated = loadedUidRef.current === uid || hydrateFromCache(uid);
        if (!hydrated) {
          setProfileLoading(true);
        }
        // Defer Supabase query out of the synchronous auth callback to prevent lock re-entrancy
        setTimeout(() => {
          void loadProfile(uid).finally(() => setProfileLoading(false));
        }, 0);
      } else {
        loadedUidRef.current = null;
        setProfile(null);
        setProgress(null);
        setProfileLoading(false);
      }
    });

    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      setSession(initialSession);
      setUser(initialSession?.user ?? null);
      if (initialSession?.user) {
        const uid = initialSession.user.id;
        const hydrated = hydrateFromCache(uid);
        if (!hydrated) {
          setProfileLoading(true);
        }
        void loadProfile(uid).finally(() => {
          setProfileLoading(false);
          setAuthLoading(false);
        });
      } else {
        setAuthLoading(false);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (user) await loadProfile(user.id);
  }, [user, loadProfile]);

  const learningLanguage: LearningLangCode = isLearningLang(profile?.learning_language)
    ? (profile!.learning_language as LearningLangCode)
    : DEFAULT_LEARNING_LANGUAGE;

  const setLearningLanguage = useCallback(
    async (code: LearningLangCode) => {
      if (!user) return;
      const { error } = await supabase
        .from("profiles")
        .update({ learning_language: code })
        .eq("user_id", user.id);
      if (error) throw error;
      await loadProfile(user.id);
    },
    [user, loadProfile],
  );

  const signOut = useCallback(async () => {
    const prevUid = user?.id;
    await supabase.auth.signOut();
    clearAuthCache(prevUid);
    loadedUidRef.current = null;
    setProfile(null);
    setProgress(null);
    setProfileLoading(false);
  }, [user?.id]);

  const loading = authLoading || profileLoading;

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
