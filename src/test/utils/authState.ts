import { vi } from "vitest";

/**
 * Mutable auth state used by the mocked AuthContext in tests.
 * Set it with `setAuthState()` before rendering.
 */
import {
  DEFAULT_LEARNING_LANGUAGE,
  getLearningLanguage,
  type LearningLangCode,
} from "@/lib/languages";

export type TestAuthState = {
  user: { id: string } | null;
  profile: Record<string, unknown> | null;
  loading: boolean;
  learningLanguage: LearningLangCode;
  progress: {
    learning_language: string;
    level: string;
    placement_done: boolean;
    total_words_known: number;
    study_streak: number;
  } | null;
};

const base = (): TestAuthState => ({
  user: { id: "test-user" },
  profile: { user_id: "test-user", ui_language: "en", learning_language: DEFAULT_LEARNING_LANGUAGE },
  loading: false,
  learningLanguage: DEFAULT_LEARNING_LANGUAGE,
  progress: {
    learning_language: DEFAULT_LEARNING_LANGUAGE,
    level: "N5",
    placement_done: true,
    total_words_known: 0,
    study_streak: 0,
  },
});

export const authState: TestAuthState = base();

export const setLearningLanguageMock = vi.fn(async () => {});
export const refreshProfileMock = vi.fn(async () => {});
export const signOutMock = vi.fn(async () => {});

export function resetAuthState() {
  Object.assign(authState, base());
  setLearningLanguageMock.mockClear();
  refreshProfileMock.mockClear();
  signOutMock.mockClear();
}

/** Configure the mocked auth context for a (UI language, learning language) pair. */
export function setAuthState(patch: Partial<TestAuthState> & { uiLanguage?: string }) {
  const { uiLanguage, ...rest } = patch;
  Object.assign(authState, rest);
  if (rest.learningLanguage) {
    authState.profile = { ...(authState.profile ?? {}), learning_language: rest.learningLanguage };
    if (authState.progress) authState.progress.learning_language = rest.learningLanguage;
  }
  if (uiLanguage) {
    authState.profile = { ...(authState.profile ?? {}), ui_language: uiLanguage };
  }
}

/** The object the mocked `useAuth()` returns. */
export const currentAuth = () => ({
  session: authState.user ? ({ user: authState.user } as never) : null,
  user: authState.user,
  profile: authState.profile,
  loading: authState.loading,
  learningLanguage: authState.learningLanguage,
  learningLanguageInfo: getLearningLanguage(authState.learningLanguage),
  progress: authState.progress,
  setLearningLanguage: setLearningLanguageMock,
  refreshProfile: refreshProfileMock,
  signOut: signOutMock,
});
