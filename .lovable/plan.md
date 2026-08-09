# Testing strategy for multi-language Tatani

The recent bugs (library not showing, blank page after quiz, missing subtitles) all came from the same class of problem: a language dimension was added to the data model, and some code paths kept the old single-language assumption. Tests should target that class, not individual screens.

## What to build

### 1. Static guardrails (fast, catch most of the recent bugs)
- **Translation key parity**: assert `en` and `ja` dictionaries in `src/i18n/strings.ts` have identical key sets, and no value is empty.
- **Language metadata**: every language in `src/lib/languages.ts` has a level scale, TTS locale, and a placement word bank entry for every level.
- **Query lint**: a test that scans `src/` and `supabase/functions/` for reads/writes on language-scoped tables (`user_anime`, `user_word_state`, `study_chunks`, `study_sessions`, `quiz_results`, `episode_summaries`, `user_language_progress`) and fails if the call site doesn't also reference `learning_language`. This would have caught the "added to library but doesn't show up" bug.

### 2. Unit tests
- `buildPlacementQuiz`: correct question count per level, distractors never equal the answer, meanings resolve in both UI languages, works for every supported language.
- Level helpers: JLPT vs CEFR ordering, next/previous level, default level.

### 3. Component tests with a provider harness
Add a `renderWithProviders` helper that mocks auth + i18n so a component can be rendered for any (UI language, learning language) pair. Then test the pairs that broke:
- Settings shows CEFR for German, JLPT for Japanese; toasts render in the UI language.
- Furigana/ruby UI only renders when the learning language supports it.
- Onboarding: language pickers appear before the quiz for a new user; after finishing, it routes to Home instead of a blank page (assert on `progress.placement_done`, not the old profile field).
- Home/Stats: empty state when the active learning language has no data, even if another language does.

### 4. Edge function tests (Deno)
For `fetch-subtitles`, `episode-summary`, `episode-discuss`, `tutor-chat`, `add-anime-to-library`:
- language resolution: request body override > profile `learning_language` > default.
- prompts contain the correct target language and the correct explanation language.
- `fetch-subtitles`: provider chain order per language, and the failure response lists the providers tried. Network calls mocked.

### 5. One end-to-end smoke test (Playwright)
Single critical path, run manually before releases: sign in → onboarding picks 日本語 UI + Deutsch target → placement quiz → Home → add anime → open episode → fetch subtitles. Assert no English strings leak when the UI language is Japanese.

## Process change
Whenever a new dimension is added to the data model (a second learning language, a third UI language), add it to the parametrised test matrix rather than writing new one-off tests. The matrix is the thing that catches regressions.

## Technical notes
Vitest + jsdom + Testing Library are already configured (`vitest.config.ts`, `src/test/setup.ts`). Supabase calls get mocked with a small chainable stub so no test hits the real backend. Edge function tests use Deno's runner via the existing edge-function test tooling. Playwright is only used for the single smoke test and is not part of the default test run.

## Suggested order
1. Static guardrails + unit tests (highest value per effort)
2. Provider harness + component tests
3. Edge function tests
4. Playwright smoke test
