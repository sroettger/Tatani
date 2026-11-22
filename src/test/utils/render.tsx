import { ReactElement } from "react";
import { render, RenderOptions } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import { setAuthState, resetAuthState, type TestAuthState } from "./authState";
import { resetSupabaseMock } from "./supabaseMock";
import type { LearningLangCode } from "@/lib/languages";

export type ProviderOptions = {
  /** UI language the user speaks. */
  uiLanguage?: "en" | "ja";
  /** Language the user is learning. */
  learningLanguage?: LearningLangCode;
  auth?: Partial<TestAuthState>;
  route?: string;
  /** Extra routes so `<Navigate>` targets render something assertable. */
  routes?: Array<{ path: string; element: ReactElement }>;
};

export function resetTestState() {
  resetAuthState();
  resetSupabaseMock();
}

export function renderWithProviders(ui: ReactElement, opts: ProviderOptions = {}, rtl?: RenderOptions) {
  const {
    uiLanguage = "en",
    learningLanguage = "ja",
    auth = {},
    route = "/",
    routes = [],
  } = opts;

  window.localStorage.setItem("ui.language", uiLanguage);
  setAuthState({ uiLanguage, learningLanguage, ...auth });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[route]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <I18nProvider>
          <Routes>
            <Route path={route} element={ui} />
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
    rtl,
  );
}

/** Every (UI language, learning language) pair worth testing. */
export const LANGUAGE_MATRIX: Array<{ uiLanguage: "en" | "ja"; learningLanguage: LearningLangCode }> = [
  { uiLanguage: "en", learningLanguage: "ja" },
  { uiLanguage: "ja", learningLanguage: "de" },
  { uiLanguage: "en", learningLanguage: "de" },
];
