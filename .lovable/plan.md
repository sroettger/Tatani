# Testing strategy for Tatani

Today the project has a vitest setup with only a placeholder test (`src/test/example.test.ts`), so every regression from the multi-language work (library not showing, redirect loop after placement, untranslated toasts, wrong language in prompts) had to be found by hand. The bugs shared one shape: **something ignored the active `learning_language` or `ui_language`**. Tests should target exactly that shape.

## 1. Unit tests (fast, no backend)

- `src/lib/languages.ts` — every supported language has metadata, a level scale (JLPT vs CEFR), TTS locale, `hasRuby` only for Japanese.
- `src/lib/placementBank.ts` — `buildPlacementQuiz` returns the right count per level for each language, distractors never equal the answer, meanings exist in both `en` and `ja`.
- `src/i18n/strings.ts` — **key parity test**: `en` and `ja` dictionaries have identical key sets and no empty values. This alone catches missing-translation bugs before they ship.
- `t()` from `src/i18n` — variable interpolation, fallback to `en` for a missing key.

## 2. Component tests (jsdom + Testing Library)

Render with a mocked auth/i18n context so we can drive the two variables that break things:

- Settings renders the CEFR selector for German and the JLPT selector for Japanese.
- Furigana / Japanese-only UI is hidden when the learning language is not Japanese.
- Onboarding shows language selection before the placement quiz for a new user, and routes to Home after the quiz completes.
- `ProtectedRoute` sends users to onboarding only when `progress.placement_done` is false for the **active** language — the exact regression we hit.

A shared test helper (`src/test/renderWithProviders.tsx`) mounts the router, query client, and a fake auth context with configurable `ui_language` / `learning_language`.

## 3. Data-layer contract tests

A test that scans the source for Supabase queries touching language-scoped tables (`user_anime`, `user_word_state`, `study_chunks`, `study_sessions`, `quiz_results`, `episode_summaries`) and asserts each one filters or writes `learning_language`. This is a lint-style guard that would have caught the "German anime saved as Japanese" bug at write time.

## 4. Edge function tests (Deno)

For `add-anime-to-library`, `episode-summary`, `episode-discuss`, `tutor-chat`, `recommend-anime`:
- resolves the learning language from the profile when not supplied,
- writes rows with the correct `learning_language`,
- system prompt contains the user's UI language instruction.
AI calls are stubbed, so no credits are spent.

## 5. End-to-end smoke (Playwright, run on demand)

One scripted pass of the highest-risk journey with UI = 日本語 and target = Deutsch: sign in, onboarding, placement quiz, add anime, open episode, study a chunk. Screenshots at each step plus a console-error assertion. This is the check that catches "empty page after the quiz" class of failures.

## 6. Making it stick

- Run the unit + component + contract suites after every change touching languages, onboarding, or data queries.
- Add a `test:e2e` script for the Playwright pass, run before publishing.

## Technical notes

- Vitest config already exists and matches `src/**/*.{test,spec}.{ts,tsx}`; no config change needed beyond adding `src/test/renderWithProviders.tsx`.
- Supabase client is mocked per-test with `vi.mock("@/integrations/supabase/client")` returning a chainable stub that records the filters applied — that recording is what the language-scoping assertions inspect.
- Deno tests live at `supabase/functions/<name>/index.test.ts` and load env via `std/dotenv/load.ts`.
- Playwright script lives outside the project checkout, driving `http://localhost:8080`.

## Suggested order

1. i18n key parity + languages/placement bank unit tests (cheapest, highest catch rate)
2. `renderWithProviders` helper + ProtectedRoute/Onboarding/Settings component tests
3. Language-scoping contract test
4. Edge function Deno tests
5. Playwright smoke journey
